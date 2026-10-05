import test from 'node:test';
import assert from 'node:assert/strict';
import {createTriggerMonitor, resolveTriggerLimits} from './triggers.mjs';

const row = (usage, revision = 1, other = {}) => ({id:'a', generation:0, usage, usage_revision:revision,
  offset:revision * 100, caughtUp:true, window:950000, ...other});
function fixture() {
  let time = 100000;
  const monitor = createTriggerMonitor({now:() => time});
  return {monitor, advance:(ms = 10000) => {time += ms;},
    sample:(rows, options = {}) => monitor.observeBatch(rows, {epoch:'on-1', desktopKey:'pipe-1', ...options})};
}
const kinds = result => result.candidates.map(c => c.kind);

test('limits are exact safe integers and never derived from a model window', () => {
  assert.deepEqual(resolveTriggerLimits(), {softLimit:500000, hardLimit:920000});
  assert.deepEqual(resolveTriggerLimits({softLimit:600000, hardLimit:930000}), {softLimit:600000, hardLimit:930000});
  for (const softLimit of [0, -1, 1.5, NaN, Infinity, '500000', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => resolveTriggerLimits({softLimit}), /safe integer/);
  }
  for (const hardLimit of [0, -1, 1.5, NaN, Infinity, '920000', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => resolveTriggerLimits({hardLimit}), /safe integer/);
  }
  assert.throws(() => resolveTriggerLimits({softLimit:920000}), /less than/);
  assert.throws(() => resolveTriggerLimits({softLimit:930000}), /less than/);
});

test('continuous crossing at 500000 produces one soft candidate', () => {
  const f = fixture();
  assert.deepEqual(kinds(f.sample([row(499999)])), []);
  f.advance();
  const crossed = f.sample([row(500000, 2)]);
  assert.deepEqual(kinds(crossed), ['soft']);
  assert.equal(crossed.decisions[0].previousUsage, 499999);
  assert.equal(f.monitor.isCurrent(crossed.candidates[0]), true);
  f.advance();
  assert.deepEqual(kinds(f.sample([row(510000, 3)])), []);
  assert.equal(f.monitor.isCurrent(crossed.candidates[0]), true);
});

test('first samples at or above soft are missed until hard, including startup after an overshoot', () => {
  for (const usage of [500000, 600000, 919999]) {
    const f = fixture();
    const first = f.sample([row(usage)]);
    assert.deepEqual(kinds(first), []);
    assert.equal(first.decisions[0].softMissed, true);
    f.advance();
    assert.deepEqual(kinds(f.sample([row(919999, 2)])), []);
    f.advance();
    assert.deepEqual(kinds(f.sample([row(920000, 3)])), ['hard']);
  }
});

test('missed soft stays locked when usage dips below soft and crosses again', () => {
  const f = fixture();
  f.sample([row(600000)]);
  f.advance();
  assert.deepEqual(kinds(f.sample([row(490000, 2)])), []);
  f.advance();
  const result = f.sample([row(510000, 3)]);
  assert.deepEqual(kinds(result), []);
  assert.equal(result.decisions[0].reason, 'soft_missed_waiting_hard');
});

test('fired soft also stays locked through a dip; no second checkpoint edge is emitted', () => {
  const f = fixture();
  f.sample([row(490000)]);
  f.advance();
  assert.deepEqual(kinds(f.sample([row(500000, 2)])), ['soft']);
  f.advance();
  f.sample([row(490000, 3)]);
  f.advance();
  assert.deepEqual(kinds(f.sample([row(501000, 4)])), []);
});

test('missed-soft latch survives monitoring pause and incomplete-source baseline resets in the same context', () => {
  for (const interruption of ['pause', 'incomplete', 'gap']) {
    const f = fixture();
    f.sample([row(600000)]);
    f.advance();
    if (interruption === 'pause') f.sample([], {enabled:false});
    else if (interruption === 'incomplete') f.sample([row(490000, 2, {caughtUp:false})]);
    else f.advance(30001);
    f.advance();
    f.sample([row(490000, 3)]);
    f.advance();
    const result = f.sample([row(510000, 4)]);
    assert.deepEqual(kinds(result), []);
    assert.equal(result.decisions[0].softMissed, true);
  }
});

test('a queued soft edge that expires across a gap cannot be emitted again after a dip', () => {
  const f = fixture();
  f.sample([row(490000)]);
  f.advance();
  assert.deepEqual(kinds(f.sample([row(500000, 2)])), ['soft']);
  f.advance(30001);
  f.sample([row(490000, 3)]);
  f.advance();
  assert.deepEqual(kinds(f.sample([row(510000, 4)])), []);
});

test('hard is inclusive, takes priority over a soft crossing, and catches up on first sample', () => {
  for (const usage of [920000, 930000]) assert.deepEqual(kinds(fixture().sample([row(usage)])), ['hard']);
  const f = fixture();
  f.sample([row(490000)]);
  f.advance();
  assert.deepEqual(kinds(f.sample([row(920000, 2)])), ['hard']);
});

