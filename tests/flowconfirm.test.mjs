// FLOW CONFIRMATION LANE (owner order 2026-10-17, "Go ahead and.
// Build." — the morning's audits in one line: first catches lose; a coin
// that already fired, stayed liquid, and fires AGAIN is the proven
// shape). While BASE_MODE is on, a live flow fire on a mint with a
// PRIOR distinct flow EVENT inside FLOW_CONFIRM_WINDOW_H — an event
// counts however its own evaluation ended, including a first fire the
// $0-liq read or the $5K min-MC floor ate (owner amendment) — at
// mc >= FLOW_CONFIRM_MIN_MC routes DIRECT through the standard pipeline
// at exactly FLOW_CONFIRM_SOL instead of enrolling. The lane waives
// only the winner/loser/closed mint cooldowns for its own entries
// (lane re-entry timer FLOW_CONFIRM_REENTRY_MIN + per-mint cap
// FLOW_CONFIRM_MAX_ENTRIES govern), stamps every record with the lane
// marker, tallies risk-blocked qualifying fires (starved-test
// bookkeeping — they never count toward the kill sample), and at
// FLOW_CONFIRM_KILL_N closes with a negative mean PnL disables itself
// (persisted + journaled flowConfirmDisabled + /state). Kill switch
// FLOW_CONFIRM_LIVE=0 restores enrollment-for-everything exactly.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { SOL_MINT } from '../src/util.js';
import { tmp, testCfg, view } from './helpers.mjs';

const T0 = 1_000_000_000_000;
const W1 = '5B52w1ZW9tuwUduueP5J7HXz5AcGfruGoX6YoAudvyxG';
const W2 = 'Be24Gbf5KisDk1LcWWZsBn8dvB816By7YzYF5zWZnRR6';
const healthyRug = { token: { supply: 1e15, decimals: 6 }, creatorBalance: 0, totalHolders: 2000, graphInsidersDetected: 0, markets: [{ pubkey: 'POOL', lp: { base: 1e8, quote: 1400, lpLockedUSD: 3e5, lpLockedPct: 100 } }], knownAccounts: { POOL: { type: 'AMM' } }, topHolders: Array.from({ length: 12 }, (_, i) => ({ owner: 'h' + i, address: 'h' + i, amount: 9e12 - i * 3.1e10, pct: 2 })), insiderNetworks: [] };
const MIN = 60000;

// Full-pipeline rig (the liveflips/basemode shape): real Bot + real
// onSignal + scripted-quote Executor. baseMode rides loadConfig's
// default (ON) unless overridden — the lane only exists inside it.
function pipelineRig({ cfgOver = {}, env = {} } = {}) {
  const cfg = testCfg({ tradeSol: 0.02, enrollSignals: 1, ...cfgOver }, env); // the lane is judged against enrollment; ENROLL_SIGNALS defaults 0 since the owner's 2026-10-18 removal order
  const clock = { t: T0 };
  // sell-back mock: a full round trip returns 0.024 SOL — a 0.96 ratio at
  // the lane's 0.025 size (the liveflips rig's 0.019 would read 0.76 at
  // this size and trip the round-trip floor for a mock artifact's sake)
  const q = { valueLam: 24_000_000 };
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
  return { bot, clock, views, cfg };
}

function seedHist(bot, mint, t, price = 1, mc = 60_000) {
  const samples = [];
  for (let k = 0; k < 12; k++) samples.push({ ts: t - (11 - k) * 30000, price, mc, volM5: 100_000, volH1: 500_000, buysM5: 900, sellsM5: 800, liq: 100_000 });
  bot.history.m.set(mint, samples);
}

/** One flow fire through the real _evalFlow. buyTs/wallet/sol define the
 *  EVENT identity — a distinct event needs a distinct buyTs (or wallet). */
