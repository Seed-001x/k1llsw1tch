// rangewatch.test.mjs — the RANGE STUDY (owner order 2026-10-16,
// RECORD-ONLY): a coin basing in a tight sideways range over the
// trailing RANGE_WINDOW_MIN journals ONE mark per range episode to
// range_marks.jsonl, forward-scored by the structure watch's own
// candle tailer and classed expanded / broke down / ranged. Pins: the
// four qualification legs (coverage, tight band, quiet minutes, real
// coin + mint age), anti-lookahead, one mark per episode + the
// sustained-exit episode end + fresh-window re-arm, source tagging,
// outcome classification incl. both-print ordering, scoring
// finalization, the kill switch, config validation, and the inertness
// pin — feeding the tracker a full range sequence produces no signals,
// no positions, and no journal writes outside range_marks.jsonl.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RangeWatch, assessRange, classifyOutcome, foldRangeJournal, buildRangeCard, RANGE_READY_N, RANGE_EXPAND_FRAC, RANGE_BREAK_FRAC } from '../src/rangeWatch.js';
import { Journal } from '../src/journal.js';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { testCfg, view, tmp } from './helpers.mjs';

const T0 = 1_700_000_000_000;
const M = 60000;
const MINT = 'RangeMint11111111111111111111111111111111';
const CFG = { rangeWatch: 1, rangeWindowMin: 15, rangeMaxBandPct: 35, rangeMaxMinMovePct: 18, rangeMinMc: 15000 };
const PAT = [20, 20.4, 20.8, 20.4];   // gentle 30s-step cycle: mc band 20000–20800 (4%), 1-min steps ≤ 4%

