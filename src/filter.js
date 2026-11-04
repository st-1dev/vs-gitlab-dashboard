'use strict';

const { PIPELINE_STATUSES } = require('./models');

const FIELDS = ['project', 'branch', 'status', 'user', 'sha', 'id', 'name', 'source', 'after', 'before', 'latest', 'text'];
const DEFAULT_QUERIES = {
  'Все за неделю': 'after:7d',
  'Мои запуски': 'user:me after:7d',
  'Ошибки за сутки': 'status:failed after:24h',
  'Текущая ветка': 'branch:@current after:7d'
};

class PipelineFilter {
  constructor(fields = {}) {
    this.projects = fields.projects ?? [];
    this.branches = fields.branches ?? [];
    this.statuses = fields.statuses ?? [];
    this.user = fields.user ?? '';
    this.sha = fields.sha ?? '';
    this.id = fields.id ?? null;
    this.name = fields.name ?? '';
    this.source = fields.source ?? '';
    this.after = fields.after ?? '';
    this.before = fields.before ?? '';
    this.latest = fields.latest ?? false;
    this.text = fields.text ?? '';
  }

  acceptsProject(project) { return !this.projects.length || this.projects.some(pattern => glob(pattern, project.path)); }

  resolvedBranches(currentBranch) {
    return this.branches.map(branch => (branch === '@current' ? currentBranch : branch)).filter(Boolean);
  }

  /** UC2: push exact conditions to GitLab, keeping wildcard and multi-value conditions for local matching. */
  serverParameters(now, username, currentBranch) {
    const parameters = {};
    const refs = this.resolvedBranches(currentBranch);
    if (refs.length === 1 && !/[*?]/.test(refs[0])) parameters.ref = refs[0];
    if (this.statuses.length === 1) parameters.status = this.statuses[0];
    if (this.user) parameters.username = this.user === 'me' ? username : this.user;
    if (this.sha.length === 40) parameters.sha = this.sha;
    if (this.source) parameters.source = this.source;
    if (this.after) parameters.created_after = new Date(resolveDate(this.after, now)).toISOString();
    if (this.before) parameters.created_before = new Date(resolveDate(this.before, now)).toISOString();
    // scope=branches is intentionally not used: it can exclude historical matches.
    return parameters;
  }

  matches(row, now, currentBranch, resolvedUsername = this.user) {
    const p = row.pipeline;
    const refs = this.resolvedBranches(currentBranch);
    if (!this.acceptsProject(row.project)) return false;
    if (this.branches.length && (!refs.length || !refs.some(ref => glob(ref, p.ref)))) return false;
    if (this.statuses.length && !this.statuses.includes(p.status)) return false;
    if (this.user && p.user && p.user.username !== resolvedUsername) return false;
    if (this.sha && !p.sha.toLowerCase().startsWith(this.sha.toLowerCase())) return false;
    if (this.id != null && this.id !== p.id) return false;
    if (this.source && this.source !== p.source) return false;
    if (this.name && !glob(this.name, p.name)) return false;
    if (this.after && (p.createdAt == null || p.createdAt < resolveDate(this.after, now))) return false;
    if (this.before && (p.createdAt == null || p.createdAt > resolveDate(this.before, now))) return false;
    const haystack = `${row.project.path} ${p.id} ${p.ref} ${p.sha} ${p.name}`.toLowerCase();
    return this.text.split(' ').filter(Boolean).every(word => haystack.includes(word.toLowerCase()));
  }

  query() {
    const parts = [];
    const add = (key, value) => { if (value) parts.push(`${key}:${quote(value)}`); };
    add('project', this.projects.join(','));
    add('branch', this.branches.join(','));
    add('status', this.statuses.join(','));
    add('user', this.user);
    add('sha', this.sha);
    add('id', this.id == null ? '' : String(this.id));
    add('name', this.name);
    add('source', this.source);
    add('after', this.after);
    add('before', this.before);
    if (this.latest) parts.push('latest:true');
    add('text', this.text);
    return parts.join(' ');
  }

