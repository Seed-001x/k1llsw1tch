// PRE-ENTRY CENSUS (owner order 2026-10-18, "it should work both ways"):
// a QUALIFIED bottom mark no longer buys on sight — the mint first takes a
// PREENTRY_WINDOW_SEC wallet-census watch, and a CLEAR puppet tape vetoes
// the entry live: absorption (buy counts dominate while price falls hard
// through the watch — the OPEQ signature) or manufactured (heavy churn
// from a handful of wallets with a high wash share). Everything else —
// including thin data — passes (fail-open). These tests pin the pure
// evaluator, then the pipeline: watch starts instead of a buy, veto ->
// skipped signal journaled, pass -> onSignal with the census read
// stamped, PREENTRY_CENSUS=0 restores the direct route, and
// PREENTRY_CENSUS_VETO=0 keeps the watch but stamps the would-veto.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bot.js';
import { loadConfig } from '../src/config.js';
import { evaluatePreEntry, preEntryReason } from '../src/preEntry.js';
import { testCfg, view } from './helpers.mjs';

const T0 = 1_000_000_000_000;
const CFG = loadConfig({});

// ------------------------------------------------------------ evaluator
test('preentry evaluator: absorption — buy counts dominate while price falls hard -> veto', () => {
  const r = evaluatePreEntry({ win: { buys: 45, sells: 16, uniqBuyers: 32, uniqSellers: 13, newBuyers: 32, wash: 6, tradesTotal: 61 }, startPrice: 100, minPrice: 85, endPrice: 88, cfg: CFG });
  assert.equal(r.veto, true);
  assert.equal(r.why, 'absorption');
  assert.equal(r.read.dropPct, 15);
});

test('preentry evaluator: an honest dump (sellers dominate the fall) is NOT the veto\'s business', () => {
  const r = evaluatePreEntry({ win: { buys: 10, sells: 40, uniqBuyers: 9, uniqSellers: 30, newBuyers: 9, wash: 1, tradesTotal: 50 }, startPrice: 100, minPrice: 84, endPrice: 86, cfg: CFG });
  assert.equal(r.veto, false);
  assert.equal(r.why, 'clean');
});

test('preentry evaluator: manufactured churn — few wallets, heavy trades, high wash -> veto', () => {
  const r = evaluatePreEntry({ win: { buys: 30, sells: 28, uniqBuyers: 3, uniqSellers: 3, newBuyers: 3, wash: 3, tradesTotal: 58 }, startPrice: 100, minPrice: 99, endPrice: 100, cfg: CFG });
  assert.equal(r.veto, true);
  assert.equal(r.why, 'manufactured');
  assert.equal(r.read.washShare, 1);
});

test('preentry evaluator: narrow but CLEAN (no wash) passes — narrow alone is not a puppet', () => {
  const r = evaluatePreEntry({ win: { buys: 30, sells: 28, uniqBuyers: 3, uniqSellers: 3, newBuyers: 3, wash: 0, tradesTotal: 58 }, startPrice: 100, minPrice: 99, endPrice: 100, cfg: CFG });
  assert.equal(r.veto, false);
});

test('preentry evaluator: broad + holding passes; thin data fails open', () => {
  const broad = evaluatePreEntry({ win: { buys: 40, sells: 25, uniqBuyers: 30, uniqSellers: 18, newBuyers: 22, wash: 2, tradesTotal: 65 }, startPrice: 100, minPrice: 98, endPrice: 104, cfg: CFG });
  assert.equal(broad.veto, false);
  assert.equal(broad.why, 'clean');
  const thin = evaluatePreEntry({ win: { buys: 3, sells: 2, uniqBuyers: 3, uniqSellers: 2, newBuyers: 3, wash: 0, tradesTotal: 5 }, startPrice: 100, minPrice: 80, endPrice: 82, cfg: CFG });
  assert.equal(thin.veto, false);
  assert.equal(thin.why, 'thin');
  const none = evaluatePreEntry({ win: null, startPrice: 100, minPrice: 80, endPrice: 82, cfg: CFG });
  assert.equal(none.veto, false);
  assert.equal(none.why, 'thin');
});

test('preentry evaluator: reason strings name the signature and the numbers', () => {
  const a = preEntryReason({ why: 'absorption', read: { buys: 45, sells: 16, dropPct: 15, trades: 61, uniqBuyers: 32, washShare: 0.19 } });
  assert.ok(a.startsWith('preentry-veto: absorption'));
  assert.ok(a.includes('45 buys vs 16 sells'));
  const m = preEntryReason({ why: 'manufactured', read: { buys: 30, sells: 28, dropPct: 1, trades: 58, uniqBuyers: 3, washShare: 1 } });
  assert.ok(m.startsWith('preentry-veto: manufactured'));
  assert.ok(m.includes('3 unique buyers'));
});

