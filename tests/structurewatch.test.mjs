// Structure Watch (user order 2026-10-15, RECORD-ONLY): the 'healthy trend'
// dataset — every signaled mint seeds an hours-long watch that samples 5m
// candles + a DAS holder count, tracks the confirmed swing staircase, and
// journals a would-enter mark at each confirmed higher low, scored forward.
// Pins: the anti-lookahead discipline the user specced for Dip Hunter B (a
// swing counts only from its confirmation, 2 candles after it prints; a
// partial candle informs nothing), the intervening-bounce condition (≥ prev
// low × 1.15 — a near-miss does not mark), ordinal counting, the holder
// split incl. null growth, the 30-watch cap, died/expired endings, boot-scan
// dedupe (a restart never re-marks), progressive scoring horizons with
// partial finals, the Journal.signal() seeding funnel, and the HTTP surface.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  StructureWatch, findConfirmedSwings, detectHigherLows, scoreMark, completedCandles,
  buildStructureCard, foldStructureJournal, pickTrendSeeds, STRUCTURE_MAX_WATCHES, STRUCTURE_TREND_RESERVE,
  HOLDER_FIX_BOUNDARY_TS,
} from '../src/structureWatch.js';
import { Journal } from '../src/journal.js';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { startServer } from '../src/server.js';
import { testCfg, tmp } from './helpers.mjs';