async function flowFire(rig, { mint = 'MINTF', mc = 60_000, liq = 20_000, price = 1, buyTs, wallet = W1, sol = 2, histPrice = null, histMc = null } = {}) {
  const { bot, clock, views } = rig;
  const v = view({ address: mint, symbol: 'FLOWC', mc, liq, price, chgM5: 1, createdAt: clock.t - 10 * 3600e3, dex: 'pumpswap' });
  views.set(mint, v);
  await bot.start();
  seedHist(bot, mint, clock.t, histPrice ?? price, histMc ?? mc);
  const ts = buyTs ?? clock.t;
  await bot._evalFlow(mint, { wallets: [wallet], maxSol: sol, count: 1, kind: 'solo', wallet, walletSol: sol, buyTs: ts, label: `flow: test wallet bought ${sol.toFixed(2)} SOL` });
  return bot.journal.signals.filter(s => s.mint === mint).at(-1);
}

const laneState = (rig, mint) => rig.bot.flowConfirmState.mints[mint];

// ------------------------------------------------------------ config
test('config: lane defaults at the owner-locked values; env knobs parse; validation bounds them', () => {
  const d = loadConfig({});
  assert.equal(d.flowConfirmLive, true);
  assert.equal(d.flowConfirmWindowH, 3);
  assert.equal(d.flowConfirmMinMc, 50000);
  assert.equal(d.flowConfirmSol, 0.025);
  assert.equal(d.flowConfirmReentryMin, 10);
  assert.equal(d.flowConfirmMaxEntries, 2);
  assert.equal(d.flowConfirmKillN, 15);
  assert.equal(loadConfig({ FLOW_CONFIRM_LIVE: '0' }).flowConfirmLive, false);
  assert.equal(loadConfig({ FLOW_CONFIRM_SOL: '0.05' }).flowConfirmSol, 0.05);
  assert.equal(loadConfig({ FLOW_CONFIRM_WINDOW_H: '6' }).flowConfirmWindowH, 6);
  assert.equal(loadConfig({ FLOW_CONFIRM_MIN_MC: '75000' }).flowConfirmMinMc, 75000);
  assert.ok(validateConfig(loadConfig({ FLOW_CONFIRM_WINDOW_H: '0' })).some(e => e.includes('FLOW_CONFIRM_WINDOW_H')));
  assert.ok(validateConfig(loadConfig({ FLOW_CONFIRM_SOL: '0' })).some(e => e.includes('FLOW_CONFIRM_SOL')));
  assert.ok(validateConfig(loadConfig({ FLOW_CONFIRM_MAX_ENTRIES: '0' })).some(e => e.includes('FLOW_CONFIRM_MAX_ENTRIES')));
  assert.ok(validateConfig(loadConfig({ FLOW_CONFIRM_KILL_N: '0' })).some(e => e.includes('FLOW_CONFIRM_KILL_N')));
  assert.ok(!validateConfig(d).some(e => e.includes('FLOW_CONFIRM')));
});

// ------------------------------------------------------------ (a) first fire enrolls
test('(a) a first flow fire enrolls exactly as before the lane — no marker, no entry', async () => {
  const rig = pipelineRig();
  const rec = await flowFire(rig, {});
  assert.equal(rec.decision, 'skipped');
  assert.ok(rec.reasons.some(r => r.startsWith('base mode: enrolled')), JSON.stringify(rec.reasons));
  assert.equal(rec.metrics.flowConfirm, undefined);
  assert.equal(rig.bot.positions.length, 0);
  assert.equal(rig.bot.flowConfirmState.fires, 1, 'the event is registered even though it enrolled');
  assert.equal(rig.bot.flowConfirmState.qualifiedFires, 0);
  assert.equal(rig.bot.flowConfirmState.entries, 0);
});

// ------------------------------------------------------------ (b) qualifying repeat enters at exactly 0.025
test('(b) a qualifying repeat fire enters DIRECT at exactly FLOW_CONFIRM_SOL, lane marker everywhere', async () => {
  const rig = pipelineRig();
  await flowFire(rig, { buyTs: T0 });
  rig.clock.t += 20 * MIN;
  const rec = await flowFire(rig, { buyTs: T0 + 20 * MIN, wallet: W2 });
  assert.equal(rec.decision, 'taken', JSON.stringify(rec.reasons));
  assert.equal(rec.metrics.flowConfirm, 1);
  assert.equal(rec.metrics.flowConfirmOrdinal, 1);
  assert.equal(rec.metrics.sizeSol, 0.025, 'the lane size — not tradeSol 0.02, not a brake/slot figure');
  assert.equal(rec.gates.flowConfirm.enrolledBypass, true);
  assert.equal(rig.bot.positions.length, 1);
  const pos = rig.bot.positions[0];
  assert.equal(pos.setup, 'flow');
  assert.equal(pos.entrySol, 0.025);
  assert.deepEqual(pos.flowConfirm, { ordinal: 1 });
  assert.equal(pos.slot, undefined, 'a lane entry is never slot-stamped');
  const open = rig.bot.journal.trades.find(t => t.type === 'open');
  assert.equal(open.flowConfirm, 1);
  assert.equal(open.flowConfirmOrdinal, 1);
  const st = rig.bot.state().flowConfirm;
  assert.equal(st.enabled, true);
  assert.equal(st.fires, 2);
  assert.equal(st.qualifiedFires, 1);
  assert.equal(st.entries, 1);
  assert.equal(st.byMint.MINTF.entries, 1);
});

