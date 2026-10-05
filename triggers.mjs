import {randomUUID} from 'node:crypto';

export const DEFAULT_SOFT_LIMIT = 500000;
export const DEFAULT_HARD_LIMIT = 920000;

export function resolveTriggerLimits({softLimit = DEFAULT_SOFT_LIMIT, hardLimit = DEFAULT_HARD_LIMIT} = {}) {
  for (const [name, value] of Object.entries({softLimit, hardLimit})) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  }
  if (softLimit >= hardLimit) throw new RangeError('softLimit must be less than hardLimit');
  return {softLimit, hardLimit};
}

const safeCount = value => Number.isSafeInteger(value) && value >= 0;
const identity = value => JSON.stringify(value ?? null);

function sampleRevision(session) {
  const explicit = session.usage_revision ?? session.usageRevision;
  if (typeof explicit === 'number' && safeCount(explicit) && explicit > 0) {
    return {key:`token:${explicit}`, order:explicit, source:'token'};
  }
  if (typeof explicit === 'string' && explicit.trim() && explicit !== '0') {
    return {key:`token:${explicit}`, order:null, source:'token'};
  }
  if (explicit !== undefined && explicit !== null && explicit !== 0 && explicit !== '') return null;
  // Old indexed rows may predate usage_revision. A positive stored count and
  // source position suffice to establish a baseline, but a default usage=0
  // without evidence of a token sample must not arm the soft trigger.
  if (safeCount(session.offset) && (session.usage > 0 || session.hasUsage === true)) {
    return {key:`offset:${session.offset}`, order:session.offset, source:'offset'};
  }
  return null;
}

/**
 * In-memory observation only. Nothing survives a controller restart.
 *
 * sessions: indexed session rows, optionally with caughtUp:false (or
 * sourceComplete:false / complete:false), hasUsage:false, and context_epoch.
 * options: enabled, epoch (manual-switch revision), desktopKey (pipe identity;
 * null/false means unavailable), resetKey, pollMs, softLimit, hardLimit.
 *
 * Observe every eligible row together before doing network work. Soft candidates
 * are edges; hard candidates are levels and may recur until the controller has
 * claimed a handoff. isCurrent(candidate) expires queued soft work across gaps
 * and per-session resets without invalidating unrelated sessions.
 */
