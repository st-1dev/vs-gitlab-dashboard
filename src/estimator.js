'use strict';

const { TERMINAL_STATUSES, jobsAreSettled, isBlockingManual, jobSignature, runtimeSeconds, queueSeconds, secondsBetween } = require('./models');

/** UC4: collect comparable successes and estimate runtime/remaining time without summing parallel jobs. */
function estimate(current, jobs, history, now) {
  const signature = jobs?.length ? jobSignature(jobs) : null;
  const usable = history.filter(run => run.pipeline.id !== current.id && run.pipeline.projectId === current.projectId &&
    run.pipeline.source === current.source && run.pipeline.status === 'success' && (runtimeSeconds(run.pipeline) ?? 0) > 0 &&
    !run.jobs.some(isBlockingManual) && (signature == null || signature === jobSignature(run.jobs)));
  const sameBranch = usable.filter(run => run.pipeline.ref === current.ref);
  const fallback = sameBranch.length < 3 && usable.some(run => run.pipeline.ref !== current.ref);
  const selected = (fallback ? usable : sameBranch).sort((a, b) => b.pipeline.id - a.pipeline.id).slice(0, 20);
  const runtimes = selected.map(run => runtimeSeconds(run.pipeline)).filter(value => value != null);
  const queues = selected.map(run => queueSeconds(run.pipeline)).filter(value => value != null);
  const runtime = range(runtimes), queue = range(queues);
  const manual = current.status === 'manual' || Boolean(jobs?.some(isBlockingManual));
  const provisional = selected.length < 5 || signature == null || fallback;
  const result = (remaining, message, extra = {}) => ({
    runtime, queue, remaining, finishAt: remaining ? now + remaining.median * 1000 : null,
    samples: selected.length, fallback, provisional, message, ...extra
  });
  if (!runtime) return result(null, 'Недостаточно сопоставимой истории', { samples: 0, provisional: true });
  if (manual) return result(null, 'Ожидает ручного действия');
  if (TERMINAL_STATUSES.has(current.status)) {
    return result(null, jobs && !jobsAreSettled(jobs) ? `Pipeline ${current.status}; ожидаем завершения остальных jobs` : 'Прогон завершён');
  }
  if (current.startedAt == null) {
    const waiting = secondsBetween(current.createdAt, now) ?? 0;
    const queueRemaining = range(queues.filter(value => value > waiting).map(value => value - waiting));
    const remaining = queueRemaining && { median: runtime.median + queueRemaining.median, lower: runtime.lower + queueRemaining.lower, upper: runtime.upper + queueRemaining.upper };
    return result(remaining, remaining ? 'Ожидание runner + выполнение' : 'Очередь: время начала пока неизвестно');
  }
  const elapsed = secondsBetween(current.startedAt, now) ?? 0;
  const remaining = elapsed < runtime.median
    ? { median: runtime.median - elapsed, lower: Math.max(0, runtime.lower - elapsed), upper: Math.max(0, runtime.upper - elapsed) }
    : range(runtimes.filter(value => value > elapsed).map(value => value - elapsed));
  return result(remaining, !remaining ? 'Дольше всех сопоставимых запусков: остаток неизвестен'
    : elapsed >= runtime.median ? 'Дольше обычного: оценка по более долгим запускам' : 'Прогноз по предыдущим запускам');
}

/** Median and P25–P75 by linear interpolation between order statistics. */
function range(values) {
  const sorted = values.filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const percentile = p => {
    const position = (sorted.length - 1) * p, index = Math.floor(position);
    return sorted[index] + (sorted[Math.min(index + 1, sorted.length - 1)] - sorted[index]) * (position - index);
  };
  return { median: percentile(0.5), lower: percentile(0.25), upper: percentile(0.75) };
}

module.exports = { estimate, range };