// ------------------------------------------------------------ amendment 1: the first fire counts even when a floor ate it
test('amendment 1: a first fire blocked by the $5K min-MC floor STILL counts — second fire at $60K qualifies', async () => {
  const rig = pipelineRig();
  const rec1 = await flowFire(rig, { mc: 3_000, liq: 100, buyTs: T0 });
  assert.equal(rec1.decision, 'skipped');
  assert.ok(rec1.reasons.some(r => /mc \$3000 < \$10000/.test(r)), JSON.stringify(rec1.reasons));
  assert.equal(rig.bot.flowConfirmState.fires, 1, 'the blocked event is in the registry');
  assert.equal(rig.bot.positions.length, 0);
  rig.clock.t += 20 * MIN;
  const rec2 = await flowFire(rig, { mc: 60_000, liq: 20_000, buyTs: T0 + 20 * MIN, wallet: W2 });
  assert.equal(rec2.decision, 'taken', JSON.stringify(rec2.reasons));
  assert.equal(rec2.metrics.flowConfirm, 1);
  assert.equal(rig.bot.positions[0].entrySol, 0.025);
});

// ------------------------------------------------------------ (c) non-qualifying repeats enroll
test('(c1) a repeat fire under the $50K lane floor enrolls (judged on its own mc)', async () => {
  const rig = pipelineRig();
  await flowFire(rig, { buyTs: T0 });
  rig.clock.t += 20 * MIN;
  const rec = await flowFire(rig, { mc: 30_000, buyTs: T0 + 20 * MIN, wallet: W2 });
  assert.equal(rec.decision, 'skipped');
  assert.ok(rec.reasons.some(r => r.startsWith('base mode: enrolled')), JSON.stringify(rec.reasons));
  assert.equal(rec.metrics.flowConfirm, undefined);
  assert.equal(rig.bot.positions.length, 0);
  assert.equal(rig.bot.flowConfirmState.qualifiedFires, 0);
});

test('(c2) a repeat fire after the 3h window enrolls — the prior fire is stale', async () => {
  const rig = pipelineRig();
  await flowFire(rig, { buyTs: T0 });
  rig.clock.t += 3 * 3600000 + 10 * MIN;
  const rec = await flowFire(rig, { buyTs: rig.clock.t, wallet: W2 });
  assert.equal(rec.decision, 'skipped');
  assert.ok(rec.reasons.some(r => r.startsWith('base mode: enrolled')), JSON.stringify(rec.reasons));
  assert.equal(rig.bot.positions.length, 0);
});

test('(c3) the SAME event re-evaluated is not a second fire — registry dedupes by event identity', async () => {
  const rig = pipelineRig();
  const agg = { buyTs: T0 };
  await flowFire(rig, agg);
  rig.clock.t += 11 * MIN; // past the 10m signal cooldown, so guards pass and only identity can save it
  const rec = await flowFire(rig, agg); // identical buyTs + wallet + sol = the same event
  assert.equal(rig.bot.flowConfirmState.fires, 1, 'one event, one fire — however often it is re-journaled');
  assert.equal(rec.decision, 'skipped');
  assert.ok(rec.reasons.some(r => r.startsWith('base mode: enrolled')), JSON.stringify(rec.reasons));
  assert.equal(rig.bot.positions.length, 0);
});

