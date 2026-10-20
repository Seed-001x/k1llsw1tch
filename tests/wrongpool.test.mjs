// WRONG-POOL EXECUTION GUARD (owner order 2026-10-19, the Rockstar buy):
// the gates grade the best-liquidity VIEW of a mint, but the swap can
// execute in a second pool for the same mint. Immediately before the
// swap, the bot identifies the execution pool from the buy quote's route
// plan and — when it differs from the graded pair — re-prices it and
// aborts if its mc is under the live minMc floor, its liquidity is under
// the gate depth floor (liq/mc < cfg.minLiqToMc, gate.js exitDepthCheck),
// or its price differs from the graded view by > cfg.wrongPoolPriceTol.
// Missing route data / an unpriceable pool passes through unchanged,
// stamped wrongPool.unknown (the codebase's fail-open missing-data
// posture). Same-pool routes behave exactly as before and never fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { SOL_MINT } from '../src/util.js';
import { testCfg, view } from './helpers.mjs';

const T0 = 1_000_000_000_000;
const healthyRug = { token: { supply: 1e15, decimals: 6 }, creatorBalance: 0, totalHolders: 2000, markets: [{ pubkey: 'POOL', lp: { base: 1e8, quote: 1400, lpLockedUSD: 3e5, lpLockedPct: 100 } }], knownAccounts: { POOL: { type: 'AMM' } }, topHolders: Array.from({ length: 12 }, (_, i) => ({ owner: 'h' + i, address: 'h' + i, amount: 9e12 - i * 3.1e10, pct: 2 })), insiderNetworks: [] };
const GRADED = () => view({ price: 2, mc: 200_000, liq: 60_000, pairAddress: 'GRADED', createdAt: T0 - 10 * 3600e3 });

function rig({ routePlan, pairViews = {}, cfgOver = {} } = {}) {
  const cfg = testCfg({ baseMode: 0, tradeSol: 0.02, ...cfgOver });
  const clock = { t: T0 };
  const quote = async (input, _o, amount) => {
    if (input === SOL_MINT) {
      const q = { outAmount: '1000000000', priceImpactPct: '0.01' };
      if (routePlan) q.routePlan = routePlan;
      return q;
    }
    return { outAmount: String(Math.floor(19_000_000 * (Number(amount) / 1e9))) }; // sell-back 0.95 of spend
  };
  const exec = new Executor(cfg, { quote });
  const fetchPairCalls = [];
  const bot = new Bot(cfg, {
    now: () => clock.t, exec,
    discover: async () => Object.assign(new Map(), { counts: {} }),
    fetchViews: async () => new Map(),
    fetchSolUsd: async () => 150, fetchRug: async () => healthyRug, searchByName: async () => [],
    fetchPair: async (pair) => { fetchPairCalls.push(pair); return pairViews[pair] || null; },
  });
  return { cfg, bot, fetchPairCalls };
}
const hop = (ammKey) => [{ swapInfo: { ammKey, label: 'PumpSwap', outputMint: 'MINT1' } }];
const sigOf = (bot) => bot.journal.signals.find(s => s.mint === 'MINT1');

test('wrong-pool: the Rockstar trap — route lands in a dead twin pool, buy aborts and journals', async () => {
  const r = rig({ routePlan: hop('TRAP'), pairViews: { TRAP: view({ price: 0.06, mc: 1_946, liq: 1_957 }) } });
  await r.bot.start();
  await r.bot.onSignal(GRADED(), { setup: 'pop', strength: 1, metrics: {} });
  assert.equal(r.bot.positions.length, 0, 'no position may open in the trap pool');
  const sig = sigOf(r.bot);
  assert.equal(sig.decision, 'skipped');
  assert.ok(sig.reasons.some(x => x.startsWith('wrong-pool abort:')), JSON.stringify(sig.reasons));
  assert.ok(sig.reasons.some(x => x.includes('exec mc $1,946') && x.includes('liq $1,957')), JSON.stringify(sig.reasons));
  assert.equal(r.bot.stats.wrongPool.aborted, 1);
  assert.equal(r.bot.stats.wrongPool.checked, 1);
  assert.deepEqual(r.fetchPairCalls, ['TRAP']);
});

test('wrong-pool: depth leg alone aborts (exec liq/mc under the gate depth floor)', async () => {
  const r = rig({ routePlan: hop('SHALLOW'), pairViews: { SHALLOW: view({ price: 2, mc: 100_000, liq: 1_000 }) } });
  await r.bot.start();
  await r.bot.onSignal(GRADED(), { setup: 'pop', strength: 1, metrics: {} });
  assert.equal(r.bot.positions.length, 0);
  const sig = sigOf(r.bot);
  assert.equal(sig.decision, 'skipped');
  assert.ok(sig.reasons.some(x => x.includes('failed: depth')), JSON.stringify(sig.reasons));
});

