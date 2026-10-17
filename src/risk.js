// risk.js — hard limits, enforced in code. State persists to DATA_DIR/risk.json so a restart
// cannot reset the daily loss counter or un-trip the kill switch.

import fs from 'node:fs';
import path from 'node:path';

const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);

export class Risk {
  constructor(cfg, { dir, now = Date.now } = {}) {
    this.cfg = cfg; this.now = now;
    this.file = dir ? path.join(dir, 'risk.json') : null;
    this.s = { day: dayKey(now()), dayPnlSol: 0, tradeTs: [], cooldown: {}, losers: {}, startEquitySol: null, killed: false, killReason: null, totalCloses: 0, haltArmedAt: null };
    this.load();
    if (!this.s.losers) this.s.losers = {}; // risk.json from before this field existed
    if (!this.s.wins) this.s.wins = {}; // winning closes — the winner re-buy block (mirrors losers)
    if (!this.s.closed) this.s.closed = {}; // every close (win or loss) — the re-entry block
    if (this.s.haltBalBaseline === undefined) this.s.haltBalBaseline = null; // balance-halt anchor (equity SOL)
    if (this.s.downHalted === undefined) this.s.downHalted = false;
    if (this.s.lossStreak === undefined) this.s.lossStreak = 0; // D4: consecutive red closes
    if (this.s.streakPausedAt === undefined) this.s.streakPausedAt = null; // D4: when the streak pause began (ms) or null
    if (this.s.heatSince === undefined) this.s.heatSince = null; // D4: breadth has been at/above the heat line since (ms) or null
    if (this.s.lastBreadth === undefined) this.s.lastBreadth = null; // D4: latest breadth reading (0..1) for /state
    // Risk brake (user 2026-10-15): fields absent from an older risk.json arm the rule
    // fresh at first boot of the new code — only closes after that boot count.
    if (this.s.brakeRed === undefined) this.s.brakeRed = 0; // red closes counted since arming
    if (this.s.sizeHalved === undefined) this.s.sizeHalved = false; // size currently halved by the brake
    if (this.s.brakeWipeHalted === undefined) this.s.brakeWipeHalted = false; // a wipe halt has fired
    if (this.s.brakeWipeReason === undefined) this.s.brakeWipeReason = null;
    // arm the one-shot auto-halt at startup so "N more closes" counts from now, not from the first close
    if ((this.cfg.haltAfterCloses || 0) > 0 && this.s.haltArmedAt == null) {
      this.s.haltArmedAt = this.s.totalCloses || 0;
      this.save();
    }
  }

