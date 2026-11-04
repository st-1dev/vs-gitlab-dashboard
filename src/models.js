'use strict';

const TERMINAL_STATUSES = new Set(['success', 'failed', 'canceled', 'skipped']);
const PIPELINE_STATUSES = new Set([...TERMINAL_STATUSES, 'created', 'waiting_for_resource', 'preparing',
  'waiting_for_callback', 'pending', 'running', 'canceling', 'manual', 'scheduled']);

/** UC3: completion requires a terminal pipeline and settled jobs, including jobs still running after an early failure. */
function isComplete(snapshot) {
  return TERMINAL_STATUSES.has(snapshot.pipeline.status) && jobsAreSettled(snapshot.jobs);
}

function jobsAreSettled(jobs) {
  return jobs.every(job => TERMINAL_STATUSES.has(job.status) || (job.status === 'manual' && job.allowFailure));
}

function isBlockingManual(job) { return job.status === 'manual' && !job.allowFailure; }

function completionKey(pipeline) {
  const time = pipeline.finishedAt ?? pipeline.startedAt ?? pipeline.createdAt;
  return `${pipeline.id}:${time == null ? 'null' : new Date(time).toISOString()}:${pipeline.status}`;
}

function jobSignature(jobs) {
  return jobs.map(job => `${job.stage}\u0000${job.name}\u0000${job.isTrigger}`).sort().join('\u0001');
}

function secondsBetween(start, end) {
  if (start == null || end == null || end < start) return null;
  return (end - start) / 1000;
}

const runtimeSeconds = pipeline => secondsBetween(pipeline.startedAt, pipeline.finishedAt);
const queueSeconds = pipeline => secondsBetween(pipeline.createdAt, pipeline.startedAt);

function formatDuration(seconds) {
  if (seconds == null) return '—';
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total} с`;
  if (total < 3600) return `${Math.floor(total / 60)} мин ${total % 60} с`;
  return `${Math.floor(total / 3600)} ч ${Math.floor(total % 3600 / 60)} мин`;
}

function formatTime(time) {
  if (time == null) return '—';
  const date = new Date(time), pad = value => String(value).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Jobs ordered by stage (stages in creation order, by their lowest job ID) and then by name. */
function sortJobs(jobs) {
  const stageOrder = new Map();
  for (const job of jobs) stageOrder.set(job.stage, Math.min(stageOrder.get(job.stage) ?? Infinity, job.id));
  return [...jobs].sort((a, b) => stageOrder.get(a.stage) - stageOrder.get(b.stage) || a.stage.localeCompare(b.stage) || a.name.localeCompare(b.name));
}

module.exports = {
  TERMINAL_STATUSES, PIPELINE_STATUSES, isComplete, jobsAreSettled, isBlockingManual, completionKey, jobSignature,
  secondsBetween, runtimeSeconds, queueSeconds, formatDuration, formatTime, sortJobs
};