test('wrong-pool: price leg alone aborts (>20% from the graded view price)', async () => {
  const r = rig({ routePlan: hop('OFFPRICE'), pairViews: { OFFPRICE: view({ price: 3, mc: 200_000, liq: 60_000 }) } });
  await r.bot.start();
  await r.bot.onSignal(GRADED(), { setup: 'pop', strength: 1, metrics: {} });
  assert.equal(r.bot.positions.length, 0);
  const sig = sigOf(r.bot);
  assert.equal(sig.decision, 'skipped');
  assert.ok(sig.reasons.some(x => x.includes('failed: price')), JSON.stringify(sig.reasons));
});

test('wrong-pool: same-pool route is taken exactly as before — and never re-priced', async () => {
  const r = rig({ routePlan: hop('GRADED'), pairViews: {} });
  await r.bot.start();
  await r.bot.onSignal(GRADED(), { setup: 'pop', strength: 1, metrics: {} });
  assert.equal(r.bot.positions.length, 1, 'same-pool fill must proceed');
  assert.equal(sigOf(r.bot).decision, 'taken');
  assert.equal(sigOf(r.bot).gates.wrongPool.samePool, true);
  assert.equal(r.fetchPairCalls.length, 0, 'no pair fetch on a same-pool route');
  assert.equal(r.bot.stats.wrongPool.samePool, 1);
});

test('wrong-pool: a different but healthy pool (within tolerance, floors pass) is taken', async () => {
  const r = rig({ routePlan: hop('OTHER'), pairViews: { OTHER: view({ price: 1.9, mc: 190_000, liq: 57_000 }) } });
  await r.bot.start();
  await r.bot.onSignal(GRADED(), { setup: 'pop', strength: 1, metrics: {} });
  assert.equal(r.bot.positions.length, 1, 'a healthy execution pool must not be blocked');
  const sig = sigOf(r.bot);
  assert.equal(sig.decision, 'taken');
  assert.equal(sig.gates.wrongPool.execMc, 190_000);
  assert.equal(r.bot.stats.wrongPool.checked, 1);
  assert.equal(r.bot.stats.wrongPool.aborted, 0);
});

test('wrong-pool: no route plan in the quote passes through unchanged, stamped unknown', async () => {
  const r = rig({ routePlan: null });
  await r.bot.start();
  await r.bot.onSignal(GRADED(), { setup: 'pop', strength: 1, metrics: {} });
  assert.equal(r.bot.positions.length, 1, 'unidentifiable execution pool must not block (fail-open posture)');
  const sig = sigOf(r.bot);
  assert.equal(sig.decision, 'taken');
  assert.equal(sig.gates.wrongPool.unknown, true);
  assert.equal(r.bot.stats.wrongPool.unknown, 1);
  assert.equal(r.fetchPairCalls.length, 0);
});

test('wrong-pool: an unpriceable execution pool (pair read fails) passes through, stamped unknown', async () => {
  const r = rig({ routePlan: hop('GHOST'), pairViews: {} }); // fetchPair returns null
  await r.bot.start();
  await r.bot.onSignal(GRADED(), { setup: 'pop', strength: 1, metrics: {} });
  assert.equal(r.bot.positions.length, 1);
  const sig = sigOf(r.bot);
  assert.equal(sig.decision, 'taken');
  assert.equal(sig.gates.wrongPool.unknown, true);
  assert.equal(sig.gates.wrongPool.ammKey, 'GHOST');
  assert.equal(r.bot.stats.wrongPool.unknown, 1);
});

test('wrong-pool: WRONG_POOL_GUARD=0 restores the pre-guard path exactly (no stamp, no tally)', async () => {
  const r = rig({ routePlan: hop('TRAP'), pairViews: { TRAP: view({ price: 0.06, mc: 1_946, liq: 1_957 }) }, cfgOver: { wrongPoolGuard: false } });
  await r.bot.start();
  await r.bot.onSignal(GRADED(), { setup: 'pop', strength: 1, metrics: {} });
  assert.equal(r.bot.positions.length, 1, 'guard off: the buy proceeds as it did before the guard existed');
  assert.equal(sigOf(r.bot).gates.wrongPool, undefined);
  assert.equal(r.bot.stats.wrongPool, undefined);
});
