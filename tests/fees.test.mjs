// Calibrated tx fees on closes (user order via D2, corrected by the rent
// analysis, 2026-10-14). The old 'txFeeEstimate' label implied a generic flat
// guess. The number was always cfg.txFeeSol per transaction actually
// incurred (buy + one per executed sell), and cfg.txFeeSol is itself the
// chain-measured burned fee: parsed buy txs paid meta.fee exactly 105,000
// lamports = 5,000 base + 100,000 configured priority. The 0.001514 SOL
// token-account deposit is NOT in the number — the closeEmptyAccounts sweep
// refunds it. These tests pin the VALUE (per-tx counting, config-derived, no
// deposit component) and the honest labels: 'calibratedTxFees', and
// 'chainTxSellFee+calibratedTxFees' where a chain-read manual sell fee joins
// the calibrated remainder. Record-only: no trading decision is pinned here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { SOL_MINT } from '../src/util.js';
import { loadConfig } from '../src/config.js';
import { testCfg, view, tmp } from './helpers.mjs';

const T0 = 1_000_000_000_000;
const healthyRug = { token: { supply: 1e15, decimals: 6 }, creatorBalance: 0, totalHolders: 2000, markets: [{ pubkey: 'POOL', lp: { base: 1e8, quote: 1400, lpLockedUSD: 3e5, lpLockedPct: 100 } }], knownAccounts: { POOL: { type: 'AMM' } }, topHolders: Array.from({ length: 12 }, (_, i) => ({ owner: 'h' + i, address: 'h' + i, amount: 9e12 - i * 3.1e10, pct: 2 })), insiderNetworks: [] };

function rig(cfgOver = {}) {
  const cfg = testCfg({ tradeSol: 0.02, baseMode: 0, bagTrailConfirmSec: 0, bagSmallHold: 0, ...cfgOver }); // trail timer off in rigs (see bagtrailconfirm.test.mjs); bagSmallHold 0: the trail lives in the closeted big-bag mode since 2026-10-17 ~04:38
  const clock = { t: T0 };
  const q = { valueLam: 19_000_000 };
  const quote = async (input, _o, amount) => (input === SOL_MINT
    ? { outAmount: '1000000000', priceImpactPct: '0.01' }
    : { outAmount: String(Math.floor(q.valueLam * (Number(amount) / 1e9))) });
  const exec = new Executor(cfg, { quote });
  const bot = new Bot(cfg, {
    now: () => clock.t, exec,
    discover: async () => Object.assign(new Map(), { counts: {} }),
    fetchViews: async () => new Map(),
    fetchSolUsd: async () => 150, fetchRug: async () => healthyRug, searchByName: async () => [],
  });
  return { cfg, bot, clock, q };
}

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('fees config: txFeeSol = 5,000 base + configured priority — the chain-measured meta.fee, no deposit', () => {
  const dflt = loadConfig({ DATA_DIR: tmp() });
  assert.equal(dflt.priorityFeeLamports, 100000);
  assert.ok(near(dflt.txFeeSol, 0.000105, 1e-12), `default txFeeSol ${dflt.txFeeSol} = the parsed buys' exact meta.fee`);
  const custom = loadConfig({ DATA_DIR: tmp(), PRIORITY_FEE_LAMPORTS: '250000' });
  assert.ok(near(custom.txFeeSol, 0.000255, 1e-12), 'the per-tx fee follows the configured priority fee');
  // one token-account deposit is 0.001514 — a full round trip of burned fees
  // is an order of magnitude below it, so no deposit can be hiding in the rate
  assert.ok(dflt.txFeeSol * 2 < 0.001514 / 7, 'round-trip fees ≪ one deposit');
});

test('fees close: TP1 bank + final sell = buy + 2 sell txs at the calibrated rate (the CONDOGE shape)', async () => {
  const { cfg, bot, clock, q } = rig();
  await bot.start();
  await bot.onSignal(view({ price: 1.0 }), { setup: 'pop', strength: 1, metrics: {} });
  assert.equal(bot.positions.length, 1);
  bot.latest.set('MINT1', view({ price: 1.0 }));
  q.valueLam = 40_000_000; clock.t += 10000; await bot.positionTick(); // TP ladder banks TP1
  q.valueLam = 20_000_000; clock.t += 10000; await bot.positionTick(); // ladder closes it
  assert.equal(bot.positions.length, 0);
  const sells = bot.journal.trades.filter(t => t.type === 'sell');
  assert.equal(sells.length, 2, 'TP1 partial + final sell');
  const close = bot.journal.trades.find(t => t.type === 'close');
  assert.ok(near(close.feesSol, 3 * cfg.txFeeSol), `feesSol ${close.feesSol} = buy + 2 sells × ${cfg.txFeeSol}`);
  assert.ok(near(close.feesSol, 0.000315), 'matches the first live D1 close (CONDOGE) to the lamport');
  assert.equal(close.feesSource, 'calibratedTxFees');
  assert.ok(near(close.pnlSol, close.exitSol - close.entrySol - close.feesSol, 1e-6), 'P&L nets exactly the recorded fees');
});