// ------------------------------------------------------------ pipeline
const BMARK = { type: 'mark', ts: T0, markId: 'bw-MINTB-1-m1', episodeId: 'bw-MINTB-1', mint: 'MINTB', symbol: 'BOTM', source: 'watched', qualified: true, peakPrice: 2, peakMc: 100_000, lowPrice: 1, lowMc: 50_000, lowTs: T0 - 600000, drawdownPct: 50, quietSec: 300, markPrice: 1.2, markMc: 60_000, pctOffLow: 20, pctOfPeakRecovered: 60, flowKnown: true, buysM5: 30, sellsM5: 10, buyShare: 0.75 };

function preRig(env = {}, cfgOver = {}) {
  const cfg = testCfg({ tradeSol: 0.02, ...cfgOver }, env);
  const clock = { t: T0 };
  const views = new Map();
  const bot = new Bot(cfg, {
    now: () => clock.t,
    discover: async () => Object.assign(new Map(), { counts: {} }),
    fetchViews: async (mints) => new Map(mints.filter(m => views.has(m)).map(m => [m, views.get(m)])),
    fetchSolUsd: async () => 150, fetchRug: async () => null, searchByName: async () => [],
  });
  const calls = [];
  bot.onSignal = async (v, sig) => { calls.push({ v, sig }); };
  views.set('MINTB', view({ address: 'MINTB', symbol: 'BOTM', price: 100 }));
  return { bot, clock, views, calls };
}
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };

function feed(bot, mint, side, n, walletPrefix, startIdx = 0) {
  for (let i = 0; i < n; i++) bot._censusOnTrade(mint, { trader: walletPrefix + (startIdx + i), side, tokens: 1000, ts: bot.now() });
}

test('preentry pipeline: a qualified bottom mark starts a WATCH, not a buy', async () => {
  const { bot, calls } = preRig();
  bot._evalBottom(BMARK);
  await flush();
  assert.equal(calls.length, 0);
  assert.ok(bot.preEntryWatch.has('MINTB'));
  assert.equal(bot.stats.preEntry.watched, 1);
});

test('preentry pipeline: absorption tape vetoes — skipped signal journaled, no buy', async () => {
  const { bot, clock, views, calls } = preRig();
  bot._evalBottom(BMARK);
  await flush();
  feed(bot, 'MINTB', 'buy', 30, 'buyer');
  feed(bot, 'MINTB', 'sell', 12, 'seller');
  views.set('MINTB', view({ address: 'MINTB', symbol: 'BOTM', price: 86 }));
  clock.t += 200_000;
  await bot._preEntryTick(clock.t);
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(bot.stats.preEntry.vetoed, 1);
  const rec = bot.journal.signals.at(-1);
  assert.equal(rec.decision, 'skipped');
  assert.ok(rec.reasons.some(r => r.startsWith('preentry-veto: absorption')), JSON.stringify(rec.reasons));
  assert.equal(bot.preEntryWatch.size, 0);
});

test('preentry pipeline: clean broad tape passes — buy routes with the census read stamped', async () => {
  const { bot, clock, views, calls } = preRig();
  bot._evalBottom(BMARK);
  await flush();
  feed(bot, 'MINTB', 'buy', 30, 'buyer');
  feed(bot, 'MINTB', 'sell', 18, 'seller');
  views.set('MINTB', view({ address: 'MINTB', symbol: 'BOTM', price: 103 }));
  clock.t += 200_000;
  await bot._preEntryTick(clock.t);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sig.setup, 'bottom');
  assert.equal(calls[0].sig.structureLow, 50_000); // the episode low rides through the watch untouched
  assert.equal(calls[0].sig.metrics.preEntry.uniqBuyers, 30);
  assert.equal(bot.stats.preEntry.passed, 1);
});

test('preentry pipeline: thin tape fails open — the buy still routes', async () => {
  const { bot, clock, calls } = preRig();
  bot._evalBottom(BMARK);
  await flush();
  feed(bot, 'MINTB', 'buy', 3, 'buyer');
  clock.t += 200_000;
  await bot._preEntryTick(clock.t);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(bot.stats.preEntry.thin, 1);
  assert.equal(bot.stats.preEntry.passed, 1);
});

test('preentry pipeline: PREENTRY_CENSUS=0 restores the direct route exactly', async () => {
  const { bot, calls } = preRig({ PREENTRY_CENSUS: '0' });
  bot._evalBottom(BMARK);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(bot.preEntryWatch, undefined);
});

