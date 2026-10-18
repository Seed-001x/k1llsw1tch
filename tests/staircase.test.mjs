// Staircase-3 Shadow Signal (user order 2026-10-16, RECORD-ONLY): the
// Structure Watch study's headline finding — a coin's 3rd-or-later
// confirmed higher low preceded a median +208% forward peak (154
// finalized marks, 67.5% runner share) — minted as a named shadow
// signal. Pins: emission ONLY at ordinal >= 3, exactly one record per
// mark (restart-safe), the STAIRCASE_SIGNAL=0 kill switch, the ordinal
// band split (fresh 3–5 vs deep 6+), aggregation math on fixtures, the
// read-time outcome join from the structure journal's mark-scores, and
// the HTTP surface. Nothing here may ever trade: the module has no path
// back into any decision, and the watch's own records stay untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { StaircaseSignal, buildStaircaseCard, staircaseRecordOf, bandOf, STAIRCASE_READY_N } from '../src/staircaseSignal.js';
import { StructureWatch } from '../src/structureWatch.js';
import { Journal } from '../src/journal.js';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { startServer } from '../src/server.js';
import { testCfg, tmp } from './helpers.mjs';

const S0 = 1_700_000_100;            // first candle start, seconds
const T0 = S0 * 1000;                // seed time, ms
const MIN = 60000;
const MINT = 'MintXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
const readStair = (dir) => { try { return fs.readFileSync(path.join(dir, 'staircase_signals.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const readSw = (dir) => { try { return fs.readFileSync(path.join(dir, 'structure_watch.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };

const markRec = (over = {}) => ({
  type: 'mark', markId: 'sw-1-m3', watchId: 'sw-1', ordinal: 3, ts: T0 + 90 * MIN,
  price: 1.30, lowPrev: 1.12, lowNew: 1.18, lowTs: 1700003700, mint: MINT, symbol: 'STR',
  holdersAtMark: 1200, holdersAtSeed: 1000, holderGrowthPct: 0.2, ...over,
});

// ---- record shape + band split (pure) ----
test('staircase: staircaseRecordOf takes only ordinal >= 3 marks, in the spec shape', () => {
  assert.equal(staircaseRecordOf(markRec({ ordinal: 2, markId: 'sw-1-m2' })), null);
  assert.equal(staircaseRecordOf(markRec({ ordinal: 1, markId: 'sw-1-m1' })), null);
  assert.equal(staircaseRecordOf({ ...markRec(), type: 'seed' }), null);
  assert.equal(staircaseRecordOf({ ...markRec(), markId: undefined }), null);
  assert.equal(staircaseRecordOf(null), null);
  assert.deepEqual(staircaseRecordOf(markRec()), {
    type: 'staircase_signal', ts: T0 + 90 * MIN, mint: MINT, symbol: 'STR',
    watchId: 'sw-1', markId: 'sw-1-m3', ordinal: 3, seedSource: 'signal', price: 1.30, lowPrev: 1.12, lowNew: 1.18,
  });
});

test('staircase: bandOf splits fresh thirds from deep ordinals', () => {
  assert.equal(bandOf(2), null);
  assert.equal(bandOf(3), '3-5');
  assert.equal(bandOf(5), '3-5');
  assert.equal(bandOf(6), '6+');
  assert.equal(bandOf(20), '6+');
});

// ---- emission: threshold, one-per-mark, kill switch ----
test('staircase: noteMark journals only ordinal >= 3, exactly once per mark', () => {
  const dir = tmp();
  const journal = new Journal(dir, { now: () => T0 });
  const ss = new StaircaseSignal({ cfg: { staircaseSignal: 1 }, journal, now: () => T0 });
  assert.equal(ss.noteMark(markRec({ ordinal: 2, markId: 'sw-1-m2' })), null);
  assert.equal(readStair(dir).length, 0);
  const rec = ss.noteMark(markRec());
  assert.equal(rec.type, 'staircase_signal');
  assert.equal(rec.ordinal, 3);
  assert.equal(ss.noteMark(markRec()), null, 'the same mark never emits twice');
  const deep = ss.noteMark(markRec({ ordinal: 19, markId: 'sw-1-m19' }));
  assert.equal(deep.ordinal, 19);
  const rows = readStair(dir);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.markId), ['sw-1-m3', 'sw-1-m19']);
  // A fresh instance over the same journal (a restart) still refuses the dup.
  const ss2 = new StaircaseSignal({ cfg: { staircaseSignal: 1 }, journal, now: () => T0 });
  assert.equal(ss2.noteMark(markRec()), null);
  assert.equal(readStair(dir).length, 2);
});

test('staircase: STAIRCASE_SIGNAL=0 disables emission and the card', () => {
  const dir = tmp();
  const journal = new Journal(dir, { now: () => T0 });
  const ss = new StaircaseSignal({ cfg: { staircaseSignal: 0 }, journal, now: () => T0 });
  assert.equal(ss.enabled, false);
  assert.equal(ss.noteMark(markRec()), null);
  assert.equal(readStair(dir).length, 0);
  assert.deepEqual(ss.card(), { enabled: false });
});

// ---- the watch hook: a real staircase end-to-end ----
// structurewatch.test.mjs' STAIRS (marks 1–2) extended with a third leg:
// swing high 1.36 (@14, ≥ low3 1.12 × 1.15), swing low 1.18 (@16), whose
// confirmation candle (@18, close 1.30) fires mark 3.
const STAIRS3 = [
  [1.18, 1.10, 1.12], [1.12, 1.04, 1.06], [1.08, 1.00, 1.03], [1.10, 1.02, 1.08],
  [1.30, 1.09, 1.22], [1.28, 1.08, 1.15], [1.18, 1.06, 1.10], [1.20, 1.09, 1.14],
  [1.24, 1.12, 1.18], [1.22, 1.13, 1.16], [1.35, 1.14, 1.30], [1.26, 1.12, 1.18],
  [1.28, 1.15, 1.22], [1.30, 1.17, 1.25], [1.36, 1.20, 1.32], [1.33, 1.19, 1.24],
  [1.30, 1.18, 1.22], [1.32, 1.21, 1.27], [1.34, 1.23, 1.30],
];
const mkCandles = (rows, start = S0) => rows.map((r, i) => [start + i * 300, r[2], r[0], r[1], r[2], 1000]);

test('staircase: the 3rd confirmed higher low on a live watch emits exactly one shadow signal', async () => {
  const dir = tmp();
  let t = T0;
  const journal = new Journal(dir, { now: () => t });
  const ss = new StaircaseSignal({ cfg: { staircaseSignal: 1 }, journal, now: () => t });
  const series = mkCandles(STAIRS3);
  const sw = new StructureWatch({
    cfg: {}, journal, now: () => t,
    fetchCandles: async (pool, from, to) => series.filter(c => c[0] * 1000 <= to),
    resolvePool: async () => 'POOL',
    fetchHolders: async () => 1000,
    onMark: (rec) => ss.noteMark(rec),
  });
  sw.seed({ id: 'sig-1', ts: T0, mint: MINT, symbol: 'STR', setup: 'pop', decision: 'skipped', mc: 50000, price: 1.12 });
  for (let tt = T0 + 6 * MIN; tt <= T0 + 100 * MIN; tt += 6 * MIN) { t = tt; await sw.tick(tt); }
  const marks = readSw(dir).filter(r => r.type === 'mark');
  assert.equal(marks.length, 3, 'the watch itself journaled its usual 3 marks — unchanged');
  const sigs = readStair(dir);
  assert.equal(sigs.length, 1, 'only the ordinal-3 mark became a signal');
  assert.equal(sigs[0].ordinal, 3);
  assert.equal(sigs[0].markId, marks[2].markId);
  assert.equal(sigs[0].watchId, marks[2].watchId);
  assert.equal(sigs[0].price, 1.30);
  assert.equal(sigs[0].lowPrev, 1.12);
  assert.equal(sigs[0].lowNew, 1.18);
});

// ---- aggregation math + read-time outcome join (pure) ----
const score = (over = {}) => ({ r15: 0.1, r60: 0.05, r240: 0.4, peakPct: 0.8, worstDipPct: -0.05, final: true, ...over });

test('staircase: buildStaircaseCard aggregates finalized signals and splits bands', () => {
  const recs = [
    { type: 'staircase_signal', ts: 1000, mint: MINT, symbol: 'A', watchId: 'w1', markId: 'm3', ordinal: 3, price: 1, lowPrev: 1, lowNew: 1.1 },
    { type: 'staircase_signal', ts: 2000, mint: MINT, symbol: 'B', watchId: 'w1', markId: 'm5', ordinal: 5, price: 1, lowPrev: 1, lowNew: 1.1 },
    { type: 'staircase_signal', ts: 3000, mint: MINT, symbol: 'C', watchId: 'w2', markId: 'm6', ordinal: 6, price: 1, lowPrev: 1, lowNew: 1.1 },
    { type: 'staircase_signal', ts: 4000, mint: MINT, symbol: 'D', watchId: 'w2', markId: 'm9', ordinal: 9, price: 1, lowPrev: 1, lowNew: 1.1 },
    { type: 'seed', ts: 500, watchId: 'w1' }, // foreign record types are ignored
  ];
  const scores = new Map([
    ['m3', score({ r60: 0.10, peakPct: 2.0 })],
    ['m5', score({ r60: -0.20, peakPct: 0.30 })],
    ['m6', score({ r60: 0.05, peakPct: 0.80 })],
    // m9 unscored — still inside its first hour: counts, never dilutes medians
  ]);
  const card = buildStaircaseCard(recs, scores, T0);
  assert.equal(card.signals, 4);
  assert.equal(card.finalized, 3);
  assert.equal(card.ready, false);
  assert.deepEqual(card.aggregates, { n: 4, finalized: 3, runnerShare: 0.667, medianPeak: 0.8, medianR60: 0.05 });
  assert.deepEqual(card.byBand['3-5'], { n: 2, finalized: 2, runnerShare: 0.5, medianPeak: 1.15, medianR60: -0.05 });
  assert.deepEqual(card.byBand['6+'], { n: 2, finalized: 1, runnerShare: 1, medianPeak: 0.8, medianR60: 0.05 });
  // Recent is newest-first with the score joined; the unscored one reads null.
  assert.deepEqual(card.recent.map(r => r.markId), ['m9', 'm6', 'm5', 'm3']);
  assert.equal(card.recent[0].score, null);
  assert.equal(card.recent[3].score.peakPct, 2.0);
  assert.equal(card.recent[3].score.final, true);
});

test('staircase: ready flips at 30 finalized', () => {
  const recs = [], scores = new Map();
  for (let i = 0; i < STAIRCASE_READY_N; i++) {
    const markId = `m${i}`;
    recs.push({ type: 'staircase_signal', ts: i, mint: MINT, symbol: 'X', watchId: 'w', markId, ordinal: 3, price: 1, lowPrev: 1, lowNew: 1.1 });
    scores.set(markId, score());
  }
  assert.equal(buildStaircaseCard(recs, scores, T0).ready, true);
  scores.delete('m0');
  // m0 now has NO score record at all — unfinalized, so ready drops back.
  const card = buildStaircaseCard(recs, scores, T0);
  assert.equal(card.finalized, STAIRCASE_READY_N - 1);
  assert.equal(card.ready, false);
});

test('staircase: card() joins scores from the structure journal file at read time', () => {
  const dir = tmp();
  const journal = new Journal(dir, { now: () => T0 });
  const ss = new StaircaseSignal({ cfg: { staircaseSignal: 1 }, journal, now: () => T0 });
  ss.noteMark(markRec());
  // The watch's score lands later, in ITS journal — no staircase-side write.
  journal.structure({ type: 'mark-score', markId: 'sw-1-m3', watchId: 'sw-1', ts: T0 + 150 * MIN, r15: 0.5, r60: 0.25, r240: 1.1, peakPct: 2.0788, worstDipPct: -0.03, final: true });
  const card = ss.card();
  assert.equal(card.enabled, true);
  assert.equal(card.signals, 1);
  assert.equal(card.finalized, 1);
  assert.equal(card.aggregates.medianPeak, 2.0788);
  assert.equal(card.aggregates.runnerShare, 1);
  assert.equal(card.recent[0].score.r60, 0.25);
  assert.equal(card.recent[0].score.final, true);
});

// ---- HTTP surface + empty state ----
test('staircase: HTTP GET /staircase serves the empty-state card on a fresh bot', async () => {
  const dir = tmp();
  const cfg = testCfg({ dataDir: dir });
  const exec = new Executor(cfg, { quote: async () => ({ outAmount: '1000000000', priceImpactPct: '0.01' }) });
  const bot = new Bot(cfg, {
    now: () => T0, exec,
    discover: async () => Object.assign(new Map(), { counts: {} }),
    fetchViews: async () => new Map(),
    fetchSolUsd: async () => 150, fetchRug: async () => null, searchByName: async () => [],
  });
  assert.ok(bot.staircaseSignal, 'shadow signal constructed on the bot');
  assert.equal(bot.staircaseSignal.enabled, true, 'STAIRCASE_SIGNAL defaults on');
  const srv = startServer(bot, 0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const card = await (await fetch(base + '/staircase')).json();
    assert.equal(card.enabled, true);
    assert.equal(card.signals, 0);
    assert.equal(card.finalized, 0);
    assert.equal(card.ready, false);
    assert.deepEqual(card.aggregates, { n: 0, finalized: 0, runnerShare: null, medianPeak: null, medianR60: null });
    assert.deepEqual(card.byBand['3-5'], { n: 0, finalized: 0, runnerShare: null, medianPeak: null, medianR60: null });
    assert.deepEqual(card.byBand['6+'], { n: 0, finalized: 0, runnerShare: null, medianPeak: null, medianR60: null });
    assert.deepEqual(card.recent, []);
    // The watch's own surface is untouched by the new tap.
    const sw = await (await fetch(base + '/structurewatch')).json();
    assert.equal(sw.enabled, true);
    assert.equal(sw.marks, 0);
  } finally { srv.close(); }
});
