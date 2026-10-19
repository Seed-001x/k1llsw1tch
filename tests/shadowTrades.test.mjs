// Trade-grade shadow (user 2026-10-14): a shadow signal that PASSES its gate
// evaluation opens a VIRTUAL position run through the REAL evaluateExit until
// it fully exits — scored like a trade, without ever being one. These tests
// pin the virtual lifecycle (TP1 bank + final exit with coherent P&L, cap
// expiry, boot restore), the registration rule (gatePass only), the outcome
// observer's fetch-set extension, the /shadowtrades + stats exposure, and the
// isolation contract: no real position, no stats.entries, no risk state, no
// trade-journal records — ever.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { SOL_MINT } from '../src/util.js';
import { ShadowTrades, SHADOW_TRADE_CAP_MS } from '../src/shadowTrades.js';
import { startServer } from '../src/server.js';
import { testCfg, view, tmp } from './helpers.mjs';

const T0 = 1_000_000_000_000;
const healthyRug = { token: { supply: 1e15, decimals: 6 }, creatorBalance: 0, totalHolders: 2000, markets: [{ pubkey: 'POOL', lp: { base: 1e8, quote: 1400, lpLockedUSD: 3e5, lpLockedPct: 100 } }], knownAccounts: { POOL: { type: 'AMM' } }, topHolders: Array.from({ length: 12 }, (_, i) => ({ owner: 'h' + i, address: 'h' + i, amount: 9e12 - i * 3.1e10, pct: 2 })), insiderNetworks: [] };
const riggedRug = { ...healthyRug, topHolders: Array.from({ length: 18 }, (_, i) => ({ owner: 'w' + i, address: 'h' + i, amount: 498001881166, pct: 0.05 })) };

function rig(cfgOver = {}, rugRef = { rug: healthyRug }) {
  const cfg = testCfg({ tradeSol: 0.02, baseMode: 0, ...cfgOver });
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
    fetchSolUsd: async () => 150, fetchRug: async () => rugRef.rug, searchByName: async () => [],
  });
  return { cfg, bot, clock };
}

const approx = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