// ------------------------------------------------------------ (d) top guard still binds the lane
test('(d) a qualifying repeat fire at the local top is blocked by the TOP GUARD — the lane bypasses enrollment, not safety', async () => {
  const rig = pipelineRig();
  await flowFire(rig, { buyTs: T0 });
  rig.clock.t += 20 * MIN;
  const n = rig.clock.t;
  // blocus shape, relative to the second fire: flat $45K, then a vertical
  // ramp to a $66K high 30s ago (+47% inside the 2-minute surge window)
  const S = (ts, mc) => ({ ts, price: mc / 1e6, mc, volM5: 100_000, volH1: 500_000, buysM5: 900, sellsM5: 800, liq: 100_000 });
  const samples = [];
  for (let t = n - 25 * MIN; t <= n - 120000; t += 60000) samples.push(S(t, 45_000));
  samples.push(S(n - 110000, 52_000), S(n - 70000, 60_000), S(n - 30000, 66_000));
  const v = view({ address: 'MINTF', symbol: 'FLOWC', mc: 65_000, liq: 20_000, price: 0.065, chgM5: 1, createdAt: n - 10 * 3600e3, dex: 'pumpswap' });
  rig.views.set('MINTF', v);
  await rig.bot.start();
  rig.bot.history.m.set('MINTF', samples);
  await rig.bot._evalFlow('MINTF', { wallets: [W2], maxSol: 2, count: 1, kind: 'solo', wallet: W2, walletSol: 2, buyTs: n, label: 'flow: test wallet bought 2.00 SOL' });
  const rec = rig.bot.journal.signals.filter(s => s.mint === 'MINTF').at(-1);
  assert.equal(rec.decision, 'skipped');
  assert.ok(rec.reasons.some(r => /local top/.test(r)), JSON.stringify(rec.reasons));
  assert.equal(rec.metrics.flowConfirm, 1, 'the blocked record still carries the lane marker');
  assert.equal(rig.bot.positions.length, 0);
  assert.equal(rig.bot.flowConfirmState.qualifiedFires, 1, 'it qualified — the guard, not the lane, said no');
  assert.equal(rig.bot.flowConfirmState.entries, 0);
});

