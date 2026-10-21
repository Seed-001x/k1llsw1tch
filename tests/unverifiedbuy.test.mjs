// LANDED-UNVERIFIED (owner order 2026-10-21, the MILK hole): on 2026-10-21
// the bot's MILK swap LANDED on-chain (−0.10182 SOL → 51,198 tokens) but the
// post-buy confirmation read hit the Helius 429 cap, exec threw a generic
// "buy failed", and the journal recorded the signal as SKIPPED — a real
// position sat in the wallet ~7 minutes with no TP ladder, no entry clip,
// and no watcher able to see it (reconcile/landing-watch candidates come
// only from journal closes), and the SOL dip tripped downHalt. The fix:
// exec throws a coded LANDED_UNVERIFIED carrying the sig; bot.js journals
// an open-unverified record + a taken-unverified signal (never "skipped");
// reconcile adopts the bag if it is in the wallet, or resolves the record
// as never-landed after a confirmed-zero read 15m past the send.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { SOL_MINT } from '../src/util.js';
import { testCfg, view } from './helpers.mjs';

const T0 = 1_000_000_000_000;
const healthyRug = { token: { supply: 1e15, decimals: 6 }, creatorBalance: 0, totalHolders: 2000, graphInsidersDetected: 0, markets: [{ pubkey: 'POOL', lp: { base: 1e8, quote: 1400, lpLockedUSD: 3e5, lpLockedPct: 100 } }], knownAccounts: { POOL: { type: 'AMM' } }, topHolders: Array.from({ length: 12 }, (_, i) => ({ owner: 'h' + i, address: 'h' + i, amount: 9e12 - i * 3.1e10, pct: 2 })), insiderNetworks: [] };

function rig() {
  const cfg = testCfg({ tradeSol: 0.02, baseMode: 0 });
  const clock = { t: T0 };
  const quote = async (input, _o, amount) => (input === SOL_MINT
    ? { outAmount: '1000000000', priceImpactPct: '0.01' }
    : { outAmount: String(Math.floor(19_000_000 * (Number(amount) / 1e9))) });
  const exec = new Executor(cfg, { quote });
  const views = new Map();
  const bot = new Bot(cfg, {
    now: () => clock.t, exec,
    discover: async () => Object.assign(new Map(), { counts: {} }),
    fetchViews: async (mints) => new Map(mints.filter(m => views.has(m)).map(m => [m, views.get(m)])),
    fetchSolUsd: async () => 150, fetchRug: async () => healthyRug, searchByName: async () => [],
    fetchCurveLife: async () => 5000,
  });
  return { bot, clock, views };
}

function seedHistory(bot, mint, price = 1) {
  const samples = [];
  for (let k = 0; k < 12; k++) samples.push({ ts: T0 - (11 - k) * 30000, price, mc: 500_000, volM5: 100_000, volH1: 500_000, buysM5: 900, sellsM5: 800, liq: 100_000 });
  bot.history.m.set(mint, samples);
}

async function fireUnverified(r, mint = 'MINTUV') {
  const v = view({ address: mint, symbol: 'UVT', mc: 500_000, liq: 100_000, createdAt: T0 - 10 * 3600e3, dex: 'pumpswap' });
  r.views.set(mint, v);
  await r.bot.start();
  seedHistory(r.bot, mint);
  r.bot.exec.buy = async () => {
    const e = new Error('buy landed but unverified (sig SIGUV, confirmed=true) — verify read failed: rpc getTokenAccountsByOwner failed: HTTP 429');
    e.code = 'LANDED_UNVERIFIED'; e.sig = 'SIGUV'; e.confirmed = true;
    throw e;
  };
  await r.bot.onSignal(v, { setup: 'pop', strength: 42, metrics: { gainPct: 42, volM5: 100_000 } });
  return r.bot.journal.signals.at(-1);
}

test('unverified buy: journaled open-unverified + taken-unverified — never skipped, never invisible', async () => {
  const r = rig();
  const rec = await fireUnverified(r);
  assert.equal(rec.decision, 'taken-unverified', JSON.stringify(rec.reasons));
  assert.match(rec.reasons[0], /landed but unverified/);
  assert.equal(rec.gates.exec.pass, false);
  const uv = r.bot.journal.trades.find(t => t.type === 'open-unverified');
  assert.ok(uv, 'an open-unverified trade record exists');
  assert.equal(uv.sig, 'SIGUV');
  assert.equal(uv.mint, 'MINTUV');
  assert.equal(uv.entrySol, 0.02);
  assert.equal(r.bot.positions.length, 0, 'no position is fabricated before reconcile verifies the bag');
  assert.equal(r.bot.stats.entries, 1, 'the entry tally counts the spend — the money may be gone');
  assert.ok(r.bot.enteredMints.has('MINTUV'), 'the mint is entry-booked so it cannot be aped twice');
});

test('unverified buy: reconcile adopts the bag when the wallet really holds it', async () => {
  const r = rig();
  await fireUnverified(r);
  r.bot.cfg.realMode = true;
  r.bot.exec.tokenBalance = async () => 2_000_000_000n;
  r.bot.exec.markValue = async () => 0.06;
  await r.bot.reconcilePositions();
  assert.equal(r.bot.positions.length, 1, 'the landed bag becomes a tracked position');
  const pos = r.bot.positions[0];
  assert.equal(pos.mint, 'MINTUV');
  assert.equal(pos.adopted, true);
  assert.equal(pos.sigBuy, 'SIGUV');
  const open = r.bot.journal.trades.find(t => t.type === 'open' && t.adopted);
  assert.ok(open && /unverified/.test(open.reason), 'the adoption is journaled as an unverified-buy pickup');
});

test('unverified buy: a confirmed zero 15m after the send resolves it as never-landed — exactly once', async () => {
  const r = rig();
  await fireUnverified(r);
  r.bot.cfg.realMode = true;
  r.bot.exec.tokenBalance = async () => 0n;
  r.bot.exec.markValue = async () => 0;
  await r.bot.reconcilePositions();
  assert.equal(r.bot.journal.trades.filter(t => t.unverifiedResolved).length, 0, 'too early: a zero inside the window does not resolve');
  r.clock.t += 16 * 60_000;
  await r.bot.reconcilePositions();
  const res = r.bot.journal.trades.filter(t => t.unverifiedResolved);
  assert.equal(res.length, 1, 'resolved once the window passes with a confirmed zero');
  assert.equal(res[0].type, 'close');
  assert.equal(r.bot.positions.length, 0);
  r.clock.t += 6 * 60_000;
  await r.bot.reconcilePositions();
  assert.equal(r.bot.journal.trades.filter(t => t.unverifiedResolved).length, 1, 'never resolved twice');
});
