'use strict';

const vscode = require('vscode');
const crypto = require('node:crypto');
const { PipelineFilter, DEFAULT_QUERIES } = require('./filter');
const { isAbort, VARIABLE_KEY, normalizeBaseUrl } = require('./gitlab');
const { PIPELINE_STATUSES, TERMINAL_STATUSES, isComplete, sortJobs, formatDuration, formatTime, runtimeSeconds, queueSeconds } = require('./models');
const { openExternal, sleep } = require('./service');
const { stripAnsi } = require('../media/shared');
const { watchKey } = require('./store');

const rowKey = (project, pipeline) => `${project.id}:${pipeline.id}`;
const VIEW_TYPE = 'gitlabDashboard.view';

/** UC6: per-window panel state; the webview only renders it and sends typed user actions. */
class DashboardView {
  constructor(extensionUri, service, registry) {
    this.extensionUri = extensionUri;
    this.service = service;
    this.registry = registry;
    this.view = null;
    this.query = 'after:7d';
    this.queryVersion = 1;
    this.filter = PipelineFilter.parse(this.query);
    this.queryTime = Date.now();
    this.username = '';
    this.projects = { projects: [], currentBranches: new Map(), errors: [] };
    this.projectsLoaded = false;
    this.lastDiscover = 0;
    this.rows = new Map();
    this.pages = new Map();
    this.status = 'Настройте GitLab и откройте рабочие проекты.';
    this.loading = false;
    this.watchedOnly = false;
    this.selectedKey = null;
    this.snapshot = null;
    this.detailsText = '';
    this.eta = '';
    this.jobs = [];
    this.selectedJobId = null;
    this.log = null;
    this.filterForm = null;
    this.runForm = null;
    this.refreshAbort = null;
    this.detailsAbort = null;
    this.traceAbort = null;
    this.formAbort = null;
    this.timer = null;
    this.renderPending = false;
    this.disposables = [];
    this.disposables.push(service.onDidChange(() => this.render()));
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [media] };
    webviewView.webview.html = this.html(webviewView.webview, media);
    const subscriptions = [
      webviewView.webview.onDidReceiveMessage(message => this.handle(message).catch(error => { this.status = error.message; this.render(); })),
      webviewView.onDidChangeVisibility(() => { if (webviewView.visible) void this.tick(); })
    ];
    webviewView.onDidDispose(() => {
      subscriptions.forEach(item => item.dispose());
      if (this.view === webviewView) this.view = null;
      clearTimeout(this.timer);
      this.timer = null;
      for (const controller of [this.refreshAbort, this.detailsAbort, this.traceAbort, this.formAbort]) controller?.abort();
    });
    this.schedule();
    if (this.service.settings().serverUrl && !this.projectsLoaded) void this.refresh({ reset: true, discover: true });
  }

  html(webview, media) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = name => webview.asWebviewUri(vscode.Uri.joinPath(media, name));
    return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('main.css')}"><title>GitLab Dashboard</title></head>