// ------------------------------------------------------------ (e)+(f) re-entry timer, cap, cooldown override scope
test('(e/f) lane re-entry: timer gates, the winner cooldown is waived ONLY for the lane, cap stops #3', async () => {
  const rig = pipelineRig();
  const { bot, clock } = rig;
  const mint = 'MINTF';
  await flowFire(rig, { buyTs: T0 });                                     // enroll
  clock.t += 20 * MIN;
  await flowFire(rig, { buyTs: T0 + 20 * MIN, wallet: W2 });              // lane entry #1
  assert.equal(bot.positions.length, 1);
  clock.t += 30 * MIN;                                                    // T0+50m: close #1 as a WIN (held 30m — the
  const pos1 = bot.positions[0];                                          // entry-anchored mint cooldown has expired)
  await bot.recordManualExit(pos1, 0.03, clock.t, 'sold in own wallet');
  assert.equal(bot.positions.length, 0);
  assert.ok(bot.risk.s.wins[mint], 'the win stamped the global 10h winner cooldown');
  assert.equal(laneState(rig, mint).windowEntries, 1);
  assert.equal(laneState(rig, mint).lastCloseTs, T0 + 50 * MIN);
  // (f) the other doors stay blocked: a pop candidate on the same mint
  // dies at the risk gate on the winner cooldown the lane is about to waive
  clock.t += 5 * MIN;                                                     // T0+55m
  {
    const v = view({ address: mint, symbol: 'FLOWC', mc: 60_000, liq: 20_000, price: 0.75, chgM5: 1, createdAt: clock.t - 10 * 3600e3, dex: 'pumpswap' });
    rig.views.set(mint, v);
    seedHist(bot, mint, clock.t, 1, 60_000);
    await bot.onSignal(v, { setup: 'pop', strength: 42, metrics: { volM5: 100_000 } });
    const rec = bot.journal.signals.filter(s => s.mint === mint && s.setup === 'pop').at(-1);
    assert.equal(rec.decision, 'skipped');
    assert.ok(rec.reasons.some(r => /no re-buy/.test(r)), JSON.stringify(rec.reasons));
    assert.equal(bot.positions.length, 0);
  }
  // a non-qualifying fire 5m after the close is NOT waived either — the
  // global cooldown eats it at the risk gate (today's behavior, untouched)
  const rec3 = await flowFire(rig, { buyTs: clock.t, price: 0.75, histPrice: 1 });
  assert.equal(rec3.decision, 'skipped');
  assert.ok(rec3.reasons.some(r => /no re-buy/.test(r)), JSON.stringify(rec3.reasons));
  assert.equal(rec3.metrics.flowConfirm, undefined, 'not qualified inside the lane re-entry timer — no marker, no waiver');
  assert.equal(bot.positions.length, 0);
  // 16m after the close (and >10m after the last signal): the lane
  // re-enters — ordinal 2, same size, DESPITE the live winner cooldown
  clock.t += 11 * MIN;                                                    // T0+66m
  const rec4 = await flowFire(rig, { buyTs: clock.t, wallet: W2, price: 0.75, histPrice: 1 });
  assert.equal(rec4.decision, 'taken', JSON.stringify(rec4.reasons));
  assert.equal(rec4.metrics.flowConfirm, 1);
  assert.equal(rec4.metrics.flowConfirmOrdinal, 2);
  assert.equal(bot.positions.length, 1);
  assert.equal(bot.positions[0].entrySol, 0.025);
  assert.deepEqual(bot.positions[0].flowConfirm, { ordinal: 2 });
  // close #2 as a loss, then a third qualifying fire: the 2-cap holds
  clock.t += 10 * MIN;                                                    // T0+76m
  await bot.recordManualExit(bot.positions[0], 0.02, clock.t, 'sold in own wallet');
  assert.equal(bot.positions.length, 0);
  clock.t += 11 * MIN;                                                    // T0+87m: re-entry timer clear, window live
  const rec5 = await flowFire(rig, { buyTs: clock.t, price: 0.75, histPrice: 1 });
  assert.equal(rec5.decision, 'skipped', 'the cap denies the waiver — the fire is judged as an ordinary one');
  assert.equal(rec5.metrics.flowConfirm, undefined);
  assert.equal(bot.positions.length, 0);
  assert.equal(laneState(rig, mint).windowEntries, 2);
  assert.equal(bot.flowConfirmState.entries, 2);
});

// ------------------------------------------------------------ amendment 2: starved-test bookkeeping
test('amendment 2: a qualifying fire blocked by a FULL SLOT journals a lane record + blocked.slot tally, never enters', async () => {
  const rig = pipelineRig({ cfgOver: { maxPositions: 1 } });
  const { bot, clock } = rig;
  await flowFire(rig, { mint: 'MINTA', buyTs: T0 });
  clock.t += 20 * MIN;
  await flowFire(rig, { mint: 'MINTA', buyTs: clock.t, wallet: W2 });
  assert.equal(bot.positions.length, 1, 'mint A holds the only slot');
  await flowFire(rig, { mint: 'MINTB', buyTs: clock.t });
  clock.t += 20 * MIN;
  const rec = await flowFire(rig, { mint: 'MINTB', buyTs: clock.t, wallet: W2 });
  assert.equal(rec.decision, 'skipped');
  assert.ok(rec.reasons.some(r => /max 1 positions open/.test(r)), JSON.stringify(rec.reasons));
  assert.equal(rec.metrics.flowConfirm, 1, 'the blocked record carries the lane marker + exact reason');
  assert.equal(bot.positions.length, 1);
  assert.equal(bot.positions[0].mint, 'MINTA');
  assert.equal(bot.flowConfirmState.blocked.slot, 1);
  assert.equal(bot.flowConfirmState.closes, 0, 'blocked fires never enter the kill-rule sample');
});

test('amendment 2: a qualifying fire during HALT journals a lane record + blocked.halt tally, never enters', async () => {
  const rig = pipelineRig();
  const { bot, clock } = rig;
  await flowFire(rig, { buyTs: T0 });
  fs.writeFileSync(path.join(rig.cfg.dataDir, 'HALT'), String(clock.t));
  clock.t += 20 * MIN;
  const rec = await flowFire(rig, { buyTs: clock.t, wallet: W2 });
  assert.equal(rec.decision, 'skipped');
  assert.ok(rec.reasons.some(r => /HALT file present/.test(r)), JSON.stringify(rec.reasons));
  assert.equal(rec.metrics.flowConfirm, 1);
  assert.equal(bot.positions.length, 0);
  assert.equal(bot.flowConfirmState.blocked.halt, 1);
  assert.equal(bot.flowConfirmState.entries, 0);
});

