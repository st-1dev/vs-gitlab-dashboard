'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 10_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const watchKey = entry => `${entry.serverUrl}|${entry.projectId}:${entry.pipelineId}`;

/**
 * State shared by the extension hosts of all VS Code windows through files in globalStorage:
 * watches.json (watched pipelines and lastNotified), monitor-lease.json (the polling window),
 * snapshots.json (latest polled watches) and windows/<id>.json (Git repositories of each window).
 */
class SharedStore {
  constructor(directory, windowId, now = Date.now) {
    this.directory = directory;
    this.windowId = windowId;
    this.now = now;
  }

  file(name) { return path.join(this.directory, name); }

  async init() { await fs.mkdir(this.file('windows'), { recursive: true }); }

  /** Exclusive cross-process section: mkdir is atomic; a lock older than 10 s is left by a crashed window. */
  async withLock(fn) {
    const lock = this.file('state.lock');
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try { await fs.mkdir(lock); break; } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const stat = await fs.stat(lock).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) { await fs.rm(lock, { recursive: true, force: true }); continue; }
        if (Date.now() > deadline) throw new Error('Общее состояние GitLab Dashboard занято другим окном');
        await sleep(20 + Math.random() * 30);
      }
    }
    try { return await fn(); } finally { await fs.rm(lock, { recursive: true, force: true }); }
  }

  async read(name, fallback) {
    try { return JSON.parse(await fs.readFile(this.file(name), 'utf8')); } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return fallback;
      throw error;
    }
  }

  /** Atomic replacement: readers in other windows never see a partially written file. */
  async write(name, value) {
    const target = this.file(name);
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(value));
    await fs.rename(temporary, target);
  }

  async watches() {
    const data = await this.read('watches.json', { watches: [] });
    return Array.isArray(data.watches) ? data.watches : [];
  }

  /** UC3: add or replace a watch, keeping its lastNotified so re-watching a finished attempt does not notify twice. */
  addWatch(entry) {
    return this.withLock(async () => {
      const watches = await this.watches();
      const old = watches.find(item => watchKey(item) === watchKey(entry));
      await this.write('watches.json', { watches: [...watches.filter(item => item !== old), { ...entry, lastNotified: old?.lastNotified ?? '' }] });
    });
  }

  removeWatch(key) {
    return this.withLock(async () => {
      const watches = await this.watches();
      await this.write('watches.json', { watches: watches.filter(item => watchKey(item) !== key) });
    });
  }

  /** UC3: compare-and-set lastNotified; only the caller that records a new completion attempt shows the notification. */
  markNotified(key, completion) {
    return this.withLock(async () => {
      const watches = await this.watches();
      const entry = watches.find(item => watchKey(item) === key);
      if (!entry || entry.lastNotified === completion) return false;
      entry.lastNotified = completion;
      await this.write('watches.json', { watches });
      return true;
    });
  }

  /** UC3: one window polls watches; it renews the lease each tick, another window takes over after expiry. */
  acquireLease(ttlMs) {
    return this.withLock(async () => {
      const lease = await this.read('monitor-lease.json', null);
      const now = this.now();
      if (lease && lease.owner !== this.windowId && lease.expiresAt > now) return false;
      await this.write('monitor-lease.json', { owner: this.windowId, expiresAt: now + ttlMs });
      return true;
    });
  }

  releaseLease() {
    return this.withLock(async () => {
      const lease = await this.read('monitor-lease.json', null);
      if (lease?.owner === this.windowId) await fs.rm(this.file('monitor-lease.json'), { force: true });
    });
  }

  writeSnapshots(value) { return this.write('snapshots.json', { ...value, owner: this.windowId, updatedAt: this.now() }); }
  readSnapshots() { return this.read('snapshots.json', null); }

  /** UC1: publish this window's Git remotes and branches for the project registries of other windows. */
  publishWindow(repositories) { return this.write(path.join('windows', `${this.windowId}.json`), { updatedAt: this.now(), repositories }); }

  async otherWindows(maxAgeMs) {
    const names = await fs.readdir(this.file('windows')).catch(() => []);
    const result = [];
    for (const name of names) {
      if (!name.endsWith('.json') || name === `${this.windowId}.json`) continue;
      const data = await this.read(path.join('windows', name), null);
      if (data && Array.isArray(data.repositories) && this.now() - data.updatedAt <= maxAgeMs) result.push(data);
      else if (data && this.now() - data.updatedAt > 24 * 3_600_000) await fs.rm(this.file(path.join('windows', name)), { force: true });
    }
    return result;
  }

  removeWindow() { return fs.rm(this.file(path.join('windows', `${this.windowId}.json`)), { force: true }); }
}

module.exports = { SharedStore, watchKey };
