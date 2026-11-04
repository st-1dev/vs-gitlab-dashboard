'use strict';

const vscode = require('vscode');
const { GitLabClient, normalizeBaseUrl, cancelled } = require('./gitlab');
const { isComplete, completionKey, jobSignature, runtimeSeconds, formatDuration } = require('./models');
const { estimate } = require('./estimator');
const { watchKey } = require('./store');

const MAX_REQUESTS = 4;
const HISTORY_TTL_MS = 5 * 60_000;

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(cancelled()); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(cancelled()); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Window-wide GitLab access: credentials, request limits, shared watch monitoring and the history cache. */
class DashboardService {
  constructor(config, store) {
    this.config = config;
    this.store = store;
    this.epoch = 0;
    this.cachedClient = null;
    this.cachedUser = null;
    this.active = 0;
    this.waiting = [];
    this.cooldownUntil = 0;
    this.history = new Map();
    this.historyQueue = Promise.resolve();
    this.snapshots = new Map();
    this.watchKeys = new Set();
    this.monitorError = '';
    this.leader = false;
    this.timer = null;
    this.ticking = null;
    this.disposed = false;
    this.changed = new vscode.EventEmitter();
    this.onDidChange = this.changed.event;
    this.requested = new vscode.EventEmitter();
    this.onDidRequestPipeline = this.requested.event;
  }

  settings() { return this.config.settings(); }

  updateSettings(patch) { return this.config.update(patch); }

  /** UC1: a server or PAT change, also from another window, drops cached clients, users, histories and snapshots. */
  resetConnection() {
    this.epoch++;
    this.cachedClient = null;
    this.cachedUser = null;
    this.cooldownUntil = 0;
    this.history.clear();
    this.snapshots.clear();
    this.watchKeys.clear();
    this.monitorError = '';
    this.changed.fire();
  }

  /** UC1: read the workspace URL and PAT; credentials never go to the webview. */
  async client() {
    const epoch = this.epoch;
    if (this.cachedClient?.epoch === epoch) return this.cachedClient.client;
    const { url: configuredUrl, token } = this.config.credentials();
    const url = normalizeBaseUrl(configuredUrl);
    if (!token) throw new Error('Укажите Personal Access Token: команда «GitLab Dashboard: Настроить подключение»');
    const client = new GitLabClient(url, token);
    if (epoch === this.epoch) this.cachedClient = { epoch, client };
    return client;
  }

