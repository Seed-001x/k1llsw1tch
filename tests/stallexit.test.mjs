import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateExit } from '../src/exits.js';
import { testCfg } from './helpers.mjs';

// STALL EXIT (user order 2026-10-16 19:24 EDT, "remove the mess... simplify
// it" / "No SL rule aside from the 3M stall 60 sec confirm"): the ONE
// general downside exit. It replaced the SL ladder (removed entire) and the
// 10-minute momentum-failure undertaker: the undertaker's own dead-flow
// conjunction (buysM5 ≤ 1 AND sellsM5 > 3 × buysM5), judged from 3 minutes
// of age, with a 60-second confirm — the first dead check only stamps a
// pending; the sell needs the tape STILL dead at the lapse. No price input
// anywhere. Defaults from config: STALL_EXIT 1, MIN_AGE 180s, CONFIRM 60s.
// txFeeSol is zeroed so gain = ratio − 1 exactly and gain prints below read
// as plain percentages (the rule never reads them — the marks just need to
// not trip the OTHER live sections while the stall is judged).
const cfg = testCfg({ txFeeSol: 0 });
const NOW = 1_000_000_000_000;
const S = 1000;
const pos = (o = {}) => ({ entrySol: 0.05, remainingFrac: 1, peakRatio: 1, tp1Done: false, entryTs: NOW - 600 * S, stallPending: null, ...o });
const mk = (p, gainPct, o = {}) => ({ valueSol: p.entrySol * p.remainingFrac * (1 + gainPct / 100), liqUsd: 200_000, buysM5: 30, sellsM5: 10, solUsd: 150, ...o });
const DEAD = { buysM5: 1, sellsM5: 10 };
// one position check, threading the pending back exactly like bot.js does
const step = (p, gainPct, c, now, markOver = {}) => { const d = evaluateExit(p, mk(p, gainPct, markOver), c, now); if ('stallPending' in d) p.stallPending = d.stallPending; return d; };

test('age gate: dead flow from birth cannot even stamp a pending before 180s; at 180s it stamps', () => {
  const p = pos({ entryTs: NOW - 60 * S });                        // 1 minute old, dead tape since birth
  let d = step(p, -5, cfg, NOW, DEAD);
  assert.equal(d.fraction, 0);
  assert.equal(p.stallPending, null);                              // no pending exists to mature later
  d = step(p, -5, cfg, NOW + 119 * S, DEAD);                       // 179s old: still nothing
  assert.equal(d.fraction, 0);
  assert.equal(p.stallPending, null);
  d = step(p, -5, cfg, NOW + 120 * S, DEAD);                       // exactly 180s: the rule engages
  assert.equal(d.fraction, 0);                                     // stamping is not a sell
  assert.equal(p.stallPending, NOW + 120 * S);
  assert.ok(d.stallEvents.some(e => e.type === 'pending'));
});

test('confirm: a stamped pending does not sell before the 60s lapse, even with the tape still dead', () => {
  const p = pos();                                                 // 10 min old
  const d = step(p, -5, cfg, NOW, DEAD);
  assert.equal(d.fraction, 0);
  assert.equal(p.stallPending, NOW);
  assert.equal(step(p, -5, cfg, NOW + 30 * S, DEAD).fraction, 0);
  assert.equal(step(p, -5, cfg, NOW + 59 * S, DEAD).fraction, 0);
  assert.equal(p.stallPending, NOW);                               // one pending, never re-stamped
});

test('fire: still dead at the lapse, the position sells in full under the plain reason', () => {
  const p = pos();
  step(p, -5, cfg, NOW, DEAD);
  const d = step(p, -5, cfg, NOW + 60 * S, DEAD);
  assert.equal(d.fraction, 1);
  assert.equal(d.reason, 'stall exit (dead flow, 60s confirm)');
  assert.ok(d.stallEvents.some(e => e.type === 'fired'));
});

test('cancel: a live check inside the window kills the pending; dead flow later re-triggers a fresh window', () => {
  const p = pos();
  step(p, -5, cfg, NOW, DEAD);
  const d = step(p, -5, cfg, NOW + 30 * S, { buysM5: 6, sellsM5: 10 }); // buyers back: conjunction fails
  assert.equal(d.fraction, 0);
  assert.equal(p.stallPending, null);
  assert.ok(d.stallEvents.some(e => e.type === 'cancelled'));
  step(p, -5, cfg, NOW + 40 * S, DEAD);                             // dead again: a NEW pending, not the old clock
  assert.equal(p.stallPending, NOW + 40 * S);
  assert.equal(step(p, -5, cfg, NOW + 99 * S, DEAD).fraction, 0);  // 59s into the new window: holds
  assert.equal(step(p, -5, cfg, NOW + 100 * S, DEAD).fraction, 1); // lapse: sells
});

