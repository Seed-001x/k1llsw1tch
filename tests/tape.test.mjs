import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { loadConfig } from '../src/config.js';
import { tapeWindow } from '../src/detect.js';
import { SOL_MINT } from '../src/util.js';
import { testCfg, view } from './helpers.mjs';

// FRESH TAPE AT JUDGMENT (owner order 2026-10-23 01:15 EDT, the yagi
// lag): a live judgment reads a fresh re-read of the mint plus the
// bot's OWN stream tape, never the poll sweep's aging snapshot alone.
// On 2026-10-22 the staircase judged yagi on a volM5 stamp of $4,113
// while the pool's real 5m tape was ~$8.6K, and the runner lane
// failed it at $13,818 against a ~$15K tape — false-dead readings
// from a stale ruler. These tests pin the tape ruler and the merge.
const T0 = 1_000_000_000_000;
const trades = (n, { at = T0, sol = 0.5, buys = true } = {}) => Array.from({ length: n }, (_, i) => ({ ts: at - i * 5000, price: 1, side: buys && i % 3 ? 'buy' : 'sell', sol }));

test('tapeWindow: sums the trailing 5m in USD and counts sides', () => {
  const buf = trades(10, { at: T0 }); // 10 trades x 0.5 SOL over the last ~50s
  const tw = tapeWindow(buf, T0, { solUsd: 200 });
  assert.equal(tw.covered, true);
  assert.equal(tw.trades, 10);
  assert.equal(tw.volUsd, 1000); // 5 SOL x $200
  assert.ok(tw.buys > tw.sells);
});

test('tapeWindow: old or sparse tape is not coverage', () => {
  const stale = trades(10, { at: T0 - 120000 }); // newest trade 2m old
  assert.equal(tapeWindow(stale, T0, { solUsd: 200 }).covered, false);
  const sparse = trades(2, { at: T0 });
  const tw = tapeWindow(sparse, T0, { solUsd: 200 });
  assert.equal(tw.covered, false);
  assert.equal(tw.volUsd, 200); // the sum is still reported for the record
  assert.equal(tapeWindow([], T0, { solUsd: 200 }).covered, false);
  assert.equal(tapeWindow(trades(5), T0, { solUsd: null }).volUsd, null);
  const outside = [...trades(3, { at: T0 }), ...trades(4, { at: T0 - 400000 })]; // 4 trades outside the 5m window
  assert.equal(tapeWindow(outside, T0, { solUsd: 200 }).trades, 3);
});

function botRig({ cfgOver = {}, env = {} } = {}) {
  const cfg = testCfg({ ...cfgOver }, env);
  const clock = { t: T0 };
  const quote = async (input) => ({ outAmount: input === SOL_MINT ? '1000000000' : '19000000', priceImpactPct: '0.01' });
  const exec = new Executor(cfg, { quote });
  const views = new Map();
  const bot = new Bot(cfg, {
    now: () => clock.t, exec,
    discover: async () => Object.assign(new Map(), { counts: {} }),
    fetchViews: async (mints) => new Map(mints.filter(m => views.has(m)).map(m => [m, views.get(m)])),
    fetchSolUsd: async () => 200, fetchRug: async () => null, searchByName: async () => [],
  });
  return { bot, clock, views };
}

test('bot _liveView: the stream tape lifts a stale volM5 stamp, and the record shows all three rulers', async () => {
  const { bot } = botRig();
  bot._solUsdCache = { at: T0, val: 200 };
  bot.streamBuf.set('M1', trades(20, { at: T0, sol: 1 })); // 20 SOL x $200 = $4,000 of stream tape
  const v = view({ address: 'M1', volM5: 1500, buysM5: 3, sellsM5: 9 });
  const sig = { setup: 'pop', metrics: {} };
  const eff = await bot._liveView(v, sig, T0, { fetch: false });
  assert.equal(eff.volM5, 4000);
  assert.equal(eff.buysM5 + eff.sellsM5, 20);
  assert.deepEqual(sig.metrics.tape, { viewVolM5: 1500, freshVolM5: null, streamVolM5: 4000, usedVolM5: 4000 });
  assert.equal(bot.stats.freshRead.tapeUsed, 1);
});

test('bot _liveView: a livelier view is never adjusted down; FRESH_READ=0 and absent knob are byte-identical', async () => {
  const { bot } = botRig();
  bot._solUsdCache = { at: T0, val: 200 };
  bot.streamBuf.set('M1', trades(4, { at: T0, sol: 0.1 })); // $80 of tape
  const v = view({ address: 'M1', volM5: 9000 });
  const eff = await bot._liveView(v, { setup: 'pop', metrics: {} }, T0, { fetch: false });
  assert.equal(eff.volM5, 9000);
  const off = botRig({ cfgOver: { freshRead: false } });
  const v2 = view({ address: 'M1', volM5: 1500 });
  assert.equal(await off.bot._liveView(v2, { setup: 'pop', metrics: {} }, T0, { fetch: true }), v2);
});

test('bot _liveView: the fresh re-read replaces the sweep snapshot TAPE fields only — price/mc stay the signal-time view (25s cache shares one fetch)', async () => {
  const { bot, views } = botRig();
  let fetches = 0;
  bot.d.fetchViews = async (mints) => { fetches++; return new Map(mints.filter(m => views.has(m)).map(m => [m, views.get(m)])); };
  views.set('M1', view({ address: 'M1', volM5: 8600, price: 2, mc: 860000 }));
  const stale = view({ address: 'M1', volM5: 4113, price: 1.8, mc: 744000 });
  const sig = { setup: 'pop', metrics: {} };
  const eff = await bot._liveView(stale, sig, T0, { fetch: true });
  assert.equal(eff.volM5, 8600);
  // price/mc are NOT swapped: the price-based vetoes (shallow-dip,
  // extension) are defined on the signal-time view vs sampled history.
  assert.equal(eff.price, 1.8);
  assert.equal(eff.mc, 744000);
  assert.equal(sig.metrics.tape.freshVolM5, 8600);
  const again = await bot._liveView(stale, { setup: 'pop', metrics: {} }, T0 + 10000, { fetch: true });
  assert.equal(again.volM5, 8600);
  assert.equal(fetches, 1); // the burst shared one re-read
  assert.equal(bot.stats.freshRead.hits, 1);
});

test('bot noteTrade: the stream buffer now retains a full 6 minutes for the tape ruler', () => {
  const { bot, clock } = botRig();
  clock.t = T0;
  bot.noteTrade('M1', { ts: T0, price: 1, side: 'buy', sol: 1 });
  clock.t = T0 + 330000; // 5.5 minutes later: a new print must NOT prune the 5.5m-old trade (old cutoff was ~2.5m)
  bot.noteTrade('M1', { ts: T0 + 330000, price: 1, side: 'buy', sol: 1 });
  assert.equal(bot.streamBuf.get('M1').length, 2);
  clock.t = T0 + 400000; // at 6m40s the first trade is outside even the new retention
  bot.noteTrade('M1', { ts: T0 + 400000, price: 1, side: 'buy', sol: 1 });
  assert.deepEqual(bot.streamBuf.get('M1').map(t => t.ts), [T0 + 330000, T0 + 400000]);
});

test('config: FRESH_READ defaults on, FRESH_READ=0 turns it off', () => {
  assert.equal(loadConfig({}).freshRead, true);
  assert.equal(loadConfig({ FRESH_READ: '0' }).freshRead, false);
});