  /** At most four GitLab requests at a time; a 429 Retry-After pauses every request of this window. */
  async request(call, signal) {
    await this.acquire(signal);
    try {
      for (let wait = this.cooldownUntil - Date.now(); wait > 0; wait = this.cooldownUntil - Date.now()) await sleep(wait, signal);
      const client = await this.client();
      return await call(client.withSignal(signal));
    } catch (error) {
      if (error?.retryAfterSeconds) this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + error.retryAfterSeconds * 1000);
      throw error;
    } finally { this.release(); }
  }

  acquire(signal) {
    if (signal?.aborted) return Promise.reject(cancelled());
    if (this.active < MAX_REQUESTS) { this.active++; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      this.waiting.push(waiter);
      signal?.addEventListener('abort', () => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) { this.waiting.splice(index, 1); reject(cancelled()); }
      }, { once: true });
    });
  }

  release() {
    const next = this.waiting.shift();
    if (next) next.resolve(); else this.active--;
  }

  async user(signal) {
    const epoch = this.epoch;
    if (this.cachedUser?.epoch === epoch) return this.cachedUser.user;
    const user = await this.request(client => client.user(), signal);
    if (epoch === this.epoch) this.cachedUser = { epoch, user };
    return user;
  }

  watchKey(project, pipelineId) { return watchKey({ serverUrl: normalizeBaseUrl(this.settings().serverUrl), projectId: project.id, pipelineId }); }
  isWatched(key) { return this.watchKeys.has(key); }

  async watch(project, pipelineId) {
    const entry = { serverUrl: normalizeBaseUrl(this.settings().serverUrl), projectId: project.id, projectPath: project.path, projectUrl: project.webUrl, pipelineId };
    await this.store.addWatch(entry);
    this.watchKeys.add(watchKey(entry));
    this.changed.fire();
    this.startMonitoring();
    void this.tick();
  }

  async unwatch(key) {
    await this.store.removeWatch(key);
    this.watchKeys.delete(key);
    this.snapshots.delete(key);
    this.changed.fire();
  }

  startMonitoring() {
    if (this.timer || this.disposed) return;
    const loop = async () => {
      await this.tick();
      if (!this.disposed) this.timer = setTimeout(loop, this.settings().refreshSeconds * 1000);
    };
    this.timer = setTimeout(loop, 0);
  }

  tick() {
    if (!this.ticking) this.ticking = this.monitor().catch(error => { this.monitorError = error.message; this.changed.fire(); }).finally(() => { this.ticking = null; });
    return this.ticking;
  }

  /** UC3: the lease holder polls the watches of the configured server and shares snapshots; other windows read them. */
  async monitor() {
    const { serverUrl, refreshSeconds } = this.settings();
    let url;
    try { url = normalizeBaseUrl(serverUrl); } catch { return; }
    const epoch = this.epoch;
    const watches = (await this.store.watches()).filter(entry => entry.serverUrl === url);
    this.watchKeys = new Set(watches.map(watchKey));
    for (const key of this.snapshots.keys()) if (!this.watchKeys.has(key)) this.snapshots.delete(key);
    if (!watches.length) {
      if (this.leader) { this.leader = false; await this.store.releaseLease(); }
      this.monitorError = '';
      this.changed.fire();
      return;
    }
    this.leader = await this.store.acquireLease(Math.max(45_000, refreshSeconds * 3000));
    if (this.leader) {
      const errors = await Promise.all(watches.map(entry => this.pollWatch(entry, epoch)));
      if (epoch !== this.epoch) return;
      this.monitorError = errors.filter(Boolean).join('; ');
      await this.store.writeSnapshots({ serverUrl: url, error: this.monitorError, snapshots: [...this.snapshots].map(([key, snapshot]) => ({ key, ...snapshot })) });
    } else {
      const shared = await this.store.readSnapshots();
      if (shared?.serverUrl === url && epoch === this.epoch) {
        for (const item of shared.snapshots || []) if (this.watchKeys.has(item.key)) this.snapshots.set(item.key, { project: item.project, pipeline: item.pipeline, jobs: item.jobs });
        this.monitorError = shared.error || '';
      }
    }
    this.changed.fire();
  }

  /** UC3: notify once after the pipeline and all of its jobs and trigger jobs settle. */
  async pollWatch(entry, epoch) {
    const key = watchKey(entry);
    try {
      const pipeline = await this.request(client => client.pipeline(entry.projectId, entry.pipelineId));
      const jobs = await this.request(client => client.jobs(entry.projectId, entry.pipelineId));
      if (!this.watchKeys.has(key) || epoch !== this.epoch) return '';
      const snapshot = { project: { id: entry.projectId, path: entry.projectPath, webUrl: entry.projectUrl, defaultBranch: '' }, pipeline, jobs };
      this.snapshots.set(key, snapshot);
      if (isComplete(snapshot) && await this.store.markNotified(key, completionKey(pipeline))) this.notify(snapshot);
      return '';
    } catch (error) { return `${entry.projectPath} #${entry.pipelineId}: ${error.message || 'Ошибка соединения'}`; }
  }

  notify(snapshot) {
    const { project, pipeline } = snapshot;
    const show = pipeline.status === 'failed' ? vscode.window.showErrorMessage : vscode.window.showInformationMessage;
    const text = `Pipeline #${pipeline.id}: ${pipeline.status} — ${project.path} · ${pipeline.ref} · ${formatDuration(runtimeSeconds(pipeline))}`;
    void Promise.resolve(show(text, 'Показать pipeline', 'Открыть в GitLab')).then(choice => {
      if (choice === 'Показать pipeline') this.requested.fire({ project, pipeline });
      if (choice === 'Открыть в GitLab') void openExternal(pipeline.webUrl);
    });
  }

  /** UC4: estimate from comparable successful runs cached for five minutes, with fallback to other branches. */
  async estimate(current, jobs, signal) {
    const signature = jobs?.length ? jobSignature(jobs) : '';
    const key = `${this.epoch}|${current.projectId}|${current.ref}|${current.source}|${signature}`;
    // Serialize history builds so concurrent estimates reuse one download.
    const runs = await (this.historyQueue = this.historyQueue.catch(() => {}).then(() => this.loadHistory(key, current, jobs, signal)));
    return estimate(current, jobs, runs, Date.now());
  }

  async loadHistory(key, current, jobs, signal) {
    const now = Date.now();
    const cached = this.history.get(key);
    if (cached && now - cached.at < HISTORY_TTL_MS) return cached.runs;
    const load = async ref => {
      const parameters = { status: 'success' };
      if (current.source) parameters.source = current.source;
      if (ref) parameters.ref = ref;
      const page = await this.request(client => client.pipelines(current.projectId, parameters), signal);
      return Promise.all(page.items.filter(item => item.id !== current.id).slice(0, 20).map(async item => ({
        pipeline: await this.request(client => client.pipeline(current.projectId, item.id), signal),
        jobs: await this.request(client => client.jobs(current.projectId, item.id), signal)
      })));
    };
    const same = await load(current.ref);
    const signature = jobs?.length ? jobSignature(jobs) : null;
    const valid = same.filter(run => runtimeSeconds(run.pipeline) != null && (signature == null || jobSignature(run.jobs) === signature) &&
      !run.jobs.some(job => job.status === 'manual' && !job.allowFailure)).length;
    let runs = same;
    if (valid < 3) {
      const ids = new Set(same.map(run => run.pipeline.id));
      runs = [...same, ...(await load(null)).filter(run => !ids.has(run.pipeline.id))];
    }
    for (const [name, value] of this.history) if (now - value.at >= HISTORY_TTL_MS) this.history.delete(name);
    if (this.history.size >= 32) this.history.delete(this.history.keys().next().value);
    if (key.startsWith(`${this.epoch}|`)) this.history.set(key, { at: now, runs });
    return runs;
  }

  async dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    await this.ticking?.catch(() => {});
    if (this.leader) await this.store.releaseLease().catch(() => {});
    this.changed.dispose();
    this.requested.dispose();
  }
}

/** UC5: GitLab links open externally only for http(s) URLs. */
async function openExternal(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (!['https:', 'http:'].includes(parsed.protocol)) return false;
  return vscode.env.openExternal(vscode.Uri.parse(parsed.toString()));
}

module.exports = { DashboardService, openExternal, sleep };
