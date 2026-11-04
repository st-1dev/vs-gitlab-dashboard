'use strict';

const vscode = require('vscode');
const crypto = require('node:crypto');
const { GitLabClient, normalizeBaseUrl, projectPath } = require('./gitlab');
const { SharedStore } = require('./store');
const { DashboardService } = require('./service');
const { WorkspaceConfig } = require('./config');
const { ProjectRegistry } = require('./registry');
const { DashboardView, VIEW_TYPE } = require('./view');

let shutdown = null;

/** UC1: verify credentials with GET /user and save them in the workspace JSON file. */
async function configure(config, service) {
  if (config.error) { await config.open(); return false; }
  const current = config.credentials();
  const input = await vscode.window.showInputBox({
    title: 'GitLab Dashboard: адрес сервера', prompt: 'HTTPS-адрес GitLab, например https://gitlab.company.ru; можно с подкаталогом установки',
    value: service.settings().serverUrl || 'https://', ignoreFocusOut: true,
    validateInput: value => { try { normalizeBaseUrl(value); return undefined; } catch (error) { return error.message; } }
  });
  if (input === undefined) return false;
  const url = normalizeBaseUrl(input);
  const existing = current.url && normalizeBaseUrl(current.url) === url ? current.token : '';
  const token = await vscode.window.showInputBox({
    title: 'GitLab Dashboard: Personal Access Token', password: true, ignoreFocusOut: true,
    prompt: existing ? 'PAT со scope api. Оставьте пустым, чтобы сохранить текущий токен этого сервера.' : 'PAT со scope api',
    validateInput: value => (!value.trim() && !existing ? 'Укажите токен' : undefined)
  });
  if (token === undefined) return false;
  try {
    const user = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'GitLab Dashboard: проверяю подключение…' },
      () => new GitLabClient(url, token.trim() || existing).user());
    void vscode.window.showInformationMessage(`GitLab Dashboard: подключено как ${user.name} (@${user.username})`);
  } catch (error) {
    const choice = await vscode.window.showWarningMessage(`Проверка подключения не прошла: ${error.message}`, { modal: true }, 'Сохранить всё равно');
    if (choice !== 'Сохранить всё равно') return false;
  }
  await config.update({ url, token: token.trim() || existing });
  return true;
}

/** UC1: add a favorite by project URL, group/project or a server-side project search. */
async function addProject(service) {
  const { serverUrl, favorites } = service.settings();
  if (!serverUrl) { await vscode.commands.executeCommand('gitlabDashboard.configure'); return false; }
  const input = (await vscode.window.showInputBox({ title: 'Добавить избранный проект', prompt: 'URL проекта, group/project или текст для поиска на GitLab', ignoreFocusOut: true }))?.trim();
  if (!input) return false;
  let path;
  if (input.includes('/')) {
    const wanted = projectPath(input, serverUrl);
    path = (await service.request(client => client.project(wanted))).path;
  } else {
    const page = await service.request(client => client.searchProjects(input));
    if (!page.items.length) { void vscode.window.showInformationMessage('Проекты не найдены'); return false; }
    const pick = await vscode.window.showQuickPick(page.items.map(project => ({ label: project.path, description: project.webUrl, project })), {
      title: 'Добавить избранный проект', placeHolder: page.nextPage ? 'Показаны первые 100 проектов: уточните поиск' : 'Выберите проект', matchOnDescription: true
    });
    if (!pick) return false;
    path = pick.project.path;
  }
  await service.updateSettings({ favorites: [...new Set([...favorites, path])] });
  void vscode.window.showInformationMessage(`Проект ${path} добавлен в избранные`);
  return true;
}

async function activate(context) {
  const config = new WorkspaceConfig();
  await config.init();
  const store = new SharedStore(context.globalStorageUri.fsPath, crypto.randomUUID());
  await store.init();
  const service = new DashboardService(config, store);
  const registry = new ProjectRegistry(service, store);
  const view = new DashboardView(context.extensionUri, service, registry);
  const focus = () => vscode.commands.executeCommand(`${VIEW_TYPE}.focus`);
  const guarded = fn => async (...args) => {
    try { return await fn(...args); } catch (error) { void vscode.window.showErrorMessage(`GitLab Dashboard: ${error.message}`); return undefined; }
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_TYPE, view, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('gitlabDashboard.configure', guarded(async () => {
      await configure(config, service);
    })),
    vscode.commands.registerCommand('gitlabDashboard.addProject', guarded(async () => {
      if (await addProject(service)) void view.refresh({ reset: true, discover: true });
    })),
    vscode.commands.registerCommand('gitlabDashboard.refresh', guarded(async () => { await focus(); await view.refresh({ reset: true, discover: true }); })),
    vscode.commands.registerCommand('gitlabDashboard.runPipeline', guarded(async () => {
      await focus();
      if (!view.projectsLoaded) await view.refresh({ reset: true, discover: true });
      view.openRunForm();
    })),
    vscode.commands.registerCommand('gitlabDashboard.openSettings', guarded(() => config.open())),
    vscode.commands.registerCommand('gitlabDashboard.show', focus),
    config.onDidChange(event => {
      if (event.connectionChanged) { view.resetConnection(); service.resetConnection(); }
      void view.refresh({ reset: true, discover: true });
    }),
    service.onDidRequestPipeline(async row => { await focus(); view.showPipeline(row); }),
    registry.onDidChange(() => { if (view.view?.visible && view.projectsLoaded) void view.refresh({ discover: true }); })
  );
  service.startMonitoring();
  registry.startPublishing();
  shutdown = async () => {
    config.dispose();
    view.dispose();
    await Promise.all([service.dispose(), registry.dispose()]);
  };
  // Internals, including credentials, are exported only to the extension's own tests.
  return context.extensionMode === vscode.ExtensionMode.Test ? { service, registry, view, store, config } : undefined;
}

async function deactivate() {
  const stop = shutdown;
  shutdown = null;
  await stop?.();
}

module.exports = { activate, deactivate };