<body><script nonce="${nonce}" src="${uri('shared.js')}"></script><script nonce="${nonce}" src="${uri('main.js')}"></script></body></html>`;
  }

  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => { await this.tick(); if (this.view) this.schedule(); }, this.service.settings().refreshSeconds * 1000);
  }

  /** UC2: while the panel is visible, refresh the list, rescan projects once a minute and reload the selected details. */
  async tick() {
    if (!this.view?.visible || !this.service.settings().serverUrl) return;
    if (!this.refreshAbort) void this.refresh({ discover: Date.now() - this.lastDiscover > 60_000 });
    const row = this.selectedRow();
    if (!this.detailsAbort && row) void this.loadDetails(row);
  }

  post(message) { if (this.view) void this.view.webview.postMessage(message); }

  resetConnection() {
    for (const controller of [this.refreshAbort, this.detailsAbort, this.traceAbort, this.formAbort]) controller?.abort();
    this.refreshAbort = this.detailsAbort = this.traceAbort = this.formAbort = null;
    this.projects = { projects: [], currentBranches: new Map(), errors: [] };
    this.projectsLoaded = false;
    this.rows.clear();
    this.pages.clear();
    this.selectedKey = this.selectedJobId = this.snapshot = this.log = null;
    this.jobs = [];
    this.detailsText = this.eta = this.username = '';
    this.runForm = this.filterForm = null;
    this.loading = false;
    this.post({ type: 'log', log: null });
    this.render();
  }

  render() {
    if (this.renderPending) return;
    this.renderPending = true;
    setImmediate(() => { this.renderPending = false; this.post({ type: 'state', state: this.state() }); });
  }

  state() {
    const { serverUrl, savedQueries } = this.service.settings();
    const server = this.server();
    const selected = this.selectedRow();
    const watched = this.service.watchKeys.size;
    return {
      configured: Boolean(serverUrl),
      query: this.query, queryVersion: this.queryVersion,
      presets: Object.keys(savedQueries),
      status: this.status, loading: this.loading, canLoadMore: this.pages.size > 0,
      monitorStatus: this.service.monitorError ? `Мониторинг: ${this.service.monitorError}` : `Отслеживаемых pipeline: ${watched}`,
      watchedOnly: this.watchedOnly,
      rows: this.visibleRows(server).map(({ project, pipeline }) => {
        const key = rowKey(project, pipeline);
        return { key, project: project.path, id: pipeline.id, status: pipeline.status, ref: pipeline.ref, sha: pipeline.sha.slice(0, 8), source: pipeline.source,
          created: formatTime(pipeline.createdAt), createdAt: pipeline.createdAt ?? 0, watched: this.service.isWatched(this.watchKey({ project, pipeline }, server)) };
      }),
      selectedKey: selected ? this.selectedKey : null,
      selectedWatched: selected ? this.service.isWatched(this.watchKey(selected, server)) : false,
      details: this.detailsText, eta: this.eta,
      jobs: this.jobs.map(job => ({ id: job.id, name: job.name, stage: job.stage, status: job.status, isTrigger: job.isTrigger, allowFailure: job.allowFailure })),
      selectedJobId: this.selectedJobId,
      filterForm: this.filterForm, runForm: this.runForm && { ...this.runForm, projects: this.projects.projects.map(p => ({ id: p.id, path: p.path })) },
      completion: { statuses: [...PIPELINE_STATUSES].sort(), projects: this.projects.projects.map(p => p.path), branches: [...new Set(this.projects.currentBranches.values())] }
    };
  }

  postLog() { this.post({ type: 'log', log: this.log && { key: this.log.key, jobName: this.log.jobName, text: this.log.text, truncated: this.log.truncated, notice: this.log.notice, error: this.log.error, loading: this.log.loading } }); }

  server() { try { return normalizeBaseUrl(this.service.settings().serverUrl); } catch { return ''; } }

  watchKey(row, server = this.server()) { return server ? watchKey({ serverUrl: server, projectId: row.project.id, pipelineId: row.pipeline.id }) : ''; }

  visibleRows(server = this.server()) {
    const combined = new Map();
    for (const snapshot of this.service.snapshots.values()) combined.set(rowKey(snapshot.project, snapshot.pipeline), { project: snapshot.project, pipeline: snapshot.pipeline });
    for (const [key, row] of this.rows) if (!combined.has(key)) combined.set(key, row);
    const rows = [...combined.values()].filter(row => (this.watchedOnly
      ? this.service.isWatched(this.watchKey(row, server))
      : this.filter.matches(row, this.queryTime, this.projects.currentBranches.get(row.project.id), this.username))).sort((a, b) => b.pipeline.id - a.pipeline.id);
    if (!this.filter.latest || this.watchedOnly) return rows;
    const seen = new Set();
    return rows.filter(row => { const key = `${row.project.id}\u0000${row.pipeline.ref}`; if (seen.has(key)) return false; seen.add(key); return true; });
  }

  selectedRow() {
    if (!this.selectedKey) return null;
    for (const snapshot of this.service.snapshots.values()) if (rowKey(snapshot.project, snapshot.pipeline) === this.selectedKey) return { project: snapshot.project, pipeline: snapshot.pipeline };
    return this.rows.get(this.selectedKey) ?? null;
  }

  /** UC2: paginate a stable creation-time snapshot, expose completeness and discard cancelled query results. */
  async refresh({ reset = false, append = false, discover = false } = {}) {
    if (!this.service.settings().serverUrl) { this.status = this.service.config?.error || 'Укажите url и token в .vscode/gitlab-dashboard.json или выполните «GitLab Dashboard: Настроить подключение»'; this.render(); return; }
    let parsed = this.filter;
    if (reset) {
      try { parsed = PipelineFilter.parse(this.query); } catch (error) { this.status = error.message; this.render(); return; }
    }
    this.refreshAbort?.abort();
    const controller = new AbortController(), signal = controller.signal;
    this.refreshAbort = controller;
    this.loading = true;
    this.status = 'Загружаю pipeline…';
    this.render();
    try {
      if (discover || !this.projectsLoaded) {
        this.projects = await this.registry.discover(signal);
        this.projectsLoaded = true;
        this.lastDiscover = Date.now();
      }
      const username = parsed.user === 'me' ? (await this.service.user(signal)).username : parsed.user;
      if (signal.aborted) return;
      if (reset) { this.filter = parsed; this.queryTime = Date.now(); this.pages.clear(); this.rows.clear(); }
      this.username = username;
      const now = reset || append ? this.queryTime : Date.now();
      const candidates = this.projects.projects.filter(project => parsed.acceptsProject(project));
      const results = await Promise.all(candidates.map(async project => {
        const number = append ? this.pages.get(project.id) : 1;
        if (number == null) return { project };
        try {
          const parameters = parsed.serverParameters(now, username, this.projects.currentBranches.get(project.id));
          parameters.created_before ??= new Date(now).toISOString();
          return { project, page: await this.service.request(client => client.pipelines(project.id, parameters, number), signal) };
        } catch (error) {
          if (isAbort(error)) throw error;
          return { project, error: `${project.path}: ${error.message}` };
        }
      }));
      if (signal.aborted) return;
      if (reset || append) {
        for (const { project, page, error } of results) {
          if (error) { if (reset) this.pages.set(project.id, 1); } else if (page) { if (page.nextPage == null) this.pages.delete(project.id); else this.pages.set(project.id, page.nextPage); }
        }
      }
      for (const { project, page } of results) for (const pipeline of page?.items ?? []) this.rows.set(rowKey(project, pipeline), { project, pipeline });
      const errors = [...this.projects.errors, ...results.map(result => result.error).filter(Boolean)].join('; ');
      const complete = this.pages.size === 0 && !errors;
      this.status = `Найдено ${this.visibleRows().length}; просмотрено ${this.rows.size} · ${complete ? 'История за период загружена' : 'История неполная — доступны дополнительные страницы / повтор загрузки'}${errors ? ` · ${errors}` : ''}`;
      if (!this.projects.projects.length) this.status = `Нет проектов: откройте GitLab-репозиторий или добавьте избранный проект${errors ? ` · ${errors}` : ''}`;
    } catch (error) {
      if (!isAbort(error)) this.status = error.message || 'Ошибка загрузки';
    } finally {
      if (this.refreshAbort === controller) { this.refreshAbort = null; this.loading = false; }
      this.render();
    }
  }

  stop() {
    if (!this.refreshAbort) return;
    this.refreshAbort.abort();
    this.refreshAbort = null;
    this.loading = false;
    this.status = 'Загрузка остановлена; результаты могут быть неполными';
    this.render();
  }

  /** UC4/UC5: load the selected pipeline jobs and empirical ETA without allowing stale selection output. */
  async loadDetails(row) {
    const key = rowKey(row.project, row.pipeline);
    this.detailsAbort?.abort();
    const controller = new AbortController(), signal = controller.signal;
    this.detailsAbort = controller;
    if (this.snapshot && rowKey(this.snapshot.project, this.snapshot.pipeline) !== key) this.snapshot = null;
    if (!this.snapshot) {
      this.traceAbort?.abort();
      this.jobs = [];
      this.selectedJobId = null;
      this.log = null;
      this.postLog();
      this.detailsText = `Загружаю ${row.project.path} #${row.pipeline.id}…`;
      this.eta = 'Загружаю прогноз…';
    }
    this.render();
    try {
      const pipeline = await this.service.request(client => client.pipeline(row.project.id, row.pipeline.id), signal);
      const jobs = await this.service.request(client => client.jobs(row.project.id, pipeline.id), signal);
      if (signal.aborted) return;
      const snapshot = { project: row.project, pipeline, jobs };
      this.snapshot = snapshot;
      if (this.rows.has(key)) this.rows.set(key, { project: row.project, pipeline });
      this.detailsText = [
        `${row.project.path} · #${pipeline.id} · ${pipeline.ref} · ${pipeline.status}`,
        `SHA ${pipeline.sha || '—'} · источник ${pipeline.source || '—'} · @${pipeline.user?.username ?? '—'}${pipeline.name ? ` · ${pipeline.name}` : ''}`,
        `Создан ${formatTime(pipeline.createdAt)} · начало ${formatTime(pipeline.startedAt)} · конец ${formatTime(pipeline.finishedAt)} · длительность ${formatDuration(runtimeSeconds(pipeline))}`,
        `Jobs: ${jobs.length}; ошибок: ${jobs.filter(job => job.status === 'failed').length}`
      ].join('\n');
      this.jobs = sortJobs(jobs);
      const target = this.jobs.find(job => job.id === this.selectedJobId) ?? this.jobs.find(job => job.status === 'failed') ?? this.jobs[0];
      this.selectedJobId = target?.id ?? null;
      if (target) void this.loadTrace(target);
      if (isComplete(snapshot)) this.eta = `Прогон завершён. Фактически: ${formatDuration(runtimeSeconds(pipeline))}; очередь: ${formatDuration(queueSeconds(pipeline))}`;
      else {
        this.render();
        this.eta = formatEstimate(await this.service.estimate(pipeline, jobs, signal));
      }
    } catch (error) {
      if (isAbort(error) || signal.aborted) return;
      if (!this.snapshot) this.detailsText = error.message || 'Ошибка загрузки pipeline';
      this.eta = `Прогноз недоступен: ${error.message || 'Ошибка загрузки'}`;
    } finally {
      if (this.detailsAbort === controller) this.detailsAbort = null;
      this.render();
    }
  }

  /** UC5: show a bounded trace and refresh it only while its job is active and the panel is visible. */
  async loadTrace(job, force = false) {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    const key = `${snapshot.project.id}:${job.id}`;
    // An active loop re-reads the job status itself; a final trace is reloaded only after a status change.
    if (!force && this.log?.key === key && (this.log.polling || (this.log.final && this.log.finalStatus === job.status))) return;
    this.traceAbort?.abort();
    if (job.isTrigger) {
      this.log = { key, jobName: job.name, text: '', final: true, notice: 'Trigger job запускает другой pipeline. Её состояние входит в текущий прогон; детали доступны по кнопке «Открыть job в GitLab».' };
      this.postLog();
      return;
    }
    const controller = new AbortController(), signal = controller.signal;
    this.traceAbort = controller;
    if (this.log?.key !== key) this.log = { key, jobName: job.name, text: '', truncated: false, loading: true };
    this.log.polling = true;
    this.postLog();
    const status = () => (this.jobs.find(item => item.id === job.id) ?? job).status;
    try {
      while (!signal.aborted) {
        if (!this.view?.visible) { await sleep(1000, signal); continue; }
        const before = status();
        const trace = await this.service.request(client => client.trace(snapshot.project.id, job.id), signal);
        if (signal.aborted) return;
        const final = TERMINAL_STATUSES.has(before) || before === 'manual';
        const changed = trace.text !== this.log.text || this.log.loading || this.log.error;
        this.log = { ...this.log, text: trace.text, truncated: trace.truncated, loading: false, error: '', final, finalStatus: before };
        if (changed) this.postLog();
        if (final) break;
        await sleep(this.service.settings().refreshSeconds * 1000, signal);
      }
    } catch (error) {
      if (isAbort(error) || signal.aborted) return;
      this.log = { ...this.log, loading: false, error: error.message, final: false };
      this.postLog();
    } finally {
      if (this.traceAbort === controller) { this.traceAbort = null; if (this.log?.key === key) this.log.polling = false; }
    }
  }

  /** UC3: show a created or notified pipeline among watched pipelines and open its details. */
  showPipeline(row) {
    this.rows.set(rowKey(row.project, row.pipeline), row);
    this.watchedOnly = true;
    this.select(rowKey(row.project, row.pipeline));
  }

  select(key) {
    if (key === this.selectedKey && this.snapshot) return;
    this.selectedKey = key;
    const row = this.selectedRow();
    if (row) void this.loadDetails(row); else this.render();
  }

  /** UC6: user actions from the webview; identifiers are resolved against this controller's state. */
  async handle(message) {
    const type = message?.type;
    const text = value => (typeof value === 'string' ? value : '');
    const id = value => (Number.isSafeInteger(value) && value > 0 ? value : null);
    switch (type) {
      case 'ready': this.render(); this.postLog(); break;
      case 'search': this.query = text(message.query).trim(); void this.refresh({ reset: true }); break;
      case 'loadMore': void this.refresh({ append: true }); break;
      case 'stop': this.stop(); break;
      case 'refreshProjects': void this.refresh({ reset: true, discover: true }); break;
      case 'selectPipeline': this.select(text(message.key)); break;
      case 'selectJob': {
        const job = this.jobs.find(item => item.id === id(message.jobId));
        if (job) { this.selectedJobId = job.id; this.render(); void this.loadTrace(job); }
        break;
      }
      case 'refreshLog': {
        const job = this.jobs.find(item => item.id === this.selectedJobId);
        if (job) void this.loadTrace(job, true);
        break;
      }
      case 'watchedOnly': this.watchedOnly = message.value === true; this.render(); break;
      case 'toggleWatch': {
        const row = this.selectedRow();
        if (!row) break;
        const key = this.watchKey(row);
        if (this.service.isWatched(key)) await this.service.unwatch(key); else await this.service.watch(row.project, row.pipeline.id);
        this.render();
        break;
      }
      case 'openPipeline': { const row = this.selectedRow(); if (row) await openExternal(row.pipeline.webUrl); break; }
      case 'openJob': {
        const job = this.jobs.find(item => item.id === this.selectedJobId);
        if (job?.webUrl) await openExternal(job.webUrl);
        else if (job && this.snapshot) await openExternal(`${this.snapshot.project.webUrl}/-/jobs/${job.id}`);
        break;
      }
      case 'copyLog': if (this.log?.text) { await vscode.env.clipboard.writeText(stripAnsi(this.log.text)); void vscode.window.showInformationMessage('Лог скопирован'); } break;
      case 'openLog': if (this.log?.text) {
        const document = await vscode.workspace.openTextDocument({ content: stripAnsi(this.log.text), language: 'log' });
        await vscode.window.showTextDocument(document, { preview: true });
      } break;
      case 'applyPreset': {
        const query = this.service.settings().savedQueries[text(message.name)];
        if (typeof query === 'string') { this.setQuery(query); void this.refresh({ reset: true }); }
        break;
      }
      case 'savePreset': await this.savePreset(text(message.query)); break;
      case 'deletePreset': await this.deletePreset(text(message.name)); break;
      case 'addProject': await vscode.commands.executeCommand('gitlabDashboard.addProject'); break;
      case 'configure': await vscode.commands.executeCommand('gitlabDashboard.configure'); break;
      case 'openSettings': await vscode.commands.executeCommand('workbench.action.openSettings', 'gitlabDashboard'); break;
      case 'openFilterForm': this.openFilterForm(text(message.query)); break;
      case 'applyFilter': this.applyFilter(message.fields || {}); break;
      case 'closeForm': this.formAbort?.abort(); if (!this.runForm?.submitting) this.runForm = null; this.filterForm = null; this.render(); break;
      case 'openRunForm': this.openRunForm(); break;
      case 'runProject': this.setRunProject(id(message.projectId)); break;
      case 'findBranches': await this.findBranches(id(message.projectId), text(message.search)); break;
      case 'forecast': await this.forecast(id(message.projectId), text(message.branch)); break;
      case 'submitRun': await this.submitRun(id(message.projectId), text(message.branch), Array.isArray(message.variables) ? message.variables : []); break;
      default: break;
    }
  }

  setQuery(query) { this.query = query; this.queryVersion++; this.render(); }

  async savePreset(query) {
    try { PipelineFilter.parse(query); } catch (error) { this.status = error.message; this.render(); return; }
    const name = (await vscode.window.showInputBox({ title: 'Сохранить фильтр', prompt: 'Название сохранённого фильтра', value: '', ignoreFocusOut: true }))?.trim();
    if (!name) return;
    const saved = { ...this.service.settings().savedQueries, [name]: query.trim() };
    await this.service.updateSettings({ savedQueries: saved });
    this.render();
  }

  async deletePreset(name) {
    const saved = { ...this.service.settings().savedQueries };
    if (!(name in saved)) return;
    delete saved[name];
    await this.service.updateSettings({ savedQueries: saved });
    this.render();
  }

  openFilterForm(query) {
    let filter;
    try { filter = PipelineFilter.parse(query); } catch (error) { this.status = error.message; this.render(); return; }
    this.runForm = null;
    this.filterForm = { fields: { ...filter, id: filter.id == null ? '' : String(filter.id) }, error: '' };
    this.render();
  }

  /** UC2: the filter form and the query line share one validated filter model. */
  applyFilter(fields) {
    const list = value => (typeof value === 'string' ? value.split(',').map(item => item.trim()).filter(Boolean) : []);
    const text = value => (typeof value === 'string' ? value.trim() : '');
    try {
      const idText = text(fields.id);
      if (idText && !/^[1-9][0-9]*$/.test(idText)) throw new Error('ID должен быть положительным числом');
      const candidate = new PipelineFilter({ projects: list(fields.projects), branches: list(fields.branches),
        statuses: Array.isArray(fields.statuses) ? fields.statuses.filter(status => typeof status === 'string') : [],
        user: text(fields.user), sha: text(fields.sha), id: idText ? Number(idText) : null, name: text(fields.name), source: text(fields.source),
        after: text(fields.after), before: text(fields.before), latest: fields.latest === true, text: text(fields.text) });
      const query = PipelineFilter.parse(candidate.query()).query();
      this.filterForm = null;
      this.setQuery(query);
      void this.refresh({ reset: true });
    } catch (error) {
      this.filterForm = { ...this.filterForm, error: error.message };
      this.render();
    }
  }

  openRunForm() {
    if (!this.projects.projects.length) { this.status = 'Добавьте проект или откройте GitLab-репозиторий'; this.render(); return; }
    this.filterForm = null;
    const project = this.selectedRow()?.project ?? this.projects.projects[0];
    this.runForm = { projectId: null, branch: '', branchVersion: 0, branches: [], branchesMore: false, forecast: '', forecastTitle: '', error: '', submitting: false };
    this.setRunProject(this.projects.projects.some(p => p.id === project.id) ? project.id : this.projects.projects[0].id);
  }

  setRunProject(projectId) {
    const project = this.projects.projects.find(p => p.id === projectId);
    if (!this.runForm || !project || this.runForm.submitting) return;
    const branch = this.projects.currentBranches.get(project.id) ?? project.defaultBranch;
    this.runForm = { ...this.runForm, projectId: project.id, branch, branchVersion: this.runForm.branchVersion + 1, branches: [], branchesMore: false, error: '' };
    void this.forecast(project.id, branch);
  }

  async findBranches(projectId, search) {
    const project = this.projects.projects.find(p => p.id === projectId);
    if (!this.runForm || !project) return;
    this.formAbort?.abort();
    const controller = new AbortController();
    this.formAbort = controller;
    try {
      const page = await this.service.request(client => client.branches(project.id, search.trim()), controller.signal);
      if (!this.runForm || controller.signal.aborted) return;
      this.runForm = { ...this.runForm, branches: page.items, branchesMore: page.nextPage != null, error: page.items.length ? '' : 'Ветки не найдены; измените поисковую строку' };
    } catch (error) {
      if (!isAbort(error) && this.runForm) this.runForm = { ...this.runForm, error: error.message };
    } finally { if (this.formAbort === controller) this.formAbort = null; this.render(); }
  }

  /** UC4: forecast in the run form from the latest successful runs of the selected branch. */
  async forecast(projectId, branch) {
    const project = this.projects.projects.find(p => p.id === projectId);
    if (!this.runForm || !project || !branch.trim()) return;
    this.formAbort?.abort();
    const controller = new AbortController();
    this.formAbort = controller;
    this.runForm = { ...this.runForm, forecast: 'Загружаю историю успешных запусков…', forecastTitle: '' };
    this.render();
    try {
      const now = Date.now();
      const result = await this.service.estimate({ id: -1, projectId: project.id, ref: branch.trim(), status: 'created', source: 'api', createdAt: now, startedAt: null, finishedAt: null }, null, controller.signal);
      if (!this.runForm || controller.signal.aborted) return;
      this.runForm = { ...this.runForm,
        forecast: `Обычно ${formatDuration(result.runtime?.median)} · очередь ${formatDuration(result.queue?.median)} · ${result.samples} запусков${result.fallback ? ' проекта, включая другие ветки' : ' этой ветки'} (предварительно)`,
        forecastTitle: `${result.message}; диапазон ${formatDuration(result.runtime?.lower)}–${formatDuration(result.runtime?.upper)}` };
    } catch (error) {
      if (!isAbort(error) && this.runForm) this.runForm = { ...this.runForm, forecast: `Прогноз недоступен: ${error.message}` };
    } finally { if (this.formAbort === controller) this.formAbort = null; this.render(); }
  }

  /** UC3: validate the run form, create the pipeline once and watch it automatically. */
  async submitRun(projectId, branch, rawVariables) {
    const project = this.projects.projects.find(p => p.id === projectId);
    if (!this.runForm || this.runForm.submitting || !project) return;
    const ref = branch.trim();
    const fail = error => { this.runForm = { ...this.runForm, submitting: false, error }; this.render(); };
    if (!ref) { fail('Выберите ветку'); return; }
    const variables = [];
    for (const item of rawVariables) {
      const key = typeof item?.key === 'string' ? item.key.trim() : '';
      const value = typeof item?.value === 'string' ? item.value : '';
      if (!key && !value) continue;
      if (!VARIABLE_KEY.test(key) || variables.some(variable => variable.key === key)) { fail('Ключи variables должны быть корректными и уникальными'); return; }
      variables.push({ key, value });
    }
    this.formAbort?.abort();
    this.runForm = { ...this.runForm, submitting: true, error: '' };
    this.render();
    try {
      // Resolve the server branch first; creating a pipeline never pushes local changes.
      await this.service.request(client => client.branch(project.id, ref));
      const pipeline = await this.service.request(client => client.createPipeline(project.id, ref, variables));
      this.runForm = null;
      try { await this.service.watch(project, pipeline.id); } catch (error) { this.status = `Pipeline #${pipeline.id} запущен, но отслеживание не включено: ${error.message}`; }
      this.showPipeline({ project, pipeline });
      void vscode.window.showInformationMessage(`Pipeline #${pipeline.id} запущен: ${project.path} · ${ref}`);
    } catch (error) {
      if (this.runForm) fail(error.message || 'Ошибка запуска');
      else { this.status = error.message; this.render(); }
    }
  }

  dispose() {
    clearTimeout(this.timer);
    for (const controller of [this.refreshAbort, this.detailsAbort, this.traceAbort, this.formAbort]) controller?.abort();
    this.disposables.forEach(item => item.dispose());
  }
}

function formatEstimate(estimate) {
  return [
    estimate.message,
    `Обычно ${formatDuration(estimate.runtime?.median)} (${formatDuration(estimate.runtime?.lower)}–${formatDuration(estimate.runtime?.upper)}); очередь ${formatDuration(estimate.queue?.median)}`,
    `Осталось ${formatDuration(estimate.remaining?.median)}; завершение ≈ ${formatTime(estimate.finishAt)}`,
    `${estimate.samples} запусков ${estimate.fallback ? 'проекта, включая другие ветки' : 'этой ветки'}${estimate.provisional ? '; предварительная оценка' : ''}`
  ].join('\n');
}

module.exports = { DashboardView, VIEW_TYPE, DEFAULT_QUERIES };