test('preentry pipeline: PREENTRY_CENSUS_VETO=0 stamps the would-veto and still buys', async () => {
  const { bot, clock, views, calls } = preRig({ PREENTRY_CENSUS_VETO: '0' });
  bot._evalBottom(BMARK);
  await flush();
  feed(bot, 'MINTB', 'buy', 30, 'buyer');
  feed(bot, 'MINTB', 'sell', 12, 'seller');
  views.set('MINTB', view({ address: 'MINTB', symbol: 'BOTM', price: 86 }));
  clock.t += 200_000;
  await bot._preEntryTick(clock.t);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sig.metrics.preEntry.wouldVeto, 'absorption');
  assert.equal(bot.stats.preEntry.vetoed || 0, 0);
});

// ------------------------------------------------------------ one-sided (owner order 2026-10-19, the Rockstar tape)
test('preentry evaluator: one-sided by ratio — sells >= 10x buys vetoes even with many unique buyers', () => {
  const r = evaluatePreEntry({ win: { buys: 5, sells: 60, uniqBuyers: 20, uniqSellers: 40, newBuyers: 20, wash: 0, tradesTotal: 65 }, startPrice: 100, minPrice: 99, endPrice: 100, cfg: CFG });
  assert.equal(r.veto, true);
  assert.equal(r.why, 'one-sided');
  assert.equal(r.read.sellBuyRatio, 12);
});

test('preentry evaluator: one-sided by single buyer — uniqBuyers=1 vetoes a balanced-count tape', () => {
  const r = evaluatePreEntry({ win: { buys: 8, sells: 6, uniqBuyers: 1, uniqSellers: 5, newBuyers: 1, wash: 0, tradesTotal: 14 }, startPrice: 100, minPrice: 99, endPrice: 100, cfg: CFG });
  assert.equal(r.veto, true);
  assert.equal(r.why, 'one-sided');
});

test('preentry evaluator: the Rockstar census shape (1 buy / 899 sells / 1 unique buyer) vetoes one-sided', () => {
  const r = evaluatePreEntry({ win: { buys: 1, sells: 899, uniqBuyers: 1, uniqSellers: 500, newBuyers: 1, wash: 0, tradesTotal: 1724 }, startPrice: 100, minPrice: 3, endPrice: 4, cfg: CFG });
  assert.equal(r.veto, true);
  assert.equal(r.why, 'one-sided', 'not absorption (buys do not dominate) and not manufactured (wash share 0)');
});

test('preentry evaluator: a heavy but two-sided tape stays clean (9:1 sells, many buyers)', () => {
  const r = evaluatePreEntry({ win: { buys: 5, sells: 45, uniqBuyers: 20, uniqSellers: 30, newBuyers: 20, wash: 0, tradesTotal: 50 }, startPrice: 100, minPrice: 90, endPrice: 92, cfg: CFG });
  assert.equal(r.veto, false);
  assert.equal(r.why, 'clean');
});

test('preentry evaluator: one-sided reason string names the signature and the numbers', () => {
  const s = preEntryReason({ why: 'one-sided', read: { buys: 5, sells: 60, trades: 65, uniqBuyers: 20, washShare: 0, dropPct: 1 } });
  assert.ok(s.startsWith('preentry-veto: one-sided'));
  assert.ok(s.includes('60 sells vs 5 buys'));
  assert.ok(s.includes('20 unique buyers'));
});

test('preentry pipeline: Rockstar-shaped tape (one buyer wallet, a wall of distinct sellers) vetoes — skipped signal journaled', async () => {
  const { bot, clock, views, calls } = preRig();
  bot._evalBottom(BMARK);
  await flush();
  // 2 buys, both from ONE wallet; 30 sells from 30 distinct wallets; price flat.
  bot._censusOnTrade('MINTB', { trader: 'lone-buyer', side: 'buy', tokens: 1000, ts: bot.now() });
  bot._censusOnTrade('MINTB', { trader: 'lone-buyer', side: 'buy', tokens: 1000, ts: bot.now() });
  feed(bot, 'MINTB', 'sell', 30, 'seller');
  views.set('MINTB', view({ address: 'MINTB', symbol: 'BOTM', price: 100 }));
  clock.t += 200_000;
  await bot._preEntryTick(clock.t);
  await flush();
  assert.equal(calls.length, 0, 'no buy may route');
  assert.equal(bot.stats.preEntry.vetoed, 1);
  const rec = bot.journal.signals.at(-1);
  assert.equal(rec.decision, 'skipped');
  assert.ok(rec.reasons.some(r => r.startsWith('preentry-veto: one-sided')), JSON.stringify(rec.reasons));
});
