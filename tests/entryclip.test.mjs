import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateExit } from '../src/exits.js';
import { testCfg } from './helpers.mjs';

// ENTRY CLIP (owner order 2026-10-18 17:56 EDT, "adding the 3m timer at the
// entry stall point like we had before — −7% we clip out"): the price
// counterpart the stall exit (section 5) deliberately lacks. From
// ENTRY_CLIP_SEC of age, a pre-TP1 position whose round-trip move is
// at/below −ENTRY_CLIP_PCT sells in full — no flow conjunction, no confirm.
// Defaults from config: ENTRY_CLIP 1, ENTRY_CLIP_SEC 180, ENTRY_CLIP_PCT
// 0.07. txFeeSol is zeroed so the marks' gain reads as a plain percentage;
// live flow (buys 30 / sells 10) is the default mark so the dead-flow stall
// exit can never be the thing that fires in these tests.
const cfg = testCfg({ txFeeSol: 0 });
const NOW = 1_000_000_000_000;
const S = 1000;
const pos = (o = {}) => ({ entrySol: 0.05, remainingFrac: 1, peakRatio: 1, tp1Done: false, entryTs: NOW - 600 * S, stallPending: null, ...o });
const mk = (p, gainPct, o = {}) => ({ valueSol: p.entrySol * p.remainingFrac * (1 + gainPct / 100), liqUsd: 200_000, buysM5: 30, sellsM5: 10, solUsd: 150, ...o });
const step = (p, gainPct, c, now, markOver = {}) => evaluateExit(p, mk(p, gainPct, markOver), c, now);

test('age gate: a crashed young position is untouched before 180s; at 180s the clip fires', () => {
  const p = pos({ entryTs: NOW - 60 * S });                        // 1 minute old, deep red since birth
  assert.equal(step(p, -30, cfg, NOW).fraction, 0);
  assert.equal(step(p, -30, cfg, NOW + 119 * S).fraction, 0);      // 179s old: the rule does not exist yet
  const d = step(p, -30, cfg, NOW + 120 * S);                      // exactly 180s: clip
  assert.equal(d.fraction, 1);
  assert.match(d.reason, /^entry clip \(/);
});

test('the line: at/after 3 minutes, −7%-or-worse sells and above the line holds — no flow input at all', () => {
  const under = pos();
  assert.equal(step(under, -5, cfg, NOW).fraction, 0);             // 10 min old but only −5%: holds
  const d = step(under, -10, cfg, NOW + 60 * S);                   // slides through the line later: clips then
  assert.equal(d.fraction, 1);
  assert.match(d.reason, /^entry clip \(/);
  const deep = pos();
  assert.equal(step(deep, -30, cfg, NOW).fraction, 1);             // deep red on a LIVE tape: price alone fires it (the stall exit never would)
  const green = pos();
  assert.equal(step(green, 10, cfg, NOW).fraction, 0);             // a working entry is never clipped
});

test('scope: TP1 banking takes the position out of the rule — the middle judges own it from there', () => {
  const mid = pos({ tp1Done: true, remainingFrac: 0.6 });
  assert.equal(step(mid, -20, cfg, NOW).fraction, 0);              // post-TP1 sag on a live tape: no clip
  const bag = pos({ tp1Done: true, tp2Done: true, remainingFrac: 0.25, peakRatio: 2 });
  assert.equal(step(bag, -20, cfg, NOW).fraction, 0);              // moonbag: out of scope entirely
});

test('switches: protect does NOT block it (same posture as the stall exit); takeover silences it', () => {
  const prot = pos({ protected: NOW - 60000 });
  assert.equal(step(prot, -10, cfg, NOW).fraction, 1);
  const taken = pos({ takenOver: NOW - 60000 });
  const d = step(taken, -10, cfg, NOW);
  assert.equal(d.fraction, 0);
  assert.equal(d.takenOver, true);
});

test('kill switch: ENTRY_CLIP=0 — nothing clips at any age or depth', () => {
  const off = testCfg({ txFeeSol: 0, entryClip: 0 });
  const p = pos({ entryTs: NOW - 3600 * S });
  assert.equal(step(p, -30, off, NOW).fraction, 0);
});
