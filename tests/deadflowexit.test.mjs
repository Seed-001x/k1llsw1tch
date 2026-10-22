// DEAD-FLOW LOSS EXIT (owner order 2026-10-20 00:32 EDT, "remove the
// 3m thing, no SL at all, only a dead flow once it's under -10%") —
// exits.js section 5c. The stack's only loss-side exit: a PRE-TP1
// position is ARMED while its round-trip move sits at/below
// −DEAD_FLOW_PCT (default 10%), and fires only when the tape over the
// trailing DEAD_FLOW_WINDOW_SEC (default 120s) reads dead under the
// moonbag test's terms (buy count rises <= deadflowMaxBuyDelta, no new
// peak in window). Missing tape never fires (fail toward holding).
// Isolation: txFeeSol 0 makes move == ratio; the entry clip is off in
// cfg (its own file pins it); the stall exit stays live but the marks'
// buy counts are >= 48, so its buysM5 <= 1 conjunction can never hold —
// the dead-flow rule is the only section that can sell in these drives.
// Tape is driven exactly as bot.js records it: a flow sample appended
// BEFORE each check, decision state (moveHist / peaks / clipPending)
// threaded back after.
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateExit } from '../src/exits.js';
import { validateConfig } from '../src/config.js';
import { testCfg } from './helpers.mjs';

const T0 = 1_700_000_000_000;
const S = 1000;
const cfg = testCfg({ txFeeSol: 0, entryClip: 0 }); // rule defaults real: DEAD_FLOW_EXIT 1, DEAD_FLOW_PCT 0.10, DEAD_FLOW_WINDOW_SEC 120, DEADFLOW_MAX_BUY_DELTA 1
const mark = (pos, ratio, o = {}) => ({ valueSol: pos.entrySol * pos.remainingFrac * ratio, liqUsd: 200_000, buysM5: 30, sellsM5: 10, solUsd: 150, volH1: 0, ...o });
const thread = (p, d) => {
  if (d.newPeak != null) p.peakRatio = d.newPeak;
  if (d.newPeakMove != null) p.peakMove = d.newPeakMove;
  if ('moveHist' in d) p.moveHist = d.moveHist;
  if ('clipPending' in d) p.clipPending = d.clipPending;
  return p;
};
const fresh = (o = {}) => ({ entrySol: 0.05, remainingFrac: 1, peakRatio: 1, peakMove: 1, tp1Done: false, entryTs: T0, exitPending: {}, flowHist: [], moveHist: [], ...o });

function drive(p, steps, cfgX = cfg) {
  let now = p._now ?? p.entryTs; const ds = [];
  for (const st of steps) {
    now += (st.dt ?? 15) * S; p._now = now;
    if (st.buys !== undefined || st.sells !== undefined) {
      p.flowHist = [...(p.flowHist || []), { ts: now, buys: st.buys ?? null, sells: st.sells ?? null, tx: (st.buys != null || st.sells != null) ? (st.buys || 0) + (st.sells || 0) : null }].slice(-45);
    }
    const d = evaluateExit(p, mark(p, st.ratio, { buysM5: st.buys ?? null, sellsM5: st.sells ?? 40 }), cfgX, now);
    thread(p, d); ds.push(d);
  }
  return ds;
}
const seq = (ratios, buys, sells = 40) => ratios.map((ratio, i) => ({ ratio, buys: Array.isArray(buys) ? buys[i] : buys, sells }));
const fired = d => (d.deadLossEvents || []).some(e => e.type === 'fired');

// The canonical dead drive: sag to −12% early, then sit there. The buy
// count creeps 50 -> 51 across the final 120s window (delta 1 = dead);
// one step earlier the same window still spans the 48 -> 51 creep
// (delta 3), so the fire can only land on the LAST check — the window
// judges the full trailing span, never a partial one.
const DEAD_R = [0.97, 0.92, 0.88, 0.88, 0.88, 0.88, 0.88, 0.88, 0.88, 0.88];
const DEAD_B = [48, 50, 50, 50, 51, 51, 51, 51, 51, 51];