  load() {
    if (!this.file) return;
    try { Object.assign(this.s, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch { /* first run */ }
  }
  save() {
    if (!this.file) return;
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.s)); } catch { /* best effort */ }
  }

  rollDay() {
    const k = dayKey(this.now());
    if (k !== this.s.day) { this.s.day = k; this.s.dayPnlSol = 0; this.save(); }
  }

  /** Balance halt (user, overnight 2026-10-13, corrected by user to BALANCE not day P&L):
   *  the first check after arming anchors the baseline at current equity (wallet SOL +
   *  open positions at cost, so opening a position doesn't fake a drop); if equity later
   *  falls HALT_DOWN_SOL below the anchor, write the HALT file and latch downHalted.
   *  Persists in risk.json; never auto-releases — only a deliberate /resume clears it. */
  checkBalanceHalt(walletSol, openCostSol = 0) {
    const lim = this.cfg.haltDownSol || 0;
    if (!(lim > 0) || this.s.downHalted || walletSol == null) return;
    const equity = walletSol + (openCostSol || 0);
    if (this.s.haltBalBaseline == null) { this.s.haltBalBaseline = equity; this.save(); return; }
    if (equity <= this.s.haltBalBaseline - lim) {
      this.s.downHalted = true;
      try { fs.writeFileSync(path.join(path.dirname(this.file || '.'), 'HALT'), String(this.now())); } catch {}
      this.save();
    }
  }

  /** Call once at boot with current wallet SOL; sets the kill-switch baseline the first time ever. */
  initEquity(sol) {
    if (this.s.startEquitySol == null) { this.s.startEquitySol = sol; this.save(); }
  }

  /** Kill switch: wallet SOL (+ open position cost basis) below fraction of starting equity → permanent halt. */
  checkKill(walletSol, openCostSol = 0) {
    if (this.s.killed || this.s.startEquitySol == null) return;
    const eq = walletSol + openCostSol;
    if (eq < this.s.startEquitySol * this.cfg.killEquityFrac) {
      this.s.killed = true;
      this.s.killReason = `equity ${eq.toFixed(4)} SOL < ${(this.cfg.killEquityFrac * 100).toFixed(0)}% of start ${this.s.startEquitySol.toFixed(4)}`;
      this.save();
    }
  }

  /** Deliberate human resume also releases the EQUITY KILL (fix 2026-10-17:
   *  the latch shipped with no clearing path at all — checkKill could set
   *  it and nothing in the codebase could unset it, so the "permanent
   *  halt" was permanent against the owner's own deliberate resume too.
   *  Clearing follows the clearDownHalt shape: the latch releases and the
   *  start-equity anchor nulls; the /resume handler re-anchors it at the
   *  wallet balance it reads at that moment (initEquity), so the kill
   *  floor going forward is a fraction of the equity the human resumed
   *  with — never the stale pre-kill anchor. */
  clearKill() {
    this.s.killed = false;
    this.s.killReason = null;
    this.s.startEquitySol = null;
    this.save();
  }

  /** Deliberate human resume: release the balance-halt latch; the next equity check re-anchors. */
  clearDownHalt() {
    this.s.downHalted = false;
    this.s.haltBalBaseline = null;
    this.save();
  }

  /** Deliberate human resume also clears the streak pause and the streak itself: his hand
   *  outranks the bot's own pause, and he starts fresh rather than one loss from re-pausing. */
  clearStreakPause() {
    this.s.lossStreak = 0;
    this.s.streakPausedAt = null;
    this.s.heatSince = null;
    this.save();
  }

  /** The risk brake's lift, wired into POST /risk/reset (the deliberate human reset):
   *  the red-close counter zeroes and the size halving releases, so the rule re-arms
   *  fresh. The wipe-halt flag is NOT cleared here — only /resume answers a halt. */
  clearBrake() {
    this.s.brakeRed = 0;
    this.s.sizeHalved = false;
    this.save();
  }

  /** Deliberate human resume acknowledges a wipe halt: clear its flag (the /resume
   *  handler removes the HALT file itself, like the other latches). */
  clearBrakeWipe() {
    this.s.brakeWipeHalted = false;
    this.s.brakeWipeReason = null;
    this.save();
  }

  /** D4 breadth feed (bot calls this every poll tick with the share of sampled coins whose
   *  chgH1 > 0 and how many coins reported). While streak-paused, resume requires: the
   *  minimum pause served, breadth at/above the heat line with enough coins reporting, held
   *  continuously for the sustain window. Any dip below the line restarts the heat clock.
   *  Returns 'resumed' on the tick the pause lifts, else null. Never touches downHalted. */
  noteBreadth(breadth, coins) {
    const n = this.now();
    if (breadth != null && Number.isFinite(breadth)) { this.s.lastBreadth = breadth; this.s.lastBreadthCoins = coins; this.s.lastBreadthAt = n; }
    if (this.s.streakPausedAt == null) return null;
    if (n - this.s.streakPausedAt < (this.cfg.streakPauseMinMin || 0) * 60000) {
      if (this.s.heatSince != null) { this.s.heatSince = null; this.save(); }
      return null;
    }
    const hot = breadth != null && coins >= (this.cfg.streakHeatMinCoins || 0) && breadth >= (this.cfg.streakHeatPct || 0.5);
    if (!hot) {
      if (this.s.heatSince != null) { this.s.heatSince = null; this.save(); }
      return null;
    }
    if (this.s.heatSince == null) { this.s.heatSince = n; this.save(); return null; }
    if (n - this.s.heatSince >= (this.cfg.streakHeatSustainMin || 0) * 60000) {
      this.s.streakPausedAt = null;
      this.s.heatSince = null;
      this.s.lossStreak = 0;
      this.save();
      return 'resumed';
    }
    return null;
  }

  /** Manual reset requires editing/deleting risk.json on purpose.
   *  skipMintCooldowns (FLOW CONFIRMATION LANE only, owner order
   *  2026-10-17): the lane ignores the winner/loser/closed mint cooldowns
   *  for its own entries — its own re-entry timer + per-mint entry cap
   *  govern instead. Every other check (halts, caps, reserve, the short
   *  mint cooldown) binds exactly as for any other entry, and every other
   *  caller passes the default false, byte-identical. */
  canEnter({ mint, walletSol, openCount, sizeSol, halted = false, skipMintCooldowns = false }) {
    this.rollDay();
    const n = this.now();
    if (this.s.downHalted) return { ok: false, reason: `balance down-stop hit (equity fell ${this.cfg.haltDownSol} SOL below the armed balance) — halted` };
    if (halted) return { ok: false, reason: 'HALT file present' };
    if (this.s.streakPausedAt != null) return { ok: false, reason: `streak pause: ${this.s.lossStreak} straight losses — entries wait for market breadth to recover` };
    if (this.s.killed) return { ok: false, reason: `kill switch: ${this.s.killReason}` };
    if (this.cfg.dailyLossSol > 0 && this.s.dayPnlSol <= -this.cfg.dailyLossSol) return { ok: false, reason: `daily loss cap hit (${this.s.dayPnlSol.toFixed(4)} SOL)` };
    if (openCount >= this.cfg.maxPositions) return { ok: false, reason: `max ${this.cfg.maxPositions} positions open` };
    const cd = this.s.cooldown[mint];
    if (cd && n - cd < this.cfg.mintCooldownMin * 60000) return { ok: false, reason: 'mint cooldown' };
    if (!skipMintCooldowns) {
      const lost = this.s.losers[mint];
      if (lost && this.cfg.loserCooldownH > 0 && n - lost < this.cfg.loserCooldownH * 3600000)
        return { ok: false, reason: `lost on this coin ${((n - lost) / 60000).toFixed(0)}m ago (no re-buy for ${this.cfg.loserCooldownH}h)` };
      // Winner re-buy block (user 2026-10-15): a WINNING close blocks re-entry for the same
      // window — the HIMA rebuy (21m after a green close, 31% under the top) passed every
      // guard because only losses anchored a cooldown. Same skip path as the loser block.
      const won = this.s.wins[mint];
      if (won && this.cfg.winnerCooldownH > 0 && n - won < this.cfg.winnerCooldownH * 3600000)
        return { ok: false, reason: `closed this coin ${((n - won) / 60000).toFixed(0)}m ago (no re-buy for ${this.cfg.winnerCooldownH}h)` };
      const closedAt = this.s.closed[mint];
      if (closedAt && this.cfg.closedCooldownH > 0 && n - closedAt < this.cfg.closedCooldownH * 3600000)
        return { ok: false, reason: `already traded this coin — closed ${((n - closedAt) / 60000).toFixed(0)}m ago (no re-entry for ${this.cfg.closedCooldownH >= 1 ? `${this.cfg.closedCooldownH}h` : `${Math.round(this.cfg.closedCooldownH * 60)}m`})` };
    }
    this.s.tradeTs = this.s.tradeTs.filter(t => n - t < 3600000);
    if (this.s.tradeTs.length >= this.cfg.maxTradesPerHour) return { ok: false, reason: `hourly trade cap (${this.cfg.maxTradesPerHour})` };
    if (walletSol - sizeSol < this.cfg.minReserveSol) return { ok: false, reason: `would leave < ${this.cfg.minReserveSol} SOL reserve` };
    if (!(sizeSol > 0)) return { ok: false, reason: 'size is zero' };
    return { ok: true };
  }

  /** Seed a close that predates this state (boot: journal closes inside the window). */
  seedClosed(mint, ts) {
    if (!mint || !ts) return;
    if (this.now() - ts > Math.max(this.cfg.closedCooldownH || 0, 1) * 3600000) return;
    if (!this.s.closed[mint] || ts > this.s.closed[mint]) { this.s.closed[mint] = ts; this.save(); }
  }

  /** The base size for an entry opened with `openCount` positions already
   *  open (owner order 2026-10-17: "open up one more trading slot but
   *  .025"): slot 1 (nothing open) sizes at tradeSol; an entry taken while
   *  a position is already open is the second slot and sizes at slot2Sol.
   *  slot2Sol <= 0 is the kill switch — every slot sizes at tradeSol,
   *  byte-identical to the pre-slot stack. The count is the caller's live
   *  positions length — the same count canEnter's cap judges, adopted
   *  positions included (they sit in that list like any other). */
  baseTradeSol(openCount = 0) {
    if (openCount >= 1 && this.cfg.slot2Sol > 0) return this.cfg.slot2Sol;
    return this.cfg.tradeSol;
  }

  /** The size new entries actually use: the slot's base size, halved while the
   *  risk brake is tripped (the brake factors whichever base the slot
   *  selected, exactly as it factors slot 1). Never changes a live
   *  position — sizeFor is entry-time only. */
  effectiveTradeSol(openCount = 0) {
    if (!this.s.sizeHalved) return this.baseTradeSol(openCount);
    return +((this.baseTradeSol(openCount) || 0) * (this.cfg.lossHalveFactor || 1)).toFixed(6);
  }

  /** Position size: effective size, capped at maxPoolFraction of pool liquidity. */
  sizeFor(liqUsd, solUsd, openCount = 0) {
    const poolCapSol = (liqUsd * this.cfg.maxPoolFraction) / (solUsd || 150);
    return Math.max(0, Math.min(this.effectiveTradeSol(openCount), poolCapSol));
  }

  /** FLOW CONFIRMATION LANE size (owner order 2026-10-17): exactly
   *  FLOW_CONFIRM_SOL — the lane's test size, deliberately NOT tradeSol
   *  and NOT factored by the risk brake (the test measures the lane, not
   *  the brake). The pool-fraction cap still binds: it is an execution
   *  safety (never more than maxPoolFraction of the pool), not a sizing
   *  policy. */
  sizeForLane(liqUsd, solUsd) {
    const poolCapSol = (liqUsd * this.cfg.maxPoolFraction) / (solUsd || 150);
    return Math.max(0, Math.min(this.cfg.flowConfirmSol || 0, poolCapSol));
  }

  recordEntry(mint) {
    const n = this.now();
    this.s.tradeTs.push(n);
    this.s.cooldown[mint] = n;
    for (const [k, t] of Object.entries(this.s.cooldown)) if (n - t > 6 * 3600000) delete this.s.cooldown[k];
    this.save();
  }

  recordClose(pnlSol, mint = null, entrySol = null) {
    this.rollDay();
    this.s.dayPnlSol += pnlSol;
    this.s.totalCloses = (this.s.totalCloses || 0) + 1;
    const ev = { red: false, halvedNow: false, wipeNow: false }; // risk-brake events, for the caller's stats
    // D4 streak pause (user 2026-10-13): count straight red closes — a win resets the count,
    // a scratch (pnl == 0) leaves it untouched. At cfg.streakPauseN the pause latches and
    // canEnter blocks until noteBreadth proves the market hot again (or the user resumes).
    if (pnlSol < 0) this.s.lossStreak = (this.s.lossStreak || 0) + 1;
    else if (pnlSol > 0) this.s.lossStreak = 0;
    const spn = this.cfg.streakPauseN || 0;
    if (spn > 0 && this.s.streakPausedAt == null && (this.s.lossStreak || 0) >= spn) {
      this.s.streakPausedAt = this.now();
      this.s.heatSince = null;
    }
    // one-shot auto-halt: after N more closes, write the HALT file (survives restarts; /resume re-arms)
    const hac = this.cfg.haltAfterCloses || 0;
    if (hac > 0) {
      if (this.s.haltArmedAt == null) this.s.haltArmedAt = this.s.totalCloses;
      if (this.s.totalCloses - this.s.haltArmedAt >= hac) {
        try { fs.writeFileSync(path.join(path.dirname(this.file || '.'), 'HALT'), String(this.now())); } catch {}
        this.s.haltArmedAt = null;
      }
    }
    // Risk brake (user 2026-10-15): count red closes from arming — unlike the D4 streak,
    // a win does NOT reset this counter. At LOSS_HALVE_N the size halves and stays halved
    // until clearBrake (/risk/reset). Separately, a single close whose loss reaches
    // WIPE_HALT_FRAC of its stake writes the HALT latch — written here, inside close
    // processing, now that the close is final (the HALT_AFTER_CLOSES pattern); partial
    // TP sells never reach recordClose, so they can never trip either leg.
    if (pnlSol < 0) {
      const hn = this.cfg.lossHalveN || 0;
      if (hn > 0) {
        ev.red = true;
        this.s.brakeRed = (this.s.brakeRed || 0) + 1;
        if (!this.s.sizeHalved && this.s.brakeRed >= hn) { this.s.sizeHalved = true; ev.halvedNow = true; }
      }
      const wf = this.cfg.wipeHaltFrac || 0;
      if (wf > 0 && entrySol > 0 && pnlSol <= -wf * entrySol && !this.s.brakeWipeHalted) {
        this.s.brakeWipeHalted = true;
        this.s.brakeWipeReason = `wipe halt: one trade lost ${(-pnlSol).toFixed(4)} SOL of its ${(+entrySol).toFixed(4)} SOL stake (>= ${(wf * 100).toFixed(0)}%)`;
        ev.wipeNow = true;
        try { fs.writeFileSync(path.join(path.dirname(this.file || '.'), 'HALT'), String(this.now())); } catch {}
      }
    }
    if (mint) {
      const n = this.now();
      this.s.closed[mint] = n;
      const keepMs = Math.max(this.cfg.closedCooldownH || 0, this.cfg.loserCooldownH || 0, 1) * 3600000;
      for (const [k, t] of Object.entries(this.s.closed)) if (n - t > keepMs) delete this.s.closed[k];
      if (pnlSol < 0) {
        this.s.losers[mint] = n;
        delete this.s.wins[mint]; // the most recent close governs: a later loss re-anchors
        const keepL = Math.max(this.cfg.loserCooldownH || 0, 1) * 3600000;
        for (const [k, t] of Object.entries(this.s.losers)) if (n - t > keepL) delete this.s.losers[k];
      } else if (pnlSol > 0) {
        // Win (pnlSol > 0, the mirror of the loser's pnlSol < 0 test): anchor the winner
        // re-buy block. A scratch close (pnlSol == 0) is neither — it anchors neither
        // block, exactly as it leaves the D4 streak untouched; the flat any-close
        // sit-out above still applies to it.
        this.s.wins[mint] = n;
        const keepW = Math.max(this.cfg.winnerCooldownH || 0, 1) * 3600000;
        for (const [k, t] of Object.entries(this.s.wins)) if (n - t > keepW) delete this.s.wins[k];
      }
    }
    this.save();
    return ev;
  }

  snapshot() {
    this.rollDay();
    return { day: this.s.day, dayPnlSol: +this.s.dayPnlSol.toFixed(5), dailyLossSol: this.cfg.dailyLossSol, tradesLastHour: this.s.tradeTs.filter(t => this.now() - t < 3600000).length, startEquitySol: this.s.startEquitySol, killed: this.s.killed, killReason: this.s.killReason, haltDownSol: this.cfg.haltDownSol || 0, haltBalBaseline: this.s.haltBalBaseline, downHalted: this.s.downHalted, lossStreak: this.s.lossStreak || 0, streakPaused: this.s.streakPausedAt != null, streakPausedAt: this.s.streakPausedAt, lastBreadth: this.s.lastBreadth, brakeRed: this.s.brakeRed || 0, sizeHalved: !!this.s.sizeHalved, brakeWipeHalted: !!this.s.brakeWipeHalted, brakeWipeReason: this.s.brakeWipeReason || null };
  }
}
