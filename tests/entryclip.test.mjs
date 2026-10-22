import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateExit } from '../src/exits.js';
import { testCfg } from './helpers.mjs';

// ENTRY CLIP (owner order 2026-10-18 17:56 EDT, "adding the 3m timer at the
// entry stall point like we had before — −7% we clip out"; AMENDED by the
// owner 2026-10-18 20:28 EDT — "don't sell right away at the −7% — give it
// a 1m confirmation there"): from ENTRY_CLIP_SEC of age, a pre-TP1 position
// whose round-trip move reaches −ENTRY_CLIP_PCT stamps a pending; the sell
// executes only when the move is STILL at/below the line
// ENTRY_CLIP_CONFIRM_SEC later. A recovery above the line inside the
// window cancels the pending outright. Defaults from config: ENTRY_CLIP 1,
// ENTRY_CLIP_SEC 180, ENTRY_CLIP_PCT 0.07, ENTRY_CLIP_CONFIRM_SEC 60.
// txFeeSol is zeroed so the marks' gain reads as a plain percentage; live
// flow (buys 30 / sells 10) is the default mark so the dead-flow stall
// exit can never be the thing that fires in these tests. Decisions thread
// clipPending back onto the position exactly like the caller does.
const cfg = testCfg({ txFeeSol: 0 });
const NOW = 1_000_000_000_000;
const S = 1000;
const pos = (o = {}) => ({ entrySol: 0.05, remainingFrac: 1, peakRatio: 1, tp1Done: false, entryTs: NOW - 600 * S, stallPending: null, clipPending: null, ...o });
const mk = (p, gainPct, o = {}) => ({ valueSol: p.entrySol * p.remainingFrac * (1 + gainPct / 100), liqUsd: 200_000, buysM5: 30, sellsM5: 10, solUsd: 150, ...o });
const step = (p, gainPct, c, now, markOver = {}) => {
  const d = evaluateExit(p, mk(p, gainPct, markOver), c, now);
  if ('clipPending' in d) p.clipPending = d.clipPending;
  return d;
};

test('age gate: before 180s the rule does not exist — not even a pending stamps', () => {
  const p = pos({ entryTs: NOW - 60 * S });                        // 1 minute old, deep red since birth
  assert.equal(step(p, -30, cfg, NOW).fraction, 0);
  assert.equal(p.clipPending, null);
  assert.equal(step(p, -30, cfg, NOW + 119 * S).fraction, 0);      // 179s old: still nothing
  assert.equal(p.clipPending, null);
  const d = step(p, -30, cfg, NOW + 120 * S);                      // exactly 180s: the breach stamps, no sale yet
  assert.equal(d.fraction, 0);
  assert.equal(p.clipPending, NOW + 120 * S);
});

test('confirm: a breach that HOLDS under the line for 60s sells; at 59s it has not', () => {
  const p = pos();
  assert.equal(step(p, -10, cfg, NOW).fraction, 0);                // breach: stamp only
  assert.equal(p.clipPending, NOW);
  assert.equal(step(p, -12, cfg, NOW + 59 * S).fraction, 0);       // still under, window not complete
  const d = step(p, -11, cfg, NOW + 60 * S);                       // window complete, still under: sell
  assert.equal(d.fraction, 1);
  assert.match(d.reason, /^entry clip \(/);
  assert.match(d.reason, /60s confirm/);
});

test('recovery: back above the line inside the window cancels the pending; a later breach starts a FRESH window', () => {
  const p = pos();
  step(p, -10, cfg, NOW);                                          // stamp
  assert.equal(step(p, -3, cfg, NOW + 30 * S).fraction, 0);        // recovered above −7% mid-window
  assert.equal(p.clipPending, null);                               // pending died
  assert.equal(step(p, -10, cfg, NOW + 45 * S).fraction, 0);       // breach again: fresh stamp, no credit for the old one
  assert.equal(p.clipPending, NOW + 45 * S);
  assert.equal(step(p, -10, cfg, NOW + 90 * S).fraction, 0);       // 45s into the fresh window: still holding
  assert.equal(step(p, -10, cfg, NOW + 105 * S).fraction, 1);      // 60s into the fresh window: sells
});

test('the line: above −7% nothing stamps; deep red on a LIVE tape still clips after the confirm (price alone, no flow input)', () => {
  const p = pos();
  assert.equal(step(p, -5, cfg, NOW).fraction, 0);                 // 10 min old but only −5%: no stamp
  assert.equal(p.clipPending, null);
  step(p, -30, cfg, NOW + 10 * S);                                 // plunges through the line on a live tape: stamp
  assert.equal(step(p, -30, cfg, NOW + 70 * S).fraction, 1);       // held under through the confirm: clips
  const green = pos();
  assert.equal(step(green, 10, cfg, NOW).fraction, 0);             // a working entry is never clipped
  assert.equal(green.clipPending, null);
});

test('scope: TP1 banking takes the position out of the rule and drops any carried pending', () => {
  // tp1Guard 0: guard pinned off because it owns the middle-stage give-back
  // since 2026-10-22 and this test isolates the clip's scope — with the
  // guard on, the −20% middle-stage print below would exit on the guard
  // floor, which is the guard working, not the clip (guard behavior:
  // tp1guard.test.mjs). The clip assertions are unchanged.
  const c = testCfg({ txFeeSol: 0, tp1Guard: 0 });
  const p = pos();
  step(p, -15, c, NOW);                                            // pending stamped pre-TP1
  assert.equal(p.clipPending, NOW);
  const mid = { ...p, tp1Done: true, remainingFrac: 0.6 };         // TP1 banks before the window completes
  const d = step(mid, -20, c, NOW + 120 * S);
  assert.equal(d.fraction, 0);                                     // the middle judges own it now: no clip
  assert.equal(mid.clipPending, null);                             // and the stale stamp is gone
  const bag = pos({ tp1Done: true, tp2Done: true, remainingFrac: 0.25, peakRatio: 2 });
  assert.equal(step(bag, -20, c, NOW).fraction, 0);                // moonbag: out of scope entirely
});

test('switches: protect does NOT block it (same posture as the stall exit); takeover silences it', () => {
  const prot = pos({ protected: NOW - 60000 });
  step(prot, -10, cfg, NOW);                                       // stamps under protect
  assert.equal(step(prot, -10, cfg, NOW + 60 * S).fraction, 1);     // and sells through it after the confirm
  const taken = pos({ takenOver: NOW - 60000 });
  const d = step(taken, -10, cfg, NOW);
  assert.equal(d.fraction, 0);
  assert.equal(d.takenOver, true);
});

test('confirm dial at 0 restores the original instant form', () => {
  const instant = testCfg({ txFeeSol: 0, entryClipConfirmSec: 0 });
  const p = pos();
  const d = step(p, -10, instant, NOW);
  assert.equal(d.fraction, 1);
  assert.match(d.reason, /^entry clip \(/);
});

test('kill switch: ENTRY_CLIP=0 — nothing clips and nothing stamps at any age or depth', () => {
  const off = testCfg({ txFeeSol: 0, entryClip: 0 });
  const p = pos({ entryTs: NOW - 3600 * S });
  assert.equal(step(p, -30, off, NOW).fraction, 0);
  assert.equal(p.clipPending, null);
});
