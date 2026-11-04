'use strict';

const http = require('node:http');
const https = require('node:https');

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const TRACE_TAIL_CHARS = 2 * 1024 * 1024;
const VARIABLE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

class GitLabError extends Error {
  constructor(status, message, retryAfterSeconds = null) {
    super(message);
    this.name = 'GitLabError';
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

class UncertainPipelineCreation extends Error {
  constructor(cause) {
    super('GitLab мог принять запуск, но ответ не получен. Обновите историю перед повторным запуском.', { cause });
    this.name = 'UncertainPipelineCreation';
  }
}

const cancelled = () => Object.assign(new Error('Запрос отменён'), { name: 'AbortError' });
const isAbort = error => error?.name === 'AbortError';
const encode = value => encodeURIComponent(String(value));

class GitLabClient {
  constructor(baseUrl, token) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.token = token;
    this.signal = undefined;
  }

  /** The same client whose requests are cancelled by `signal`. */
  withSignal(signal) {
    const bound = Object.create(this);
    bound.signal = signal;
    return bound;
  }

  async user() { return parseUser(await this.json('GET', 'user')); }
  async project(path) { return parseProject(await this.json('GET', `projects/${encode(path)}`)); }
  searchProjects(search, page = 1) { return this.page('projects', { search, simple: 'true' }, page, parseProject); }
  branches(projectId, search, page = 1) { return this.page(`projects/${projectId}/repository/branches`, { search }, page, o => required(o, 'name')); }
  async branch(projectId, ref) { return required(await this.json('GET', `projects/${projectId}/repository/branches/${encode(ref)}`), 'name'); }

  pipelines(projectId, parameters = {}, page = 1) {
    return this.page(`projects/${projectId}/pipelines`, { ...parameters, order_by: 'id', sort: 'desc' }, page, o => parsePipeline(o, projectId));
  }

  async pipeline(projectId, id) { return parsePipeline(await this.json('GET', `projects/${projectId}/pipelines/${id}`), projectId); }

  /** UC3: create exactly once; a transport failure or 5xx is an uncertain outcome, never an automatic POST retry. */
  async createPipeline(projectId, ref, variables) {
    if (!String(ref).trim()) throw new Error('Выберите серверную ветку');
    const keys = new Set();
    for (const { key } of variables) {
      if (!VARIABLE_KEY.test(key) || keys.has(key)) throw new Error('Ключи CI/CD variables должны быть корректными и уникальными');
      keys.add(key);
    }
    const body = JSON.stringify({ ref, variables: variables.map(({ key, value }) => ({ key, value: String(value), variable_type: 'env_var' })) });
    try {
      return parsePipeline(await this.json('POST', `projects/${projectId}/pipeline`, {}, body), projectId);
    } catch (error) {
      if (error instanceof GitLabError && error.status < 500) throw error;
      throw new UncertainPipelineCreation(error);
    }
  }

  /** UC3/UC5: fetch every jobs and bridges page before making completion or job-shape decisions. */
  async jobs(projectId, pipelineId) {
    const jobs = [];
    for (const route of ['jobs', 'bridges']) {
      const visited = new Set();
      for (let next = 1; next != null;) {
        if (visited.has(next)) throw new Error('GitLab вернул повторяющуюся страницу jobs');
        visited.add(next);
        const page = await this.page(`projects/${projectId}/pipelines/${pipelineId}/${route}`, {}, next, parseJob);
        jobs.push(...page.items.map(job => ({ ...job, isTrigger: route === 'bridges' })));
        next = page.nextPage;
      }
    }
    return jobs;
  }

  /** UC5: stream the trace into a bounded tail so large logs do not exhaust extension host memory. */
  async trace(projectId, jobId, tailLimit = TRACE_TAIL_CHARS) {
    const response = await this.send('GET', `projects/${projectId}/jobs/${jobId}/trace`, {});
    checkResponse(response);
    let tail = '', truncated = false;
    await consume(response, chunk => {
      tail += chunk;
      if (tail.length > tailLimit * 2) { tail = tail.slice(-tailLimit); truncated = true; }
    }, 'utf8');
    if (tail.length > tailLimit) { tail = tail.slice(-tailLimit); truncated = true; }
    if (truncated && /^[\udc00-\udfff]/.test(tail)) tail = tail.slice(1);
    return { text: tail, truncated };
  }

  async page(path, parameters, number, parse) {
    if (!(number > 0)) throw new Error('Некорректная страница');
    const response = await this.send('GET', path, { ...parameters, page: number, per_page: 100 });
    const array = JSON.parse(await readBody(response));
    if (!Array.isArray(array)) throw new Error('GitLab вернул некорректный список');
    const header = response.headers['x-next-page'];
    const next = header !== undefined ? (/^\d+$/.test(header) ? Number(header) : null) : array.length === 100 ? number + 1 : null;
    if (next != null && next <= number) throw new Error('Некорректная пагинация GitLab');
    return { items: array.map(parse), nextPage: next };
  }

  async json(method, path, parameters = {}, body) {
    return JSON.parse(await readBody(await this.send(method, path, parameters, body)));
  }

  send(method, path, parameters, body) {
    const query = Object.entries(parameters).map(([key, value]) => `${encode(key)}=${encode(value)}`).join('&');
    const url = new URL(`${this.baseUrl}/api/v4/${path}${query ? `?${query}` : ''}`);
    const signal = this.signal;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(cancelled()); return; }
      const headers = { 'PRIVATE-TOKEN': this.token, Accept: 'application/json', 'User-Agent': 'GitLab-Dashboard-VSCode/0.1' };
      if (body != null) Object.assign(headers, { 'Content-Type': 'application/json; charset=UTF-8', 'Content-Length': Buffer.byteLength(body) });
      // Redirects are never followed, so the PAT cannot be forwarded to another host.
      const request = (url.protocol === 'https:' ? https : http).request(url, { method, headers, signal, timeout: 30_000 }, resolve);
      request.on('timeout', () => request.destroy(new Error('GitLab не ответил за 30 секунд')));
      request.on('error', error => reject(signal?.aborted ? cancelled() : error));
      request.end(body);
    });
  }
}