// ------------------------------------------------------------ (g) kill rule
test('(g) kill rule: 15 negative lane closes disable the lane — journaled, in /state, and a restart keeps it off', async () => {
  const rig = pipelineRig({ cfgOver: { streakPauseN: 0, lossHalveN: 0, wipeHaltFrac: 0, haltAfterCloses: 0 } });
  const { bot, clock } = rig;
  for (let i = 1; i <= 15; i++) {
    const mint = 'KILLM' + i;
    await flowFire(rig, { mint, buyTs: clock.t });
    clock.t += 20 * MIN;
    const rec = await flowFire(rig, { mint, buyTs: clock.t, wallet: W2 });
    assert.equal(rec.decision, 'taken', `mint ${i}: ${JSON.stringify(rec.reasons)}`);
    await bot.recordManualExit(bot.positions[0], 0.02, clock.t, 'sold in own wallet'); // ~-0.005 SOL each
    assert.equal(bot.positions.length, 0);
    clock.t += 20 * MIN;
  }
  const st = bot.state().flowConfirm;
  assert.equal(st.closes, 15);
  assert.ok(st.meanPnlSol < 0, `mean ${st.meanPnlSol}`);
  assert.equal(st.disabled, true);
  assert.equal(st.enabled, false);
  assert.ok(st.disabledMeanPnlSol < 0, 'the mean AT disablement is on the block');
  assert.equal(st.disabledMeanPnlSol, st.meanPnlSol);
  const journalFile = fs.readFileSync(path.join(rig.cfg.dataDir, 'flow_confirm.jsonl'), 'utf8');
  const evt = journalFile.trim().split('\n').map(l => JSON.parse(l)).find(r => r.type === 'flowConfirmDisabled');
  assert.ok(evt, 'a distinct journal event marks the disablement');
  assert.equal(evt.closes, 15);
  assert.ok(evt.meanPnlSol < 0);
  // the 16th coin's qualifying fire enrolls again — the lane is off
  await flowFire(rig, { mint: 'KILLM16', buyTs: clock.t });
  clock.t += 20 * MIN;
  const rec16 = await flowFire(rig, { mint: 'KILLM16', buyTs: clock.t, wallet: W2 });
  assert.equal(rec16.decision, 'skipped');
  assert.ok(rec16.reasons.some(r => r.startsWith('base mode: enrolled')), JSON.stringify(rec16.reasons));
  assert.equal(bot.positions.length, 0);
  // restart: a fresh Bot on the same data dir inherits the disablement
  const bot2 = new Bot(rig.cfg, {
    now: () => clock.t, exec: bot.exec,
    discover: async () => Object.assign(new Map(), { counts: {} }),
    fetchViews: async () => new Map(),
    fetchSolUsd: async () => 150, fetchRug: async () => healthyRug, searchByName: async () => [],
  });
  assert.equal(bot2.state().flowConfirm.disabled, true);
  assert.equal(bot2.state().flowConfirm.closes, 15);
});

test('(g2) kill rule: a non-negative mean at the check keeps the lane live (one-time gate)', async () => {
  const rig = pipelineRig({ cfgOver: { streakPauseN: 0, lossHalveN: 0, wipeHaltFrac: 0, haltAfterCloses: 0 }, env: { FLOW_CONFIRM_KILL_N: '3' } });
  const { bot, clock } = rig;
  for (let i = 1; i <= 3; i++) {
    const mint = 'WINM' + i;
    await flowFire(rig, { mint, buyTs: clock.t });
    clock.t += 20 * MIN;
    await flowFire(rig, { mint, buyTs: clock.t, wallet: W2 });
    await bot.recordManualExit(bot.positions[0], 0.03, clock.t, 'sold in own wallet'); // green closes
    clock.t += 20 * MIN;
  }
  const st = bot.state().flowConfirm;
  assert.equal(st.closes, 3);
  assert.equal(st.killChecked, true);
  assert.equal(st.disabled, false);
  assert.equal(st.enabled, true);
  // and it still enters afterwards
  await flowFire(rig, { mint: 'WINM4', buyTs: clock.t });
  clock.t += 20 * MIN;
  const rec = await flowFire(rig, { mint: 'WINM4', buyTs: clock.t, wallet: W2 });
  assert.equal(rec.decision, 'taken', JSON.stringify(rec.reasons));
});