test('no price input: a −50% crash with buyers alive never sells; a green coin on a dead tape does', () => {
  // the crash half runs with the entry clip OFF (entryClip: 0): since the
  // owner's 2026-10-18 order, the clip (exits.js 5a) owns a pre-TP1 crash on
  // price alone — what is judged here is that the STALL EXIT itself still
  // never reads price: it cannot even stamp a pending off a crash.
  const noClip = testCfg({ txFeeSol: 0, entryClip: 0 });
  const crash = pos();
  const live = { buysM5: 20, sellsM5: 25 };                        // sells heavy but buyers far above the ≤1 line
  assert.equal(step(crash, -50, noClip, NOW, live).fraction, 0);
  assert.equal(crash.stallPending, null);                          // price alone cannot even stamp
  assert.equal(step(crash, -50, noClip, NOW + 300 * S, live).fraction, 0);
  const green = pos({ tp1Done: true, remainingFrac: 0.6 });        // middle stage, UP on entry: the old undertaker demanded underwater — this rule does not read price at all
  step(green, 40, cfg, NOW, DEAD);
  assert.equal(green.stallPending, NOW);
  const d = step(green, 40, cfg, NOW + 60 * S, DEAD);
  assert.equal(d.fraction, 1);
  assert.equal(d.reason, 'stall exit (dead flow, 60s confirm)');
});

test('switches: protect does NOT block it (it succeeds the undertaker); takeover silences it and drops the pending', () => {
  const prot = pos({ protected: NOW - 60000 });
  step(prot, -5, cfg, NOW, DEAD);
  assert.equal(prot.stallPending, NOW);                            // protect never gated the undertaker, and does not gate its successor
  assert.equal(step(prot, -5, cfg, NOW + 60 * S, DEAD).fraction, 1);
  const taken = pos({ takenOver: NOW - 60000, stallPending: NOW - 120 * S }); // a matured pending, ripe to fire
  const d = evaluateExit(taken, mk(taken, -5, DEAD), cfg, NOW);
  assert.equal(d.fraction, 0);
  assert.equal(d.takenOver, true);
  assert.equal(d.stallPending, null);                              // arming state drops under takeover, like every other judge's
});

test('moonbag scope: a post-TP2 position is out of the rule entirely — its own dead flow and trail own the bag', () => {
  const bag = pos({ tp1Done: true, tp2Done: true, remainingFrac: 0.25, peakRatio: 2, stallPending: NOW - 120 * S });
  const d = evaluateExit(bag, mk(bag, 100, DEAD), cfg, NOW);       // valued AT its peak (no trail breach), tape dead, stale pending carried in
  assert.equal(d.fraction, 0);
  assert.equal(d.stallPending, null);                              // the carried pending is dropped, never executed, in the moonbag stage
});

test('kill switch: STALL_EXIT=0 — no pending, no fire, and a carried pending is dropped', () => {
  const off = testCfg({ txFeeSol: 0, stallExit: 0 });
  const p = pos();
  const d = step(p, -5, off, NOW, DEAD);
  assert.equal(d.fraction, 0);
  assert.equal(p.stallPending, null);
  assert.deepEqual(d.stallEvents, []);
  const carried = pos({ stallPending: NOW - 120 * S });
  const d2 = step(carried, -5, off, NOW, DEAD);
  assert.equal(d2.fraction, 0);
  assert.equal(carried.stallPending, null);
});

test('middle stage is in scope: a post-TP1 remainder on a dead tape sells at the lapse', () => {
  // The remainder holds at +30% — ABOVE the TP1 fire line (+25%): since
  // 2026-10-22 the TP1 guard (exits.js 3d-guard) owns the middle-stage
  // give-back, so a remainder faded back under the line would trim/exit on
  // the guard before the stall's confirm could lapse. The stall judges
  // flow, not price, so the tape dies here while the price holds — and the
  // stall remains the seller, exactly as this test has always pinned.
  const p = pos({ tp1Done: true, remainingFrac: 0.6 });
  step(p, 30, cfg, NOW, DEAD);
  assert.equal(p.stallPending, NOW);
  const d = step(p, 30, cfg, NOW + 60 * S, DEAD);
  assert.equal(d.fraction, 1);
  assert.equal(d.reason, 'stall exit (dead flow, 60s confirm)');
});