/** Reads a JSON response with the 8 MiB limit after validating the HTTP status. */
async function readBody(response) {
  checkResponse(response);
  const chunks = [];
  let size = 0;
  await consume(response, chunk => {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) throw new Error('Ответ GitLab слишком большой');
    chunks.push(chunk);
  });
  return Buffer.concat(chunks).toString('utf8');
}

function consume(response, onChunk, encoding) {
  if (encoding) response.setEncoding(encoding);
  return new Promise((resolve, reject) => {
    let done = false;
    const fail = error => { if (!done) { done = true; response.destroy(); reject(error); } };
    response.on('data', chunk => { try { onChunk(chunk); } catch (error) { fail(error); } });
    response.on('end', () => { if (!done) { done = true; resolve(); } });
    response.on('error', error => fail(isAbort(error) ? cancelled() : error));
    response.on('aborted', () => fail(new Error('Соединение с GitLab прервано')));
    response.on('close', () => { if (!response.complete) fail(cancelled()); });
  });
}

function checkResponse(response) {
  const status = response.statusCode;
  if (status >= 200 && status <= 299) return;
  response.resume();
  const header = response.headers['retry-after'];
  let retry = null;
  if (header != null) retry = /^\d+$/.test(header) ? Number(header) : Math.ceil((Date.parse(header) - Date.now()) / 1000);
  if (!Number.isFinite(retry)) retry = null;
  // Error bodies may echo CI variable values: use actionable status messages instead.
  const message = status === 400 || status === 422 ? `GitLab отклонил запрос: проверьте ветку, variables и CI rules (${status})`
    : status === 401 ? 'Токен GitLab недействителен или истёк (401)'
      : status === 403 ? 'Нет прав для операции; проверьте роль и scope api (403)'
        : status === 404 ? 'Проект, pipeline, job или лог недоступен (404)'
          : status === 429 ? `Лимит запросов GitLab; повтор через ${retry ?? 60} с (429)`
            : status >= 300 && status <= 399 ? `GitLab перенаправил запрос; проверьте адрес сервера (${status})`
              : `Ошибка GitLab HTTP ${status}`;
  throw new GitLabError(status, message, status === 429 ? Math.min(3600, Math.max(1, retry ?? 60)) : null);
}