test('hard remains a level so a failed unclaimed handoff may retry; duplicate soft samples cannot fire', () => {
  const f = fixture();
  f.sample([row(490000)]);
  f.advance();
  assert.deepEqual(kinds(f.sample([row(500000, 2)])), ['soft']);
  f.advance();
  assert.deepEqual(kinds(f.sample([row(500000, 2)])), []);
  f.advance();
  assert.deepEqual(kinds(f.sample([row(920000, 3)])), ['hard']);
  f.advance();
  assert.deepEqual(kinds(f.sample([row(920000, 3)])), ['hard']);
});

test('pause discards baselines and expires soft candidates; resume above soft does not catch up', () => {
  const f = fixture();
  f.sample([row(490000)]);
  f.advance();
  const candidate = f.sample([row(500000, 2)]).candidates[0];
  f.advance();
  assert.deepEqual(kinds(f.sample([row(700000, 3)], {enabled:false})), []);
  assert.equal(f.monitor.isCurrent(candidate), false);
  f.advance();
  assert.deepEqual(kinds(f.sample([row(700000, 3)])), []);
  f.advance();
  assert.deepEqual(kinds(f.sample([row(920000, 4)])), ['hard']);
});

test('persistent control epoch detects pause and resume entirely between two polls', () => {
  const f = fixture();
  const before = f.sample([row(490000)]);
  f.advance();
  const after = f.sample([row(700000, 2)], {epoch:'on-2'});
  assert.deepEqual(kinds(after), []);
  assert.equal(after.resetReason, 'control_epoch_changed');
  assert.notEqual(after.epochId, before.epochId);
});

test('desktop unavailability and pipe identity changes prevent soft catch-up', () => {
  const unavailable = fixture();
  unavailable.sample([row(490000)]);
  unavailable.advance();
  unavailable.sample([row(600000, 2)], {desktopKey:null});
  unavailable.advance();
  assert.deepEqual(kinds(unavailable.sample([row(650000, 3)])), []);
  const restart = fixture();
  restart.sample([row(490000)]);
  restart.advance();
  const result = restart.sample([row(650000, 2)], {desktopKey:'pipe-2'});
  assert.equal(result.resetReason, 'desktop_changed');
  assert.deepEqual(kinds(result), []);
});

test('a new monitor never inherits a previous process baseline', () => {
  const old = fixture();
  old.sample([row(490000)]);
  const next = fixture();
  assert.deepEqual(kinds(next.sample([row(600000, 2)])), []);
  assert.notEqual(old.monitor.epochId, next.monitor.epochId);
});

test('sleep gaps expire pending soft work before another poll and rebaseline on return', () => {
  const f = fixture();
  f.sample([row(490000)]);
  f.advance();
  const candidate = f.sample([row(500000, 2)]).candidates[0];
  f.advance(30001);
  assert.equal(f.monitor.isCurrent(candidate), false);
  const result = f.sample([row(700000, 3)]);
  assert.equal(result.resetReason, 'monitoring_gap');
  assert.deepEqual(kinds(result), []);
  f.advance(30001);
  assert.deepEqual(kinds(f.sample([row(920000, 4)])), ['hard']);
});

test('gap boundary is inclusive and configurable as max(three polls, thirty seconds)', () => {
  const f = fixture();
  f.sample([row(490000)], {pollMs:20000});
  f.advance(60000);
  assert.deepEqual(kinds(f.sample([row(500000, 2)], {pollMs:20000})), ['soft']);
  const g = fixture();
  g.sample([row(490000)], {pollMs:20000});
  g.advance(60001);
  assert.deepEqual(kinds(g.sample([row(500000, 2)], {pollMs:20000})), []);
});

test('clock rollback, explicit reset and threshold changes invalidate old baselines', () => {
  for (const change of ['clock', 'manual', 'threshold', 'resetKey']) {
    const f = fixture();
    f.sample([row(490000)]);
    let options = {};
    if (change === 'clock') f.advance(-1);
    else if (change === 'manual') f.monitor.reset();
    else if (change === 'threshold') options = {softLimit:550000};
    else options = {resetKey:'new-configuration'};
    assert.deepEqual(kinds(f.sample([row(600000, 2)], options)), []);
  }
});

test('generation and context changes reset only their session and permit a later new crossing', () => {
  for (const change of [{generation:1}, {context_epoch:'new-context'}]) {
    const f = fixture();
    f.sample([row(600000)]);
    f.advance();
    assert.deepEqual(kinds(f.sample([row(490000, 2, change)])), []);
    f.advance();
    assert.deepEqual(kinds(f.sample([row(500000, 3, change)])), ['soft']);
    f.advance();
    assert.deepEqual(kinds(f.sample([row(700000, 1, {generation:2})])), []);
  }
});

test('generation reset expires its queued candidate without expiring another session', () => {
  const f = fixture();
  f.sample([row(490000), row(490000, 1, {id:'b'})]);
  f.advance();
  const candidates = f.sample([row(500000, 2), row(500000, 2, {id:'b'})]).candidates;
  f.advance();
  f.sample([row(700000, 3, {generation:1}), row(510000, 3, {id:'b'})]);
  assert.equal(f.monitor.isCurrent(candidates[0]), false);
  assert.equal(f.monitor.isCurrent(candidates[1]), true);
});