test('(a) armed at -12% with a dead tape over the full 120s window: full exit, dead-flow reason', () => {
  const p = fresh();
  const ds = drive(p, seq(DEAD_R, DEAD_B));
  assert.ok(ds.slice(0, -1).every(d => d.fraction === 0), 'no fire before the window reads dead across its full span');
  const last = ds[ds.length - 1];
  assert.equal(last.fraction, 1);
  assert.match(last.reason, /^dead-flow exit \(/);
  assert.match(last.reason, /no new peak/);
  assert.ok(fired(last), 'the fire event rides the decision for the stats tally');
});

test('(b1) armed at -12% but buys keep flowing (delta 8 across the window): no exit', () => {
  const p = fresh();
  const ds = drive(p, seq(DEAD_R, [48, 50, 52, 54, 56, 58, 58, 58, 58, 58]));
  assert.ok(ds.every(d => d.fraction === 0));
  assert.ok(ds.every(d => !fired(d)));
});

test('(b2) armed at -12% with a dead buy count but a NEW PEAK inside the window: no exit', () => {
  const p = fresh();
  const ds = drive(p, seq([0.97, 0.92, 0.88, 0.88, 0.99, 0.88, 0.88, 0.88, 0.88, 0.88], DEAD_B));
  assert.ok(ds.every(d => d.fraction === 0), 'the in-window pop to 0.99 is a new peak vs the window-start peak — the tape is not dead');
  assert.ok(ds.every(d => !fired(d)));
});

test('(c) dead tape but only -5% (above the arm line): no exit — price arms, tape fires, both are required', () => {
  const p = fresh();
  const ds = drive(p, seq(Array(10).fill(0.95), DEAD_B));
  assert.ok(ds.every(d => d.fraction === 0));
  assert.ok(ds.every(d => !fired(d)));
});

test('(d) TP1-banked position under -10% on a dead tape: the dead-flow rule does NOT fire — the TP1 guard owns the middle and exits it (owner order 2026-10-22)', () => {
  // 5c judges PRE-TP1 positions only, so it stays silent here exactly as
  // before. What changed on 2026-10-22: the middle stage gained its own
  // give-back rule (exits.js 3d-guard) — a remainder back at/below the
  // guard floor (entry) exits in full on the guard, dead tape or not.
  const p = fresh({ tp1Done: true, remainingFrac: 0.4 });
  const ds = drive(p, seq(DEAD_R, DEAD_B));
  assert.ok(ds.every(d => !fired(d)), '5c never fires on a TP1-banked position');
  assert.ok(ds.every(d => !/^dead-flow exit/.test(d.reason || '')), 'no sell carries the dead-flow reason');
  assert.equal(ds[0].fraction, 1, 'the guard exits the remainder in full once it is back at/below entry');
  assert.match(ds[0].reason, /TP1 guard exit/);
});

test('(e) no tape data at all: no exit, however deep — missing tape fails toward holding', () => {
  const p = fresh();
  const ds = drive(p, DEAD_R.map(ratio => ({ ratio }))); // no flow samples ever appended
  assert.ok(ds.every(d => d.fraction === 0));
  assert.ok(ds.every(d => !fired(d)));
  // stale tape: samples exist but the freshest is a minute old at judgment
  const q = fresh({
    flowHist: [{ ts: T0 + 15 * S, buys: 50, sells: 40, tx: 90 }, { ts: T0 + 30 * S, buys: 50, sells: 40, tx: 90 }],
    moveHist: [{ ts: T0 + 15 * S, move: 0.97 }, { ts: T0 + 30 * S, move: 0.92 }],
  });
  const d = evaluateExit(q, mark(q, 0.88, { buysM5: 50, sellsM5: 40 }), cfg, T0 + 150 * S);
  assert.equal(d.fraction, 0);
  assert.ok(!fired(d));
});

test('(f) DEAD_FLOW_EXIT=0: no exit even armed on a dead tape', () => {
  const off = testCfg({ txFeeSol: 0, entryClip: 0, deadFlowExit: 0 });
  const p = fresh();
  const ds = drive(p, seq(DEAD_R, DEAD_B), off);
  assert.ok(ds.every(d => d.fraction === 0));
  assert.ok(ds.every(d => !fired(d)));
});

test('(g) ENTRY_CLIP=0: no clip sell at any age or depth, and a carried pending is dropped', () => {
  const off = testCfg({ txFeeSol: 0, entryClip: 0 });
  const NOW = T0 + 3600 * S;
  const p = fresh({ entryTs: T0, clipPending: T0 + 600 * S }); // an hour old, -30%, stamp carried from an on-period
  const d = evaluateExit(p, mark(p, 0.70, { buysM5: 30, sellsM5: 10 }), off, NOW);
  assert.equal(d.fraction, 0);
  assert.equal(d.clipPending, null, 'state prep drops the stale stamp while the switch is off');
  // control: the same fixture with the clip on and confirm 0 clips instantly
  const on = testCfg({ txFeeSol: 0, entryClip: 1, entryClipConfirmSec: 0, deadFlowExit: 0 });
  const d2 = evaluateExit(fresh({ entryTs: T0 }), mark(p, 0.70, { buysM5: 30, sellsM5: 10 }), on, NOW);
  assert.equal(d2.fraction, 1);
  assert.match(d2.reason, /^entry clip \(/);
});

test('config: the new dials parse from env and validate', () => {
  const c = testCfg({}, { DEAD_FLOW_EXIT: '0', DEAD_FLOW_PCT: '0.12', DEAD_FLOW_WINDOW_SEC: '90' });
  assert.equal(c.deadFlowExit, 0);
  assert.equal(c.deadFlowPct, 0.12);
  assert.equal(c.deadFlowWindowSec, 90);
  assert.ok(validateConfig({ ...c, deadFlowPct: 0.95 }).some(e => e.includes('DEAD_FLOW_PCT')));
  assert.ok(validateConfig({ ...c, deadFlowExit: 2 }).some(e => e.includes('DEAD_FLOW_EXIT')));
  assert.ok(validateConfig({ ...c, deadFlowWindowSec: 7200 }).some(e => e.includes('DEAD_FLOW_WINDOW_SEC')));
});
