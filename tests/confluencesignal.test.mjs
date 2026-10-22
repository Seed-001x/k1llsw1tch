// Confluence Shadow Signal (user order 2026-10-16, RECORD-ONLY): every
// walletWatch confluence fire opens two DETECTION-time virtual positions —
// SCALP (100% exit at the first check whose net gain reaches +20%) and
// LADDER (the live evaluateExit stack) — on a 0.05 SOL shadow stake, with
// the fire's bucket features journaled. These tests pin the dual-open, the
// scalp's touch discipline (never before the line, whole at the line), the
// ladder running the real stack, the mirrored downside rules (liquidity
// death / momentum-failure undertaker / 4h cap), noView accounting,
// dedupe across restarts, the kill switch, the /confluencesignal surface,
// and the isolation contract: no real position, no stats.entries, no risk
// state, no trade-journal records — ever, and no decision-path source
// references the module or its journal.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { SOL_MINT } from '../src/util.js';
import { ConfluenceSignal, CONFLUENCE_CAP_MS, scalpExit, buildConfluenceCard } from '../src/confluenceSignal.js';
import { startServer } from '../src/server.js';
import { testCfg, view, tmp } from './helpers.mjs';

const T0 = 1_000_000_000_000;
// feeFrac on the exits.js gain ruler at these knobs: 3 × 0.001 / 0.05 = 0.06,
// so the +20% scalp needs ratio ≥ 1.26 and TP1 (0.25, ceiling 0.60) arms ≥ 1.31.
const CFG = { txFeeSol: 0.001, tradeSol: 0.05, confluenceScalpPct: 0.20, tp1Pct: 0.25, tp1Frac: 0.4, tp1AdaptMax: 0.60, tp1Giveback: 0.08 };
const cfg = (over = {}) => testCfg({ ...CFG, ...over });

const approx = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

function fireEv(over = {}) {
  return {
    id: 'cnf-1000-1', kind: 'confluence', ts: T0 + 240000, // detection: 4 min after the window closed
    mint: 'MINT1', symbol: 'CNF', entryTs: T0, // window close (deciding buy, blockTime)
    clusters: ['alpha', 'beta'], entities: ['e1', 'e2'], names: ['Alpha', 'Beta'],
    maxSol: 4.2, walletCount: 3, coinAgeMin: 12.5, mc: 42000, pool: 'POOL1',
    viewPrice: 2, gates: { fresh: { pass: true } }, gatePass: true, firstBlocker: null,
    ...over,
  };
}