test('incomplete sources and omitted sessions lose baselines instead of catching up', () => {
  for (const middle of [[], [row(600000, 2, {caughtUp:false})], [row(600000, 2, {complete:false})]]) {
    const f = fixture();
    f.sample([row(490000)]);
    f.advance();
    assert.deepEqual(kinds(f.sample(middle)), []);
    f.advance();
    assert.deepEqual(kinds(f.sample([row(700000, 3)])), []);
  }
  assert.deepEqual(kinds(fixture().sample([row(930000, 1, {caughtUp:false})])), []);
});

test('invalid usage samples never arm the soft trigger and invalidate previous observations', () => {
  for (const usage of [NaN, Infinity, -1, 1.5, '490000', null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
    const f = fixture();
    f.sample([row(490000)]);
    f.advance();
    assert.deepEqual(kinds(f.sample([row(usage, 2)])), []);
    f.advance();
    assert.deepEqual(kinds(f.sample([row(700000, 3)])), []);
  }
});

test('default zero usage without a token sample cannot manufacture a first crossing', () => {
  const f = fixture();
  f.sample([row(0, 0)]);
  f.advance();
  assert.deepEqual(kinds(f.sample([row(700000, 1)])), []);
  const validZero = fixture();
  validZero.sample([row(0, 1)]);
  validZero.advance();
  assert.deepEqual(kinds(validZero.sample([row(500000, 2)])), ['soft']);
});

test('fallback revision supports old indexed positive usage and ignores unrelated offset when token revision exists', () => {
  const fallback = fixture();
  fallback.sample([row(490000, 0, {offset:100})]);
  fallback.advance();
  assert.deepEqual(kinds(fallback.sample([row(500000, 0, {offset:200})])), ['soft']);
  const explicit = fixture();
  explicit.sample([row(490000)]);
  explicit.advance();
  const result = explicit.sample([row(490000, 1, {offset:900})]);
  assert.equal(result.decisions[0].duplicateSample, true);
  assert.deepEqual(kinds(result), []);
});

test('changed usage with the same token revision is rejected and cannot cause an edge', () => {
  const f = fixture();
  f.sample([row(490000)]);
  f.advance();
  const invalid = f.sample([row(600000, 1)]);
  assert.deepEqual(kinds(invalid), []);
  assert.equal(invalid.decisions[0].reason, 'same_revision_changed_usage');
  f.advance();
  assert.deepEqual(kinds(f.sample([row(700000, 2)])), []);
});

test('regressing revision rebaselines and does not mix old and new observations', () => {
  const f = fixture();
  f.sample([row(490000, 10)]);
  f.advance();
  const result = f.sample([row(600000, 9)]);
  assert.deepEqual(kinds(result), []);
  assert.equal(result.decisions[0].baselineReason, 'sample_revision_regressed');
});

test('all batch rows update before candidates are returned, with hard candidates first', () => {
  const f = fixture();
  f.sample([row(490000), row(490000, 1, {id:'b'}), row(700000, 1, {id:'c'})]);
  f.advance();
  const result = f.sample([row(500000, 2), row(510000, 2, {id:'b'}), row(920000, 2, {id:'c'})]);
  assert.deepEqual(result.candidates.map(c => [c.id, c.kind]), [['c', 'hard'], ['a', 'soft'], ['b', 'soft']]);
  assert.equal(result.decisions.length, 3);
  f.advance();
  assert.deepEqual(f.sample([row(500000, 2), row(510000, 2, {id:'b'}), row(920000, 2, {id:'c'})])
    .candidates.map(c => c.id), ['c']);
});

test('duplicate rows cannot produce multiple candidates for one session', () => {
  const f = fixture();
  f.sample([row(490000)]);
  f.advance();
  const result = f.sample([row(500000, 2), row(510000, 3)]);
  assert.deepEqual(kinds(result), ['soft']);
  assert.equal(result.diagnostics[0].code, 'duplicate_session_in_batch');
});

test('small context windows produce diagnostics without silently lowering either limit', () => {
  const f = fixture();
  const first = f.sample([row(240000, 1, {window:258400})]);
  assert.equal(first.hardLimit, 920000);
  assert.equal(first.softLimit, 500000);
  assert.equal(first.decisions[0].hardReachable, false);
  assert.equal(first.diagnostics[0].code, 'hard_limit_exceeds_context_window');
  f.advance();
  assert.deepEqual(kinds(f.sample([row(250000, 2, {window:258400})])), []);
});

test('invalid monitor configuration fails explicitly before observations are modified', () => {
  assert.throws(() => createTriggerMonitor({now:42}), /function/);
  assert.throws(() => createTriggerMonitor({now:() => NaN}).observeBatch([]), /finite/);
  const f = fixture();
  for (const pollMs of [0, -1, 1.5, Infinity, '10000', Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => f.sample([], {pollMs}), /pollMs/);
  }
  assert.throws(() => f.monitor.observeBatch(null), /array/);
});
