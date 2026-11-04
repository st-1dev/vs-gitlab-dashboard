'use strict';

const vscode = require('vscode');
const { normalizeBaseUrl, projectPath, remoteProjectPath, isAbort } = require('./gitlab');

const WINDOW_MAX_AGE_MS = 3 * 60_000;
const PUBLISH_INTERVAL_MS = 60_000;

/** Projects of the dashboard: favorites, Git repositories of this window and of other windows. */
class ProjectRegistry {
  constructor(service, store) {
    this.service = service;
    this.store = store;
    this.api = null;
    this.published = '';
    this.timer = null;
    this.debounce = null;
    this.subscriptions = [];
    this.changed = new vscode.EventEmitter();
    this.onDidChange = this.changed.event;
  }

  async gitApi() {
    if (this.api) return this.api;
    const extension = vscode.extensions.getExtension('vscode.git');
    if (!extension) return null;
    try {
      const exports = extension.isActive ? extension.exports : await extension.activate();
      if (!exports?.enabled) return null;
      const api = exports.getAPI(1);
      if (api.state !== 'initialized') {
        await new Promise(resolve => {
          const timeout = setTimeout(resolve, 5000);
          const listener = api.onDidChangeState(state => { if (state === 'initialized') { clearTimeout(timeout); listener.dispose(); resolve(); } });
        });
      }
      this.api = api;
      const changed = () => { clearTimeout(this.debounce); this.debounce = setTimeout(() => void this.publish(true), 2000); };
      const watchRepository = repository => this.subscriptions.push(repository.state.onDidChange(changed));
      api.repositories.forEach(watchRepository);
      this.subscriptions.push(api.onDidOpenRepository(repository => { watchRepository(repository); changed(); }), api.onDidCloseRepository(changed));
      return api;
    } catch { return null; }
  }

  /** Remote URLs and the current branch of every repository open in this window. */
  async localRepositories() {
    const api = await this.gitApi();
    if (!api) return [];
    return api.repositories.map(repository => ({
      remotes: [...new Set(repository.state.remotes.flatMap(remote => [remote.fetchUrl, remote.pushUrl]).filter(Boolean))],
      branch: repository.state.HEAD?.name || null
    })).filter(repository => repository.remotes.length);
  }

  /** UC1: publish this window's repositories on change and every minute; fire onDidChange when they differ. */
  async publish(notify = false) {
    const repositories = await this.localRepositories().catch(() => []);
    await this.store.publishWindow(repositories).catch(() => {}); // Other windows retry on the next minute.
    const serialized = JSON.stringify(repositories);
    if (notify && serialized !== this.published) this.changed.fire();
    this.published = serialized;
    return repositories;
  }

  startPublishing() {
    void this.publish();
    this.timer = setInterval(() => void this.publish(), PUBLISH_INTERVAL_MS);
  }

  /** UC1: resolve favorites and repositories from every open window, preferring this window's branch. */
  async discover(signal) {
    const { serverUrl, favorites } = this.service.settings();
    const url = normalizeBaseUrl(serverUrl);
    const paths = new Map();
    const errors = [];
    for (const favorite of favorites) {
      try { paths.set(projectPath(favorite, url), null); } catch (error) { errors.push(`${favorite}: ${error.message}`); }
    }
    const local = await this.publish();
    const windows = [...await this.store.otherWindows(WINDOW_MAX_AGE_MS).catch(() => []), { repositories: local }];
    for (const window of windows) {
      for (const repository of window.repositories) {
        for (const remote of repository.remotes || []) {
          const path = remoteProjectPath(String(remote), url);
          if (path) paths.set(path, typeof repository.branch === 'string' ? repository.branch : null);
        }
      }
    }
    const projects = new Map(), branches = new Map();
    await Promise.all([...paths].map(async ([path, branch]) => {
      try {
        const project = await this.service.request(client => client.project(path), signal);
        projects.set(project.id, project);
        if (branch) branches.set(project.id, branch);
      } catch (error) {
        if (isAbort(error)) throw error;
        errors.push(`${path}: ${error.message}`);
      }
    }));
    return { projects: [...projects.values()].sort((a, b) => a.path.localeCompare(b.path)), currentBranches: branches, errors };
  }

  async dispose() {
    clearInterval(this.timer);
    clearTimeout(this.debounce);
    this.subscriptions.forEach(subscription => subscription.dispose());
    this.changed.dispose();
    await this.store.removeWindow().catch(() => {});
  }
}

module.exports = { ProjectRegistry };