// ------------------------------------------------------------ (h) kill switch
test('(h) FLOW_CONFIRM_LIVE=0: a qualifying repeat fire enrolls exactly as before the lane existed', async () => {
  const rig = pipelineRig({ env: { FLOW_CONFIRM_LIVE: '0' } });
  await flowFire(rig, { buyTs: T0 });
  rig.clock.t += 20 * MIN;
  const rec = await flowFire(rig, { buyTs: T0 + 20 * MIN, wallet: W2 });
  assert.equal(rec.decision, 'skipped');
  assert.ok(rec.reasons.some(r => r.startsWith('base mode: enrolled')), JSON.stringify(rec.reasons));
  assert.equal(rec.metrics.flowConfirm, undefined);
  assert.equal(rig.bot.positions.length, 0);
  assert.equal(rig.bot.state().flowConfirm.enabled, false);
  assert.equal(rig.bot.state().flowConfirm.killSwitch, false);
});

// ------------------------------------------------------------ (i) restart persistence of the cap
test('(i) lane state survives a restart: the per-mint 2-entry cap and counts reload from disk', async () => {
  const dir = tmp();
  const env = { DATA_DIR: dir };
  const rig = pipelineRig({ env });
  const { bot, clock } = rig;
  const mint = 'MINTF';
  await flowFire(rig, { buyTs: T0 });
  clock.t += 20 * MIN;
  await flowFire(rig, { buyTs: clock.t, wallet: W2 });
  clock.t += 10 * MIN; // held 10m — the entry-anchored mint cooldown expires before the re-fire
  await bot.recordManualExit(bot.positions[0], 0.03, clock.t, 'sold in own wallet');
  clock.t += 11 * MIN;
  const rec2 = await flowFire(rig, { buyTs: clock.t, price: 0.75, histPrice: 1 });
  assert.equal(rec2.decision, 'taken', JSON.stringify(rec2.reasons));
  await bot.recordManualExit(bot.positions[0], 0.03, clock.t, 'sold in own wallet');
  assert.equal(laneState(rig, mint).windowEntries, 2);
  assert.ok(fs.existsSync(path.join(dir, 'flow-confirm.json')), 'the registry is a persisted file');
  // fresh Bot, same data dir: the cap must still hold
  const bot2 = new Bot(rig.cfg, {
    now: () => clock.t, exec: bot.exec,
    discover: async () => Object.assign(new Map(), { counts: {} }),
    fetchViews: async (mints) => new Map(mints.filter(m => rig.views.has(m)).map(m => [m, rig.views.get(m)])),
    fetchSolUsd: async () => 150, fetchRug: async () => healthyRug, searchByName: async () => [],
  });
  assert.equal(bot2.flowConfirmState.mints[mint].windowEntries, 2);
  assert.equal(bot2.state().flowConfirm.entries, 2);
  assert.equal(bot2.state().flowConfirm.closes, 2);
  clock.t += 11 * MIN;
  await bot2.start();
  seedHist(bot2, mint, clock.t, 1, 60_000);
  rig.views.set(mint, view({ address: mint, symbol: 'FLOWC', mc: 60_000, liq: 20_000, price: 0.75, chgM5: 1, createdAt: clock.t - 10 * 3600e3, dex: 'pumpswap' }));
  await bot2._evalFlow(mint, { wallets: [W2], maxSol: 2, count: 1, kind: 'solo', wallet: W2, walletSol: 2, buyTs: clock.t, label: 'flow: test wallet bought 2.00 SOL' });
  const rec = bot2.journal.signals.filter(s => s.mint === mint).at(-1);
  assert.equal(bot2.positions.length, 0, 'the reloaded cap still blocks a third entry');
  assert.equal(bot2.flowConfirmState.mints[mint].windowEntries, 2);
});
