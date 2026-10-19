// D1 — the DATA FIX (user 2026-10-14, forward plan step 2). Record-only: every
// test here pins a RECORD shape, never a trading decision. Close records carry
// the entry snapshot + per-gate results + fills + config stamp + % P&L on every
// close path; skipped and shadow signals keep per-gate results; manual exits
// carry an exit snapshot and spawn a paired virtual (shadow) exit; /trades,
// /signals, /postexit and /learn paginate without breaking their defaults.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { SOL_MINT } from '../src/util.js';
import { loadConfig } from '../src/config.js';
import { configStamp } from '../src/stamp.js';
import { learnReport } from '../src/learn.js';
import { startServer } from '../src/server.js';
import { testCfg, view, tmp } from './helpers.mjs';

const T0 = 1_000_000_000_000;
const healthyRug = { token: { supply: 1e15, decimals: 6 }, creatorBalance: 0, totalHolders: 2000, markets: [{ pubkey: 'POOL', lp: { base: 1e8, quote: 1400, lpLockedUSD: 3e5, lpLockedPct: 100 } }], knownAccounts: { POOL: { type: 'AMM' } }, topHolders: Array.from({ length: 12 }, (_, i) => ({ owner: 'h' + i, address: 'h' + i, amount: 9e12 - i * 3.1e10, pct: 2 })), insiderNetworks: [] };
const riggedRug = { ...healthyRug, topHolders: Array.from({ length: 18 }, (_, i) => ({ owner: 'w' + i, address: 'w' + i, amount: 498001881166, pct: 0.05 })) };

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
  return { cfg, bot, clock, q };
}

test('D1 stamp: digest stable for identical config, changes with a behavior knob, commit from env', () => {
  const a = configStamp(loadConfig({ DATA_DIR: tmp() }));
  const b = configStamp(loadConfig({ DATA_DIR: tmp() }));
  assert.equal(a.cfg, b.cfg, 'same effective config → same digest (data dir excluded)');
  const c = configStamp(loadConfig({ DATA_DIR: tmp(), TRADE_SOL: '0.03' }));
  assert.notEqual(a.cfg, c.cfg, 'a size change is a new config era');
  const prev = process.env.RENDER_GIT_COMMIT;
  process.env.RENDER_GIT_COMMIT = 'deadbeefcafe';
  try { assert.equal(configStamp(loadConfig({ DATA_DIR: tmp() })).commit, 'deadbeefcafe'); }
  finally { if (prev === undefined) delete process.env.RENDER_GIT_COMMIT; else process.env.RENDER_GIT_COMMIT = prev; }
});

test('D1 close: a bot-managed exit carries snapshot, gates, stamp, fills, fees and % P&L', async () => {
  const { bot, clock, q } = rig();
  await bot.start();
  await bot.onSignal(view({ price: 1.0 }), { setup: 'pop', strength: 1, metrics: {} });
  assert.equal(bot.positions.length, 1);
  const open = bot.journal.trades.find(t => t.type === 'open');
  assert.ok(open.stamp && open.stamp.cfg === bot.cfgStamp.cfg, 'open record is stamped');
  assert.equal(open.tokensRaw, '1000000000');
  assert.ok(open.entryFillSol > 0, 'open record carries the real entry fill');

  bot.latest.set('MINT1', view({ price: 1.0 }));
  q.valueLam = 40_000_000; clock.t += 10000; await bot.positionTick(); // run up — TP ladder banks some
  q.valueLam = 20_000_000; clock.t += 10000; await bot.positionTick(); // fall — ladder closes it
  assert.equal(bot.positions.length, 0, 'position must be fully closed by the bot');

  const close = bot.journal.trades.find(t => t.type === 'close');
  assert.ok(close, 'close record exists');
  // entry snapshot — the field whose absence broke /learn for 441 closes
  assert.ok(close.entry, 'close carries the entry snapshot');
  assert.equal(close.entry.holders, 2000);
  assert.equal(close.entry.liq, 100000);
  assert.ok(close.entry.gates && close.entry.gates.depth.pass === true, 'snapshot carries per-gate results');
  // full per-check map (pipeline checks + gate stack) on the close itself
  assert.ok(close.gates && close.gates.extension && close.gates.depth.pass === true, 'close carries the per-gate map');
  assert.equal(close.gatePass, true);
  // stamp matches the entry's stamp
  assert.deepEqual(close.stamp, open.stamp);
  // quantity, decimals, fills
  assert.equal(close.tokensRaw, '1000000000');
  assert.equal(close.decimals, 6);
  assert.ok(Math.abs(close.entryFillSol - 0.00002) < 1e-12, `entry fill ${close.entryFillSol}`);
  assert.ok(close.exitFillSol > 0 && close.exitFillUsd > 0, 'exit fill present on a bot-managed sell');
  // fees: the accumulated calibrated tx fees, labeled as calibrated — never fabricated as chain-exact
  assert.ok(close.feesSol > 0);
  assert.equal(close.feesSource, 'calibratedTxFees');
  // % P&L alongside SOL P&L
  assert.ok(close.pnlSol != null && close.pnlPct != null);
  assert.ok(Math.abs(close.pnlPct - (close.pnlSol / close.entrySol) * 100) < 0.02, `pnlPct ${close.pnlPct}`);
});