// ------------------------------------------------------------ tracker unit
test('shadow trades: TP1 bank, post-TP1 fade holds (trail removed), TP2 + moonbag exit completes with coherent P&L math', () => {
  const dir = tmp();
  const cfg = testCfg({ txFeeSol: 0.001, tp1Pct: 0.25, tp1Frac: 0.4, tp1AdaptMax: 0.60, tp1Giveback: 0.08, bagTrailConfirmSec: 0, bagSmallHold: 0 }); // trail timer off: this test pins the line's fire (timer: bagtrailconfirm.test.mjs); bagSmallHold 0: the trail lives in the closeted big-bag mode since 2026-10-17 ~04:38
  const tr = new ShadowTrades(dir, () => T0, { txFeeSol: cfg.txFeeSol });
  assert.equal(tr.open({ id: 'sig1', mint: 'MINT1', symbol: 'TEST', setup: 'trend', price: 2, mc: 500000, ts: T0, sizeSol: 0.05 }), true);
  let price = 2;
  const viewOf = () => view({ price });

  price = 3.40; // +70% on the view: gain clears the adaptive ceiling → TP1 fires
  tr.tick(viewOf, T0 + 30000, cfg, 150);
  const mid = tr.pending.get('sig1');
  assert.ok(mid, 'position still open after a partial bank');
  assert.ok(approx(mid.remainingFrac, 0.6), `remainingFrac ${mid.remainingFrac}`);
  assert.equal(mid.legs.length, 1);
  assert.equal(mid.legs[0].frac, 0.4);
  assert.ok(approx(mid.realizedSol, 0.034), `banked ${mid.realizedSol}`); // 0.4 × (0.05 × 1.70)

  price = 2.40; // ratio 1.20 vs peak 1.70 → the old post-TP1 trail print: since the
  // trail's removal (2026-10-16) the middle-stage remainder HOLDS through the fade
  tr.tick(viewOf, T0 + 60000, cfg, 150);
  assert.equal(tr.pending.size, 1, 'the fade no longer exits the shadow position');
  assert.equal(tr.done.length, 0);

  price = 4.40; // ratio 2.20: gain on the remainder clears TP2 (+100%) → second bank
  tr.tick(viewOf, T0 + 90000, cfg, 150);
  const mid2 = tr.pending.get('sig1');
  assert.ok(mid2, 'position still open after the TP2 bank');
  assert.ok(approx(mid2.remainingFrac, 0.25), `remainingFrac ${mid2.remainingFrac}`); // 0.6 − 0.35 of original
  assert.equal(mid2.legs.length, 2);

  price = 3.60; // ratio 1.80 vs peak 2.20 → past the moonbag trail (15% off peak) → full exit
  tr.tick(viewOf, T0 + 120000, cfg, 150);
  assert.equal(tr.pending.size, 0);
  assert.equal(tr.done.length, 1);
  const rec = tr.done[0];
  assert.equal(rec.status, 'exited');
  assert.match(rec.exitReason, /moonbag trail/);
  assert.equal(rec.legs.length, 3, 'TP1 leg + TP2 leg + final leg');
  assert.equal(rec.legs[2].frac, 1);
  // proceeds = 0.034 (TP1 at 1.70×) + 0.0385 (TP2: 0.35 of original at 2.20×) + 0.0225
  // (bag: 0.25 of original at 1.80×) = 0.095; fees = 0.001 × (1 buy + 3 sells)
  assert.ok(approx(rec.proceedsSol, 0.095), `proceeds ${rec.proceedsSol}`);
  assert.ok(approx(rec.pnlSol, 0.041), `pnl ${rec.pnlSol}`);
  assert.ok(approx(rec.pnlPct, 82), `pnlPct ${rec.pnlPct}`);
  assert.ok(approx(rec.peakRatio, 2.20), `peak ${rec.peakRatio}`);
  assert.equal(rec.pnlBasis, 'viewQuote');
  assert.equal(rec.markCadenceSec, 30, 'marks 30s apart — the cadence approximation is on the record');
  assert.equal(rec.heldMin, 2);
  assert.equal(rec.sizeSol, 0.05);
  assert.equal(rec.entryMc, 500000);
  const totals = tr.totalsView();
  assert.deepEqual([totals.opened, totals.completed, totals.wins], [1, 1, 1]);
  assert.ok(approx(totals.netPnlSol, 0.041));
  // persistence: the completed record is on disk; the pending file is drained
  const lines = fs.readFileSync(path.join(dir, 'virtual_trades.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).id, 'sig1');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'virtual_pending.json'), 'utf8')).pending.length, 0);
});

test('shadow trades: the 4h cap terminates a virtual as expired, marked to its last value', () => {
  const dir = tmp();
  const cfg = testCfg({ txFeeSol: 0.001 });
  const tr = new ShadowTrades(dir, () => T0, { txFeeSol: cfg.txFeeSol });
  assert.equal(tr.open({ id: 'sig1', mint: 'MINT1', symbol: 'TEST', setup: 'liftoff', price: 2, mc: 1000, ts: T0, sizeSol: 0.05 }), true);
  tr.tick(() => null, T0 + SHADOW_TRADE_CAP_MS + 1000, cfg, 150); // no view at all — the cap still lands
  assert.equal(tr.pending.size, 0);
  const rec = tr.done[0];
  assert.equal(rec.status, 'expired');
  assert.equal(rec.exitReason, null);
  assert.equal(rec.marks, 0);
  assert.equal(rec.markCadenceSec, null, 'never marked — no cadence to claim');
  // never marked → marked at entry value: P&L is just the (virtual) buy fee
  assert.ok(approx(rec.pnlSol, -0.001), `pnl ${rec.pnlSol}`);
  assert.equal(tr.totalsView().completed, 1);
  assert.equal(tr.totalsView().wins, 0);
});

test('shadow trades: one virtual per mint, and a priceless signal opens nothing', () => {
  const tr = new ShadowTrades(tmp(), () => T0);
  assert.equal(tr.open({ id: 'a', mint: 'MINT1', symbol: 'T', setup: 'trend', price: 1, mc: 1, ts: T0, sizeSol: 0.02 }), true);
  assert.equal(tr.open({ id: 'b', mint: 'MINT1', symbol: 'T', setup: 'trend', price: 1, mc: 1, ts: T0 + 1000, sizeSol: 0.02 }), false, 'same mint already running');
  assert.equal(tr.open({ id: 'c', mint: 'MINT2', symbol: 'T', setup: 'trend', price: 0, mc: 1, ts: T0, sizeSol: 0.02 }), false, 'no entry price, no virtual');
  assert.equal(tr.pending.size, 1);
  assert.equal(tr.totalsView().opened, 1);
});

test('shadow trades: boot restores a pending virtual; a past-cap one finalizes at boot', () => {
  const dir = tmp();
  const t1 = new ShadowTrades(dir, () => T0, { txFeeSol: 0.001 });
  t1.open({ id: 'sig1', mint: 'MINT1', symbol: 'TEST', setup: 'trend', price: 2, mc: 9, ts: T0, sizeSol: 0.05 });
  const cfg = testCfg({ txFeeSol: 0.001 });
  t1.tick(() => view({ price: 3.40 }), T0 + 30000, cfg, 150); // bank TP1 before the restart (default tp1Frac)
  assert.equal(t1.pending.get('sig1').legs.length, 1);

  const t2 = new ShadowTrades(dir, () => T0 + 60000, { txFeeSol: 0.001 });
  assert.equal(t2.pending.size, 1, 'pending virtual restored');
  const restored = t2.pending.get('sig1');
  assert.equal(restored.legs.length, 1, 'banked legs survive the restart');
  assert.ok(restored.tp1Done, 'exit-stack state survives the restart');
  assert.deepEqual(t2.pendingMints(), [{ mint: 'MINT1', since: T0 }]);
  assert.equal(t2.totalsView().opened, 1, 'cumulative totals restored, not reset');

  const t3 = new ShadowTrades(dir, () => T0 + SHADOW_TRADE_CAP_MS + 5000, { txFeeSol: 0.001 });
  assert.equal(t3.pending.size, 0, 'past-cap at boot leaves nothing pending');
  assert.equal(t3.done.length, 1);
  assert.equal(t3.done[0].status, 'expired');
  assert.equal(t3.done[0].legs.length, 1, 'the banked leg is part of the expired record');
  assert.equal(t3.totalsView().completed, 1);
});

// ------------------------------------------------------------ bot wiring
test('bot: a gate-passing shadow signal opens a virtual — and touches nothing real', async () => {
  const { bot } = rig({ trendShadow: 1, trendLive: false });
  await bot.start();
  const riskBefore = JSON.stringify(bot.risk.s);
  await bot.onSignal(view({ price: 1.0 }), { setup: 'trend', strength: 5, metrics: {} });
  const rec = bot.journal.signals.find(s => s.setup === 'trend');
  assert.equal(rec.decision, 'shadow');
  assert.equal(rec.gatePass, true);
  assert.equal(bot.shadowTrades.pending.size, 1, 'virtual opened');
  const virt = [...bot.shadowTrades.pending.values()][0];
  assert.equal(virt.id, rec.id, 'the virtual carries the signal id');
  assert.equal(virt.entryPrice, 1.0);
  assert.equal(virt.sizeSol, 0.02, 'nominal size is cfg.tradeSol');
  assert.equal(bot.state().stats.shadowTrades.opened, 1, 'stats.shadowTrades maintained');
  // isolation: nothing real moved
  assert.equal(bot.positions.length, 0, 'no real position');
  assert.equal(bot.stats.entries, 0, 'stats.entries untouched');
  assert.equal(bot.journal.trades.length, 0, 'no trade-journal records');
  assert.equal(bot.enteredMints.size, 0);
  assert.equal(JSON.stringify(bot.risk.s), riskBefore, 'risk state untouched');
});

test('bot: a gate-FAILED shadow signal opens no virtual', async () => {
  const { bot } = rig({ trendShadow: 1, trendLive: false }, { rug: riggedRug });
  await bot.start();
  await bot.onSignal(view({ price: 1.0 }), { setup: 'trend', strength: 5, metrics: {} });
  const rec = bot.journal.signals.find(s => s.setup === 'trend');
  assert.equal(rec.decision, 'shadow');
  assert.equal(rec.gatePass, false);
  assert.equal(bot.shadowTrades.pending.size, 0);
  assert.equal(bot.state().stats.shadowTrades.opened, 0);
});

test('bot: taken and skipped (non-shadow) signals open no virtual', async () => {
  const taken = rig();
  await taken.bot.start();
  await taken.bot.onSignal(view({ price: 1.0 }), { setup: 'pop', strength: 1, metrics: {} });
  assert.equal(taken.bot.positions.length, 1, 'the real trade happened');
  assert.equal(taken.bot.shadowTrades.pending.size, 0, 'no virtual alongside a real entry');
  assert.equal(taken.bot.state().stats.shadowTrades.opened, 0);

  const skipped = rig({}, { rug: riggedRug });
  await skipped.bot.start();
  await skipped.bot.onSignal(view({ price: 1.0 }), { setup: 'pop', strength: 1, metrics: {} });
  assert.equal(skipped.bot.journal.signals[0].decision, 'skipped');
  assert.equal(skipped.bot.shadowTrades.pending.size, 0);
  assert.equal(skipped.bot.state().stats.shadowTrades.opened, 0);
});

test('bot: the outcome observer fetches + marks virtual mints after journal tracking ends', async () => {
  const { bot, clock } = rig({ trendShadow: 1, trendLive: false });
  await bot.start();
  await bot.onSignal(view({ price: 1.0 }), { setup: 'trend', strength: 5, metrics: {} });
  assert.equal(bot.shadowTrades.pending.size, 1);
  clock.t += 91 * 60000; // past the outcome tracker's 90-min horizon
  bot.journal.expireSweep(clock.t);
  assert.ok(!bot.journal.pendingMints().some(p => p.mint === 'MINT1'), 'journal no longer tracks the mint — only the virtual keeps it in the fetch set');
  const asked = [];
  bot.d.fetchViews = async (mints) => { asked.push(...mints); return new Map(mints.map(m => [m, view({ price: 1.5 })])); };
  bot.lastOutcomeTickTs = 0;
  await bot.outcomeTick(clock.t);
  assert.ok(asked.includes('MINT1'), 'observer fetched the virtual mint');
  const virt = [...bot.shadowTrades.pending.values()][0];
  assert.ok(virt, 'virtual still open (armed TP1 on strength is not an exit)');
  assert.ok(approx(virt.lastValueSol, 0.03), `marked at the fetched view: ${virt.lastValueSol}`); // 0.02 × 1.5
  assert.ok(virt.marks >= 1);
});

test('server: /shadowtrades serves pending + done in the paging envelope; /state carries the totals', async () => {
  const { bot, cfg } = rig({ trendShadow: 1, trendLive: false });
  await bot.start();
  bot.shadowTrades.open({ id: 'x-open', mint: 'MINT8', symbol: 'OPEN', setup: 'trend', price: 1, mc: 10, ts: T0, sizeSol: 0.02 });
  bot.shadowTrades.open({ id: 'x-done', mint: 'MINT9', symbol: 'DONE', setup: 'liftoff', price: 1, mc: 10, ts: T0, sizeSol: 0.02 });
  // MINT9 halves on the view → at 11 minutes old and −50%, the ENTRY CLIP
  // (owner order 2026-10-18, exits.js 5a) closes that virtual in full once
  // the breach has held through its 60s confirm (owner amendment
  // 2026-10-18 20:28 EDT): the first tick stamps the pending, the second
  // (61s later, still −50%) executes it. The tape keeps live buyers (5 vs
  // 10 sells is not dead flow), so the stall exit never competes for the
  // print; the shadow book runs the same stack as live, clip included.
  bot.shadowTrades.tick(mint => (mint === 'MINT9' ? view({ price: 0.5, buysM5: 5, sellsM5: 10 }) : null), T0 + 660000, cfg, 150);
  bot.shadowTrades.tick(mint => (mint === 'MINT9' ? view({ price: 0.5, buysM5: 5, sellsM5: 10 }) : null), T0 + 721000, cfg, 150);
  const srv = startServer(bot, 0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const get = async (p) => { const r = await fetch(base + p); assert.equal(r.status, 200, p); return r.json(); };
  try {
    const dflt = await get('/shadowtrades');
    assert.equal(dflt.pending.length, 1);
    assert.equal(dflt.pending[0].id, 'x-open');
    assert.equal(dflt.total, 1);
    assert.equal(dflt.done.length, 1);
    assert.equal(dflt.done[0].id, 'x-done');
    assert.equal(dflt.done[0].status, 'exited');
    assert.match(dflt.done[0].exitReason, /entry clip/);
    assert.equal(dflt.done[0].pnlBasis, 'viewQuote');
    const pg = await get('/shadowtrades?limit=1&offset=0');
    assert.equal(pg.total, 1);
    assert.equal(pg.limit, 1);
    assert.equal(pg.done.length, 1);
    const st = await get('/state');
    assert.equal(st.stats.shadowTrades.opened, 2);
    assert.equal(st.stats.shadowTrades.completed, 1);
    assert.equal(st.stats.shadowTrades.wins, 0);
    assert.ok(approx(st.stats.shadowTrades.netPnlSol, -0.01021), `net ${st.stats.shadowTrades.netPnlSol}`); // 0.01 back on 0.02, minus 2 × 0.000105 fees
  } finally { srv.close(); }
});