const S0 = 1_700_000_100;            // first candle start, seconds
const T0 = S0 * 1000;                // seed time, ms
const MIN = 60000;
const MINT = 'MintXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); await new Promise(r => setTimeout(r, 10)); };
const readSw = (dir) => { try { return fs.readFileSync(path.join(dir, 'structure_watch.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };

// candles from [high, low, close] triples, 5m spacing from S0
const mkCandles = (rows, start = S0) => rows.map((r, i) => [start + i * 300, r[2], r[0], r[1], r[2], 1000]);
// The staircase: swing lows 1.00 (@2) → 1.06 (@6) → 1.12 (@11); swing highs
// 1.30 (@4) and 1.35 (@10), each ≥ the previous low × 1.15. Mark 1 confirms
// at candle 8 (price 1.18), mark 2 at candle 13 (price 1.25).
const STAIRS = [
  [1.18, 1.10, 1.12], [1.12, 1.04, 1.06], [1.08, 1.00, 1.03], [1.10, 1.02, 1.08],
  [1.30, 1.09, 1.22], [1.28, 1.08, 1.15], [1.18, 1.06, 1.10], [1.20, 1.09, 1.14],
  [1.24, 1.12, 1.18], [1.22, 1.13, 1.16], [1.35, 1.14, 1.30], [1.26, 1.12, 1.18],
  [1.28, 1.15, 1.22], [1.30, 1.17, 1.25],
];
// Same staircase, but the bounce between the first two lows tops at 1.14 <
// 1.00 × 1.15 — the higher low must NOT mark.
const NEAR_MISS = STAIRS.map((r, i) => (i === 4 ? [1.14, r[1], r[2]] : i === 5 ? [1.13, r[1], r[2]] : i === 7 ? [1.14, r[1], r[2]] : r));

function harness(dir, t0 = T0) {
  let t = t0;
  const journal = new Journal(dir, { now: () => t });
  const h = {
    journal, series: [], holders: 1000,
    setT: (v) => { t = v; }, now: () => t,
  };
  h.sw = new StructureWatch({
    cfg: {}, journal, now: () => t,
    fetchCandles: async (pool, from, to) => h.series.filter(c => c[0] * 1000 <= to),
    resolvePool: async () => 'POOL',
    fetchHolders: async () => h.holders,
  });
  return h;
}
const sigRec = (over = {}) => ({ id: 'sig-1', ts: T0, mint: MINT, symbol: 'STR', setup: 'pop', decision: 'skipped', mc: 50000, price: 1.12, ...over });

// ---- staircase engine: confirmation timing (the lookahead pin) ----
test('structure: a swing low is invisible until its confirmation candle completes', () => {
  const cs = mkCandles(STAIRS);
  // Candles 0..7: the second low (@6) has printed but candle 8 — its
  // confirmation — does not exist yet. Only the first low is confirmed.
  let swings = findConfirmedSwings(cs.slice(0, 8));
  assert.equal(swings.lows.length, 1);
  assert.equal(swings.lows[0].low, 1.00);
  assert.equal(detectHigherLows(swings).length, 0);
  // Candle 8 exists but is still IN PROGRESS at its own start: the engine
  // must not see it (its close is not a fact yet).
  const partial = completedCandles(cs.slice(0, 9), (S0 + 8 * 300) * 1000);
  assert.equal(partial.length, 8);
  assert.equal(detectHigherLows(findConfirmedSwings(partial)).length, 0);
  // Once candle 8 has fully closed, the higher low confirms and marks.
  const done = completedCandles(cs.slice(0, 9), (S0 + 9 * 300) * 1000);
  const marks = detectHigherLows(findConfirmedSwings(done));
  assert.equal(marks.length, 1);
  assert.equal(marks[0].lowPrev, 1.00);
  assert.equal(marks[0].lowNew, 1.06);
  assert.equal(marks[0].price, 1.18);                    // confirmation candle close
  assert.equal(marks[0].ts, (S0 + 8 * 300) * 1000);       // confirmation candle start
});

test('structure: the intervening bounce must reach prev low × 1.15 — a near-miss does not mark', () => {
  // The first pair (1.00 → 1.06) never marks: its bounce topped at 1.14 <
  // 1.15. The walk still advances, and the second pair (1.06 → 1.12, with
  // the 1.35 high between) marks normally — exactly one mark, and it is
  // the second pair.
  const marks = detectHigherLows(findConfirmedSwings(mkCandles(NEAR_MISS)));
  assert.equal(marks.length, 1);
  assert.equal(marks[0].lowPrev, 1.06);
  assert.equal(marks[0].lowNew, 1.12);
  // …and the full staircase marks twice, in order.
  const two = detectHigherLows(findConfirmedSwings(mkCandles(STAIRS)));
  assert.equal(two.length, 2);
  assert.deepEqual([two[0].lowPrev, two[0].lowNew], [1.00, 1.06]);
  assert.deepEqual([two[1].lowPrev, two[1].lowNew], [1.06, 1.12]);
  assert.equal(two[1].price, 1.25);
});

// ---- scoring horizons ----
test('structure: scoreMark fills horizons from completed candles only, missing stays null', () => {
  const rows = Array.from({ length: 49 }, () => [1.0, 1.0, 1.0]);
  rows[3] = [1.10, 0.98, 1.10];   // +15m candle close → r15 = +0.10
  rows[5] = [1.50, 1.00, 1.20];   // peak high 1.50
  rows[7] = [1.05, 0.80, 0.95];   // worst dip 0.80
  rows[12] = [1.00, 0.85, 0.90];  // +60m close → r60 = −0.10
  rows[48] = [2.00, 0.95, 2.00];  // +240m close → r240 = +1.00 (and the series peak: high 2.00)
  const cs = mkCandles(rows);
  const mark = { ts: T0, price: 1.0 };
  const s = scoreMark(cs, mark);
  const approx = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(approx(s.r15, 0.10), `r15 ${s.r15}`);
  assert.ok(approx(s.r60, -0.10), `r60 ${s.r60}`);
  assert.ok(approx(s.r240, 1.00), `r240 ${s.r240}`);
  assert.ok(approx(s.peakPct, 1.00), `peak ${s.peakPct}`);
  assert.ok(approx(s.worstDipPct, -0.20), `dip ${s.worstDipPct}`);
  // Early series: no +15m candle yet → r15 null (never fabricated); peak/dip
  // still read the candles that exist after the mark.
  const early = scoreMark(cs.slice(0, 3), mark);
  assert.equal(early.r15, null);
  assert.equal(early.r60, null);
  assert.equal(early.peakPct, 0);
  assert.equal(early.worstDipPct, 0);
});

// ---- the watch, end to end over a scripted staircase ----
test('structure: a seeded watch samples, marks both higher lows with ordinals + holder growth, and scores forward', async () => {
  const dir = tmp();
  const h = harness(dir);
  h.series = mkCandles(STAIRS);
  const seed = h.sw.seed(sigRec());
  assert.ok(seed && seed.watchId, 'seed returns the record');
  await flush();
  let rows = readSw(dir);
  assert.equal(rows.filter(r => r.type === 'seed').length, 1);
  assert.equal(rows.filter(r => r.type === 'sample').length >= 1, true);
  // Duplicate seed for the same live mint is a no-op (not a cap skip).
  assert.equal(h.sw.seed(sigRec({ id: 'sig-2' })), null);
  assert.equal(h.sw.stats.skippedCap, 0);

  h.holders = 1080; // holders grow +8% before the first mark confirms
  for (let t = T0 + 6 * MIN; t <= T0 + 48 * MIN; t += 6 * MIN) { h.setT(t); await h.sw.tick(t); }
  await flush();
  rows = readSw(dir);
  const marks = rows.filter(r => r.type === 'mark');
  assert.equal(marks.length, 1);
  assert.equal(marks[0].ordinal, 1);
  assert.equal(marks[0].price, 1.18);
  assert.equal(marks[0].lowPrev, 1.00);
  assert.equal(marks[0].lowNew, 1.06);
  assert.equal(marks[0].holdersAtSeed, 1000);
  assert.equal(marks[0].holdersAtMark, 1080);
  assert.equal(marks[0].holderGrowthPct, 0.08);
  // Samples are journaled with the meter: every sample row tried DAS once.
  const samples = rows.filter(r => r.type === 'sample');
  assert.ok(samples.length >= 5, `expected several samples, got ${samples.length}`);
  assert.equal(samples.every(s => s.holderTried), true);
  const card = h.sw.scorecard();
  assert.equal(card.watching, 1);
  assert.equal(card.watchedTotal, 1);
  assert.equal(card.marks, 1);
  assert.equal(card.samples, samples.length);
  assert.equal(card.holderSamples, samples.length);

  for (let t = T0 + 54 * MIN; t <= T0 + 78 * MIN; t += 6 * MIN) { h.setT(t); await h.sw.tick(t); }
  await flush();
  rows = readSw(dir);
  const marks2 = rows.filter(r => r.type === 'mark');
  assert.equal(marks2.length, 2);
  assert.equal(marks2[1].ordinal, 2);
  assert.equal(marks2[1].price, 1.25);
  assert.equal(marks2[1].lowPrev, 1.06);
  assert.equal(marks2[1].lowNew, 1.12);
  // Mark 1's +15m horizon has completed by now (its +15m candle is #11):
  // r15 = close(11)/1.18 − 1 = 0, journaled as a mark-score; r60 still null.
  const scores1 = rows.filter(r => r.type === 'mark-score' && r.markId === marks[0].markId);
  assert.ok(scores1.length >= 1, 'a mark-score was appended when r15 completed');
  assert.equal(scores1[scores1.length - 1].r15, 0);
  assert.equal(scores1[scores1.length - 1].r60, null);

  // The coin goes quiet: 35 min after the last candle ends, the watch dies
  // and both marks get FINAL scores with whatever horizons exist.
  h.setT(T0 + 106 * MIN);
  await h.sw.tick(T0 + 106 * MIN);
  await flush();
  rows = readSw(dir);
  const ends = rows.filter(r => r.type === 'end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].reason, 'died');
  const fin1 = rows.filter(r => r.type === 'mark-score' && r.markId === marks[0].markId && r.final);
  assert.equal(fin1.length, 1);
  assert.equal(fin1[0].r15, 0);
  assert.equal(fin1[0].r60, null);                        // +60m candle never existed — stays null
  assert.equal(fin1[0].peakPct, 0.1441);                  // 1.35 / 1.18 − 1
  const fin2 = rows.filter(r => r.type === 'mark-score' && r.markId === marks2[1].markId && r.final);
  assert.equal(fin2.length, 1);
  assert.equal(fin2[0].peakPct, null);                    // no candle after mark 2's confirmation
  const card2 = h.sw.scorecard();
  assert.equal(card2.watching, 0);
  assert.equal(card2.ended, 1);
  assert.equal(card2.marks, 2);
});

// ---- restart: boot scan rebuilds, nothing re-marks ----
test('structure: boot scan restores the watch — a restart never re-marks a confirmed higher low', async () => {
  const dir = tmp();
  const h = harness(dir);
  h.series = mkCandles(STAIRS);
  h.sw.seed(sigRec());
  await flush();
  for (let t = T0 + 6 * MIN; t <= T0 + 48 * MIN; t += 6 * MIN) { h.setT(t); await h.sw.tick(t); }
  await flush();
  assert.equal(readSw(dir).filter(r => r.type === 'mark').length, 1);

  // A second instance over the SAME journal (the restart): the watch is
  // active again, its fired-mark set rebuilt from the file.
  const h2 = harness(dir, T0 + 54 * MIN);
  h2.series = h.series;
  assert.equal(h2.sw.active.size, 1);
  assert.equal(h2.sw.scorecard().marks, 1);
  await h2.sw.tick(T0 + 54 * MIN);
  await flush();
  assert.equal(readSw(dir).filter(r => r.type === 'mark').length, 1, 'no duplicate mark after restart');
  assert.equal(readSw(dir).filter(r => r.type === 'seed').length, 1, 'no duplicate seed after restart');
  // …and the restored watch still progresses to the second higher low.
  for (let t = T0 + 60 * MIN; t <= T0 + 78 * MIN; t += 6 * MIN) { h2.setT(t); await h2.sw.tick(t); }
  await flush();
  const marks = readSw(dir).filter(r => r.type === 'mark');
  assert.equal(marks.length, 2);
  assert.equal(marks[1].ordinal, 2, 'ordinal continues across the restart');
});

// ---- cap ----
test('structure: the 30-watch cap skips and counts further seeds', async () => {
  const dir = tmp();
  const h = harness(dir);
  for (let i = 0; i < STRUCTURE_MAX_WATCHES; i++) {
    assert.ok(h.sw.seed(sigRec({ id: `sig-${i}`, mint: `Mint${i}XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX` })), `seed ${i} accepted`);
  }
  assert.equal(h.sw.seed(sigRec({ id: 'sig-over', mint: 'MintOverXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' })), null);
  assert.equal(h.sw.stats.skippedCap, 1);
  await flush();
  const rows = readSw(dir);
  assert.equal(rows.filter(r => r.type === 'seed').length, STRUCTURE_MAX_WATCHES);
  assert.equal(rows.filter(r => r.type === 'skip').length, 1);
  const card = h.sw.scorecard();
  assert.equal(card.watching, STRUCTURE_MAX_WATCHES);
  assert.equal(card.skippedCap, 1);
});

// ---- expiry ----
test('structure: a watch expires at 4h and the mint can re-seed afterwards', async () => {
  const dir = tmp();
  const h = harness(dir);
  const flat = Array.from({ length: 55 }, () => [1.0, 1.0, 1.0]);
  h.series = mkCandles(flat);
  h.sw.seed(sigRec());
  await flush();
  const tEnd = T0 + 4 * 3600e3 + 6 * MIN;
  h.setT(tEnd);
  await h.sw.tick(tEnd);
  await flush();
  const rows = readSw(dir);
  const ends = rows.filter(r => r.type === 'end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].reason, 'expired');
  assert.equal(h.sw.active.size, 0);
  // Re-seed after the end: a fresh watch on the same mint.
  const again = h.sw.seed(sigRec({ id: 'sig-later', ts: tEnd }));
  assert.ok(again && again.watchId !== ends[0].watchId);
  assert.equal(readSw(dir).filter(r => r.type === 'seed').length, 2);
});

// ---- holder split + ordinal buckets (pure card) ----
test('structure: holder split buckets growing / flat / shrinking / unknown; ordinals bucket 1 / 2 / 3+', () => {
  // Fixtures live in the POST-FIX era (base = a day past the holder-fix
  // boundary): this test pins the bucketing math for normal marks. The
  // legacy-era exclusion has its own test below.
  const B0 = HOLDER_FIX_BOUNDARY_TS + 24 * 3600e3;
  const seed = (watchId, mint) => ({ type: 'seed', watchId, ts: B0, mint, symbol: 'X', setup: 'pop', decision: 'skipped' });
  const mark = (markId, watchId, ordinal, growth) => ({ type: 'mark', markId, watchId, ordinal, ts: B0 + 3600e3, mint: 'M', symbol: 'X', price: 1, lowPrev: 1, lowNew: 1.1, lowTs: 1, holdersAtSeed: 100, holdersAtMark: null, holderGrowthPct: growth });
  const score = (markId, r60, peakPct) => ({ type: 'mark-score', markId, watchId: 'w', ts: B0 + 7200e3, r15: 0, r60, r240: null, peakPct, worstDipPct: -0.1, final: true });
  const records = [
    seed('w1', 'A'), seed('w2', 'B'), seed('w3', 'C'), seed('w4', 'D'), seed('w5', 'E'),
    mark('w1-m1', 'w1', 1, 0.08), score('w1-m1', 0.10, 0.60),
    mark('w2-m1', 'w2', 1, 0.02), score('w2-m1', -0.05, 0.10),
    mark('w3-m1', 'w3', 1, -0.09), score('w3-m1', 0.20, 0.80),
    mark('w4-m1', 'w4', 1, null), score('w4-m1', 0.30, 0.55),
    mark('w5-m3', 'w5', 3, null),
    { type: 'sample', watchId: 'w1', ts: B0, price: 1, holders: 100, holderTried: true },
    { type: 'sample', watchId: 'w1', ts: B0 + 300e3, price: 1, holders: 108, holderTried: true },
    { type: 'skip', ts: B0, mint: 'Z', reason: 'cap' },
  ];
  const card = buildStructureCard(records);
  assert.equal(card.watchedTotal, 5);
  assert.equal(card.watching, 5);
  assert.equal(card.samples, 2);
  assert.equal(card.holderSamples, 2);
  assert.equal(card.skippedCap, 1);
  assert.equal(card.marks, 5);
  assert.equal(card.marksFinalized, 4);
  assert.equal(card.holderSplit.growing.n, 1);
  assert.equal(card.holderSplit.growing.medianR60, 0.10);
  assert.equal(card.holderSplit.flat.n, 1);
  assert.equal(card.holderSplit.flat.medianR60, -0.05);
  assert.equal(card.holderSplit.shrinking.n, 1);
  assert.equal(card.holderSplit.shrinking.medianR60, 0.20);
  assert.equal(card.holderSplit.unknown, 2);              // both null-growth marks, scored or not
  assert.equal(card.holderLegacyExcluded, 0);             // post-fix era: nothing is legacy
  assert.equal(card.byOrdinal['1'].n, 4);
  assert.equal(card.byOrdinal['1'].finalized, 4);
  assert.equal(card.byOrdinal['1'].medianR60, 0.15);      // median(−0.05, 0.10, 0.20, 0.30)
  assert.equal(card.byOrdinal['1'].sharePeak50, 0.75);    // peaks 0.60 / 0.10 / 0.80 / 0.55
  assert.equal(card.byOrdinal['3+'].n, 1);
  assert.equal(card.byOrdinal['3+'].finalized, 0);
  assert.equal(card.byOrdinal['3+'].medianR60, null);
  assert.equal(card.ready, false);
  assert.equal(card.recentMarks.length, 5);
  assert.equal(card.recentMarks.find(r => r.markId === 'w5-m3').score, null);
});

// ---- the Journal.signal() funnel seeds watches ----
test('structure: Journal.signal() seeds a watch through the funnel hook', async () => {
  const dir = tmp();
  let t = T0;
  const journal = new Journal(dir, { now: () => t });
  const sw = new StructureWatch({
    cfg: {}, journal, now: () => t,
    fetchCandles: async () => [], resolvePool: async () => 'POOL', fetchHolders: async () => 42,
  });
  journal.onStructureSignal = (rec) => sw.seed(rec);
  journal.signal({ mint: MINT, symbol: 'FUN', setup: 'pop', decision: 'taken', price: 1.5, mc: 12345 });
  await flush();
  const rows = readSw(dir);
  const seeds = rows.filter(r => r.type === 'seed');
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].setup, 'pop');
  assert.equal(seeds[0].decision, 'taken');
  assert.equal(seeds[0].mc, 12345);
  assert.equal(seeds[0].price, 1.5);
  assert.equal(sw.active.size, 1);
  // A second signal for the same mint while the watch lives seeds nothing.
  journal.signal({ mint: MINT, symbol: 'FUN', setup: 'pop', decision: 'skipped', price: 1.6, mc: 13000 });
  assert.equal(readSw(dir).filter(r => r.type === 'seed').length, 1);
  // The first sample's holder read becomes holdersAtSeed on the card's marks;
  // here it at least proves the DAS dep was consulted exactly once per sample.
  assert.ok(sw.stats.holderSamples >= 1);
  assert.equal(foldStructureJournal(rows).seeds.size, 1);
});

// ---- HTTP surface + empty state ----
test('structure: HTTP GET /structurewatch serves the empty-state card on a fresh bot', async () => {
  const dir = tmp();
  const cfg = testCfg({ dataDir: dir });
  const exec = new Executor(cfg, { quote: async () => ({ outAmount: '1000000000', priceImpactPct: '0.01' }) });
  const bot = new Bot(cfg, {
    now: () => T0, exec,
    discover: async () => Object.assign(new Map(), { counts: {} }),
    fetchViews: async () => new Map(),
    fetchSolUsd: async () => 150, fetchRug: async () => null, searchByName: async () => [],
  });
  assert.ok(bot.structureWatch, 'watch constructed on the bot');
  assert.equal(typeof bot.journal.onStructureSignal, 'function', 'funnel hook wired');
  const srv = startServer(bot, 0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const card = await (await fetch(base + '/structurewatch')).json();
    assert.equal(card.enabled, true);
    assert.equal(card.watching, 0);
    assert.equal(card.watchedTotal, 0);
    assert.equal(card.ended, 0);
    assert.equal(card.samples, 0);
    assert.equal(card.holderSamples, 0);
    assert.equal(card.skippedCap, 0);
    assert.equal(card.marks, 0);
    assert.equal(card.marksFinalized, 0);
    assert.deepEqual(card.byOrdinal['1'], { n: 0, finalized: 0, medianR60: null, medianPeak: null, sharePeak50: null });
    assert.deepEqual(card.byOrdinal['3+'], { n: 0, finalized: 0, medianR60: null, medianPeak: null, sharePeak50: null });
    assert.equal(card.holderSplit.unknown, 0);
    assert.equal(card.holderLegacyExcluded, 0);
    assert.equal(card.ready, false);
    assert.deepEqual(card.recentMarks, []);
  } finally { srv.close(); }
});

// ---- trending seeding (owner order 2026-10-18): the watch's second supply line ----
test('trend seeds: pickTrendSeeds keeps only readable caps at/above the floor, dedupes, and caps', () => {
  const rows = [
    { mint: 'A', symbol: 'AAA', usd_market_cap: 40_000, price: 0.001 },
    { mint: 'B', symbol: 'BBB', usd_market_cap: 10_000 },              // below the floor
    { mint: 'C', symbol: 'CCC' },                                       // cap unreadable — the floor must be verified, not assumed
    { address: 'D', name: 'DDD', market_cap: 25_000 },                  // floor edge + field fallbacks
    { mint: 'A', symbol: 'AAA', usd_market_cap: 41_000 },               // duplicate mint
    { mint: 'E', symbol: 'EEE', mc: 900_000 },
  ];
  const picks = pickTrendSeeds(rows, { minMc: 25_000, limit: 10 });
  assert.deepEqual(picks.map(p => p.mint), ['A', 'D', 'E']);
  assert.equal(picks[0].mc, 40_000);
  assert.equal(picks[1].symbol, 'DDD');
  assert.deepEqual(pickTrendSeeds(rows, { minMc: 25_000, limit: 2 }).map(p => p.mint), ['A', 'D']);
  assert.deepEqual(pickTrendSeeds(rows, { minMc: 0, limit: 10 }).map(p => p.mint), ['A', 'B', 'D', 'E']); // C still out: no cap at any floor
  assert.deepEqual(pickTrendSeeds(null, { minMc: 0 }), []);
  // Already-watched mints are walked past WITHOUT spending the limit — the
  // head of the trending list is usually already watched, and the seed
  // budget must reach the quieter coins deeper in the page.
  assert.deepEqual(pickTrendSeeds(rows, { minMc: 25_000, limit: 1, exclude: new Set(['A']) }).map(p => p.mint), ['D']);
});

test('trend seeds: seedSource stamps the seed, its marks, and the card tally — signal seeds default to signal', async () => {
  const dir = tmp();
  const h = harness(dir);
  h.series = mkCandles(STAIRS);
  const plain = h.sw.seed(sigRec({ mint: 'MintSignalXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' }));
  assert.equal(plain.seedSource, 'signal');
  const trend = h.sw.seed({ ts: T0, mint: MINT, symbol: 'TRD', setup: 'trending', decision: 'seed', seedSource: 'trending', mc: 60_000, price: 1.12 });
  assert.equal(trend.seedSource, 'trending');
  for (let t = T0 + 6 * MIN; t <= T0 + 48 * MIN; t += 6 * MIN) { h.setT(t); await h.sw.tick(t); }
  await flush();
  const rows = readSw(dir);
  const marks = rows.filter(r => r.type === 'mark' && r.mint === MINT);
  assert.ok(marks.length >= 1);
  assert.equal(marks[0].seedSource, 'trending');
  const card = h.sw.scorecard();
  assert.deepEqual(card.seedSources, { signal: 1, trending: 1 });
  assert.equal(card.recentMarks.find(m => m.mint === MINT).seedSource, 'trending');
});

test('trend seeds: the reserve slice lets trending seeds land past the signal cap — and only trending seeds', () => {
  const dir = tmp();
  const h = harness(dir);
  for (let i = 0; i < STRUCTURE_MAX_WATCHES; i++) {
    assert.ok(h.sw.seed(sigRec({ id: `sig-${i}`, mint: `Mint${i}XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX` })), `signal seed ${i} accepted`);
  }
  assert.equal(h.sw.seed(sigRec({ id: 'sig-over', mint: 'MintOverXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' })), null, 'signal seeds stop at the shared cap');
  const trendRec = (i) => ({ ts: T0, mint: `Trend${i}XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`, symbol: 'TRD', setup: 'trending', decision: 'seed', seedSource: 'trending', mc: 60000, price: 1 });
  for (let i = 0; i < STRUCTURE_TREND_RESERVE; i++) {
    assert.ok(h.sw.seed(trendRec(i), { reserve: STRUCTURE_TREND_RESERVE }), `trending seed ${i} lands inside the reserve`);
  }
  assert.equal(h.sw.seed(trendRec(99), { reserve: STRUCTURE_TREND_RESERVE }), null, 'the reserve is a cap too, not a bypass');
  assert.equal(h.sw.active.size, STRUCTURE_MAX_WATCHES + STRUCTURE_TREND_RESERVE);
});

test('trend seeds: the bot seeder verifies the mc floor from its own market views when the list rows carry none', async () => {
  const dir = tmp();
  const cfg = testCfg({ dataDir: dir, structureTrendSeed: 1, structureSeedMinMc: 25000, structureTrendSeedPerHour: 12 });
  const bot = new Bot(cfg, {
    now: () => T0, exec: { solBalance: async () => 1 },
    discover: async () => Object.assign(new Map(), { counts: {} }),
    fetchViews: async () => new Map(), fetchSolUsd: async () => 150, fetchRug: async () => null, searchByName: async () => [],
  });
  // A recording stand-in for the watch — the seeder's contract is what it ASKS for.
  const seeded = [];
  bot.structureWatch = {
    active: new Map(), activeMint: new Map(),
    seed: (rec, opts) => { seeded.push({ rec, opts }); return rec; },
  };
  bot.latest.set('MintViewedXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', { mc: 40000, price: 0.5, symbol: 'VW' });
  bot._seedStructureFromTrending([
    { address: 'MintViewedXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', name: 'Viewed', symbol: 'VW' },   // no mc on the row — the view supplies it
    { address: 'MintBlindXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', name: 'Blind', symbol: 'BL' },      // no mc and no view — skipped, retried later
    { address: 'MintSmallXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', name: 'Small', symbol: 'SM', usd_market_cap: 9000 }, // readable but under the floor
  ], T0, new Set());
  assert.equal(seeded.length, 1);
  assert.equal(seeded[0].rec.mint, 'MintViewedXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');
  assert.equal(seeded[0].rec.mc, 40000);
  assert.equal(seeded[0].rec.seedSource, 'trending');
  assert.equal(seeded[0].opts.reserve, STRUCTURE_TREND_RESERVE);
  assert.equal(bot._trendSeedHour.count, 1);
});

// ---- legacy holder seeds (owner order 2026-10-19): boot reseed + aggregate exclusion ----
// The pre-fix sampler pinned every holder seed at 1, so growth computed
// against it is fiction in both directions (0% pre-fix; +281,700% post-fix
// on the same watch). The fix: still-active legacy watches are reseeded
// once at boot ('seed-reseed' journal record; a failed read invalidates
// the seed instead of keeping the fake 1), and any mark whose growth
// basis is a legacy seed is excluded from holderSplit and counted in
// holderLegacyExcluded. Journal history itself is never rewritten.
const B = HOLDER_FIX_BOUNDARY_TS;
const writeSw = (dir, rows) => fs.writeFileSync(path.join(dir, 'structure_watch.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
// A legacy watch as journaled before the fix: seeded 2h pre-boundary, its
// first sample pinned holders at 1, and a mark whose +281,700% "growth"
// (1 → 2818) is pure sampler fiction. No end record — still active.
const legacyRows = () => {
  const seedTs = B - 2 * 3600e3;
  return [
    { type: 'seed', watchId: 'sw-legacy-1', ts: seedTs, mint: MINT, symbol: 'LEG', setup: 'pop', decision: 'skipped', seedSource: 'signal', mc: 50000, price: 1 },
    { type: 'sample', watchId: 'sw-legacy-1', ts: seedTs + 5 * MIN, price: 1, holders: 1, holderTried: true, candleTs: null },
    { type: 'mark', markId: 'sw-legacy-1-m1', watchId: 'sw-legacy-1', ordinal: 1, ts: seedTs + 40 * MIN, mint: MINT, symbol: 'LEG', seedSource: 'signal', price: 1.1, lowPrev: 1, lowNew: 1.05, lowTs: 42, holdersAtSeed: 1, holdersAtMark: 2818, holderGrowthPct: 2817 },
    { type: 'mark-score', markId: 'sw-legacy-1-m1', watchId: 'sw-legacy-1', ts: seedTs + 50 * MIN, r15: 0, r60: 0.5, r240: null, peakPct: 0.6, worstDipPct: -0.1, final: true },
  ];
};

test('structure legacy: the card excludes legacy-seeded marks from holderSplit and counts them', () => {
  const D = 24 * 3600e3;
  const seed = (watchId, mint, ts) => ({ type: 'seed', watchId, ts, mint, symbol: 'X', setup: 'pop', decision: 'skipped' });
  const sample = (watchId, ts, holders) => ({ type: 'sample', watchId, ts, price: 1, holders, holderTried: true, candleTs: null });
  const mark = (markId, watchId, ts, growth, seedH) => ({ type: 'mark', markId, watchId, ordinal: 1, ts, mint: 'M', symbol: 'X', price: 1, lowPrev: 1, lowNew: 1.1, lowTs: 1, holdersAtSeed: seedH, holdersAtMark: null, holderGrowthPct: growth });
  const score = (markId, watchId, ts) => ({ type: 'mark-score', markId, watchId, ts, r15: 0, r60: 0.1, r240: null, peakPct: 0.5, worstDipPct: -0.1, final: true });
  const records = [
    // wL: legacy watch. Its pre-reseed marks (fake-flat 0 and fake-huge
    // 2817) are excluded; the post-reseed mark counts.
    seed('wL', 'L', B - 7 * D), sample('wL', B - 7 * D + 300e3, 1),
    mark('wL-m0', 'wL', B - 6 * D, 0, 1), score('wL-m0', 'wL', B - 6 * D + 60e3),
    mark('wL-m1', 'wL', B - 5 * D, 2817, 1), score('wL-m1', 'wL', B - 5 * D + 60e3),
    { type: 'seed-reseed', watchId: 'wL', ts: B + 3600e3, mint: 'L', holders: 2500, prevHoldersAtSeed: 1 },
    mark('wL-m2', 'wL', B + 2 * 3600e3, 0.10, 2500), score('wL-m2', 'wL', B + 2 * 3600e3 + 60e3),
    // wP: post-fix watch — unaffected.
    seed('wP', 'P', B + D), sample('wP', B + D + 300e3, 900),
    mark('wP-m1', 'wP', B + D + 3600e3, -0.20, 900), score('wP-m1', 'wP', B + D + 3600e3 + 60e3),
    // wN: legacy watch whose mark has null growth — unknown bucket, NOT the legacy count.
    seed('wN', 'N', B - 7 * D), sample('wN', B - 7 * D + 300e3, 1),
    mark('wN-m1', 'wN', B - 6 * D, null, 1),
  ];
  const card = buildStructureCard(records);
  assert.equal(card.holderLegacyExcluded, 2);
  assert.equal(card.holderSplit.growing.n, 1);           // only the post-reseed mark
  assert.equal(card.holderSplit.growing.medianR60, 0.1);
  assert.equal(card.holderSplit.shrinking.n, 1);         // the post-fix watch
  assert.equal(card.holderSplit.flat.n, 0);              // the fake-flat legacy mark is gone
  assert.equal(card.holderSplit.unknown, 1);
  assert.equal(card.marks, 5);                           // history itself is untouched
  assert.equal(card.byOrdinal['1'].n, 5);                // …and non-holder aggregates still see every mark
});

test('structure legacy: boot reseeds a still-active legacy watch and its later marks use the real seed', async () => {
  const dir = tmp();
  const journal = new Journal(dir, { now: () => B + 30 * MIN });
  writeSw(dir, legacyRows());
  let t = B + 30 * MIN, holdersNow = 2818;
  const sw = new StructureWatch({
    cfg: {}, journal, now: () => t,
    fetchCandles: async (pool, from, to) => mkCandles(STAIRS).filter(c => c[0] * 1000 <= to),
    resolvePool: async () => 'POOL',
    fetchHolders: async () => holdersNow,
  });
  await sw.reseedPass;
  const w = sw.active.get('sw-legacy-1');
  assert.ok(w, 'the legacy watch is still active');
  assert.equal(w.holdersAtSeed, 2818, 'the fake seed of 1 was replaced by a fresh sample');
  assert.equal(w.seedReseeded, true);
  let rows = readSw(dir);
  const reseeds = rows.filter(r => r.type === 'seed-reseed');
  assert.equal(reseeds.length, 1);
  assert.equal(reseeds[0].holders, 2818);
  assert.equal(reseeds[0].prevHoldersAtSeed, 1);
  // The fake mark is excluded from the split even before any new mark lands.
  let card = sw.scorecard();
  assert.equal(card.holderLegacyExcluded, 1);
  assert.equal(card.holderSplit.growing.n, 0);
  // New marks compute growth against the RESEEDED seed (2818 → 3100 = +10%).
  holdersNow = 3100;
  await sw.tick(t);
  await flush();
  rows = readSw(dir);
  const fresh = rows.filter(r => r.type === 'mark' && r.markId !== 'sw-legacy-1-m1');
  assert.equal(fresh.length, 2);
  assert.ok(fresh.every(m => m.holdersAtSeed === 2818), 'marks stamp the reseeded seed, not the fake 1');
  assert.ok(fresh.every(m => m.holderGrowthPct === 0.1001), 'growth is real: 3100/2818 − 1, rounded to 4dp');
  t = B + 32 * MIN; // step past the 60s card cache
  card = sw.scorecard();
  assert.equal(card.holderSplit.growing.n, 2);
  assert.equal(card.holderLegacyExcluded, 1, 'the historical fake mark stays excluded — history is not rewritten');
});

test('structure legacy: a failed reseed invalidates the seed — marks go unknown until a real sample lands', async () => {
  const dir = tmp();
  const journal = new Journal(dir, { now: () => B + 30 * MIN });
  writeSw(dir, legacyRows());
  let t = B + 30 * MIN, holdersNow = null;
  // Candles ending near "now" so the watch survives its samples (no candle-gap death).
  const startSec = Math.floor((B + 30 * MIN) / 1000) - 13 * 300;
  const sw = new StructureWatch({
    cfg: {}, journal, now: () => t,
    fetchCandles: async (pool, from, to) => mkCandles(STAIRS, startSec).filter(c => c[0] * 1000 <= to),
    resolvePool: async () => 'POOL',
    fetchHolders: async () => holdersNow,
  });
  await sw.reseedPass;
  const w = sw.active.get('sw-legacy-1');
  assert.equal(w.holdersAtSeed, null, 'failed reseed invalidates — never falls back to the fake 1');
  assert.equal(w.seedInvalid, true);
  const reseeds = readSw(dir).filter(r => r.type === 'seed-reseed');
  assert.equal(reseeds.length, 1);
  assert.equal(reseeds[0].holders, null);
  assert.equal(reseeds[0].prevHoldersAtSeed, 1);
  // A mark confirmed while the seed is invalid carries null growth (unknown bucket).
  await sw.tick(t);
  await flush();
  const fresh = readSw(dir).filter(r => r.type === 'mark' && r.markId !== 'sw-legacy-1-m1');
  assert.equal(fresh.length, 1);
  assert.ok(fresh.every(m => m.holdersAtSeed === null && m.holderGrowthPct === null));
  const card = sw.scorecard();
  assert.equal(card.holderLegacyExcluded, 1, 'only the historical fake mark is legacy-excluded');
  assert.equal(card.holderSplit.unknown, 1);
  assert.equal(card.holderSplit.growing.n, 0);
  // A later successful sample establishes a real seed ("until a valid seed exists").
  holdersNow = 1500;
  t = B + 36 * MIN;
  await sw.tick(t);
  await flush();
  assert.equal(w.holdersAtSeed, 1500);
  assert.equal(w.seedInvalid, false);
});

test('structure legacy: a post-fix watch is never reseeded and its marks count normally', async () => {
  const dir = tmp();
  const journal = new Journal(dir, { now: () => B + 3 * 3600e3 });
  const seedTs = B + 3600e3;
  writeSw(dir, [
    { type: 'seed', watchId: 'sw-post-1', ts: seedTs, mint: MINT, symbol: 'PST', setup: 'pop', decision: 'skipped', seedSource: 'signal', mc: 50000, price: 1 },
    { type: 'sample', watchId: 'sw-post-1', ts: seedTs + 5 * MIN, price: 1, holders: 900, holderTried: true, candleTs: null },
    { type: 'mark', markId: 'sw-post-1-m1', watchId: 'sw-post-1', ordinal: 1, ts: seedTs + 40 * MIN, mint: MINT, symbol: 'PST', seedSource: 'signal', price: 1.1, lowPrev: 1, lowNew: 1.05, lowTs: 7, holdersAtSeed: 900, holdersAtMark: 1080, holderGrowthPct: 0.2 },
    { type: 'mark-score', markId: 'sw-post-1-m1', watchId: 'sw-post-1', ts: seedTs + 50 * MIN, r15: 0, r60: 0.3, r240: null, peakPct: 0.4, worstDipPct: -0.05, final: true },
  ]);
  const sw = new StructureWatch({
    cfg: {}, journal, now: () => B + 3 * 3600e3,
    fetchCandles: async () => [], resolvePool: async () => 'POOL', fetchHolders: async () => 9999,
  });
  await sw.reseedPass;
  const w = sw.active.get('sw-post-1');
  assert.ok(w, 'post-fix watch restored active (2h into its 4h life)');
  assert.equal(w.holdersAtSeed, 900, 'real seed untouched');
  assert.equal(w.seedReseeded, false);
  assert.equal(readSw(dir).filter(r => r.type === 'seed-reseed').length, 0, 'no reseed record for a post-fix watch');
  const card = sw.scorecard();
  assert.equal(card.holderSplit.growing.n, 1);
  assert.equal(card.holderLegacyExcluded, 0);
});