test('D1 close: the funnel completes records for paths that pass nothing extra (admin drop)', async () => {
  const { bot } = rig();
  await bot.start();
  await bot.onSignal(view({ price: 1.0 }), { setup: 'pop', strength: 1, metrics: {} });
  const pos = bot.positions[0];
  pos.lastValueSol = 0.03; // +50% mark → estimated pnl +0.01
  bot.dropPosition(pos.id);
  const close = bot.journal.trades.find(t => t.type === 'close');
  assert.ok(close.entry && close.entry.holders === 2000, 'admin close still carries the snapshot');
  assert.ok(close.gates && close.stamp, 'admin close carries gates + stamp');
  assert.ok(Math.abs(close.pnlPct - 50) < 0.6, `pnlPct ${close.pnlPct}`);
  assert.equal(close.exitFillSol, null, 'no bot sell happened — exit fill is honestly null');
});

test('D1 signals: a gate-failed skip record carries every gate result, not just the first reason', async () => {
  const { bot } = rig({}, { rug: riggedRug });
  await bot.start();
  await bot.onSignal(view({ price: 1.0 }), { setup: 'pop', strength: 1, metrics: {} });
  assert.equal(bot.positions.length, 0);
  const rec = bot.journal.signals.find(s => s.decision === 'skipped');
  assert.ok(rec.gates, 'skip record carries the gate map');
  assert.equal(rec.gates.clones.pass, false);
  assert.match(rec.gates.clones.reason, /exact same balance/);
  assert.ok(rec.gates.depth, 'passing gates are recorded too, not only the failure');
  assert.equal(rec.gatePass, false);
});

test('D1 shadow: shadow records carry gate results; a gate fail never changes the shadow decision', async () => {
  const ok = rig({ trendShadow: 1, trendLive: false });
  await ok.bot.start();
  await ok.bot.onSignal(view({ price: 1.0 }), { setup: 'trend', strength: 5, metrics: {} });
  const rec = ok.bot.journal.signals.find(s => s.setup === 'trend');
  assert.equal(rec.decision, 'shadow');
  assert.equal(rec.gatePass, true);
  assert.ok(rec.gates && rec.gates.depth.pass === true && rec.gates.extension, 'pre-checks + gates both recorded');

  const bad = rig({ trendShadow: 1, trendLive: false }, { rug: riggedRug });
  await bad.bot.start();
  await bad.bot.onSignal(view({ price: 1.0 }), { setup: 'trend', strength: 5, metrics: {} });
  const rec2 = bad.bot.journal.signals.find(s => s.setup === 'trend');
  assert.equal(rec2.decision, 'shadow', 'decision stays shadow regardless of gates');
  assert.equal(rec2.gatePass, false);
  assert.equal(rec2.gates.clones.pass, false);
  assert.equal(bad.bot.positions.length, 0);
  assert.equal(bad.bot.stats.entries, 0);
});