/** UC1: accept only an HTTPS server URL without credentials, query or fragment; plain HTTP is for loopback tests. */
function normalizeBaseUrl(value) {
  const raw = String(value ?? '').trim().replace(/\/+$/, '');
  let url;
  try { url = new URL(raw); } catch { throw new Error('Некорректный URL GitLab'); }
  if (!url.hostname || url.username || url.password || raw.includes('?') || raw.includes('#')) throw new Error('Укажите URL сервера без логина, query и fragment');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) throw new Error('Для GitLab требуется HTTPS');
  return (url.origin + url.pathname).replace(/\/+$/, '');
}

/** UC1: `group/project`, a project URL or a project page URL of the configured server. */
function projectPath(value, baseUrl) {
  const input = String(value ?? '').trim().replace(/\/+$/, '');
  let path;
  if (input.includes('://')) {
    const base = new URL(normalizeBaseUrl(baseUrl));
    let url;
    try { url = new URL(input); } catch { throw new Error('Некорректная ссылка на проект'); }
    if (url.hostname.toLowerCase() !== base.hostname.toLowerCase() || url.protocol !== base.protocol || url.port !== base.port) throw new Error('Проект находится на другом GitLab');
    const prefix = `${base.pathname.replace(/\/+$/, '')}/`;
    if (!url.pathname.startsWith(prefix) || url.username || url.password || url.search || url.hash) throw new Error('Некорректная ссылка на проект');
    path = decodeURIComponent(url.pathname.slice(prefix.length));
  } else path = input.replace(/^\/+/, '');
  const cleaned = path.split('/-/')[0].replace(/\/+$/, '').replace(/\.git$/, '');
  const parts = cleaned.split('/');
  if (parts.length < 2 || parts.some(part => !part.trim() || part === '.' || part === '..')) throw new Error('Укажите group/project или ссылку на проект');
  return cleaned;
}

/** UC1: resolve an HTTPS or SSH Git remote of the configured server to its project path. */
function remoteProjectPath(remote, baseUrl) {
  try {
    const base = new URL(normalizeBaseUrl(baseUrl));
    if (/^https?:\/\//i.test(remote)) {
      const url = new URL(remote);
      url.username = ''; url.password = '';
      return projectPath(url.toString(), baseUrl);
    }
    let host, path;
    if (/^ssh:\/\//i.test(remote)) {
      const url = new URL(remote);
      host = url.hostname; path = decodeURIComponent(url.pathname);
    } else {
      const match = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(remote);
      if (!match) return null;
      [, host, path] = match;
    }
    if (host.toLowerCase() !== base.hostname.toLowerCase()) return null;
    return projectPath(path.replace(/^\/+/, ''), baseUrl);
  } catch { return null; }
}

const string = (o, key) => (o[key] == null ? '' : String(o[key]));
function required(o, key) {
  const value = string(o, key);
  if (!value.trim()) throw new Error(`GitLab не вернул ${key}`);
  return value;
}
function id(o, key = 'id') {
  const value = Number(o[key]);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`GitLab не вернул ${key}`);
  return value;
}
function time(o, key) {
  if (!o[key]) return null;
  const value = Date.parse(o[key]);
  return Number.isNaN(value) ? null : value;
}
const parseUser = o => ({ id: id(o), username: required(o, 'username'), name: string(o, 'name') });
const parseProject = o => ({ id: id(o), path: required(o, 'path_with_namespace'), webUrl: string(o, 'web_url'), defaultBranch: string(o, 'default_branch') || 'main' });
const parsePipeline = (o, projectId) => ({
  id: id(o), projectId, ref: required(o, 'ref'), status: required(o, 'status'), sha: string(o, 'sha'), source: string(o, 'source'),
  name: string(o, 'name'), webUrl: string(o, 'web_url'), createdAt: time(o, 'created_at'), updatedAt: time(o, 'updated_at'),
  startedAt: time(o, 'started_at'), finishedAt: time(o, 'finished_at'), user: o.user ? parseUser(o.user) : null
});
const parseJob = o => ({
  id: id(o), name: required(o, 'name'), stage: required(o, 'stage'), status: required(o, 'status'), allowFailure: o.allow_failure === true,
  webUrl: string(o, 'web_url'), startedAt: time(o, 'started_at'), finishedAt: time(o, 'finished_at'), isTrigger: false
});

module.exports = {
  GitLabClient, GitLabError, UncertainPipelineCreation, TRACE_TAIL_CHARS, VARIABLE_KEY,
  normalizeBaseUrl, projectPath, remoteProjectPath, isAbort, cancelled
};