const readJournal = (dir) => fs.readFileSync(path.join(dir, 'confluence_signal.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));

// ------------------------------------------------------------ module unit
test('confluence signal: a fire journals its features and opens the SCALP + LADDER pair at detection', () => {
  const dir = tmp();
  const cs = new ConfluenceSignal({ cfg: cfg(), dir, now: () => T0 + 240000 });
  const fire = cs.noteEvent(fireEv(), { held: true, signaled: false });
  assert.ok(fire, 'fire record returned');
  assert.equal(fire.noView, false);
  assert.equal(fire.lagSec, 240, 'detection lag = detection ts − window close');
  assert.equal(fire.entryPrice, 2, 'entry ref = the detection view price');
  assert.equal(fire.sizeSol, 0.05, 'standard shadow stake');
  assert.deepEqual(fire.names, ['Alpha', 'Beta']);
  assert.equal(fire.walletCount, 3);
  assert.equal(fire.maxSol, 4.2);
  assert.equal(fire.mc, 42000);
  assert.equal(fire.coinAgeMin, 12.5);
  assert.equal(fire.gatePass, true);
  assert.equal(fire.held, true);
  assert.equal(fire.signaled, false);
  assert.equal(cs.pending.size, 2, 'both profiles opened');
  assert.ok(cs.pending.has('cnf-1000-1:scalp') && cs.pending.has('cnf-1000-1:ladder'));
  assert.deepEqual(cs.pendingMints(), [{ mint: 'MINT1', since: T0 + 240000 }], 'fetch-set stamp is the DETECTION time, not blockTime');
  const lines = readJournal(dir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, 'fire');
  // a dev event and a malformed event open nothing
  assert.equal(cs.noteEvent({ id: 'dev-1', kind: 'dev', mint: 'MINT9', ts: T0 }), null);
  assert.equal(cs.noteEvent(null), null);
  assert.equal(cs.pending.size, 2);
});

test('confluence signal: dedupe by event id — same instance and across a restart', () => {
  const dir = tmp();
  const cs = new ConfluenceSignal({ cfg: cfg(), dir, now: () => T0 + 240000 });
  assert.ok(cs.noteEvent(fireEv()));
  assert.equal(cs.noteEvent(fireEv()), null, 're-journal in the same process opens nothing twice');
  assert.equal(cs.pending.size, 2);
  const cs2 = new ConfluenceSignal({ cfg: cfg(), dir, now: () => T0 + 300000 });
  assert.equal(cs2.pending.size, 2, 'in-flight pair restored at boot');
  assert.equal(cs2.noteEvent(fireEv()), null, 'the rebuilt seen-set refuses the same event id');
  assert.equal(readJournal(dir).filter(r => r.type === 'fire').length, 1, 'exactly one fire record on disk');
});

test('confluence signal: a fire with no detection view journals as noView and opens nothing', () => {
  const dir = tmp();
  const cs = new ConfluenceSignal({ cfg: cfg(), dir, now: () => T0 + 240000 });
  const fire = cs.noteEvent(fireEv({ viewPrice: null }), {});
  assert.ok(fire);
  assert.equal(fire.noView, true);
  assert.equal(fire.entryPrice, null);
  assert.equal(cs.pending.size, 0, 'no positions without a price');
  const card = buildConfluenceCard(readJournal(dir), T0 + 300000);
  assert.equal(card.fires, 1);
  assert.equal(card.noView, 1);
  assert.equal(card.noViewRate, 1);
  assert.equal(card.profiles.scalp.opened, 0);
  assert.equal(card.profiles.ladder.opened, 0);
});

test('confluence signal: kill switch — no fires journaled, card dark', () => {
  const dir = tmp();
  const cs = new ConfluenceSignal({ cfg: cfg({ confluenceSignal: 0 }), dir, now: () => T0 });
  assert.equal(cs.enabled, false);
  assert.equal(cs.noteEvent(fireEv(), {}), null);
  assert.equal(cs.pending.size, 0);
  assert.equal(fs.existsSync(path.join(dir, 'confluence_signal.jsonl')), false, 'no journal written while off');
  assert.deepEqual(cs.card(), { enabled: false });
});

test('scalp judge: liquidity death and the stall exit are exits.js rules verbatim', () => {
  const s = { entrySol: 0.05, remainingFrac: 1, entryTs: T0 };
  const c = cfg();
  // liquidity death fires even green and even in the first minute
  let d = scalpExit(s, { valueSol: 0.06, liqUsd: 100, buysM5: 30, sellsM5: 10, solUsd: 150 }, c, T0 + 60000);
  assert.equal(d.fraction, 1);
  assert.match(d.reason, /liquidity death/);
  // stall exit (exits.js §5 verbatim, successor to the undertaker): past
  // 3 min a dead tape stamps the pending; still dead 60s later it sells
  const s2 = { entrySol: 0.05, remainingFrac: 1, entryTs: T0, stallPending: null };
  d = scalpExit(s2, { valueSol: 0.025, liqUsd: 100000, buysM5: 1, sellsM5: 10, solUsd: 150 }, c, T0 + 11 * 60000);
  assert.equal(d.fraction, 0);
  assert.equal(d.stallPending, T0 + 11 * 60000);
  s2.stallPending = d.stallPending;
  d = scalpExit(s2, { valueSol: 0.025, liqUsd: 100000, buysM5: 1, sellsM5: 10, solUsd: 150 }, c, T0 + 11 * 60000 + 61000);
  assert.equal(d.fraction, 1);
  assert.match(d.reason, /stall exit/);
  // ...but no pending before 3 minutes, and live flow cancels a stamped one
  assert.equal(scalpExit({ entrySol: 0.05, remainingFrac: 1, entryTs: T0, stallPending: null }, { valueSol: 0.025, liqUsd: 100000, buysM5: 1, sellsM5: 10, solUsd: 150 }, c, T0 + 2 * 60000).stallPending, null);
  assert.equal(scalpExit({ entrySol: 0.05, remainingFrac: 1, entryTs: T0, stallPending: T0 + 600000 }, { valueSol: 0.025, liqUsd: 100000, buysM5: 5, sellsM5: 10, solUsd: 150 }, c, T0 + 11 * 60000).stallPending, null);
  // flat and healthy: hold
  assert.equal(scalpExit(s, { valueSol: 0.05, liqUsd: 100000, buysM5: 30, sellsM5: 10, solUsd: 150 }, c, T0 + 60000).fraction, 0);
});

test('confluence signal: SCALP holds below the +20% net line and exits WHOLE at the first check at/above it', () => {
  const dir = tmp();
  const c = cfg();
  const cs = new ConfluenceSignal({ cfg: c, dir, now: () => T0 + 240000 });
  cs.noteEvent(fireEv(), {});
  let price = 2;
  const viewOf = () => view({ price });
  price = 2.48; // ratio 1.24 → net gain 0.18 < 0.20: NOT a touch, however close
  cs.tick(viewOf, T0 + 270000, c, 150);
  assert.ok(cs.pending.has('cnf-1000-1:scalp'), 'scalp still open below the line');
  price = 2.56; // ratio 1.28 → net gain 0.22 ≥ 0.20: the touch
  cs.tick(viewOf, T0 + 300000, c, 150);
  assert.equal(cs.pending.has('cnf-1000-1:scalp'), false, 'scalp closed at the touch');
  assert.ok(cs.pending.has('cnf-1000-1:ladder'), 'the ladder twin is untouched by the scalp exit');
  const closes = readJournal(dir).filter(r => r.type === 'close');
  assert.equal(closes.length, 1);
  const rec = closes[0];
  assert.equal(rec.profile, 'scalp');
  assert.equal(rec.status, 'exited');
  assert.match(rec.exitReason, /confluence scalp \+20%/);
  assert.equal(rec.legs.length, 1);
  assert.equal(rec.legs[0].frac, 1, '100% exit — the whole position, no bank-and-ride');
  // proceeds 0.05 × 1.28 = 0.064; fees 0.001 × (1 buy + 1 sell) = 0.002
  assert.ok(approx(rec.proceedsSol, 0.064), `proceeds ${rec.proceedsSol}`);
  assert.ok(approx(rec.pnlSol, 0.012), `pnl ${rec.pnlSol}`);
  assert.ok(approx(rec.pnlPct, 24), `pnlPct ${rec.pnlPct}`);
  assert.equal(rec.timeToTouchSec, 60, 'entry (detection) to the touch check');
  assert.equal(rec.touched20, true);
  assert.equal(rec.pnlBasis, 'viewQuote');
  // card aggregates over a fresh fold of the journal
  const card = new ConfluenceSignal({ cfg: c, dir, now: () => T0 + 400000 }).card();
  assert.equal(card.fires, 1);
  assert.equal(card.profiles.scalp.closed, 1);
  assert.equal(card.profiles.scalp.wins, 1);
  assert.equal(card.profiles.scalp.winRate, 1);
  assert.equal(card.profiles.scalp.touchRate, 1);
  assert.equal(card.profiles.scalp.medianTimeToTouchSec, 60);
  assert.equal(card.profiles.ladder.open, 1);
  assert.equal(card.ready, false, 'READY needs 50 closes per profile');
  assert.equal(card.recentCloses.length, 1);
  assert.deepEqual(card.recentCloses[0].names, ['Alpha', 'Beta'], 'recent closes carry the fire features');
});

test('confluence signal: LADDER runs the real stack — TP1 banks a fraction, the stall exit closes the rest', () => {
  const dir = tmp();
  // tp1Guard 0: guard pinned off because it owns the middle-stage give-back
  // since 2026-10-22 and this script isolates the stall exit as the closer —
  // the scripted fade (to 0.45×) sits under the guard floor, so with the
  // guard on the remainder would exit on it before the stall's confirm
  // could lapse, and the stall-as-seller shape this test pins could not
  // exist (guard behavior: tp1guard.test.mjs). Every assertion below is
  // unchanged.
  const c = cfg({ tp1Guard: 0 });
  const cs = new ConfluenceSignal({ cfg: c, dir, now: () => T0 + 240000 });
  cs.noteEvent(fireEv(), {});
  let price = 3.40; // ratio 1.70 → gain 0.64 clears the adaptive ceiling → TP1 fires
  cs.tick(() => view({ price }), T0 + 270000, c, 150);
  const lad = cs.pending.get('cnf-1000-1:ladder');
  assert.ok(lad, 'ladder still open after a partial bank');
  assert.ok(approx(lad.remainingFrac, 0.6), `remainingFrac ${lad.remainingFrac}`);
  assert.equal(lad.legs.length, 1);
  assert.equal(lad.legs[0].frac, 0.4);
  assert.ok(approx(lad.realizedSol, 0.034), `banked ${lad.realizedSol}`); // 0.4 × (0.05 × 1.70)
  assert.ok(lad.tp1Done, 'TP1 state threaded back');
  assert.equal(cs.pending.has('cnf-1000-1:scalp'), false, 'the scalp twin exited whole on the same print');
  // fade into dead flow at 11 min: the stall exit stamps its pending on the
  // first dead tick and closes the ladder when the tape is still dead 61s on
  cs.tick(() => view({ price: 0.9, buysM5: 1, sellsM5: 10 }), T0 + 240000 + 11 * 60000, c, 150);
  assert.ok(cs.pending.has('cnf-1000-1:ladder'), 'pending stamped, not yet sold — the 60s confirm is running');
  cs.tick(() => view({ price: 0.9, buysM5: 1, sellsM5: 10 }), T0 + 240000 + 11 * 60000 + 61000, c, 150);
  assert.equal(cs.pending.size, 0);
  const closes = readJournal(dir).filter(r => r.type === 'close');
  const lrec = closes.find(r => r.profile === 'ladder');
  assert.ok(lrec, 'ladder close journaled');
  assert.match(lrec.exitReason, /stall exit/);
  assert.equal(lrec.legs.length, 2, 'TP1 leg + final leg');
  assert.equal(lrec.status, 'exited');
  // proceeds = 0.034 (TP1 at 1.70×) + 0.0135 (0.6 remainder at 0.45×) = 0.0475; fees 0.001 × 3
  assert.ok(approx(lrec.proceedsSol, 0.0475), `proceeds ${lrec.proceedsSol}`);
  assert.ok(approx(lrec.pnlSol, -0.0055), `pnl ${lrec.pnlSol}`);
});

test('confluence signal: the 4h cap closes both profiles as expired at their last mark', () => {
  const dir = tmp();
  const c = cfg();
  const cs = new ConfluenceSignal({ cfg: c, dir, now: () => T0 + 240000 });
  cs.noteEvent(fireEv(), {});
  cs.tick(() => null, T0 + 240000 + CONFLUENCE_CAP_MS + 1000, c, 150); // no view at all — the cap still lands
  assert.equal(cs.pending.size, 0);
  const closes = readJournal(dir).filter(r => r.type === 'close');
  assert.equal(closes.length, 2);
  for (const rec of closes) {
    assert.equal(rec.status, 'expired');
    assert.equal(rec.marks, 0);
    assert.ok(approx(rec.pnlSol, -0.001), `pnl ${rec.pnlSol}`); // never marked → entry value back, minus the buy fee
  }
  const card = buildConfluenceCard(readJournal(dir), T0 + 300000);
  assert.equal(card.profiles.scalp.closed, 1);
  assert.equal(card.profiles.scalp.touchRate, 0, 'an expired scalp never touched');
  assert.equal(card.profiles.scalp.medianTimeToTouchSec, null);
});

test('confluence signal: boot finalizes a past-cap pending pair instead of leaving limbo', () => {
  const dir = tmp();
  const c = cfg();
  const cs = new ConfluenceSignal({ cfg: c, dir, now: () => T0 + 240000 });
  cs.noteEvent(fireEv(), {});
  const cs2 = new ConfluenceSignal({ cfg: c, dir, now: () => T0 + 240000 + CONFLUENCE_CAP_MS + 5000 });
  assert.equal(cs2.pending.size, 0);
  assert.equal(readJournal(dir).filter(r => r.type === 'close').length, 2, 'both profiles finalized at boot');
});

// ------------------------------------------------------------ bot wiring
const healthyRug = { token: { supply: 1e15, decimals: 6 }, creatorBalance: 0, totalHolders: 2000, markets: [{ pubkey: 'POOL', lp: { base: 1e8, quote: 1400, lpLockedUSD: 3e5, lpLockedPct: 100 } }], knownAccounts: { POOL: { type: 'AMM' } }, topHolders: Array.from({ length: 12 }, (_, i) => ({ owner: 'h' + i, address: 'h' + i, amount: 9e12 - i * 3.1e10, pct: 2 })), insiderNetworks: [] };

function rig(cfgOver = {}) {
  const cfg = testCfg({ ...CFG, ...cfgOver });
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
  return { cfg, bot, clock };
}

test('bot: a confluence event opens the shadow pair — and touches nothing real', async () => {
  const { bot } = rig();
  await bot.start();
  const riskBefore = JSON.stringify(bot.risk.s);
  bot.noteConfluenceEvent(fireEv());
  assert.equal(bot.confluenceSignal.pending.size, 2, 'shadow pair opened');
  assert.equal(bot.positions.length, 0, 'no real position');
  assert.equal(bot.stats.entries, 0, 'stats.entries untouched');
  assert.equal(bot.journal.trades.length, 0, 'no trade-journal records');
  assert.equal(JSON.stringify(bot.risk.s), riskBefore, 'risk state untouched');
  // a dev event through the same seam opens nothing
  bot.noteConfluenceEvent({ id: 'dev-9', kind: 'dev', mint: 'MINT9', ts: T0 });
  assert.equal(bot.confluenceSignal.pending.size, 2);
  const card = bot.confluenceSignalCard();
  assert.equal(card.enabled, true);
  assert.equal(card.fires, 1);
  assert.equal(card.profiles.scalp.open, 1);
  assert.equal(card.profiles.ladder.open, 1);
});

test('server: /confluencesignal serves the zeroed card before any fire', async () => {
  const { bot } = rig();
  await bot.start();
  const srv = startServer(bot, 0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const r = await fetch(base + '/confluencesignal');
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.enabled, true);
    assert.equal(d.fires, 0);
    assert.equal(d.noView, 0);
    assert.equal(d.profiles.scalp.closed, 0);
    assert.equal(d.profiles.ladder.closed, 0);
    assert.equal(d.profiles.scalp.touchRate, null);
    assert.equal(d.ready, false);
    assert.equal(d.readyN, 50);
    assert.deepEqual(d.recentCloses, []);
    assert.equal(d.rules.scalpPct, 0.2);
    assert.equal(d.rules.stakeSol, 0.05);
  } finally { srv.close(); }
});

test('record-only proof: no decision-path source references the module or its journal', () => {
  for (const f of ['detect.js', 'gate.js', 'risk.js', 'exec.js', 'exits.js', 'journal.js', 'sources.js']) {
    const src = fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
    assert.ok(!/confluenceSignal|confluence_signal/.test(src), `${f} must not reference the confluence shadow signal`);
  }
});