test('D1 manual exit: snapshot lands on the manual record and the reason tag joins the same record', async () => {
  const rugRef = { rug: healthyRug };
  const { bot, clock } = rig({}, rugRef);
  await bot.start();
  await bot.onSignal(view({ price: 1.0 }), { setup: 'pop', strength: 1, metrics: {} });
  const pos = bot.positions[0];
  const n = T0 + 20 * 60000;
  clock.t = n;
  pos.ticks = [0, 1, 2].map(i => ({ ts: n - 60000 + i * 20000, price: 1.1 + i * 0.05, ratio: 1.1 + i * 0.05 }));
  pos.peakRatio = 1.3;
  for (let i = 0; i < 3; i++) bot.shadowFlow.note('MINT1', { ts: n - 10000, side: 'buy', sol: 0.5 });
  for (let i = 0; i < 5; i++) bot.shadowFlow.note('MINT1', { ts: n - 5000, side: 'sell', sol: 0.5 });
  for (let i = 0; i < 2; i++) bot.shadowFlow.note('MINT1', { ts: n - 90000, side: 'buy', sol: 0.25 });
  rugRef.rug = { ...healthyRug, totalHolders: 2150 };
  const rec = await bot.recordManualExit(pos, 0.024, n, 'sold in own wallet');
  const s = rec.snapshot;
  assert.ok(s, 'manual record carries an exit snapshot');
  assert.equal(s.path.length, 3, 'last-120s price path from the position tick ring');
  assert.equal(s.distFromPeakPct, -7.69);
  assert.deepEqual([s.flow.last30s.buys, s.flow.last30s.sells], [3, 5]);
  assert.deepEqual([s.flow.prior60s.buys, s.flow.prior60s.sells], [2, 0]);
  assert.equal(s.flow.source, 'stream');
  assert.equal(s.holdersEntry, 2000);
  assert.equal(s.holdersChange, 150);
  assert.equal(s.largeHolderSells, null, 'no holder-delta feed exists — null, never invented');
  assert.equal(s.heldMin, 20);
  assert.ok(s.pnlSol != null && s.pnlPct != null && Math.abs(s.pnlPct - (s.pnlSol / 0.02) * 100) < 0.02);
  // the /exittag reason lands on the SAME record that carries the snapshot
  bot.journal.tagExit(rec.id, 'chart_off');
  const tagged = bot.journal.manual.find(m => m.id === rec.id);
  assert.equal(tagged.reason, 'chart_off');
  assert.ok(tagged.snapshot, 'snapshot and tag share one record');
  // and the close record for the manual exit carries snapshot + stamp + % P&L too
  const close = bot.journal.trades.find(t => t.type === 'close' && t.id === rec.id);
  assert.ok(close.entry && close.stamp && close.pnlPct != null);
});

test('D1 paired: a manual exit spawns a virtual exit that terminates with a would-be record', async () => {
  const { bot, clock } = rig();
  await bot.start();
  await bot.onSignal(view({ price: 1.0 }), { setup: 'pop', strength: 1, metrics: {} });
  const pos = bot.positions[0];
  const n = T0 + 20 * 60000;
  clock.t = n;
  const rec = await bot.recordManualExit(pos, 0.024, n, 'sold in own wallet');
  assert.equal(bot.paired.pending.size, 1, 'paired shadow exit registered');
  // the coin craters after the human sold: the virtual stack exits on its own rules
  bot.latest.set('MINT1', view({ price: 0.5, buysM5: 5, sellsM5: 10 }));
  clock.t = n + 60000;
  bot.paired.tick(m => bot.latest.get(m) || null, clock.t, bot.cfg, 150);
  // the virtual is 21 minutes old and −50% on the crater print, so the
  // ENTRY CLIP (owner order 2026-10-18, exits.js 5a) owns the exit — the
  // tape still has buyers (5 buys vs 10 sells is not the stall exit's
  // dead-flow conjunction), so no other downside rule can take it. Since
  // the owner's 2026-10-18 20:28 amendment the clip needs its 60s
  // confirm: the first crater tick only stamps the pending, and the pair
  // still records the would-be exit once the breach has held a minute
  assert.equal(bot.paired.pending.size, 1, 'first crater tick stamps the clip pending — no instant sale');
  clock.t = n + 120000;
  bot.paired.tick(m => bot.latest.get(m) || null, clock.t, bot.cfg, 150);
  assert.equal(bot.paired.pending.size, 0, 'virtual position terminated once the breach held through the confirm');
  const done = bot.paired.done.find(d => d.id === rec.id);
  assert.ok(done, 'paired comparison record produced');
  assert.equal(done.status, 'exited');
  assert.ok(done.wouldReason, 'records where/when it WOULD have exited');
  assert.match(done.wouldReason, /entry clip/, 'the clip is the rule that would have exited it');
  assert.ok(done.wouldPnlSol < 0, 'cratered coin → would-be P&L is the loss the human avoided');
  assert.ok(done.manualRemainderPnlSol > 0, 'human remainder mark was positive — the pair is comparable');
  assert.equal(done.manualTs, n);
  // never trades, never reopens
  assert.equal(bot.positions.length, 0);
  assert.equal(bot.journal.trades.filter(t => t.type === 'open').length, 1);
});

test('D1 paired: the shadow exit terminates at the cap even with no price data', async () => {
  const { bot, clock } = rig();
  await bot.start();
  await bot.onSignal(view({ price: 1.0 }), { setup: 'pop', strength: 1, metrics: {} });
  const pos = bot.positions[0];
  const n = T0 + 5 * 60000;
  clock.t = n;
  const rec = await bot.recordManualExit(pos, 0.019, n, 'sold in own wallet');
  assert.equal(bot.paired.pending.size, 1);
  bot.paired.tick(() => null, n + 61 * 60000, bot.cfg, 150);
  assert.equal(bot.paired.pending.size, 0, 'cap terminates the watch');
  const done = bot.paired.done.find(d => d.id === rec.id);
  assert.equal(done.status, 'expired');
  assert.ok(done.wouldPnlSol != null, 'expired records still mark the remainder to the last value');
});

