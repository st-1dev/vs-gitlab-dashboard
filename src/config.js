'use strict';

const vscode = require('vscode');
const { normalizeBaseUrl } = require('./gitlab');
const { DEFAULT_QUERIES } = require('./filter');

const CONFIG_PATH = '.vscode/gitlab-dashboard.json';
const missing = error => error?.code === 'FileNotFound' || error?.code === 'ENOENT';

function parseConfig(bytes) {
  let value;
  // JSON parser errors may contain the source text, including the token.
  try { value = JSON.parse(Buffer.from(bytes).toString('utf8')); }
  catch { throw new Error(`${CONFIG_PATH}: некорректный JSON`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${CONFIG_PATH}: ожидается объект`);
  for (const key of ['url', 'token']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') throw new Error(`${CONFIG_PATH}: ${key} должен быть строкой`);
  }
  if (value.url?.trim()) normalizeBaseUrl(value.url);
  if (value.favorites !== undefined && (!Array.isArray(value.favorites) || value.favorites.some(item => typeof item !== 'string'))) {
    throw new Error(`${CONFIG_PATH}: favorites должен быть массивом строк`);
  }
  if (value.refreshSeconds !== undefined && (!Number.isInteger(value.refreshSeconds) || value.refreshSeconds < 5 || value.refreshSeconds > 3600)) {
    throw new Error(`${CONFIG_PATH}: refreshSeconds должен быть целым числом от 5 до 3600`);
  }
  if (value.savedQueries !== undefined && (!value.savedQueries || typeof value.savedQueries !== 'object' || Array.isArray(value.savedQueries) || Object.values(value.savedQueries).some(item => typeof item !== 'string'))) {
    throw new Error(`${CONFIG_PATH}: savedQueries должен быть объектом со строковыми значениями`);
  }
  return value;
}

/** The first workspace folder owns this window's configuration, including credentials. */
class WorkspaceConfig {
  constructor() {
    this.value = {};
    this.error = '';
    this.currentUri = '';
    this.pending = Promise.resolve();
    this.changed = new vscode.EventEmitter();
    this.onDidChange = this.changed.event;
    this.subscriptions = [];
  }

  uri() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) throw new Error(`Откройте папку проекта для настройки ${CONFIG_PATH}`);
    return vscode.Uri.joinPath(folder.uri, '.vscode', 'gitlab-dashboard.json');
  }

  enqueue(task) {
    const result = this.pending.then(task);
    this.pending = result.catch(() => {});
    return result;
  }

  async init() {
    const watcher = vscode.workspace.createFileSystemWatcher(`**/${CONFIG_PATH}`);
    const reload = () => { void this.reload(); };
    this.subscriptions.push(watcher, watcher.onDidCreate(reload), watcher.onDidChange(reload), watcher.onDidDelete(reload),
      vscode.workspace.onDidChangeWorkspaceFolders(reload));
    await this.reload();
  }

  async read(uri) {
    try { return parseConfig(await vscode.workspace.fs.readFile(uri)); }
    catch (error) { if (missing(error)) return {}; throw error; }
  }

  apply(value, error, uri) {
    const connectionChanged = this.value.url !== value.url || this.value.token !== value.token || this.error !== error || this.currentUri !== uri;
    const changed = connectionChanged || JSON.stringify(this.value) !== JSON.stringify(value);
    this.value = value;
    this.error = error;
    this.currentUri = uri;
    if (changed) this.changed.fire({ connectionChanged });
  }

  reload() {
    return this.enqueue(async () => {
      let uri;
      try { uri = this.uri(); this.apply(await this.read(uri), '', uri.toString()); }
      catch (error) { this.apply({}, error.message, uri?.toString() || ''); }
    });
  }

  credentials() {
    if (this.error) throw new Error(this.error);
    return { url: (this.value.url || '').trim(), token: (this.value.token || '').trim() };
  }

  settings() {
    return {
      serverUrl: (this.value.url || '').trim(),
      favorites: (this.value.favorites || []).filter(item => item.trim()),
      refreshSeconds: this.value.refreshSeconds ?? 15,
      savedQueries: this.value.savedQueries ?? DEFAULT_QUERIES
    };
  }

  update(patch) {
    return this.enqueue(async () => {
      const uri = this.uri();
      const value = { ...await this.read(uri), ...patch };
      const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
      parseConfig(bytes);
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
      await vscode.workspace.fs.writeFile(uri, bytes);
      this.apply(value, '', uri.toString());
    });
  }

  async open() {
    const uri = this.uri();
    try { await vscode.workspace.fs.stat(uri); }
    catch (error) {
      if (!missing(error)) throw error;
      await this.update({ url: '', token: '' });
    }
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  }

  dispose() {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.changed.dispose();
  }
}

module.exports = { WorkspaceConfig, CONFIG_PATH, parseConfig };