export function createTriggerMonitor({now = () => Date.now()} = {}) {
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  const instanceId = randomUUID();
  const sessions = new Map();
  // Losing a baseline must not re-arm a soft edge already missed or emitted in
  // this context. These latches are still process-local and contain no history.
  const softLatches = new Map();
  let epochNumber = 0;
  let sessionNumber = 0;
  let epochId = `${instanceId}:0`;
  let previousOptions = null;
  let lastObservedAt = null;
  let gapLimitMs = 30000;
  let active = false;
  let initialReason = 'process_start';

  function newEpoch(reason) {
    epochId = `${instanceId}:${++epochNumber}`;
    sessions.clear();
    return reason;
  }

  function reset(reason = 'manual_reset') {
    newEpoch(reason);
    previousOptions = null;
    lastObservedAt = null;
    active = false;
    initialReason = reason;
    return epochId;
  }

  function timeIsCurrent() {
    const current = now();
    return active && Number.isFinite(current) && lastObservedAt !== null
      && current >= lastObservedAt && current - lastObservedAt <= gapLimitMs;
  }

  function isCurrent(candidate) {
    if (!candidate || !timeIsCurrent() || candidate.epochId !== epochId) return false;
    return sessions.get(candidate.id)?.sessionEpochId === candidate.sessionEpochId;
  }

  function observeBatch(rows, options = {}) {
    if (!Array.isArray(rows)) throw new TypeError('sessions must be an array');
    const {softLimit, hardLimit} = resolveTriggerLimits(options);
    const pollMs = options.pollMs ?? 10000;
    if (!Number.isSafeInteger(pollMs) || pollMs <= 0 || pollMs > Number.MAX_SAFE_INTEGER / 3) {
      throw new RangeError('pollMs must be a positive safe integer no larger than MAX_SAFE_INTEGER / 3');
    }
    const observedAt = now();
    if (!Number.isFinite(observedAt)) throw new RangeError('now() must return a finite timestamp');
    gapLimitMs = Math.max(3 * pollMs, 30000);
    const enabled = options.enabled !== false && options.desktopKey !== null && options.desktopKey !== false;
    const currentOptions = {
      enabled,
      epoch:identity(options.epoch),
      desktopKey:identity(options.desktopKey),
      resetKey:identity(options.resetKey),
      softLimit,
      hardLimit,
    };
    let resetReason = null;
    if (!previousOptions) {
      resetReason = initialReason;
      if (!epochNumber) newEpoch(resetReason);
    } else if (previousOptions.enabled !== enabled) resetReason = newEpoch(enabled ? 'monitoring_resumed' : 'monitoring_disabled');
    else if (previousOptions.epoch !== currentOptions.epoch) resetReason = newEpoch('control_epoch_changed');
    else if (previousOptions.desktopKey !== currentOptions.desktopKey) resetReason = newEpoch('desktop_changed');
    else if (previousOptions.resetKey !== currentOptions.resetKey) resetReason = newEpoch('external_reset');
    else if (previousOptions.softLimit !== softLimit || previousOptions.hardLimit !== hardLimit) resetReason = newEpoch('limits_changed');
    else if (observedAt < lastObservedAt) resetReason = newEpoch('clock_moved_backwards');
    else if (observedAt - lastObservedAt > gapLimitMs) resetReason = newEpoch('monitoring_gap');
    previousOptions = currentOptions;
    lastObservedAt = observedAt;
    active = enabled;
    const result = {epochId, epochChanged:resetReason !== null, resetReason, enabled, observedAt,
      gapLimitMs, softLimit, hardLimit, candidates:[], decisions:[], diagnostics:[]};
    if (!enabled) {
      sessions.clear();
      return result;
    }

    const batch = new Map();
    for (const row of rows) {
      if (!row || typeof row.id !== 'string' || !row.id) {
        result.diagnostics.push({code:'invalid_session'});
        continue;
      }
      if (batch.has(row.id)) result.diagnostics.push({id:row.id, code:'duplicate_session_in_batch'});
      batch.set(row.id, row);
    }
    for (const id of sessions.keys()) if (!batch.has(id)) sessions.delete(id);

    for (const [id, row] of batch) {
      const decision = {id, action:'none', reason:null, usage:row.usage, previousUsage:null,
        epochId, sessionEpochId:null, softMissed:false, softLocked:false, duplicateSample:false};
      result.decisions.push(decision);
      const invalidate = reason => {
        sessions.delete(id);
        decision.reason = reason;
        result.diagnostics.push({id, code:reason});
      };
      if (row.caughtUp === false || row.sourceComplete === false || row.complete === false) {
        invalidate('source_incomplete');
        continue;
      }
      if (!safeCount(row.usage) || row.hasUsage === false || row.sampleValid === false) {
        invalidate('invalid_usage_sample');
        continue;
      }
      const generation = row.generation ?? 0;
      const revision = sampleRevision(row);
      if (!safeCount(generation) || !revision) {
        invalidate(!safeCount(generation) ? 'invalid_generation' : 'missing_usage_revision');
        continue;
      }
      const contextKey = identity(row.context_epoch ?? row.contextEpoch);
      const latchKey = identity([generation, contextKey, softLimit, hardLimit]);
      const contextWindow = safeCount(row.window) && row.window > 0 ? row.window : null;
      decision.hardReachable = contextWindow === null ? null : hardLimit <= contextWindow;
      if (decision.hardReachable === false) result.diagnostics.push({id, code:'hard_limit_exceeds_context_window',
        contextWindow, hardLimit});
      let previous = sessions.get(id);
      let baselineReason = 'first_sample';
      if (previous && (previous.generation !== generation || previous.contextKey !== contextKey)) {
        baselineReason = previous.generation !== generation ? 'generation_changed' : 'context_changed';
        previous = null;
      }
      if (previous && previous.revision.source === revision.source && revision.order !== null
        && previous.revision.order !== null && revision.order < previous.revision.order) {
        baselineReason = 'sample_revision_regressed';
        previous = null;
      }
      if (previous && previous.revision.key === revision.key && previous.usage !== row.usage) {
        invalidate('same_revision_changed_usage');
        continue;
      }

      const isBaseline = !previous;
      const retainedLatch = softLatches.get(id);
      const latch = retainedLatch?.key === latchKey ? retainedLatch : {
        key:latchKey, softMissed:row.usage >= softLimit, softLocked:row.usage >= softLimit,
      };
      const state = previous || {
        sessionEpochId:`${epochId}:session-${++sessionNumber}`,
        generation, contextKey, revision, usage:row.usage,
        softMissed:latch.softMissed,
        softLocked:latch.softLocked,
      };
      decision.previousUsage = previous?.usage ?? null;
      decision.sessionEpochId = state.sessionEpochId;
      decision.baselineReason = isBaseline ? baselineReason : null;
      decision.duplicateSample = !isBaseline && state.revision.key === revision.key;
      if (row.usage >= hardLimit) {
        decision.action = 'hard';
        decision.reason = 'hard_limit';
        state.softLocked = true;
      } else if (isBaseline) {
        // A new epoch first seen above soft is also a miss, even when an earlier
        // epoch observed this context below the limit.
        if (!state.softLocked && row.usage >= softLimit) {
          state.softMissed = true;
          state.softLocked = true;
        }
        decision.reason = state.softMissed ? (row.usage >= softLimit ? 'soft_missed' : 'soft_missed_waiting_hard')
          : state.softLocked ? 'soft_already_observed' : 'baseline_below_soft';
        if (state.softMissed) result.diagnostics.push({id, code:'soft_missed', usage:row.usage, hardLimit});
      } else if (decision.duplicateSample) decision.reason = 'duplicate_sample';
      else if (state.softLocked) decision.reason = state.softMissed ? 'soft_missed_waiting_hard' : 'soft_already_observed';
      else if (state.usage < softLimit && row.usage >= softLimit) {
        decision.action = 'soft';
        decision.reason = 'soft_crossed';
        state.softLocked = true;
      } else decision.reason = 'below_soft';

      state.usage = row.usage;
      state.revision = revision;
      sessions.set(id, state);
      softLatches.set(id, {...latch, softMissed:state.softMissed, softLocked:state.softLocked});
      decision.softMissed = state.softMissed;
      decision.softLocked = state.softLocked;
      decision.revision = revision.key;
      if (decision.action !== 'none') result.candidates.push({id, kind:decision.action, usage:row.usage,
        limit:decision.action === 'hard' ? hardLimit : softLimit, epochId,
        sessionEpochId:state.sessionEpochId, revision:revision.key, generation,
        contextKey, reason:decision.reason});
    }
    result.candidates.sort((a, b) => (a.kind === 'hard' ? 0 : 1) - (b.kind === 'hard' ? 0 : 1));
    return result;
  }

  return {observeBatch, reset, isCurrent, isCurrentEpoch:value => value === epochId && timeIsCurrent(),
    get epochId() { return epochId; }};
}