  /** UC2: validate weak query input into one typed filter shared with the filter form. */
  static parse(query, now = Date.now()) {
    const fields = new Map();
    const text = [];
    for (const token of tokenize(query)) {
      const colon = token.indexOf(':');
      if (colon < 0) { text.push(token); continue; }
      const key = token.slice(0, colon).toLowerCase();
      if (!FIELDS.includes(key)) throw new Error(`Неизвестный фильтр: ${key}`);
      if (fields.has(key)) throw new Error(`Фильтр ${key} указан дважды`);
      const value = token.slice(colon + 1);
      if (!value.trim()) throw new Error(`Укажите значение ${key}`);
      fields.set(key, value);
    }
    const list = key => {
      if (!fields.has(key)) return [];
      const values = fields.get(key).split(',').map(value => value.trim());
      if (values.some(value => !value)) throw new Error(`Пустое значение в ${key}`);
      return values;
    };
    const statuses = list('status');
    if (statuses.some(status => !PIPELINE_STATUSES.has(status))) throw new Error('Неизвестный статус pipeline');
    let id = null;
    if (fields.has('id')) {
      if (!/^[1-9][0-9]*$/.test(fields.get('id')) || !Number.isSafeInteger(Number(fields.get('id')))) throw new Error('ID должен быть положительным числом');
      id = Number(fields.get('id'));
    }
    const sha = fields.get('sha') ?? '';
    if (sha && !/^[0-9a-fA-F]{4,40}$/.test(sha)) throw new Error('SHA: от 4 до 40 hex-символов');
    let latest = false;
    if (fields.has('latest')) {
      if (!['true', 'false'].includes(fields.get('latest'))) throw new Error('latest: используйте true или false');
      latest = fields.get('latest') === 'true';
    }
    const after = fields.get('after') ?? '', before = fields.get('before') ?? '';
    const start = after ? resolveDate(after, now) : null, end = before ? resolveDate(before, now) : null;
    if (start != null && end != null && start > end) throw new Error('Начало периода позже его окончания');
    if (fields.has('text')) text.push(fields.get('text'));
    return new PipelineFilter({ projects: list('project'), branches: list('branch'), statuses, user: fields.get('user') ?? '', sha, id,
      name: fields.get('name') ?? '', source: fields.get('source') ?? '', after, before, latest, text: text.join(' ') });
  }
}

/** Relative `30m`/`24h`/`7d`, a UTC date `YYYY-MM-DD` or an ISO 8601 date-time with zone; returns epoch milliseconds. */
function resolveDate(value, now) {
  const relative = /^([1-9][0-9]*)([mhd])$/.exec(value);
  if (relative) return now - Number(relative[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2]];
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (match) {
    const [, year, month, day, hour = '00', minute = '00', second = '00'] = match;
    const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
    if (Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= days && Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60) {
      const parsed = Date.parse(match[4] ? value : `${value}T00:00:00Z`);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  throw new Error(`Некорректная дата '${value}': используйте 24h, 7d, YYYY-MM-DD или ISO 8601`);
}

function glob(pattern, value) {
  const source = [...pattern].map(c => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\/-]/g, '\\$&'))).join('');
  return new RegExp(`^${source}$`, 'is').test(value);
}

function quote(value) {
  return /[\s"'\\]/.test(value) ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : value;
}

function tokenize(query) {
  const result = [];
  let current = '', quoteChar = null, escape = false;
  for (const c of query) {
    if (escape) { current += c; escape = false; } else if (c === '\\') escape = true;
    else if (quoteChar) { if (c === quoteChar) quoteChar = null; else current += c; } else if (c === '"' || c === "'") quoteChar = c;
    else if (/\s/.test(c)) { if (current) { result.push(current); current = ''; } } else current += c;
  }
  if (quoteChar || escape) throw new Error('Незакрытая кавычка или escape в запросе');
  if (current) result.push(current);
  return result;
}

module.exports = { PipelineFilter, DEFAULT_QUERIES, FIELDS, resolveDate, glob };