test('D1 learn: the bot-winner comparison populates from complete close records', () => {
  const entry = { mc: 500000, liq: 80000, ageMin: 30, holders: 1500, insiderWallets: 2, top10Pct: 18, flowM5: 2.5, chgM5: 4, chgH1: 20, linkedDrain: 0.1 };
  const trades = [
    { type: 'close', manual: false, pnlSol: 0.01, entry },
    { type: 'close', manual: false, pnlSol: -0.005, entry }, // loser — not compared
    { type: 'close', manual: true, pnlSol: 0.02, entry },    // manual — not a bot winner
    { type: 'close', manual: false, pnlSol: 0.03 },          // no entry (pre-D1 record) — excluded
  ];
  const manual = [{ id: 'x', reason: 'chart_off', entry }];
  const rep = learnReport(manual, trades);
  assert.equal(rep.botWinnersCompared, 1, 'exactly the bot-managed winners with snapshots count');
  assert.equal(rep.compare.holders.botWinners, 1500);
  assert.equal(rep.compare.mc.botWinners, 500000);
  assert.equal(rep.compare.holders.manualExits, 1500);
});

test('D1 pagination: defaults unchanged, limit/offset walk the full history', async () => {
  const { bot } = rig();
  await bot.start();
  for (let i = 0; i < 250; i++) {
    bot.journal.trade({ type: 'close', id: `t${i}`, mint: 'M' + i, symbol: 'T' + i, ts: T0 + i, entrySol: 0.02, pnlSol: i < 3 ? 0.01 : -0.001, ...(i < 3 ? { entry: { holders: 100 + i, mc: 1000 } } : {}) });
    bot.journal.signal({ mint: 'S' + i, symbol: 'S' + i, setup: 'pop', decision: 'skipped', reasons: ['x'], price: 1, mc: 1 });
  }
  for (let i = 0; i < 30; i++) bot.journal.manualExit({ id: `m${i}`, mint: 'M' + i, symbol: 'T' + i, ts: T0 + i, heldMin: 1, entry: { holders: 50 + i }, reason: null });
  for (let i = 0; i < 60; i++) bot.postExit.done.push({ id: `p${i}`, mint: 'M' + i });
  for (let i = 0; i < 5; i++) bot.paired.done.push({ id: `ps${i}`, mint: 'M' + i, status: 'exited' });
  const srv = startServer(bot, 0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const get = async (p) => { const r = await fetch(base + p); assert.equal(r.status, 200, p); return r.json(); };
  try {
    // /trades — legacy default: bare array of the newest 100
    const t0 = await get('/trades');
    assert.ok(Array.isArray(t0) && t0.length === 100 && t0[0].id === 't249');
    const seen = new Set();
    for (let off = 0; off < 250; off += 100) {
      const page = await get(`/trades?limit=100&offset=${off}`);
      assert.equal(page.total, 250);
      for (const it of page.items) { assert.ok(!seen.has(it.id)); seen.add(it.id); }
    }
    assert.equal(seen.size, 250, 'pagination walks past the old 100 cap to the full history');
    // /signals — legacy limit stays a bare array; offset (or >200 limit) pages
    const s0 = await get('/signals');
    assert.ok(Array.isArray(s0) && s0.length === 50);
    const s1 = await get('/signals?limit=120');
    assert.ok(Array.isArray(s1) && s1.length === 120, 'legacy limit semantics preserved');
    const s2 = await get('/signals?limit=100&offset=200');
    assert.equal(s2.total, 250);
    assert.equal(s2.items.length, 50);
    const s3 = await get('/signals?limit=500');
    assert.equal(s3.total, 250);
    assert.equal(s3.items.length, 250, 'limit above the old 200 cap reaches everything');
    // /postexit — default shape + paired key; paging walks done
    const p0 = await get('/postexit');
    assert.ok(Array.isArray(p0.done) && p0.done.length === 50);
    assert.ok(p0.paired && p0.paired.total === 5 && p0.paired.done.length === 5, 'paired records exposed on /postexit');
    const p1 = await get('/postexit?limit=10&offset=55');
    assert.equal(p1.total, 60);
    assert.equal(p1.done.length, 5);
    // /learn — default last-20 with entry no longer stripped; paging walks all 30
    const l0 = await get('/learn');
    assert.equal(l0.exits.length, 20);
    assert.ok(l0.exits[0].entry && l0.exits[0].entry.holders != null, 'entry snapshot present on /learn exits');
    assert.equal(l0.botWinnersCompared, 3, 'the comparison populates from the seeded D1 closes');
    const l1 = await get('/learn?limit=10&offset=25');
    assert.equal(l1.total, 30);
    assert.equal(l1.exits.length, 5);
  } finally { srv.close(); }
});
