import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { SOL_MINT } from '../src/util.js';
import { tmp, testCfg, view } from './helpers.mjs';

// POP LIVE FLIP (owner order 2026-10-22 19:48 EDT, "pop off, staircase
// only" — after a day where every open was a pop and the clip closes
// summed ≈ −0.27): POP_LIVE=0 routes pop through shadow exactly like
// TREND_LIVE=0 does trend — signals are journaled, gate-evaluated and
// outcome-tracked, virtual shadow trades included, but never bought.
// POP_LIVE absent from a hand-built cfg keeps pop live (historical).
const T0 = 1_000_000_000_000;
const healthyRug = { token: { supply: 1e15, decimals: 6 }, creatorBalance: 0, totalHolders: 2000, graphInsidersDetected: 0, markets: [{ pubkey: 'POOL', lp: { base: 1e8, quote: 1400, lpLockedUSD: 3e5, lpLockedPct: 100 } }], knownAccounts: { POOL: { type: 'AMM' } }, topHolders: Array.from({ length: 12 }, (_, i) => ({ owner: 'h' + i, address: 'h' + i, amount: 9e12 - i * 3.1e10, pct: 2 })), insiderNetworks: [] };

function seedHistory(bot, mint, price = 1) {
  const samples = [];
  for (let k = 0; k < 12; k++) samples.push({ ts: T0 - (11 - k) * 30000, price, mc: 500_000, volM5: 100_000, volH1: 500_000, buysM5: 900, sellsM5: 800, liq: 100_000 });
  bot.history.m.set(mint, samples);
}

function pipelineRig({ cfgOver = {}, env = {} } = {}) {
  const cfg = testCfg({ tradeSol: 0.02, enrollSignals: 0, ...cfgOver }, env);
  const clock = { t: T0 };
  const q = { valueLam: 19_000_000 };
  const quote = async (input, _o, amount) => (input === SOL_MINT
    ? { outAmount: '1000000000', priceImpactPct: '0.01' }
    : { outAmount: String(Math.floor(q.valueLam * (Number(amount) / 1e9))) });
  const exec = new Executor(cfg, { quote });
  const views = new Map();
  const bot = new Bot(cfg, {
    now: () => clock.t, exec,
    discover: async () => Object.assign(new Map(), { counts: {} }),
    fetchViews: async (mints) => new Map(mints.filter(m => views.has(m)).map(m => [m, views.get(m)])),
    fetchSolUsd: async () => 150, fetchRug: async () => healthyRug, searchByName: async () => [],
  });
  return { bot, clock, views, exec };
}

async function firePop(rig, mint = 'POP1') {
  // 100 minutes old: young, and past the 60m blind fast-bond window.
  const v = view({ address: mint, symbol: 'POPPY', mc: 500_000, liq: 100_000, createdAt: T0 - 100 * 60000, dex: 'pumpswap' });
  rig.views.set(mint, v);
  await rig.bot.start();
  seedHistory(rig.bot, mint);
  await rig.bot.onSignal(v, { setup: 'pop', strength: 42, metrics: { gainPct: 42, drawFromPeak: 0, buyRatioM5: 0.75, volH1: 500_000, volM5: 100_000 } });
  return rig.bot.journal.signals.at(-1);
}

test('config: POP_LIVE defaults on, env 0 turns it off, config validates', () => {
  assert.equal(loadConfig({}).popLive, true);
  assert.equal(loadConfig({ POP_LIVE: '0' }).popLive, false);
  assert.deepEqual(validateConfig(loadConfig({})), []);
});

test('bot: POP_LIVE=0 shadows pop — journaled and tracked, never bought', async () => {
  const rig = pipelineRig({ cfgOver: { popLive: false } });
  const rec = await firePop(rig);
  assert.equal(rec.decision, 'shadow', JSON.stringify(rec.reasons));
  assert.equal(rig.bot.positions.length, 0);
  assert.equal(rig.bot.stats.entries || 0, 0);
  assert.equal(rig.bot.stats.shadowSignals.pop, 1);
});

test('bot: POP_LIVE on takes the same pop signal live', async () => {
  const rig = pipelineRig();
  const rec = await firePop(rig);
  assert.equal(rec.decision, 'taken', JSON.stringify(rec.reasons));
  assert.equal(rig.bot.positions.length, 1);
});