function rig({ cfgOver = {}, wasExited = null, isHeld = null, fetchCandles = null, resolvePool = null } = {}) {
  const dir = tmp();
  const journal = new Journal(dir);
  const clock = { t: T0 };
  const rw = new RangeWatch({ cfg: { ...CFG, ...cfgOver }, journal, dir, now: () => clock.t, wasExited, isHeld, fetchCandles, resolvePool });
  const recs = () => { try { return fs.readFileSync(path.join(dir, 'range_marks.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  const obs = (price, over = {}) => rw.observe(view({ address: MINT, symbol: 'RNG', price, mc: price * 1000, ...over }), clock.t);
  return { dir, journal, clock, rw, recs, obs };
}

// feed the gentle pattern for `minutes` (one view per 30s), returning the last mark fired
function feedRange(r, minutes, startIdx = 0) {
  let mark = null;
  const steps = Math.round(minutes * 2);
  for (let i = 0; i <= steps; i++) {
    const m = r.obs(PAT[(startIdx + i) % 4]);
    if (m) mark = m;
    r.clock.t += 30000;
  }
  return mark;
}

// raw sample array builder for the pure assessor (30s spacing)
function samples(prices, { mcScale = 1000, start = T0, stepMs = 30000 } = {}) {
  return prices.map((p, i) => ({ ts: start + i * stepMs, price: p, mc: p * mcScale }));
}
const gentle = (n) => Array.from({ length: n }, (_, i) => PAT[i % 4]);

// ---- config ----
test('config: RANGE_WATCH defaults on, dials parse, junk rejected', () => {
  const c = loadConfig({});
  assert.equal(c.rangeWatch, 1);
  assert.equal(c.rangeWindowMin, 15);
  assert.equal(c.rangeMaxBandPct, 35);
  assert.equal(c.rangeMaxMinMovePct, 18);
  assert.equal(c.rangeMinMc, 15000);
  assert.deepEqual(validateConfig(loadConfig({})), []);
  assert.equal(loadConfig({ RANGE_WATCH: '0' }).rangeWatch, 0);
  assert.equal(loadConfig({ RANGE_WINDOW_MIN: '20' }).rangeWindowMin, 20);
  assert.equal(loadConfig({ RANGE_MIN_MC: '25000' }).rangeMinMc, 25000);
  assert.ok(validateConfig(loadConfig({ RANGE_WATCH: '2' })).some(e => e.includes('RANGE_WATCH')));
  assert.ok(validateConfig(loadConfig({ RANGE_WINDOW_MIN: '2' })).some(e => e.includes('RANGE_WINDOW_MIN')));
  assert.ok(validateConfig(loadConfig({ RANGE_MAX_BAND_PCT: '0' })).some(e => e.includes('RANGE_MAX_BAND_PCT')));
  assert.ok(validateConfig(loadConfig({ RANGE_MAX_MIN_MOVE_PCT: '101' })).some(e => e.includes('RANGE_MAX_MIN_MOVE_PCT')));
  assert.ok(validateConfig(loadConfig({ RANGE_MIN_MC: '0' })).some(e => e.includes('RANGE_MIN_MC')));
});

test('config: RANGE_LIVE defaults ON (owner correction — "none of this is shadow"), parses, junk rejected', () => {
  assert.equal(loadConfig({}).rangeLive, 1);
  assert.equal(loadConfig({ RANGE_LIVE: '0' }).rangeLive, 0);
  assert.equal(loadConfig({ RANGE_LIVE: '1' }).rangeLive, 1);
  assert.ok(validateConfig(loadConfig({ RANGE_LIVE: '2' })).some(e => e.includes('RANGE_LIVE')));
});

// ---- pure assessor: the four legs ----
test('assessRange: a tight, quiet, covered window passes with the range geometry', () => {
  const s = samples(gentle(31));                       // 15 minutes of the gentle pattern
  const a = assessRange(s, { now: T0 + 15 * M + 30000, windowMs: 15 * M, maxBandPct: 35, maxMinMovePct: 18 });
  assert.ok(a);
  assert.equal(a.bandPct, 4);                          // 20800 / 20000
  assert.equal(a.rangeHi, 20800);
  assert.equal(a.rangeLo, 20000);
  assert.equal(a.rangeMid, 20400);
  assert.equal(a.sampleCount, 30);                     // the sample AT `now` is never judged (anti-lookahead)
  assert.ok(a.tightness > 0 && a.tightness < 0.2);
});

test('assessRange: a wide window fails the band leg even when every minute is quiet', () => {
  const drift = Array.from({ length: 31 }, (_, i) => 20 + i * (8 / 30));  // 20 → 28 across the window: +1.3% steps, band 40%
  const a = assessRange(samples(drift), { now: T0 + 15 * M + 30000, windowMs: 15 * M, maxBandPct: 35, maxMinMovePct: 18 });
  assert.equal(a, null);
});

test('assessRange: a pumped window fails the quiet leg even inside the band', () => {
  const prices = gentle(31);
  prices[15] = 25.5;                                   // one vertical minute: band 25500/20000 = 27.5% (passes), the step back down is −21.6%
  const a = assessRange(samples(prices), { now: T0 + 15 * M + 30000, windowMs: 15 * M, maxBandPct: 35, maxMinMovePct: 18 });
  assert.equal(a, null);
});

test('assessRange: thin coverage fails — a >3m gap, and a span under 80% of the window', () => {
  const gappy = samples(gentle(5), { stepMs: 4 * M }); // a print every 4 minutes
  assert.equal(assessRange(gappy, { now: T0 + 16 * M, windowMs: 15 * M, maxBandPct: 35, maxMinMovePct: 18 }), null);
  const short = samples(gentle(21));                    // only the first 10 minutes of the window exist
  assert.equal(assessRange(short, { now: T0 + 15 * M + 30000, windowMs: 15 * M, maxBandPct: 35, maxMinMovePct: 18 }), null);
});

test('assessRange: a window whose mc is mostly missing fails the tight leg (never judged on air)', () => {
  const s = samples(gentle(31)).map((x, i) => i % 2 ? { ...x, mc: null } : x);  // half the prints carry no mc
  assert.equal(assessRange(s, { now: T0 + 15 * M + 30000, windowMs: 15 * M, maxBandPct: 35, maxMinMovePct: 18 }), null);
});

test('assessRange: anti-lookahead — samples at/after the mark instant never change the verdict', () => {
  const s = samples(gentle(31));
  const now = T0 + 15 * M + 30000;
  const before = assessRange(s, { now, windowMs: 15 * M, maxBandPct: 35, maxMinMovePct: 18 });
  assert.ok(before);
  const poisoned = [...s, { ts: now, price: 999, mc: 999000 }, { ts: now + 30000, price: 0.01, mc: 10 }];
  const after = assessRange(poisoned, { now, windowMs: 15 * M, maxBandPct: 35, maxMinMovePct: 18 });
  assert.deepEqual(after, before);
});

test('assessRange: duration extends back over the older base that was already holding', () => {
  const s = samples(gentle(81));                       // 40 minutes of base; judge the trailing 15
  const a = assessRange(s, { now: T0 + 40 * M + 30000, windowMs: 15 * M, maxBandPct: 35, maxMinMovePct: 18 });
  assert.ok(a);
  assert.ok(a.durationMin >= 38, `duration ${a.durationMin}`);
});

// ---- outcome classification ----
const CM = { ts: T0, price: 100 };
const candle = (secOff, hi, lo, close = 100) => [T0 / 1000 + secOff, 100, hi, lo, close, 1000];
test('classifyOutcome: expanded when the +50% peak prints first', () => {
  assert.equal(RANGE_EXPAND_FRAC, 0.5);
  assert.equal(RANGE_BREAK_FRAC, -0.3);
  assert.equal(classifyOutcome([candle(300, 160, 95)], CM), 'expanded');
  assert.equal(classifyOutcome([candle(300, 120, 90), candle(600, 170, 110)], CM), 'expanded');
});
test('classifyOutcome: broke down when the −30% dip prints first — order matters', () => {
  assert.equal(classifyOutcome([candle(300, 110, 65), candle(600, 220, 130)], CM), 'broke-down');
});
test('classifyOutcome: a single candle crossing both lines classes broke down (risk-first)', () => {
  assert.equal(classifyOutcome([candle(300, 200, 50)], CM), 'broke-down');
});
test('classifyOutcome: ranged when neither line prints; null with no candles at all', () => {
  assert.equal(classifyOutcome([candle(300, 130, 85), candle(600, 125, 88)], CM), 'ranged');
  assert.equal(classifyOutcome([], CM), null);
  assert.equal(classifyOutcome([candle(0, 300, 10)], CM), 'ranged');  // the mark candle itself is never judged
});

// ---- the mark ----
test('mark fires once a full tight quiet window has formed; record carries the range geometry', () => {
  const r = rig();
  const mark = feedRange(r, 15);
  assert.ok(mark, 'a mark fires at the 15-minute mark');
  assert.equal(mark.type, 'mark');
  assert.equal(mark.markTs, mark.ts);
  assert.equal(mark.windowMin, 15);
  assert.equal(mark.bandPct, 4);
  assert.equal(mark.rangeHi, 20800);
  assert.equal(mark.rangeLo, 20000);
  assert.equal(mark.rangeMid, 20400);
  assert.equal(mark.sampleCount, 30);
  assert.ok(mark.durationMin >= 14 && mark.durationMin <= 15.5);
  assert.equal(mark.markMc, 20800);
  assert.equal(mark.source, 'watched');
  assert.deepEqual(r.rw.pendingMints(), [{ mint: MINT, since: mark.ts }]);
  // the episode is open: continued ranging never re-fires
  assert.equal(feedRange(r, 5, 3), null);
  assert.equal(r.recs().filter(x => x.type === 'mark').length, 1);
});

test('real-coin leg: a mint younger than one window never marks, however perfect the range', () => {
  const r = rig();
  // 14 minutes in: coverage/band/quiet all hold — only the mint-age leg can be blocking
  assert.equal(feedRange(r, 14), null);
  assert.equal(r.recs().filter(x => x.type === 'mark').length, 0);
  const mark = feedRange(r, 1.5, 1);
  assert.ok(mark, 'the same range marks once the mint is a full window old');
});

test('real-coin leg: mc under the floor never marks', () => {
  const r = rig();
  const cheap = (price) => r.rw.observe(view({ address: MINT, symbol: 'RNG', price, mc: price * 500 }), r.clock.t); // mc tops at 10400 < 15000
  for (let i = 0; i <= 40; i++) { cheap(PAT[i % 4]); r.clock.t += 30000; }
  assert.equal(r.recs().filter(x => x.type === 'mark').length, 0);
});

test('a pumped minute inside the stream blocks the mark until it leaves the window', () => {
  const r = rig();
  // 10 clean minutes, then a spike print, then clean again
  feedRange(r, 10);
  r.obs(25.5); r.clock.t += 30000;
  let mark = null;
  for (let i = 0; i <= 40 && !mark; i++) { const m = r.obs(PAT[i % 4]); if (m) mark = m; r.clock.t += 30000; }
  assert.ok(mark, 'marks once the spike has aged out of the trailing window');
  assert.ok(mark.ts - T0 >= 25 * M, 'not before the spike left the 15m window');
});

// ---- source tags ----
test('source tags: bot-held beats bot-exited beats watched', () => {
  const held = rig({ isHeld: () => true, wasExited: () => true });
  assert.equal(feedRange(held, 15).source, 'bot-held');
  const exited = rig({ wasExited: () => true });
  assert.equal(feedRange(exited, 15).source, 'bot-exited');
  const plain = rig();
  assert.equal(feedRange(plain, 15).source, 'watched');
});

// ---- episode discipline ----
test('episode ends only on a SUSTAINED exit — one wick out of the zone is not an exit', () => {
  const r = rig();
  const mark = feedRange(r, 15);
  assert.ok(mark);                                       // band mc 20000–20800, half-width 400 → exit zone above 21200
  r.obs(22); r.clock.t += 30000;                         // one sample out (22000)
  assert.equal(r.rw.pendingMints().length, 1);
  r.obs(20.4); r.clock.t += 30000;                       // back inside: the streak resets
  r.obs(22); r.clock.t += 30000;                         // out again — streak 1
  assert.equal(r.rw.pendingMints().length, 1);
  r.obs(22.2); r.clock.t += 30000;                       // out again — streak 2: episode ends
  assert.equal(r.rw.pendingMints().length, 0);
  const ends = r.recs().filter(x => x.type === 'episode-end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].reason, 'exit-up');
  assert.equal(ends[0].episodeId, mark.episodeId);
});

test('episode ends on a sustained breakdown too', () => {
  const r = rig();
  feedRange(r, 15);
  r.obs(19); r.clock.t += 30000;                         // 19000 < 19600 zone floor: streak 1
  r.obs(18.8); r.clock.t += 30000;                       // streak 2: ended
  const ends = r.recs().filter(x => x.type === 'episode-end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].reason, 'exit-down');
});

test('re-mark needs the episode ended AND a fresh full window — no spam off one base', () => {
  const r = rig();
  const m1 = feedRange(r, 15);
  assert.ok(m1);
  r.obs(22); r.clock.t += 30000;
  r.obs(22.2); r.clock.t += 30000;                       // sustained exit-up: episode over
  assert.equal(r.recs().filter(x => x.type === 'episode-end').length, 1);
  // 10 more minutes of perfect ranging: the trailing window still holds
  // pre-exit samples, so no re-mark yet
  assert.equal(feedRange(r, 10, 2), null);
  assert.equal(r.recs().filter(x => x.type === 'mark').length, 1);
  // once the window is entirely post-exit samples, the fresh base marks
  const m2 = feedRange(r, 6, 1);
  assert.ok(m2);
  assert.notEqual(m2.markId, m1.markId);
  assert.equal(r.recs().filter(x => x.type === 'mark').length, 2);
});

test('episode ends stale when the mint leaves the sampling orbit', async () => {
  const r = rig();
  feedRange(r, 15);
  assert.equal(r.rw.pendingMints().length, 1);
  r.clock.t += 31 * M;
  await r.rw.tick(r.clock.t);
  const ends = r.recs().filter(x => x.type === 'episode-end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].reason, 'stale');
  assert.equal(r.rw.pendingMints().length, 0);
});

// ---- restart survival ----
test('restart: the sample ring and an open episode survive via the state file', () => {
  const r = rig();
  feedRange(r, 10);                                      // half a window banked
  const rw2 = new RangeWatch({ cfg: { ...CFG }, journal: r.journal, dir: r.dir, now: () => r.clock.t });
  let mark = null;
  for (let i = 0; i <= 12 && !mark; i++) { const m = rw2.observe(view({ address: MINT, symbol: 'RNG', price: PAT[i % 4], mc: PAT[i % 4] * 1000 }), r.clock.t); if (m) mark = m; r.clock.t += 30000; }
  assert.ok(mark, 'the pre-restart samples still count — the mark fires on the original cycle clock');
  const rw3 = new RangeWatch({ cfg: { ...CFG }, journal: r.journal, dir: r.dir, now: () => r.clock.t });
  assert.equal(rw3.pendingMints().length, 1);            // the open episode survived too
});

// ---- scoring + card ----
function candlesFrom(markTs, markPrice, minutes, gain = 0.1) {
  // 5m candles from 5 min before the mark to `minutes` after it (the
  // bottomwatch rig): closes at markPrice x (1+gain), highs a touch
  // above, lows just under the mark — scoreMark reads r15/r60/r240 off
  // the closes and peakPct off the highs.
  const out = [];
  const start = Math.floor((markTs - 300000) / 1000);
  for (let t = start; t * 1000 <= markTs + minutes * 60000; t += 300) {
    const c = markPrice * (1 + gain);
    out.push([t, markPrice, c * 1.05, markPrice * 0.98, c, 1000]);
  }
  return out;
}

test('scoring: an expanding mark finalizes with its outcome class; the card aggregates it', async () => {
  let markTs = 0, markPrice = 0;
  const r = rig({
    resolvePool: async () => 'POOL',
    fetchCandles: async () => candlesFrom(markTs, markPrice, 420, 0.5),  // closes +50%, highs +57.5% → EXPANDED
  });
  const mark = feedRange(r, 15);
  markTs = mark.ts; markPrice = mark.markPrice;
  await r.rw.tick(r.clock.t);                            // too young: no score yet
  assert.equal(r.recs().filter(x => x.type === 'mark-score').length, 0);
  r.clock.t += 70 * M;
  await r.rw.tick(r.clock.t);
  const scores = r.recs().filter(x => x.type === 'mark-score');
  assert.equal(scores.length, 1);
  assert.equal(scores[0].final, false);
  assert.ok(Math.abs(scores[0].r60 - 0.5) < 1e-9);
  assert.equal(scores[0].outcome, 'expanded');
  const card = r.rw.card();
  assert.equal(card.enabled, true);
  assert.equal(card.marks, 1);
  assert.equal(card.finalized, 1);                      // finalized = r60 present, the house convention
  assert.equal(card.ready, false);
  assert.equal(card.aggregates.expanded, 1);
  assert.equal(card.aggregates.expandedShare, 1);
  assert.equal(card.aggregates.brokeDownShare, 0);
  assert.equal(card.aggregates.medianR60, 0.5);
  assert.equal(card.byTightness.le20.n, 1);              // band 4% ≤ 20
  assert.equal(card.byTightness.gt20.n, 0);
  assert.equal(card.byDuration.lt30.n, 1);               // duration ~14.5m < 30
  assert.equal(card.bySource.watched.n, 1);
  assert.equal(card.recent[0].markId, mark.markId);
  assert.equal(card.recent[0].score.outcome, 'expanded');
  assert.equal(card.windowMin, 15);
  assert.equal(card.minMc, 15000);
  r.clock.t = markTs + 400 * M;
  await r.rw.tick(r.clock.t);                            // r240 fills → final
  const scores2 = r.recs().filter(x => x.type === 'mark-score');
  assert.equal(scores2.length, 2);
  assert.equal(scores2[1].final, true);
  await r.rw.tick(r.clock.t + 10 * M);
  assert.equal(r.recs().filter(x => x.type === 'mark-score').length, 2);
});

test('scoring: a breaking-down mark classes broke-down on the card', async () => {
  let markTs = 0, markPrice = 0;
  const down = (mts, mp, minutes) => {
    const out = [];
    const start = Math.floor((mts - 300000) / 1000);
    for (let t = start; t * 1000 <= mts + minutes * 60000; t += 300) {
      out.push([t, mp, mp * 0.66, mp * 0.55, mp * 0.6, 1000]);   // closes −40%, lows −45%, highs never expand
    }
    return out;
  };
  const r = rig({ resolvePool: async () => 'POOL', fetchCandles: async () => down(markTs, markPrice, 420) });
  const mark = feedRange(r, 15);
  markTs = mark.ts; markPrice = mark.markPrice;
  r.clock.t += 70 * M;
  await r.rw.tick(r.clock.t);
  const scores = r.recs().filter(x => x.type === 'mark-score');
  assert.equal(scores.length, 1);
  assert.equal(scores[0].outcome, 'broke-down');
  assert.ok(Math.abs(scores[0].r60 + 0.4) < 1e-9);
  const card = r.rw.card();
  assert.equal(card.aggregates.brokeDown, 1);
  assert.equal(card.aggregates.brokeDownShare, 1);
});

test('card: empty journal reads as a zeroed, not-ready card', () => {
  const r = rig();
  const card = r.rw.card();
  assert.equal(card.marks, 0);
  assert.equal(card.finalized, 0);
  assert.equal(card.ready, false);
  assert.equal(card.aggregates.medianPeak, null);
  assert.equal(card.aggregates.expandedShare, null);
  assert.equal(RANGE_READY_N, 30);
  const folded = foldRangeJournal([]);
  assert.equal(folded.marks.size, 0);
  assert.equal(buildRangeCard([], Date.now()).marks, 0);
});

// ---- kill switch ----
test('kill switch: RANGE_WATCH=0 — no observing, no records, card off', async () => {
  const r = rig({ cfgOver: { rangeWatch: 0 } });
  feedRange(r, 20);
  await r.rw.tick(r.clock.t);
  assert.equal(r.recs().length, 0);
  assert.equal(r.rw.pendingMints().length, 0);
  assert.deepEqual(r.rw.card(), { enabled: false });
  assert.equal(fs.existsSync(path.join(r.dir, 'range_watch_state.json')), false);
});

// ---- inertness pin (Bot level) ----
test('inertness: feeding the study never signals, never positions, writes only its own file', () => {
  const mk = (env) => {
    const cfg = testCfg({ fastPop: 0, dipStopPct: 0 }, env);
    const clock = { t: T0 };
    const exec = { solBalance: async () => 5, markValue: async () => 0, sell: async () => ({ tokensSold: '0', solOut: 0, sig: null, simulated: true }), closeEmptyAccounts: async () => {} };
    const bot = new Bot(cfg, { now: () => clock.t, exec, discover: async () => new Map(), fetchViews: async () => new Map(), fetchSolUsd: async () => 150, fetchRug: async () => null, searchByName: async () => [] });
    return { cfg, bot, clock };
  };
  const feed = ({ bot, clock }) => {
    for (let i = 0; i <= 32; i++) {
      const price = PAT[i % 4];
      bot.rangeWatch.observe(view({ address: MINT, symbol: 'RNG', price, mc: price * 1000 }), clock.t);
      clock.t += 30000;
    }
  };
  const on = mk({});                        // RANGE_WATCH defaults on
  feed(on);
  const rwFile = path.join(on.cfg.dataDir, 'range_marks.jsonl');
  assert.ok(fs.existsSync(rwFile));
  assert.ok(fs.readFileSync(rwFile, 'utf8').includes('"mark"'));
  assert.ok(on.bot.rangeWatchCard().marks >= 1);
  // ...and nothing else moved: no signals, no trades, no positions
  assert.equal(on.bot.journal.signals.length, 0);
  assert.equal(on.bot.journal.trades.length, 0);
  assert.equal(on.bot.positions.length, 0);
  assert.equal(on.bot.stats.signals, 0);
  assert.equal(on.bot.stats.entries, 0);

  const off = mk({ RANGE_WATCH: '0' });
  feed(off);
  assert.equal(fs.existsSync(path.join(off.cfg.dataDir, 'range_marks.jsonl')), false);
  assert.deepEqual(off.bot.rangeWatchCard(), { enabled: false });
  assert.equal(off.bot.journal.signals.length, 0);
  assert.equal(off.bot.positions.length, 0);

  // a signal journaled beside the study is byte-identical on vs off
  const sigArgs = { mint: MINT, symbol: 'RNG', setup: 'pop', decision: 'skipped', reasons: ['test'], price: 1, mc: 1000 };
  on.bot.journal.signal(sigArgs);
  off.bot.journal.signal(sigArgs);
  const read = (cfg) => fs.readFileSync(path.join(cfg.dataDir, 'signals.jsonl'), 'utf8').trim();
  assert.equal(read(on.cfg), read(off.cfg));
});

// ---- RANGE LIVE (owner correction 2026-10-16: "None of this is shadow
// btw — Real"): a range mark ALSO routes a live entry attempt through
// the standard pipeline (Bot._evalRange, the _evalStaircase guard shape).
// These tests pin the routing and its guards — kill switch, already-
// held, per-mint signal cooldown, missing view + retry, eligible()
// floor — not the gates downstream of onSignal.
const RMARK = { type: 'mark', ts: T0, mint: MINT, symbol: 'RNG', markId: 'rw-RangeM-1-m1', episodeId: 'rw-RangeM-1', bandPct: 4, tightness: 0.114, durationMin: 14.5, rangeHi: 20800, rangeLo: 20000, rangeMid: 20400, markMc: 20800, markPrice: 20.8 };

function liveRig(over = {}, env = {}) {
  const cfg = testCfg({ ...over }, env);
  const clock = { t: T0 };
  const views = new Map();
  const exec = new Executor(cfg, { quote: async () => ({ outAmount: '1000000000', priceImpactPct: '0.01' }) });
  const bot = new Bot(cfg, {
    now: () => clock.t, exec,
    discover: async () => Object.assign(new Map(), { counts: {} }),
    fetchViews: async (mints) => new Map(mints.filter(m => views.has(m)).map(m => [m, views.get(m)])),
    fetchSolUsd: async () => 150, fetchRug: async () => null, searchByName: async () => [],
  });
  const calls = [];
  bot.onSignal = async (v, sig) => { calls.push({ v, sig }); };
  // ENROLLMENT GATE (owner decision 2026-10-16 23:16 EDT): a range entry
  // routes only for a NOMINATED mint — these routing tests judge the
  // routing, so the mint stands enrolled by a prior pop signal.
  bot.baseEnrolled.set(MINT, { setup: 'pop', ts: T0 });
  views.set(MINT, view({ address: MINT, symbol: 'RNG', mc: 20400 }));
  return { bot, clock, views, calls };
}
const flush = async () => { await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); };
function feedBotRange(bot, clock, minutes, startIdx = 0) {
  for (let i = 0; i <= Math.round(minutes * 2); i++) {
    const price = PAT[(startIdx + i) % 4];
    bot.rangeWatch.observe(view({ address: MINT, symbol: 'RNG', price, mc: price * 1000 }), clock.t);
    clock.t += 30000;
  }
}

test('range live: a qualifying mark routes ONE range signal into onSignal, mark context carried', async () => {
  const { bot, clock, calls } = liveRig();
  feedBotRange(bot, clock, 15);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sig.setup, 'range');
  assert.equal(calls[0].sig.metrics.range.markId, 'rw-RangeM-' + (T0 + 15 * M) + '-m1');
  assert.equal(calls[0].sig.metrics.range.bandPct, 4);
  assert.equal(calls[0].sig.metrics.range.durationMin, 14.5);
  assert.equal(bot.stats.range.evals, 1);
  assert.equal(bot.lastSignal.get(MINT), T0 + 15 * M);
  // the study layer is untouched: the mark journaled exactly as the shadow design wrote it
  const recs = fs.readFileSync(path.join(bot.cfg.dataDir, 'range_marks.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.equal(recs.filter(x => x.type === 'mark').length, 1);
});

test('range live: judged at the mark moment — later expansion never re-judges', async () => {
  const { bot, clock, calls } = liveRig();
  feedBotRange(bot, clock, 15);
  await flush();
  assert.equal(calls.length, 1);
  // the coin now moons out of the range: no second eval, ever — the one
  // mark per episode was the only trigger
  for (const p of [26, 34, 45, 60, 80]) { bot.rangeWatch.observe(view({ address: MINT, symbol: 'RNG', price: p, mc: p * 1000 }), clock.t); clock.t += 30000; }
  feedBotRange(bot, clock, 10, 1);   // and ranges again afterwards — still no re-judge (episode/rearm discipline)
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(bot.stats.range.evals, 1);
});

test('range live: RANGE_LIVE=0 reverts to the pure study — marks journal, zero signals, no evals', async () => {
  const { bot, clock, calls } = liveRig({}, { RANGE_LIVE: '0' });
  feedBotRange(bot, clock, 15);
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(bot.stats.range, undefined);
  assert.equal(bot.journal.signals.length, 0);
  const recs = fs.readFileSync(path.join(bot.cfg.dataDir, 'range_marks.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.equal(recs.filter(x => x.type === 'mark').length, 1);   // the study half is fully intact
  // and a signal journaled beside it is byte-identical to the live bot's
  const on = liveRig();
  on.clock.t = clock.t;   // same journal clock — the records, not the clocks, are what is compared
  const sigArgs = { mint: MINT, symbol: 'RNG', setup: 'pop', decision: 'skipped', reasons: ['test'], price: 1, mc: 1000 };
  bot.journal.signal(sigArgs);
  on.bot.journal.signal(sigArgs);
  const read = (cfg) => fs.readFileSync(path.join(cfg.dataDir, 'signals.jsonl'), 'utf8').trim();
  assert.equal(read(bot.cfg), read(on.bot.cfg));
});

test('range live: kill switch via cfg — no eval, no call', async () => {
  const { bot, calls } = liveRig({ rangeLive: 0 });
  bot._evalRange(RMARK);
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(bot.stats.range, undefined);
});

test('range live: already holding the mint — no eval routed', async () => {
  const { bot, calls } = liveRig();
  bot.positions.push({ mint: MINT, symbol: 'RNG' });
  bot._evalRange(RMARK);
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(bot.stats.range.evals, 1);   // evaluated, refused at the held guard
});

test('range live: per-mint signal cooldown suppresses a re-judge inside the window', async () => {
  const { bot, clock, calls } = liveRig();
  bot._evalRange(RMARK);
  await flush();
  assert.equal(calls.length, 1);
  clock.t += 60000; // 1m later — inside the 10m signal cooldown
  bot._evalRange({ ...RMARK, markId: 'rw-RangeM-2-m1', episodeId: 'rw-RangeM-2' });
  await flush();
  assert.equal(calls.length, 1);
  clock.t += 10 * 60000; // cooldown over — a fresh mark judges fresh
  bot._evalRange({ ...RMARK, markId: 'rw-RangeM-3-m1', episodeId: 'rw-RangeM-3' });
  await flush();
  assert.equal(calls.length, 2);
});

test('range live: missing view queues a retry instead of dropping the mark', async () => {
  const { bot, views, calls } = liveRig();
  views.delete(MINT);
  bot._evalRange(RMARK);
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(bot.stats.range.noView, 1);
  assert.ok(bot.rangePending.has(MINT), 'mark is queued for retry, not dropped');
});

test('range live: retry tick lands the eval once the view appears', async () => {
  const { bot, clock, views, calls } = liveRig();
  views.delete(MINT);
  bot._evalRange(RMARK);
  await flush();
  views.set(MINT, view({ address: MINT, symbol: 'RNG', mc: 20400 }));
  clock.t += 20000; // first retry slot
  await bot._rangeRetryTick(clock.t);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sig.setup, 'range');
  assert.equal(bot.rangePending.has(MINT), false);
  assert.equal(bot.stats.range.retries, 1);
});

test('range live: a mark that never gets a view expires after 5 minutes, counted once', async () => {
  const { bot, clock, views, calls } = liveRig();
  views.delete(MINT);
  bot._evalRange(RMARK);
  await flush();
  clock.t += 5 * 60000 + 1;
  await bot._rangeRetryTick(clock.t);
  assert.equal(calls.length, 0);
  assert.equal(bot.rangePending.has(MINT), false);
  assert.equal(bot.stats.range.noViewFinal, 1);
});

test('range live: eligible() failure tallies silently (no signal card since the 2026-10-18 declutter order), no onSignal', async () => {
  const { bot, views, calls } = liveRig();
  views.set(MINT, view({ address: MINT, symbol: 'RNG', chgH1: -80 })); // dead bounce — fails the tradability floor
  bot._evalRange(RMARK);
  await flush();
  assert.equal(calls.length, 0);
  const recs = bot.journal.signals.filter(s => s.setup === 'range');
  assert.equal(recs.length, 0);
  assert.equal(bot.stats.baseMode.rangeSkips.byKind.eligible, 1);
  assert.equal(bot.stats.baseMode.rangeSkips.total, 1);
});

test('range live: the card notes live routing (evals + fired/taken) while aggregates stay mark-based', async () => {
  const { bot, views } = liveRig();
  views.set(MINT, view({ address: MINT, symbol: 'RNG', chgH1: -80 }));
  bot._evalRange(RMARK);
  await flush();
  const card = bot.rangeWatchCard();
  assert.equal(card.liveRouting.live, true);
  assert.equal(card.liveRouting.evals, 1);
  assert.equal(card.liveRouting.signals, 0);   // the eligible-floor verdict tallies silently now — no journaled range signal
  assert.equal(card.liveRouting.taken, 0);
  assert.equal(card.marks, 0);                 // aggregates still judge marks only — the direct eval wrote none
  const off = liveRig({}, { RANGE_LIVE: '0' });
  assert.equal(off.bot.rangeWatchCard().liveRouting.live, false);
});