test('fees close: TP1 + TP2 + moonbag final counts every sell tx (buy + 3 sells)', async () => {
  // tp1Frac pinned at 0.4 (as in the e2e lifecycle fixture) so a moonbag
  // survives TP2 — at the 0.65 default the TP2 slice consumes the whole
  // remainder and the position closes inside the TP2 sell itself
  const { cfg, bot, clock, q } = rig({ tp1Frac: 0.4 });
  await bot.start();
  await bot.onSignal(view({ price: 1.0 }), { setup: 'pop', strength: 1, metrics: {} });
  const pos = bot.positions[0];
  bot.latest.set('MINT1', view({ price: 1.0 }));
  q.valueLam = 34_000_000; clock.t += 10000; await bot.positionTick(); // ratio 1.70 — TP1 banks
  assert.equal(pos.tp1Done, true);
  q.valueLam = 36_000_000; clock.t += 10000; await bot.positionTick(); // middle-stage print above the TP1 fire level holds (since 2026-10-22 the TP1 guard owns any dip back under the fire gain — a sub-fire pullback would trim there and add a fourth sell tx, tp1guard.test.mjs)
  assert.equal(bot.positions.length, 1);
  q.valueLam = 44_000_000; clock.t += 10000; await bot.positionTick(); // ratio 2.20 on remainder — TP2 banks
  assert.equal(pos.tp2Done, true);
  q.valueLam = 36_000_000; clock.t += 10000; await bot.positionTick(); // moonbag trail closes it
  assert.equal(bot.positions.length, 0);
  const sells = bot.journal.trades.filter(t => t.type === 'sell');
  assert.equal(sells.length, 3, 'TP1 + TP2 + final');
  const close = bot.journal.trades.find(t => t.type === 'close');
  assert.ok(near(close.feesSol, 4 * cfg.txFeeSol), `feesSol ${close.feesSol} = buy + 3 sells × ${cfg.txFeeSol}`);
  assert.equal(close.feesSource, 'calibratedTxFees');
});

test('fees close: a single-shot exit counts buy + exactly one sell', async () => {
  const { cfg, bot, clock, q } = rig();
  await bot.start();
  await bot.onSignal(view({ price: 1.0 }), { setup: 'pop', strength: 1, metrics: {} });
  bot.latest.set('MINT1', view({ price: 1.0 }));
  // the 10-minute dead check (the stripped stack's only early undertaker):
  // minutes of steady decline into dead flow, no TP ever arms — at 10 minutes
  // the momentum-failure check closes the position through ONE full sell
  bot.latest.set('MINT1', view({ price: 1.0, buysM5: 1, sellsM5: 10 }));
  for (let i = 0; i < 44 && bot.positions.length > 0; i++) {
    clock.t += 15000;
    q.valueLam = Math.max(6_000_000, 16_000_000 - i * 1_000_000);
    await bot.positionTick();
  }
  assert.equal(bot.positions.length, 0, 'the decline must close the position');
  const sells = bot.journal.trades.filter(t => t.type === 'sell');
  assert.equal(sells.length, 1, 'one sell tx only');
  const close = bot.journal.trades.find(t => t.type === 'close');
  assert.ok(near(close.feesSol, 2 * cfg.txFeeSol), `feesSol ${close.feesSol} = buy + 1 sell`);
  assert.equal(close.feesSource, 'calibratedTxFees');
});

test('fees close: a configured per-tx fee flows through — nothing is hardcoded', async () => {
  const { cfg, bot, clock, q } = rig({ txFeeSol: 0.000255 });
  await bot.start();
  await bot.onSignal(view({ price: 1.0 }), { setup: 'pop', strength: 1, metrics: {} });
  bot.latest.set('MINT1', view({ price: 1.0 }));
  q.valueLam = 40_000_000; clock.t += 10000; await bot.positionTick();
  q.valueLam = 20_000_000; clock.t += 10000; await bot.positionTick();
  assert.equal(bot.positions.length, 0);
  const close = bot.journal.trades.find(t => t.type === 'close');
  assert.ok(near(close.feesSol, 3 * 0.000255), `feesSol ${close.feesSol} tracks cfg.txFeeSol`);
  assert.equal(cfg.txFeeSol, 0.000255);
});

test('fees close: an admin drop incurred no sell tx — buy fee only', async () => {
  const { cfg, bot } = rig();
  await bot.start();
  await bot.onSignal(view({ price: 1.0 }), { setup: 'pop', strength: 1, metrics: {} });
  const pos = bot.positions[0];
  pos.lastValueSol = 0.03;
  bot.dropPosition(pos.id);
  const close = bot.journal.trades.find(t => t.type === 'close');
  assert.ok(near(close.feesSol, cfg.txFeeSol), `feesSol ${close.feesSol} = the buy tx only`);
  assert.equal(close.feesSource, 'calibratedTxFees');
});

test('fees manual: chain-read sell fee stays exact; the remainder is exactly one calibrated buy fee', async () => {
  const { cfg, bot, clock } = rig();
  await bot.start();
  await bot.onSignal(view({ price: 1.0 }), { setup: 'pop', strength: 1, metrics: {} });
  const pos = bot.positions[0];
  assert.ok(near(pos.feesSol, cfg.txFeeSol), 'the accumulated remainder is one calibrated buy fee — no deposit, no padding');
  bot.lastSolUsd = 150;
  bot.exec.sellFill = async () => ({ sigs: ['SX1'], txCount: 1, tokensRawSold: '1000000000', decimals: 6, tokensWhole: 1000, proceedsNetSol: 0.03, feeSol: 0.000005, grossSol: 0.030005, fillSol: 0.030005 / 1000 });
  const n = T0 + 20 * 60000;
  clock.t = n;
  const rec = await bot.recordManualExit(pos, 0.029, n, 'sold in own wallet');
  const close = bot.journal.trades.find(t => t.type === 'close' && t.id === rec.id);
  assert.equal(close.sellTxFeeSol, 0.000005, 'the chain-read sell fee, exact');
  assert.ok(near(close.feesSol, cfg.txFeeSol + 0.000005), `feesSol ${close.feesSol} = calibrated buy fee + chain sell fee`);
  assert.equal(close.feesSource, 'chainTxSellFee+calibratedTxFees');
});
