import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { SOL_MINT } from '../src/util.js';
import { testCfg, view } from './helpers.mjs';

// CURL LIVE FLIP (owner order 2026-10-23 01:15 EDT, "build the package
// AND the curl door together — let's see how it does"): CURL_LIVE=0
// routes curl through shadow exactly like POP_LIVE=0 does pop —
// journaled, gate-evaluated and outcome-tracked, but never bought.
// CURL_LIVE absent from a hand-built cfg keeps curl live.
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

async function fireCurl(rig, mint = 'CURL1') {
  const v = view({ address: mint, symbol: 'MEOWE', mc: 500_000, liq: 100_000, createdAt: T0 - 100 * 60000, dex: 'pumpswap' });
  rig.views.set(mint, v);
  await rig.bot.start();
  seedHistory(rig.bot, mint);
  await rig.bot.onSignal(v, { setup: 'curl', strength: 0.71, metrics: { curl: { peakMc: 350000, depth: 0.714, lift: 0.3, volM5: 20000 } } });
  return rig.bot.journal.signals.at(-1);
}

test('config: CURL_LIVE defaults on, env 0 turns it off, curl dials validate', () => {
  assert.equal(loadConfig({}).curlLive, true);
  assert.equal(loadConfig({ CURL_LIVE: '0' }).curlLive, false);
  assert.deepEqual(validateConfig(loadConfig({})), []);
  assert.ok(validateConfig(loadConfig({ CURL_MIN_DEPTH: '0.9', CURL_MAX_DEPTH: '0.4' })).some(e => e.includes('CURL_MIN_DEPTH')));
});

test('bot: CURL_LIVE=0 shadows curl — journaled and tracked, never bought', async () => {
  const rig = pipelineRig({ cfgOver: { curlLive: false } });
  const rec = await fireCurl(rig);
  assert.equal(rec.decision, 'shadow', JSON.stringify(rec.reasons));
  assert.equal(rig.bot.positions.length, 0);
  assert.equal(rig.bot.stats.shadowSignals.curl, 1);
});

test('bot: CURL_LIVE on takes the same curl signal live', async () => {
  const rig = pipelineRig();
  const rec = await fireCurl(rig);
  assert.equal(rec.decision, 'taken', JSON.stringify(rec.reasons));
  assert.equal(rig.bot.positions.length, 1);
});
