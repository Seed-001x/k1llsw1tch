// bot.js — orchestrator. All I/O comes in through `deps` so the whole loop is testable offline.
//
//   discoverTick : refresh the watchlist from every source (quota-based)
//   pollTick     : re-poll watchlist + open positions (10s), update history, run detectors, handle signals
//   positionTick : mark open positions by live SELL quote and apply exit rules
//
// Entry order (cheap → expensive, every skip is journaled with its reason):
//   detector → risk limits → gates (RugCheck) → round-trip quote → buy

import fs from 'node:fs';
import path from 'node:path';
import { History } from './history.js';
import { detect, detectChurn, detectLiftoff, eligible, eligibleChecks, liqFamilyChecks, fastPop, fastPopFloors, judgeScan, closestCall, betterScanVerdict } from './detect.js';
import { runGates, hasHardFail, tempRuleViolation, blockedNameWord, extensionCheck, freshHistoryCheck, flowSnapshotCheck, shallowDipCheck, summarizeGateChecks, holderSamples, foldLastTrades, insiderCountVerdict, fastBondVerdict, birthMemoryVerdict, topGuardVerdict } from './gate.js';
import { computeSignalFields } from './signalFields.js';
import { evaluateExit } from './exits.js';
import { ShadowFlow, ratchetArmed, ratchetShadowFire } from './ratchetShadow.js';
import { bundleRisk, bundleDecision, pickTracked, linkedWeights, CREATOR_KEY } from './bundleWatch.js';
import { Journal } from './journal.js';
import { Risk } from './risk.js';
import { postCallout } from './callout.js';
import { CalloutLab } from './calloutLab.js';
import { FlowExits } from './flowExits.js';
import { StructureWatch, pickTrendSeeds, STRUCTURE_MAX_WATCHES, STRUCTURE_TREND_RESERVE } from './structureWatch.js';
import { StaircaseSignal } from './staircaseSignal.js';
import { BottomWatch } from './bottomWatch.js';
import { RangeWatch } from './rangeWatch.js';
import { ConfluenceSignal } from './confluenceSignal.js';
import { ScanLab, buildScanCard } from './scanLab.js';
import { rotateJournalSet } from './archive.js';
import { ShadowSeller } from './shadowSeller.js';
import { NeverGreenCut } from './neverGreen.js';
import { snapshotFeatures, externalExit } from './learn.js';

import { PostExitTracker, PairedShadowExits } from './postExit.js';
import { ShadowTrades } from './shadowTrades.js';
import { WalletWatch } from './walletWatch.js';
import { buildTradeReport } from './reports.js';
import { gtOutcomesSnapshot } from './gtFetch.js';
import { configStamp } from './stamp.js';
import { sampleFakeAlive, fakeAliveStamp, fakeAliveWindow } from './fakeAlive.js';
import { newCensus, censusFold, censusWindow, censusStamp } from './census.js';
import { evaluatePreEntry, preEntryReason } from './preEntry.js';
import { evaluateGrind, grindReason, grindKillTally } from './grindJudge.js';

// Scan Ledger: a watch session finalizes at this age even if the coin is
// still being viewed (a re-view afterward starts a fresh session).
const SCAN_SESSION_MAX_MS = 3 * 3600e3;

// BASE MODE (owner order 2026-10-16 23:00 EDT): the setups that ARE a
// formed base — the only shapes allowed to buy while the base strategy
// is on. Every other live setup demotes to a watch enrollment at the
// onSignal seam (default-deny: a future setup demotes too until it is
// named here).
const BASE_ENTRY_SETUPS = new Set(['range', 'staircase', 'bottom']);

const fmtUsd = (x) => '$' + Math.round(x).toLocaleString('en-US');

export class Bot {
  /**
   * deps: { discover(cfg), fetchViews(mints), fetchSolUsd(), fetchRug(mint), exec, now }
   */
  constructor(cfg, deps) {
    this.cfg = cfg; this.d = deps; this.now = deps.now || Date.now;
    this.exec = deps.exec;
    // Settings tab state (owner order 2026-10-18): the env-boot baseline
    // for every settings-schema key + the live overlay values applied on
    // top of it (index.js computes both; unit rigs leave them empty and
    // /settings simply reports no overrides).
    this.settingsBaseline = deps.settingsBaseline || null;
    this.settingsOverlay = deps.settingsOverlay || {};
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    this.history = new History();
    this.journal = new Journal(cfg.dataDir, { now: this.now });
    this.calloutLab = new CalloutLab({ cfg, journal: this.journal, now: this.now }); // Callout Shadow Lab (record-only): journals would-calls + scores them as a follower would have fared; can never post, sign, or trade
    this.flowExits = new FlowExits({ cfg, journal: this.journal, now: this.now, positionState: (id) => this._flowExitPosState(id), log: console.log }); // Flow-Exit Watcher (record-only): polls the wallet that triggered a flow entry for its trim/exit and scores the race at close; no decision reads it
    this.staircaseSignal = new StaircaseSignal({ cfg, journal: this.journal, now: this.now, log: console.log }); // Staircase-3 Shadow Signal (record-only, user 2026-10-16): every structure-watch mark at ordinal >= 3 is ALSO journaled as a named shadow signal, scored by the watch's forward scores joined at read time (/staircase); nothing reads it into any decision
    this.structureWatch = new StructureWatch({ cfg, journal: this.journal, now: this.now, fetchHolders: (mint) => this._dasHolderSample(mint), log: console.log, onMark: (rec) => { try { this.staircaseSignal.noteMark(rec); } catch { /* observer only — never disturb the watch */ } try { this._evalStaircase(rec); } catch { /* live tap (STAIRCASE_LIVE) — self-guarded, async, fail-silent: can never disturb the watch */ } } }); // Structure Watch (record-only): seeds every signaled mint into an hours-long staircase + holder-series watch with would-enter marks at confirmed higher lows; holder reads ride the same knob-respecting DAS helper as gate sampling; no decision reads it
    this.bottomWatch = new BottomWatch({ cfg, journal: this.journal, dir: cfg.dataDir, now: this.now, log: console.log, wasExited: (mint) => this.journal.trades.some(t => t.type === 'close' && t.mint === mint), onMark: (rec) => { try { this._evalBottom(rec); } catch { /* live tap (BOTTOM_LIVE) — self-guarded, async, fail-silent: can never disturb the tracker */ } }, fetchCandles: (pool, fromTs, toTs) => this.structureWatch.fetchCandles(pool, fromTs, toTs), resolvePool: (mint) => this.structureWatch.resolvePool(mint) }); // Bottom Tracker (record-only, user 2026-10-16): episodes on watched coins dumped >= BOTTOM_DROP_PCT off their sampled peak; a 'first move off the bottom' mark once the low holds quiet and price + flow turn up; forward-scored by the structure watch's own candle tailer (/bottomwatch); fed from the poll + outcome-observer view streams — no sampler of its own. Marks ALSO route live entries via the onMark tap (BOTTOM_LIVE, base strategy: only QUALIFIED marks — the retrace setups)
    // BASE MODE state (owner order 2026-10-16): enrollment provenance
    // (mint -> { setup, ts } of the latest demoted signal — the journal
    // is the durable record, this is the live lookup), deferred range
    // dip watches (episodeId -> watch), and the bottom no-view retry
    // queue (the _evalFlow discipline, shared with staircase/range).
    this.baseEnrolled = new Map();
    this.rangeDipWatch = new Map();
    this.bottomPending = new Map();
    // LIQ RE-CHECK queue (owner order 2026-10-17): `${setup}:${mint}` ->
    // a deferred entry evaluation whose only blocker was a $0/missing
    // liquidity read on a young coin — see _queueLiqRecheck. In-memory
    // like the sibling no-view retry queues; a restart drops pending
    // re-checks (the coin simply re-signals later, exactly as a dropped
    // no-view retry behaves).
    this.liqPending = new Map();
    this.rangeWatch = new RangeWatch({ cfg, journal: this.journal, dir: cfg.dataDir, now: this.now, log: console.log, wasExited: (mint) => this.journal.trades.some(t => t.type === 'close' && t.mint === mint), isHeld: (mint) => this.positions.some(p => p.mint === mint), onMark: (rec) => { try { this._evalRange(rec); } catch { /* live tap (RANGE_LIVE) — self-guarded, async, fail-silent: can never disturb the study */ } }, fetchCandles: (pool, fromTs, toTs) => this.structureWatch.fetchCandles(pool, fromTs, toTs), resolvePool: (mint) => this.structureWatch.resolvePool(mint) }); // Range Study (owner 2026-10-16): a tight sideways base held over the trailing window journals one mark per range episode to range_marks.jsonl; forward-scored by the structure watch's own candle tailer (/rangewatch) — expanded / broke down / ranged; fed from the poll + outcome-observer view streams — no sampler of its own. Marks ALSO route live entries via the onMark tap (RANGE_LIVE, default on — his correction: "None of this is shadow btw — Real")
    this.scanLab = new ScanLab({ cfg, journal: this.journal, now: this.now, log: console.log }); // Scan Ledger scorer (record-only): r15/r60 after each finalized scan session; no decision reads it
    this.scanFold = new Map(); // Scan Ledger: mint -> live watch-session fold (cheap scalars only; finalized into the journal by _scanSweep)
    this.lastScanSweepTs = 0;
    this.journal.onStructureSignal = (rec) => { try { this.structureWatch.seed(rec); } catch { /* observer only — never disturb the signal path */ } }; // seeding seam: the Journal.signal() funnel (taken/skipped/shadow/flow alike)
    this.risk = new Risk(cfg, { dir: cfg.dataDir, now: this.now });
    this.closedIds = new Set(this.journal.trades.filter(t => t.type === 'close').map(t => t.id)); // journaling guarantee (ensureClose)
    this.adoptScan = new Map(); // orphan adoption: mint -> ts of last balance check (throttles re-reads of closed mints)
    for (const t of this.journal.trades) if (t.type === 'close' && t.mint) this.risk.seedClosed(t.mint, t.ts); // re-entry block survives restarts/deploys
    this.lastTrades = foldLastTrades(this.journal.trades); // ran-rebuy block: most recent closed trade per mint, rebuilt from the journal so trades closed before this deploy (e.g. BOOT, 2026-10-14) anchor the rule on its first boot; ensureClose keeps it current
    this.postExit = new PostExitTracker(cfg.dataDir, this.now); // 5-min post-exit price tracker (observer only)
    this.paired = new PairedShadowExits(cfg.dataDir, this.now); // D1: virtual would-be exits paired to manual exits (observer only)
    this.shadowSeller = new ShadowSeller({ cfg, journal: this.journal, now: this.now, log: console.log, postExitOf: (id) => (this.postExit && this.postExit.done || []).find(x => x.id === id) || null }); // Shadow Seller (record-only, user 2026-10-16): a LEARNED exit judge — buckets each open position's state and journals its first would-sell when the bot's own completed history says holding from that state paid worse than the mark; pairs against the ladder's actual outcome at close. No ladder rules, no borrowed thresholds; can never sell
    this.neverGreen = new NeverGreenCut({ cfg, journal: this.journal, now: this.now, log: console.log }); // Never-Green Cut SHADOW (record-only, owner 2026-10-17): a position that never peaked above +2%, is 5+ min old, and prints realizable <= -10% for 2 consecutive checks would have been cut — journaled + paired at close in nevergreen.jsonl (/nevergreen); NEVER sells, blocks, or feeds any decision
    this.streamEvalAt = new Map(); // mint -> ts of last stream-judge evaluation (v2 throttle, mirrors fastEvalAt)
    this.shadowStreamState = new Map(); // shadow virtual id -> stream-judge state (kept Bot-side: the virtual's own serialized state stays untouched)
    this.shadowTrades = new ShadowTrades(cfg.dataDir, this.now, { // trade-grade shadow (record-only): virtual positions for gate-passing shadow signals, run through the real exit stack
      txFeeSol: cfg.txFeeSol,
      onTick: (s, move, ts) => this._onShadowVirtualTick(s, move, ts),   // stream judge fire-quality probes (record-only)
      onClose: (s, rec) => this._onShadowVirtualClose(s, rec),          // stream judge completion records (record-only)
    });
    this.confluenceSignal = new ConfluenceSignal({ cfg, dir: cfg.dataDir, now: this.now, log: console.log }); // Confluence Shadow Signal (record-only, user 2026-10-16): every walletWatch confluence fire opens two DETECTION-time virtual positions — SCALP (100% at +20% net) and LADDER (the live exit stack) — the forward instrument for the classification study's open questions (touch rates at tradable refs, lag cost, per-profile EV); nothing reads it into any decision
    this.walletWatch = new WalletWatch({ // wallet-task shadow detectors (record-only): dev launches + survivor confluence over the Phase 1–3 sets
      cfg, dir: cfg.dataDir, now: this.now,
      fetchViews: deps.fetchViews,
      shadowGates: (v, setup) => this.shadowGateRecord(v, { setup, metrics: {} }, this.now()),
      noteMint: (m, s) => this.noteMint(m, s),
      onEvent: (ev) => { this.noteCalloutEvent(ev); this.noteConfluenceEvent(ev); }, // observer taps (record-only): Callout Shadow Lab + Confluence Shadow Signal
      liveEval: (ev) => { try { this._evalWalletLive(ev); } catch { /* live tap — self-guarded, fail-silent: can never disturb the watch */ } }, // LIVE tap (owner order 2026-10-16): dev-launch + confluence events route live entry attempts through the standard pipeline (kill switches DEVLAUNCH_LIVE / CONFLUENCE_LIVE)
    });
    this.cfgStamp = configStamp(cfg); // D1: config version stamp carried by entries + closes (record-only)
    this.lastSolUsd = null; // last SOL/USD the position loop saw (feeds observer marks)
    this.watch = new Map();      // mint -> { ts, source }
    this.intakeCounts = {};      // source -> mints added via noteMint since the last discovery cycle (scan-record bookkeeping, record-only)
    this.outcomeSeenAt = new Map(); // mint -> ts the outcome tracker last got a view (observer bookkeeping only)
    this.lastOutcomeTickTs = 0;
    this.latest = new Map();     // mint -> latest view
    this.lastSignal = new Map(); // mint -> ts
    this.latestAt = new Map();   // mint -> ts of the latest view fetch
    this.streamBuf = new Map();  // mint -> recent stream trades (fast pop detection)
    this.fastEvalAt = new Map(); // mint -> ts of last fast-pop evaluation
    this.shadowFlow = new ShadowFlow(); // held mints' streamed flow for the shadow ratchet judge (record-only)
    this.churnPins = new Map(); // mint -> { at, until } basing watch: dumped coins stay watchlist-pinned past the normal TTL (churn detector)
    this.curveSeen = new Set(); // mints whose latest view was the pump.fun bonding-curve pair — graduation handoff watches for the flip to an AMM pair
    this.curveLifeCache = new Map(); // mint -> { lifeSec: number|null, ts } fast-bonder block: a measured lifespan is immutable once graduated and cached forever; an unknown (null) read is retried only after 60s so a hot mint can't hammer DexScreener through the seam
    this.posFile = path.join(cfg.dataDir, 'positions.json');
    this.positions = this.loadPositions();
    this.busy = { discover: false, poll: false, pos: false };
    this.stats = { discoverTicks: 0, pollTicks: 0, positionTicks: 0, signals: 0, entries: 0, exits: 0, errors: 0, lastError: null, sourceCounts: {}, lastDiscoverTs: 0, lastPollTs: 0, closesSinceReport: 0, lastReportTs: 0, reportIndex: 0, tempRules: null, fastPop: { fires: 0 }, ratchetShadow: { wouldFire: 0, completed: 0 }, exitConfirm: { confirmed: 0, cancelled: 0 }, shadowSignals: {}, tickJournal: { records: 0, lastTs: 0 }, liveFeed: { connected: false, events: 0, added: 0, reconnects: 0, lastEventTs: 0, lastError: null } };
    this.statsFile = path.join(cfg.dataDir, 'stats.json');
    this.entryTimes = []; // timestamps of entries (for pace keeper)
    this.PACE_TARGET = 120; // target trades per hour (2 per min)
    this.mintsFile = path.join(cfg.dataDir, 'entered-mints.json');
    this.enteredMints = this.loadEnteredMints();
    this.loadStats();
    this._syncShadowStats(); // the tracker owns its cumulative totals (persisted with its pending state) — stats mirrors them
    // Birth-verdict memory (owner order 2026-10-16, the FMR hole): a disqualifying birth verdict — an instantGrad bought-out fire or a measured sub-line curve lifespan — is a fact about a mint's BIRTH, and birth facts do not expire when a later fetch fails. Persisted per mint (birth-verdicts.json, the entered-mints pattern) so it survives restarts, seeded at boot from the journal's own gate stamps (_backfillBirthVerdicts) so verdicts established before this fix are remembered too, and enforced at the onSignal seam (see the birth-memory block) under the FAST_BOND_BLOCK switch.
    this.birthFile = path.join(cfg.dataDir, 'birth-verdicts.json');
    this.birthVerdicts = this.loadBirthVerdicts(); // mint -> { mint, kind, evidence, firstSeenTs }
    this._backfillBirthVerdicts();
    this._birthStats().known = this.birthVerdicts.size;
    // FLOW CONFIRMATION LANE (owner order 2026-10-17): the per-mint fire
    // registry + lane accounting (entry caps, re-entry timers, the
    // pre-registered kill rule's sample) persist to flow-confirm.json —
    // the birth-verdicts pattern — so a restart cannot reset the
    // per-mint 2-entry cap or hand the lane a fresh 15-trade sample.
    this.flowConfirmFile = path.join(cfg.dataDir, 'flow-confirm.json');
    this.flowConfirmState = this.loadFlowConfirm();
    // GRIND JUDGE persisted state (2026-10-18): fires/closes tallies and
    // the pre-registered kill rule's latches, mirroring the lane's file.
    this.grindFile = path.join(cfg.dataDir, 'grind-judge.json');
    this.grindState = this.loadGrindState();
    this.censusFeed = null; // wired from index.js when CENSUS_WATCH is on
    // BASE MODE enrollment restore (owner decision 2026-10-16 23:16
    // EDT): range entries require a NOMINATED mint — re-arm the
    // enrollment map from the journal's enrollment records inside the
    // TTL so a restart does not un-nominate the watchlist.
    this._restoreBaseEnrollments();
    // Flow-Exit Watcher: re-establish watches for flow positions that were
    // open across this restart (their start records carry the attribution;
    // fired trims/exits are rebuilt from the journal and never re-fire).
    try { this.flowExits.restore(this.positions); } catch { /* observer only */ }
  }

  // Trade-grade shadow report card for /state (record-only): maintained from
  // the tracker's own totals at open/complete time (constructor, the shadow
  // journal point, and both tick paths call this after ticking the tracker).
  _syncShadowStats() {
    try { if (this.shadowTrades) this.stats.shadowTrades = this.shadowTrades.totalsView(); } catch { /* observer only */ }
  }

  /** Stream-judge state for one shadow virtual (get-or-create). Lives Bot-side
   *  keyed by virtual id so ShadowTrades' persisted state shape is untouched. */
  _shadowStreamStateFor(id) {
    let st = this.shadowStreamState.get(id);
    if (!st) { st = { streamPeakMove: null, streamArmed: false, streamFired: false, streamFireTs: null, streamTrades: 0, entryPriceSol: null, mint: null, probe30: false, probe60: false }; this.shadowStreamState.set(id, st); }
    return st;
  }

  /**
   * ShadowTrades tick hook (record-only): fire-quality probes for a virtual
   * the stream judge would-fired — what did its mark move do at the first
   * ticks >= 30s / >= 60s after the fire? Same shape as the real positions'
   * probes in judgeRatchetShadow, on the virtual's own view-mark move.
   */
  _onShadowVirtualTick(s, move, ts) {
    try {
      const st = this.shadowStreamState.get(s.id);
      if (!st || !st.streamFired || !st.streamFireTs || move == null) return;
      for (const atSec of [30, 60]) {
        const key = atSec === 30 ? 'probe30' : 'probe60';
        if (st[key] || ts - st.streamFireTs < atSec * 1000) continue;
        st[key] = true;
        this.journal.ratchetShadow({ kind: 'fire-quality', source: 'shadow', id: s.id, ts, mint: s.mint, symbol: s.symbol, atSec, jupMove: +move.toFixed(4) });
      }
    } catch { /* observer only */ }
  }

  /**
   * ShadowTrades close hook (record-only): the stream judge's completion
   * record for a virtual it ever saw armed — the shadow-book mirror of the
   * real positions' ensureClose record, journaled separately (source
   * 'shadow') and never pooled with the real sample. tickFireTs/leadSec are
   * null by construction: a virtual has no tick judge — its own exit-stack
   * close (exitReason/pnlSol on the record) is what a stream fire is scored
   * against.
   */
  _onShadowVirtualClose(s, rec) {
    try {
      const st = this.shadowStreamState.get(s.id);
      if (st) this.shadowStreamState.delete(s.id);
      if (!this.cfg.ratchetShadow || !st || !(st.streamArmed || st.streamFired)) return;
      this.journal.ratchetShadow({ kind: 'closed', outcome: 'closed', source: 'shadow', id: s.id, ts: rec.exitTs || this.now(), mint: s.mint, symbol: s.symbol, setup: s.setup, exitReason: rec.exitReason ?? null, pnlSol: rec.pnlSol ?? null, streamWouldFire: !!st.streamFired, streamFireTs: st.streamFireTs ?? null, tickFireTs: null, leadSec: null, jupArmed: null, tickArmed: null, streamArmed: !!st.streamArmed, streamCovered: (st.streamTrades || 0) > 0, streamTrades: st.streamTrades || 0 });
      if (this.shadowFlow && !this.positions.some(p => p.mint === s.mint) && !(this.shadowTrades && this.shadowTrades.openVirtual(s.mint))) this.shadowFlow.drop(s.mint);
    } catch { /* observer only */ }
  }

  loadStats() {
    let loaded = false;
    try { const s = JSON.parse(fs.readFileSync(this.statsFile, 'utf8')); Object.assign(this.stats, s); loaded = true; }
    catch { /* no saved stats */ }
    // STALL-EXIT simplification (user order 2026-10-16 19:24 EDT): the removed
    // SL ladder's counters die with it — a stats file persisted during the
    // ladder's few live hours must not resurrect them on /state.
    delete this.stats.slLadder; delete this.stats.ladderOff;
    // STAGED MOONBAG DEAD FLOW (user order 2026-10-16): the deadflow tally
    // gains waves/floor counters — a stats file persisted by the pre-staging
    // build carries only {armed, fired}, so normalize the shape here or the
    // first wave event would increment an undefined field into NaN.
    if (this.stats.deadflow) { this.stats.deadflow.waves = this.stats.deadflow.waves || 0; this.stats.deadflow.floor = this.stats.deadflow.floor || 0; }
    // BASE MODE (owner order 2026-10-16): the tally exists from boot so
    // /state shows the strategy's shape even before the first enrollment.
    this.stats.baseMode = { enrolled: 0, bySetup: {}, dipWatches: 0, dipEntries: 0, structureStops: 0, pulseSkips: { total: 0, bySetup: {} }, rangeUnenrolled: 0, ...(this.stats.baseMode || {}) };
    // Never-Green Cut shadow tally (record-only, owner 2026-10-17): exists
    // from boot so /state shows the shadow's shape at 0 before its first
    // fire; fires counted at the would-fire, paired/deltaSol at the close
    // pairing (see ensureClose / managePosition).
    this.stats.neverGreen = { fires: 0, paired: 0, deltaSol: 0, ...(this.stats.neverGreen || {}) };
    // LIQ RE-CHECK tally (owner order 2026-10-17): with the switch on the
    // counters exist from boot so /state shows them at 0 before the first
    // deferred evaluation; with LIQ_RECHECK=0 the key never exists and
    // records/counters stay exactly as before the fix.
    if (this.cfg.liqRecheck) this.stats.liqRecheck = { queued: 0, recovered: 0, expired: 0, ...(this.stats.liqRecheck || {}) };
    if (!this.stats.baseMode.bySetup) this.stats.baseMode.bySetup = {};
    if (!this.stats.baseMode.pulseSkips) this.stats.baseMode.pulseSkips = { total: 0, bySetup: {} };
    if (loaded) return;
    // Seed from journal history so dashboard isn't empty after first deploy with persistence
    try {
      if (this.journal) {
        this.stats.signals = this.journal.signals.length;
        this.stats.entries = this.journal.trades.filter(t => t.type === 'open' && !t.adopted).length;
        this.stats.exits = this.journal.trades.filter(t => t.type === 'close').length;
      }
    } catch {}
  }
  saveStats() { try { fs.writeFileSync(this.statsFile, JSON.stringify(this.stats)); } catch { /* best effort */ } }
  loadEnteredMints() { try { return new Set(JSON.parse(fs.readFileSync(this.mintsFile, 'utf8'))); } catch { return new Set(); } }
  saveEnteredMints() { try { fs.writeFileSync(this.mintsFile, JSON.stringify([...this.enteredMints])); } catch { /* best effort */ } }
  loadBirthVerdicts() { try { const arr = JSON.parse(fs.readFileSync(this.birthFile, 'utf8')); const m = new Map(); for (const r of Array.isArray(arr) ? arr : []) if (r && r.mint && r.kind) m.set(r.mint, { mint: r.mint, kind: r.kind, evidence: r.evidence || '', firstSeenTs: Number(r.firstSeenTs) || 0 }); return m; } catch { return new Map(); } }
  saveBirthVerdicts() { try { fs.writeFileSync(this.birthFile, JSON.stringify([...this.birthVerdicts.values()])); } catch { /* best effort */ } }

  // FLOW CONFIRMATION LANE state (see the constructor note): one object —
  // lane totals (fires / qualifiedFires / entries / closes / pnlSumSol),
  // the kill-rule latch (killChecked / disabled / disabledMeanPnlSol),
  // starved-test blocked tallies, and the per-mint registry
  // { fires: [{k, ts}], anchorTs, windowEntries, entries, lastCloseTs }.
  loadFlowConfirm() {
    const dflt = () => ({ fires: 0, qualifiedFires: 0, entries: 0, closes: 0, pnlSumSol: 0, disabled: false, disabledAt: null, disabledMeanPnlSol: null, killChecked: false, blocked: { slot: 0, halt: 0, risk: 0 }, mints: {} });
    try {
      const s = JSON.parse(fs.readFileSync(this.flowConfirmFile, 'utf8'));
      const out = { ...dflt(), ...(s || {}) };
      out.blocked = { slot: 0, halt: 0, risk: 0, ...((s && s.blocked) || {}) };
      if (!out.mints || typeof out.mints !== 'object' || Array.isArray(out.mints)) out.mints = {};
      return out;
    } catch { return dflt(); }
  }
  saveFlowConfirm() { try { fs.writeFileSync(this.flowConfirmFile, JSON.stringify(this.flowConfirmState)); } catch { /* best effort */ } }

  loadGrindState() {
    const dflt = () => ({ fires: 0, closes: 0, killChecked: false, disabled: false, disabledAt: null, finalizedAtCheck: null, wrongAtCheck: null });
    try {
      const s = JSON.parse(fs.readFileSync(this.grindFile, 'utf8'));
      return { ...dflt(), ...(s || {}) };
    } catch { return dflt(); }
  }
  saveGrindState() { try { fs.writeFileSync(this.grindFile, JSON.stringify(this.grindState)); } catch { /* best effort */ } }

  /** Census feed entry point (wired in index.js): fold a parsed trade
   *  into every open position on that mint. Observer-grade: never throws
   *  into the feed, never trades. */
  _censusOnTrade(mint, trade) {
    try {
      if (!this.cfg.censusWatch) return;
      for (const pos of this.positions) {
        if (pos.mint !== mint) continue;
        if (!pos.census) pos.census = newCensus(this.now());
        censusFold(pos.census, trade, this.now());
      }
      // PRE-ENTRY watches fold the same stream (owner order 2026-10-18):
      // the census works both ways — it witnesses open positions AND
      // vets bottom marks before they spend.
      const pw = this.preEntryWatch && this.preEntryWatch.get(mint);
      if (pw) censusFold(pw.census, trade, this.now());
    } catch { /* census is an observer */ }
  }

  /** Keep the census feed's desired set == open positions' mints, and
   *  every open position's census initialized (so stamps exist even on a
   *  zero-trade watch). Rides positionTick; cheap and fail-silent. */
  _syncCensus() {
    try {
      if (!this.cfg.censusWatch) return;
      for (const pos of this.positions) if (!pos.census) pos.census = newCensus(this.now());
      if (this.censusFeed) {
        const wanted = new Set(this.positions.map(p => p.mint));
        if (this.preEntryWatch) for (const mint of this.preEntryWatch.keys()) wanted.add(mint);
        this.censusFeed.setDesired([...wanted]);
      }
    } catch { /* observer */ }
  }

  /** The grind judge's pre-registered kill rule: once grindKillN of its
   *  closes have FINALIZED post-exit outcomes, if grindKillWrong+ of them
   *  ripped >= grindWrongPeakPct inside the post-exit window (it sold
   *  into bounces — the unambiguous harm), the judge disables itself. */
  _grindKillCheck() {
    try {
      const st = this.grindState;
      if (!this.cfg.grindJudge || !st || st.killChecked || st.disabled) return;
      const { finalized, wrong } = grindKillTally(this.postExit ? this.postExit.done : [], this.cfg);
      if (finalized < this.cfg.grindKillN) return;
      st.killChecked = true; st.finalizedAtCheck = finalized; st.wrongAtCheck = wrong;
      if (wrong >= this.cfg.grindKillWrong) {
        st.disabled = true; st.disabledAt = this.now();
        try { this.journal.grind({ type: 'grindDisabled', ts: st.disabledAt, finalized, wrong, killN: this.cfg.grindKillN, wrongBar: this.cfg.grindKillWrong, peakPct: this.cfg.grindWrongPeakPct }); } catch { /* journaling never blocks */ }
        console.log(`[grindjudge] KILL RULE: ${wrong}/${finalized} judge exits ripped >= +${this.cfg.grindWrongPeakPct}% post-exit — judge DISABLED (census + stamps continue)`);
      } else {
        console.log(`[grindjudge] kill-rule check at ${finalized} finalized exits: ${wrong} bad bounces < ${this.cfg.grindKillWrong} — judge stays live`);
      }
      this.saveGrindState();
    } catch { /* bookkeeping only */ }
  }

  /** The /state grindJudge block: arm state + the kill rule's report card. */
  _grindJudgeState() {
    const st = this.grindState || {};
    const { finalized, wrong } = grindKillTally(this.postExit ? this.postExit.done : [], this.cfg);
    return {
      enabled: !!this.cfg.grindJudge,
      live: !!(this.cfg.grindJudge && this.cfg.grindJudgeLive && !st.disabled),
      liveSwitch: !!this.cfg.grindJudgeLive,
      disabled: !!st.disabled,
      disabledAt: st.disabledAt ?? null,
      fires: st.fires || 0,
      closes: st.closes || 0,
      killN: this.cfg.grindKillN, killWrong: this.cfg.grindKillWrong,
      killChecked: !!st.killChecked,
      finalized, wrong,
    };
  }

  // Pace keeper: returns a relaxed cfg if we're behind the hourly target.
  // Never overrides user blacklists, RugCheck safety, or risk limits.
  paceCfg(n) {
    const hourAgo = n - 3600000;
    this.entryTimes = this.entryTimes.filter(t => t > hourAgo);
    const pace = this.entryTimes.length;
    // Entry-fixes A2 (user 2026-10-13): the pace relaxer is OFF unless PACE_RELAX=1 — gates
    // run at face value. The always-on loosening (liq/mc floors ×0.6–0.7, maxMc ×1.5) is what
    // let BORING's $9.2k liquidity pass a $15k floor (relaxed bar: $9k).
    if (!this.cfg.paceRelax) return { cfg: this.cfg, boosted: false, pace };
    const relaxed = { ...this.cfg };
    if (relaxed.minVolH1) relaxed.minVolH1 *= 0.6;
    if (relaxed.minLiqUsd) relaxed.minLiqUsd *= 0.6;
    if (relaxed.minHolders) relaxed.minHolders = Math.max(50, Math.floor(relaxed.minHolders * 0.6));
    if (relaxed.maxMc) relaxed.maxMc *= 1.5;
    if (relaxed.minMc) relaxed.minMc *= 0.7;
    return { cfg: relaxed, boosted: true, pace };
  }

  // ------------------------------------------------------------ persistence
  loadPositions() { try { return JSON.parse(fs.readFileSync(this.posFile, 'utf8')); } catch { return []; } }
  savePositions() { try { fs.writeFileSync(this.posFile, JSON.stringify(this.positions)); } catch { /* best effort */ } }
  halted() { try { return fs.existsSync(path.join(this.cfg.dataDir, 'HALT')); } catch { return false; } }
  err(where, e) { this.stats.errors++; this.stats.lastError = `${where}: ${e && e.message ? e.message : e}`; }

  // ------------------------------------------------------------ boot
  /**
   * Journal archive rotation (owner order 2026-10-18): file finalized
   * records older than cfg.archiveHotDays into <dataDir>/archive/*.gz so
   * the hot journal files stay lean (the 2026-10-18 boot-OOM lesson).
   * NEVER rotated: feedback (the user's marks), manual exits (the
   * learning set), resignal/ratchet shadow files (small, dedupe-critical)
   * and outcome_pending.json (live state). Runs at boot and daily.
   */
  async _rotateArchives(reason) {
    if (!this.cfg.archiveRotate || this._rotating) return;
    this._rotating = true;
    try {
      const skip = new Set([this.journal.f.fb, this.journal.f.manual, this.journal.f.rsig, this.journal.f.rshadow, this.journal.f.pend]);
      const files = [...new Set([...Object.values(this.journal.f), this.walletWatch && this.walletWatch.file, this.scanLab && this.scanLab.file].filter(f => f && !skip.has(f)))];
      const archiveDir = path.join(this.journal.dir, 'archive');
      const { summary, manifest } = await rotateJournalSet(files, { hotDays: this.cfg.archiveHotDays, now: this.now(), archiveDir, log: console.log });
      this.archiveStats = { hotDays: this.cfg.archiveHotDays, lastRunTs: this.now(), lastReason: reason, lastArchived: summary.archived, files: manifest.files };
      console.log(`[archive] rotation (${reason}): ${summary.archived} records filed across ${summary.files} files, ${summary.kept} kept hot`);
    } catch (e) { this.err('archive', e); }
    this._rotating = false;
  }

  async start() {
    await this._rotateArchives('boot');
    const t = setInterval(() => { this._rotateArchives('daily').catch(() => {}); }, 24 * 3600 * 1000);
    if (t.unref) t.unref();
    const sol = await this.exec.solBalance();
    this.risk.initEquity(sol);
    // real mode: drop positions whose tokens are no longer in the wallet (sold/transferred outside the bot)
    if (this.cfg.realMode) {
      for (const p of [...this.positions]) {
        try {
          const bal = await this.exec.tokenBalance(p.mint);
          if (this._reconcileZeroConfirmed(p, bal, this.now())) await this.closeExternal(p, 'reconcile: tokens no longer in wallet (manual sell)');
        } catch (e) { this.err('reconcile', e); }
      }
      this.savePositions();
      // and pick orphan bags back up (a deploy restart is exactly when a
      // dropped-while-down bag would otherwise stay invisible)
      await this._adoptOrphans(this.now());
    }
    return { solBalance: sol, openPositions: this.positions.length };
  }

  // THE funnel for closing a position in the journal: every path that removes a position
  // (bot sell, manual exit, reconcile, admin clear) goes through here, so every open gets
  // exactly one close record. The DINU ghost — sold on-chain, never journaled, position
  // never cleared — is the bug this makes structurally impossible. Also registers the
  // post-exit tracker and the every-N-trades report counter. Returns false when this
  // position was already closed (double-log guard).
  ensureClose(pos, rec) {
    if (this.closedIds.has(pos.id)) return false;
    this.closedIds.add(pos.id);
    // FLOW CONFIRMATION LANE: a lane position's close feeds the lane's
    // own accounting here — this funnel is the one place every close
    // passes through exactly once (bot sell, manual exit, reconcile,
    // admin clear alike), so neither the re-entry timer nor the
    // kill-rule sample can miss or double-count a close.
    if (pos.flowConfirm) this._laneOnClose(pos, rec);
    const full = { type: 'close', ...rec };
    // FAKE-ALIVE STAMP (record-only, owner 2026-10-18): the position's final
    // volume-bot grind score rides every close record, whichever path closed
    // it, so the study can join score to outcome. Funnel fills it only when
    // the caller didn't (no caller ever does).
    if (full.fakeAlive === undefined) full.fakeAlive = fakeAliveStamp(pos);
    if (full.census === undefined) full.census = censusStamp(pos, this.now(), this.cfg.censusWindowMin * 60000);
    if (typeof full.reason === 'string' && full.reason.startsWith('grind judge')) {
      this.grindState.closes++;
      this.saveGrindState();
    }
    // D1 (record-only): EVERY close carries the full decision record, whichever
    // path closed it. The entry snapshot used to survive only on manual exits —
    // bot-managed closes dropped it here, which is why /learn's bot-winner
    // comparison was empty by construction. An explicit value in `rec` always
    // wins; the funnel only fills what the caller didn't provide. Fields the
    // exec layer genuinely doesn't produce at record time are null, never
    // invented. `feesSol` is the accumulated BURNED tx-fee estimate, calibrated
    // on-chain (D2 + rent analysis, 2026-10-14): cfg.txFeeSol per transaction
    // actually incurred — one for the buy, one per executed sell — where
    // txFeeSol = 5,000 base + configured priority fee (parsed buy txs' meta.fee
    // was exactly that). The 0.001514 token-account deposit is never counted:
    // the closeEmptyAccounts sweep refunds it. feesSource 'calibratedTxFees'
    // says exactly this — an estimate calibrated to chain, never chain-exact
    // (the manual path's chain-read sell fee is the exception; its label
    // says so).
    try {
      if (full.entry === undefined) full.entry = pos.entry || null;
      if (full.gates === undefined) full.gates = pos.gates || null;
      if (full.gatePass === undefined && pos.gatePass !== undefined) full.gatePass = pos.gatePass;
      if (full.stamp === undefined) full.stamp = pos.stamp || this.cfgStamp;
      if (full.tokensRaw === undefined) full.tokensRaw = pos.entryTokensRaw || pos.tokensRaw || null;
      if (full.decimals === undefined) full.decimals = pos.decimals ?? null;
      if (full.entryFillSol === undefined) full.entryFillSol = pos.entryFillSol ?? null;
      if (full.entryFillUsd === undefined) full.entryFillUsd = full.entryFillSol != null && pos.solUsdEntry > 0 ? +(full.entryFillSol * pos.solUsdEntry).toFixed(10) : null;
      if (full.exitFillSol === undefined) full.exitFillSol = null;
      if (full.exitFillUsd === undefined) full.exitFillUsd = null;
      if (full.feesSol === undefined) { full.feesSol = +((pos.feesSol || 0)).toFixed(6); full.feesSource = 'calibratedTxFees'; }
      if (full.path === undefined) full.path = pos.pathClass ?? null; // two-path class (user 2026-10-15): the 30-position judging sample reads it off the close
      if (full.pnlPct === undefined) full.pnlPct = full.pnlSol != null && full.entrySol > 0 ? +(full.pnlSol / full.entrySol * 100).toFixed(2) : null;
    } catch { /* record enrichment must never disturb the close itself */ }
    this.journal.trade(full);
    // Ran-rebuy block (user 2026-10-15): keep the most-recent-closed-trade map
    // current in-process (boot rebuilds it from the journal; this is the seam
    // every close passes through exactly once). entryFillUsd was just resolved
    // by the enrichment above; the position's signal-time USD price is the
    // fallback, mirroring foldLastTrades' resolution order.
    try {
      if (pos.mint) {
        const closeTs = full.ts || this.now();
        const prev = this.lastTrades.get(pos.mint);
        if (!prev || closeTs >= prev.closeTs) {
          this.lastTrades.set(pos.mint, { mint: pos.mint, id: pos.id, symbol: pos.symbol || null, entryTs: pos.entryTs ?? null, closeTs, entryPriceUsd: full.entryFillUsd != null && full.entryFillUsd > 0 ? full.entryFillUsd : (pos.entryPrice > 0 ? pos.entryPrice : null) });
        }
      }
    } catch { /* bookkeeping must never disturb the close itself */ }
    try {
      const v = this.latest.get(pos.mint);
      this.postExit.watch({ id: pos.id, mint: pos.mint, symbol: pos.symbol, setup: pos.setup, exitTs: full.ts || this.now(), exitPriceUsd: v && v.price > 0 ? v.price : (pos.entryPrice || null), reason: full.reason || null, manual: !!full.manual, pnlSol: full.pnlSol ?? null });
    } catch { /* observer only — never disturb trading */ }
    // Shadow Seller pairing (record-only): if the learned judge would-fired
    // on this position, pair it against what the ladder actually did with
    // the same remainder from fire time to this close.
    try { if (this.shadowSeller) this.shadowSeller.noteClose(pos, full); } catch { /* observer only — never disturb trading */ }
    // Never-Green Cut pairing (record-only): if the shadow would-fired on
    // this position, pair it against what the remainder actually realized
    // from fire time to this close, and keep the /state tally current.
    try {
      if (this.neverGreen) {
        const pr = this.neverGreen.noteClose(pos, full);
        if (pr && pr.deltaSol != null) {
          this.stats.neverGreen = this.stats.neverGreen || { fires: 0, paired: 0, deltaSol: 0 };
          this.stats.neverGreen.paired++;
          this.stats.neverGreen.deltaSol = +(this.stats.neverGreen.deltaSol + pr.deltaSol).toFixed(6);
        }
      }
    } catch { /* observer only — never disturb trading */ }
    try {
      this.stats.closesSinceReport = (this.stats.closesSinceReport || 0) + 1;
      if (this.stats.closesSinceReport >= (this.cfg.reportEveryTrades || 10)) this.makeTradeReport();
    } catch { /* reporting must never disturb trading */ }
    // shadow ratchet judge completion (record-only): every close of a position
    // either judge ever saw armed gets its comparison record — what actually
    // closed it, whether the live ratchet was the one that fired, and the move
    // at exit — so a would-fire can be scored against what the price trigger
    // really did. v2: a STREAM-armed/fired position lands the record even if
    // the tick judge never armed, carrying both fire timestamps (leadSec =
    // how much earlier the stream fired, only when both did) and the stream
    // coverage, so an uncovered mint reads as uncovered instead of absent.
    try {
      if (this.cfg.ratchetShadow && (pos.ratchetShadowArmed || pos.streamArmed || pos.streamFired)) {
        this.stats.ratchetShadow = this.stats.ratchetShadow || { wouldFire: 0, completed: 0 };
        this.stats.ratchetShadow.completed++;
        this.journal.ratchetShadow({ kind: 'closed', outcome: 'closed', source: 'real', id: pos.id, ts: rec.ts || this.now(), mint: pos.mint, symbol: pos.symbol, setup: pos.setup, exitReason: rec.reason || null, pnlSol: rec.pnlSol ?? null, ratchetFired: /^break-even ratchet/.test(rec.reason || ''), wouldFire: !!pos.ratchetShadowFired, actualExitMove: pos.ratchetShadowMove != null ? +pos.ratchetShadowMove.toFixed(4) : null, streamWouldFire: !!pos.streamFired, streamFireTs: pos.streamFireTs ?? null, tickFireTs: pos.ratchetShadowFireTs ?? null, leadSec: (pos.streamFireTs != null && pos.ratchetShadowFireTs != null) ? +((pos.ratchetShadowFireTs - pos.streamFireTs) / 1000).toFixed(2) : null, tickArmed: !!pos.ratchetShadowArmed, streamArmed: !!pos.streamArmed, streamCovered: (pos.streamTrades || 0) > 0, streamTrades: pos.streamTrades || 0 });
        if (!this.positions.some(p => p.id !== pos.id && p.mint === pos.mint) && !(this.shadowTrades && this.shadowTrades.openVirtual(pos.mint))) this.shadowFlow.drop(pos.mint);
      }
    } catch { /* observer only — never disturb trading */ }
    // Callout Shadow Lab (record-only): TP3 = this position's FINAL close, and
    // only when it had reached TP2 — the moonbag stage completing. ensureClose
    // is the single funnel every close passes through exactly once (bot sell,
    // manual exit, reconcile, admin clear), which is what makes it the
    // faithful seam: no close path can miss it and none can double-fire it.
    try {
      if (pos.tp2Done && this.calloutLab) {
        const lv = this.latest.get(pos.mint);
        this.calloutLab.record({ trigger: 'tp3', ts: rec.ts || this.now(), mint: pos.mint, symbol: pos.symbol, v: lv || { address: pos.mint, symbol: pos.symbol, name: pos.symbol, mc: pos.entryMc ?? null }, mc: lv ? lv.mc : (pos.entryMc ?? null), liquidity: lv ? lv.liq : null, setup: pos.setup, source: 'position', holding: false, linkId: pos.id }).catch(() => {});
      }
    } catch { /* observer only — never disturb trading */ }
    // Flow-Exit Watcher (record-only): the close funnel is the single seam
    // every close passes through exactly once, so the watch finalizes here —
    // one last balance read classifies whether the trigger wallet beat the
    // bot out, held through, or can't be known. Fire-and-forget; no-op for
    // positions that were never watched.
    try { if (this.flowExits) this.flowExits.finalize(pos, full).catch(() => {}); } catch { /* observer only — never disturb trading */ }
    return true;
  }

  makeTradeReport() {
    const until = this.now();
    const since = this.stats.lastReportTs || 0;
    const closes = this.journal.trades.filter(t => t.type === 'close' && (t.ts || 0) > since);
    const opens = this.journal.trades.filter(t => t.type === 'open');
    const staleAborts = this.journal.signals.filter(s => (s.ts || 0) > since && (s.reasons || []).some(r => String(r).startsWith('stale:'))).length;
    const index = (this.stats.reportIndex || 0) + 1;
    const rec = buildTradeReport({
      index, sinceTs: since, untilTs: until, closes, opens,
      signals: this.journal.signals,
      postExits: this.postExit.done, // matched per trade by position id inside the builder
      postExitPending: [...this.postExit.pending.keys()],
      staleAborts,
    });
    this.journal.addTradeReport(rec);
    this.stats.reportIndex = index;
    this.stats.lastReportTs = until;
    this.stats.closesSinceReport = 0;
    console.log(`[report] trade report #${index} written (${closes.length} closes, net ${rec.netSol} SOL)`);
  }

  // Real P&L of an out-of-bot exit, read from the chain itself: the proceeds of the
  // user's own sell transactions (the bot's sell signatures excluded) instead of a
  // last-quote guess. Returns { pnl } or null when the sells can't be parsed.
  async chainPnl(pos) {
    try {
      if (!this.exec.sellProceeds) return null;
      const excludeSigs = new Set(this.journal.trades.filter(t => t.id === pos.id && t.sig).map(t => t.sig));
      const r = await this.exec.sellProceeds(pos.mint, { sinceSec: Math.floor(pos.entryTs / 1000), excludeSigs });
      if (!r || !(r.proceedsSol > 0)) return null;
      return { pnl: (pos.realizedSol || 0) + r.proceedsSol - pos.entrySol - (pos.feesSol || 0) };
    } catch { return null; }
  }

  // D1 follow-up (user 2026-10-14): the real fill of the user's own sell(s),
  // read from the sell transaction(s) — SOL and token balance deltas plus the
  // fee the wallet paid (see exec.sellFill for the exact convention). Null
  // when the txs can't be found or parsed: the close then keeps today's
  // mark-based record, unchanged. Never throws into a close path.
  async chainSellFill(pos) {
    try {
      if (!this.exec.sellFill) return null;
      const excludeSigs = new Set(this.journal.trades.filter(t => t.id === pos.id && t.sig).map(t => t.sig));
      const r = await this.exec.sellFill(pos.mint, { sinceSec: Math.floor(pos.entryTs / 1000), excludeSigs });
      return r && r.fillSol > 0 ? r : null;
    } catch { return null; }
  }

  // Record fields a chain-read manual fill contributes — to the close record
  // and to the manual-exit record: the real per-token fill (chainTx-sourced),
  // the real sell fee folded into feesSol alongside the buy-side calibrated
  // tx fees (feesSource says exactly that mix), and manualValueSol: what the manual
  // remainder actually realized — net (after-fee) proceeds scaled to the
  // books' full remainder at the realized per-token net price, so the paired
  // shadow comparison prices the SAME remainder its virtual position holds.
  // {} when there is no fill.
  _manualFill(pos, fill) {
    if (!fill) return {};
    const booksWhole = Number(pos.tokensRaw) > 0 && fill.decimals != null ? Number(pos.tokensRaw) / 10 ** fill.decimals : null;
    return {
      exitFillSol: +fill.fillSol.toFixed(10),
      exitFillUsd: this.lastSolUsd > 0 ? +(fill.fillSol * this.lastSolUsd).toFixed(10) : null,
      fillSource: 'chainTx',
      sellTxFeeSol: +(fill.feeSol || 0).toFixed(6),
      sellSigs: fill.sigs || [],
      feesSol: +(((pos.feesSol || 0)) + (fill.feeSol || 0)).toFixed(6),
      feesSource: 'chainTxSellFee+calibratedTxFees',
      manualValueSol: booksWhole > 0 && fill.tokensWhole > 0 ? +((fill.proceedsNetSol * booksWhole) / fill.tokensWhole).toFixed(6) : fill.proceedsNetSol,
    };
  }

  /** Every full close (bot exit, reconcile, manual, admin) funnels through here exactly
   *  once: risk.recordClose does the books, and its risk-brake events mirror into the
   *  lazy stats.riskBrake counters. Partial TP sells never pass through — they are not
   *  closes and never count toward the brake. */
  _recordClose(pnl, mint, entrySol) {
    const ev = this.risk.recordClose(pnl, mint, entrySol);
    if (ev && (ev.red || ev.halvedNow || ev.wipeNow)) {
      const rb = this.stats.riskBrake = this.stats.riskBrake || { redCounted: 0, halvings: 0, wipeHalts: 0 };
      if (ev.red) rb.redCounted++;
      if (ev.halvedNow) rb.halvings++;
      if (ev.wipeNow) rb.wipeHalts++;
    }
  }

  // Admin removals go THROUGH the funnel too — a removed position gets its close record
  // (estimated P&L) instead of vanishing silently.
  adminDrop(p, reason) {
    const n = this.now();
    const pnl = p.lastValueSol != null ? (p.realizedSol || 0) + p.lastValueSol - p.entrySol - (p.feesSol || 0) : null;
    this.positions = this.positions.filter(x => x.id !== p.id);
    if (pnl != null) this._recordClose(pnl, p.mint, p.entrySol);
    this.ensureClose(p, { id: p.id, mint: p.mint, symbol: p.symbol, setup: p.setup, entrySol: p.entrySol, pnlSol: pnl != null ? +pnl.toFixed(6) : null, estimated: true, pnlSource: 'estimate', heldMin: +((n - p.entryTs) / 60000).toFixed(1), reason, simulated: p.simulated, ts: n });
  }

  dropPosition(idOrMint) {
    const p = this.positions.find(x => x.id === idOrMint || x.mint === idOrMint);
    if (!p) return 0;
    this.adminDrop(p, 'position removed (admin)');
    this.savePositions();
    return 1;
  }

  clearAllPositions() {
    let count = 0;
    for (const p of [...this.positions]) { this.adminDrop(p, 'positions cleared (admin)'); count++; }
    this.savePositions();
    return count;
  }

  // PROTECT switch (user 2026-10-15, "just the stop loss… no ratchet", "no SL until I
  // say"): a one-time, per-position flag set via POST /protect. While set, exits.js
  // skips ONLY that position's stop-loss family, break-even ratchet and kill zone
  // (the redesign's one-rule scope widening); everything else — bleed, probation,
  // stall, trails, the TP ladder, the modest target — judges as normal. The
  // flag lives ON the position record (persisted by savePositions, so it survives
  // restarts), holds for the life of the position with no expiry, and clears only
  // when the position closes (the record goes with it — a rebuy starts unprotected)
  // or when unprotectPosition clears it early. Re-protecting an already-protected
  // position is a no-op that does not double-count the set.
  protectPosition(key) {
    const p = this.positions.find(x => x.mint === key || x.id === key || x.symbol === key);
    if (!p) return null;
    if (!p.protected) {
      p.protected = this.now();
      this.stats.protect = this.stats.protect || { set: 0, blocked: 0 };
      this.stats.protect.set++;
      console.log(`[protect] ${p.symbol} protected at ${new Date(p.protected).toISOString()} — stop-loss + ratchet off until unprotect or close`);
    }
    this.savePositions();
    return p;
  }

  // Clears the protect flag early (POST /unprotect). Returns the position when a flag
  // was cleared, false when the position exists but is not protected, null when no
  // open position matches — the route maps those to 200 / 404 / 404.
  unprotectPosition(key) {
    const p = this.positions.find(x => x.mint === key || x.id === key || x.symbol === key);
    if (!p) return null;
    if (!p.protected) return false;
    delete p.protected;
    // Two-path redesign (user 2026-10-15): the kill zone re-arms FRESH on
    // unprotect, like the stop and the ratchet — its record resets here so no
    // window or counted entry can survive from the protected window; arming
    // re-derives from the live post-TP1 peak on the next judged check.
    p.killZone = null;
    this.savePositions();
    console.log(`[protect] ${p.symbol} unprotected — stop-loss + ratchet + kill zone re-armed`);
    return p;
  }

  // TAKEOVER switch (user 2026-10-15, the XZON race: his manual sell and the bot's
  // ratchet sell fired into the same balance): POST /takeover hands the position to
  // the user ENTIRELY — wider than protect, which only silences the stop family +
  // ratchet. While pos.takenOver is set, exits.js returns a hold before any exit
  // section runs (the whole ladder, trails, stops, bleed, leash, time stops and
  // liquidity death included), the bundle watcher cannot sell it, and the no-quote
  // fallback cannot force it out: the bot must never sell a coin the user is
  // driving himself. Marks, peaks and flow history keep updating, and the
  // manual-exit detector + reconciler keep working — when the user sells by hand,
  // the close books exactly as manual sells book today, now race-free. The flag
  // lives ON the position record (persisted, survives restarts, no expiry) and
  // clears only when the position closes (a rebuy starts untaken) or on release.
  // Takeover supersedes protect: both flags may coexist; takeover wins.
  takeoverPosition(key) {
    const p = this.positions.find(x => x.mint === key || x.id === key || x.symbol === key);
    if (!p) return null;
    if (!p.takenOver) {
      p.takenOver = this.now();
      // any stored exitPending dies HERE, silently — a pending fail-safe sell can
      // never execute into the takeover window (the judge drops them again on
      // every check while the flag is set; this covers the gap before the next).
      if (p.exitPending && typeof p.exitPending === 'object') p.exitPending = {};
      this.stats.takeover = this.stats.takeover || { set: 0, released: 0, sellsSuppressed: 0 };
      this.stats.takeover.set++;
      console.log(`[takeover] ${p.symbol} taken over at ${new Date(p.takenOver).toISOString()} — bot will not sell this position until release or close`);
    }
    this.savePositions();
    return p;
  }

  // Hands the position back (POST /release). Judging resumes FRESH, mirroring the
  // protect switch's re-arm precedent: no pendings survive, the stop is un-armed,
  // probation and the adaptive-TP1 arm are cleared, and the stall/probation clock
  // re-anchors to the release moment (stallBaseTs — exits.js 4b judges from it), so
  // no deadline that matured while the user held the coin can fire. Peaks are NOT
  // reset: they tracked the whole takeover, so the trails judge against the true
  // peak. Returns the position when a flag was cleared, false when the position
  // exists but is not taken over, null when no open position matches.
  releasePosition(key) {
    const p = this.positions.find(x => x.mint === key || x.id === key || x.symbol === key);
    if (!p) return null;
    if (!p.takenOver) return false;
    delete p.takenOver;
    p.stallBaseTs = this.now();
    p.stopArmedTs = null;
    p.floorChecks = 0;
    p.floorSince = null;
    p.probationSince = null;
    p.tp1Arm = null;
    if (p.exitPending && typeof p.exitPending === 'object') p.exitPending = {};
    this.stats.takeover = this.stats.takeover || { set: 0, released: 0, sellsSuppressed: 0 };
    this.stats.takeover.released++;
    this.savePositions();
    console.log(`[takeover] ${p.symbol} released — exit judging resumed with fresh arming (stall clock re-anchored)`);
    return p;
  }

  // TP1 OVERRIDE (user 2026-10-16 19:12 EDT, "arm tp1 to hit at 50% / not
  // 20%-60% / just for this coin"): POST /tp1at pins one position's TP1 to a
  // flat net-gain line (pos.tp1AtPct, a fraction — 0.5 = +50%). While set,
  // exits.js section 3 bypasses the adaptive TP1 machinery for that position
  // entirely and banks cfg.tp1Frac flat at the line; every later stage (TP2,
  // TP2 rejection, the moonbag) is unchanged. The field lives ON the position
  // record (persisted by savePositions, survives restarts) and is spent three
  // ways: the position closes (the record goes with it — a rebuy starts
  // unset), its TP1 fires (the booking seam in managePosition deletes it), or
  // tp1ClearPosition clears it early and the adaptive machinery resumes.
  // Setting a new value overwrites the old — it is a dial, not a latch.
  tp1AtPosition(key, pct) {
    const p = this.positions.find(x => x.mint === key || x.id === key || x.symbol === key);
    if (!p) return null;
    if (p.tp1AtPct !== pct) {
      p.tp1AtPct = pct;
      this.stats.tp1At = this.stats.tp1At || { set: 0, cleared: 0 };
      this.stats.tp1At.set++;
      console.log(`[tp1at] ${p.symbol} TP1 override set at +${Math.round(pct * 100)}% — adaptive TP1 bypassed for this coin until the line, a clear, or close`);
    }
    this.savePositions();
    return p;
  }

  // Clears the TP1 override early (POST /tp1clear, or POST /tp1at with
  // pct 0): the adaptive TP1 machinery resumes on the next checks. Returns
  // the position when an override was cleared, false when the position
  // exists but has none, null when no open position matches — the routes
  // map those to 200 / 404 / 404, exactly like unprotect.
  tp1ClearPosition(key) {
    const p = this.positions.find(x => x.mint === key || x.id === key || x.symbol === key);
    if (!p) return null;
    if (!(p.tp1AtPct > 0)) return false;
    delete p.tp1AtPct;
    this.stats.tp1At = this.stats.tp1At || { set: 0, cleared: 0 };
    this.stats.tp1At.cleared++;
    this.savePositions();
    console.log(`[tp1at] ${p.symbol} TP1 override cleared — adaptive TP1 resumed`);
    return p;
  }

  // Reconcile drop guard (user order 2026-10-16, the WORLD orphan): a zero
  // token-balance read is evidence, not proof — a fresh fill's token account
  // can read as zero across RPC nodes for seconds, and an empty RPC response
  // parses to 0n too. WORLD was dropped 5s after its buy on one such read;
  // the tokens never left the wallet, the position fell off the books, and
  // the exit stack never managed it through its run. So a position counts as
  // externally sold only when (a) it is older than the post-entry grace
  // window AND (b) the zero has persisted across separate checks spanning at
  // least the confirm window. zeroBalSince is stamped on the first post-grace
  // zero sighting (persisted with the position) and cleared by any non-zero
  // read. Returns true when the caller should drop the position now; also
  // keeps p.tokensRaw fresh on live reads, as the call sites did before.
  _reconcileZeroConfirmed(p, bal, now) {
    if (bal !== 0n) {
      if (bal != null) p.tokensRaw = bal.toString();
      if (p.zeroBalSince) delete p.zeroBalSince;
      return false;
    }
    if (now - (p.entryTs || 0) < (this.cfg.reconcileGraceSec ?? 120) * 1000) return false;
    if (!p.zeroBalSince) { p.zeroBalSince = now; return false; }
    return now - p.zeroBalSince >= (this.cfg.reconcileConfirmSec ?? 60) * 1000;
  }

  // Tokens left the wallet outside the bot. P&L comes from the chain when the user's sell
  // transactions parse (marked pnlSource 'chain'), else an estimate from the last sell
  // quote (marked estimated) — and it counts toward the daily loss cap either way.
  // A reconcile drop IS a manual exit: it also writes a manual-exit record so it lands
  // in the manual feed and on the dashboard, not only in the trade log.
  async closeExternal(p, reason) {
    if (!this.positions.some(x => x.id === p.id)) return false; // already closed — don't log it twice
    const n = this.now();
    const chain = await this.chainPnl(p);
    let pnl = null, source = null;
    if (chain) { pnl = chain.pnl; source = 'chain'; }
    else if (p.lastValueSol != null) { pnl = (p.realizedSol || 0) + p.lastValueSol - p.entrySol - (p.feesSol || 0); source = 'estimate'; }
    this.positions = this.positions.filter(x => x.id !== p.id);
    if (pnl != null) this._recordClose(pnl, p.mint, p.entrySol);
    const heldMin = +((n - p.entryTs) / 60000).toFixed(1);
    const snapshot = await this._manualSnapshot(p, p.lastValueSol ?? null, n, pnl);
    // D1 follow-up: the real fill from the sell tx, when it can be read
    const ff = this._manualFill(p, await this.chainSellFill(p));
    const hasFill = ff.exitFillSol != null;
    this.journal.manualExit({ id: p.id, mint: p.mint, symbol: p.symbol, ts: n, how: 'sold outside bot (reconcile)', entry: p.entry || null, heldMin, peakRatio: p.peakRatio, bundleScore: p.bundleScore || 0, pnlSolEstimate: pnl != null ? +pnl.toFixed(6) : null, pnlSol: source === 'chain' ? +pnl.toFixed(6) : null, pnlSource: source || 'unknown', reason: null, snapshot, exitFillSol: hasFill ? ff.exitFillSol : null, fillSource: hasFill ? ff.fillSource : null });
    this.ensureClose(p, { manual: true, id: p.id, mint: p.mint, symbol: p.symbol, setup: p.setup, entrySol: p.entrySol, pnlSol: pnl != null ? +pnl.toFixed(6) : null, estimated: source !== 'chain', pnlSource: source, heldMin, reason: pnl != null ? `${reason} — P&L ${source === 'chain' ? 'from chain' : 'est. from last quote'}` : `${reason} (P&L unknown — no quote yet)`, simulated: p.simulated, ts: n, ...(hasFill ? { exitFillSol: ff.exitFillSol, exitFillUsd: ff.exitFillUsd, fillSource: ff.fillSource, sellTxFeeSol: ff.sellTxFeeSol, sellSigs: ff.sellSigs, feesSol: ff.feesSol, feesSource: ff.feesSource } : {}) });
    // D1 paired shadow exit: keep judging this position's remainder virtually
    // (its manual side prices off the REAL fill when one was read)
    try { this.paired.watch(this._pairedState(p, n, { pnlSol: pnl != null ? +pnl.toFixed(6) : null, valueSol: hasFill ? ff.manualValueSol : (p.lastValueSol ?? null), fillSource: hasFill ? ff.fillSource : null, fillSol: hasFill ? ff.exitFillSol : null })); } catch { /* observer only */ }
    return true;
  }

  // Periodic reconcile: drop positions whose tokens left the wallet (manual sells)
  async reconcilePositions() {
    if (!this.cfg.realMode) return;
    if (this.positions.length) {
      for (const p of [...this.positions]) {
        try {
          const bal = await this.exec.tokenBalance(p.mint);
          if (this._reconcileZeroConfirmed(p, bal, this.now())) {
            if (await this.closeExternal(p, 'reconcile: sold outside bot (manual sell)')) console.log(`[reconcile] dropped ${p.symbol} (not in wallet)`);
          }
        } catch (e) { /* RPC flaky — skip, don't drop on error */ }
      }
      this.savePositions();
    }
    // the other half: pick orphan bags back up (runs even when the books are
    // flat — that is exactly the state an orphan leaves behind)
    await this._adoptOrphans(this.now());
  }

  // Orphan adoption (user order 2026-10-16): the drop guard keeps the bot
  // from losing a position it still holds; this covers the case where the
  // books lost one anyway. Candidates are journal-driven — a mint whose last
  // journal event is a close, with the original buy on record — because every
  // bag the bot owns arrived through a journaled buy, and foreign transfers
  // in must never be adopted. A candidate is adopted only when the wallet
  // still holds the mint and its realizable value clears the dust floor;
  // the position is reconstructed from the original open + the close's
  // decision record (entry snapshot, decimals, fill) and judged from
  // adoption forward (peak starts at the adoption mark).
  _orphanCandidates(now) {
    const lookback = (this.cfg.adoptLookbackH ?? 168) * 3600e3;
    const lastEvent = new Map(); // mint -> { kind, open, close }
    for (const t of this.journal.trades) {
      if (t.type === 'open' && !t.adopted) {
        const e = lastEvent.get(t.mint) || {};
        e.kind = 'open'; e.open = t; lastEvent.set(t.mint, e);
      } else if (t.type === 'close') {
        const e = lastEvent.get(t.mint) || {};
        e.kind = 'close'; e.close = t; lastEvent.set(t.mint, e);
      }
    }
    const openNow = new Set(this.positions.map(p => p.mint));
    const out = [];
    for (const [mint, e] of lastEvent) {
      if (e.kind !== 'close' || !e.open || !e.close) continue;
      if (openNow.has(mint)) continue;
      if (now - (e.close.ts || 0) > lookback) continue;
      out.push({ mint, open: e.open, close: e.close });
    }
    return out;
  }

  async _adoptOrphans(now) {
    if (!this.cfg.realMode || !(this.cfg.adoptOrphans ?? 1)) return;
    for (const cand of this._orphanCandidates(now)) {
      try { await this._tryAdopt(cand, now); } catch (e) { this.err('adopt', e); }
    }
  }

  async _tryAdopt({ mint, open, close }, now) {
    // respect the position cap — a later pass retries when a slot frees
    if (this.positions.length >= (this.cfg.maxPositions || 1)) return false;
    const last = this.adoptScan.get(mint) || 0;
    if (now - last < 300_000) return false; // one balance read per mint per 5 min
    this.adoptScan.set(mint, now);
    const bal = await this.exec.tokenBalance(mint).catch(() => null);
    if (bal == null || bal === 0n) return false;
    const entryTokens = Number(open.tokensRaw || close.tokensRaw || 0);
    if (!(entryTokens > 0)) return false;
    const remainingFrac = Math.min(1, Number(bal) / entryTokens);
    if (!(remainingFrac > 0)) return false;
    let valueSol = null;
    try { valueSol = await this.exec.markValue(mint, bal.toString()); } catch { return false; }
    if (valueSol == null || !(valueSol >= (this.cfg.adoptMinSol ?? 0.005))) return false; // dust stays dust
    let rtRatio = 0.97; // the standard birth spread, when a fresh round-trip can't be measured
    try { const rt = await this.exec.roundTrip(mint, Math.max(0.001, Math.min(valueSol, this.cfg.tradeSol || valueSol))); if (rt && rt.ratio > 0) rtRatio = rt.ratio; } catch { /* keep the estimate */ }
    const basis = (open.entrySol || 0) * remainingFrac;
    const ratio0 = basis > 0 ? (valueSol / basis) / rtRatio : 1;
    const snap = close.entry || null;
    // banks the original position already made stay banked (journal sells on its id)
    const sells = this.journal.trades.filter(t => t.type === 'sell' && t.id === open.id);
    const pos = {
      id: `${mint.slice(0, 6)}-${now}`, mint, symbol: open.symbol || close.symbol || mint.slice(0, 6), setup: open.setup || close.setup || 'pop',
      entryTs: open.ts || now, entrySol: open.entrySol || 0, tokensRaw: bal.toString(), entryTokensRaw: String(open.tokensRaw || bal.toString()), remainingFrac, peakRatio: Math.max(1, ratio0), tp1Done: sells.some(t => (t.reason || '').startsWith('TP1')), tp2Done: sells.some(t => (t.reason || '').startsWith('TP2')), tp1Arm: null, flowHist: [], suspectUnbookedSell: false,
      entryPrice: snap ? snap.price ?? null : null, entryMc: snap ? snap.mc ?? null : null, realizedSol: 0, simulated: false, sigBuy: open.sig || null, markFails: 0,
      stamp: this.cfgStamp, gates: { adopted: true }, gatePass: null, decimals: close.decimals ?? null,
      entryFillSol: open.entryFillSol ?? close.entryFillSol ?? null, solUsdEntry: null, ticks: [],
      entryVolH1: snap ? snap.volH1 || 0 : 0,
      entryRoundTrip: rtRatio, peakMove: Math.max(1, ratio0), stopArmedTs: null, floorChecks: 0, floorSince: null, probationSince: null, moveHist: [], exitPending: {}, stallPending: null, bagDeadWaves: 0, bagDeadHot: false, feesSol: this.cfg.txFeeSol || 0,
      bw: { tracked: null, supply: 0, creator: null, weights: linkedWeights(null), snaps: [], vals: [], lastTs: 0, trimmed: false },
      entry: snap, lastTickTs: 0, lastChainTs: 0, chainDropStrikes: 0,
      adopted: true, adoptedTs: now, adoptOf: close.id || null, lastValueSol: valueSol,
    };
    this.positions.push(pos);
    this.savePositions();
    this.enteredMints.add(mint); this.saveEnteredMints();
    this.journal.trade({ type: 'open', adopted: true, id: pos.id, mint, symbol: pos.symbol, setup: pos.setup, entrySol: pos.entrySol, sig: open.sig || null, simulated: false, ts: now, stamp: pos.stamp, tokensRaw: pos.tokensRaw, entryFillSol: pos.entryFillSol, entryFillUsd: null, reason: `adopted orphan bag — closed as "${(close.reason || '').slice(0, 60)}" but ${valueSol.toFixed(4)} SOL of tokens remained in the wallet` });
    console.log(`[adopt] ${pos.symbol}: picked an orphan bag back up — ${valueSol.toFixed(4)} SOL realizable, ${(remainingFrac * 100).toFixed(0)}% of the original buy, was closed as "${(close.reason || '').slice(0, 50)}"`);
    return true;
  }

  // ------------------------------------------------------------ discovery
  // Live-feed intake: add a mint the moment it's seen (e.g. a brand-new
  // launch from the websocket). The feed gets a reserved slice of the
  // watchlist (25%) with its own rotation: a new mint evicts the OLDEST
  // live-feed mint once the slice is full, and may evict the single oldest
  // watch entry overall when the watchlist is at its hard cap. Curated
  // sources keep the rest. Returns true if added.
  // Blacklist eviction (user, 2026-10-12): a user-marked mint leaves the watchlist
  // entirely and can never re-enter — before this, marked coins kept firing signals,
  // eating evaluation slots and spamming the signals feed every cooldown cycle.
  evictBlacklisted() {
    const bl = this.journal.blacklistedMints();
    if (!bl.size) return 0;
    const held = new Set(this.positions.map(p => p.mint));
    let n = 0;
    for (const mint of bl) if (!held.has(mint) && this.watch.delete(mint)) n++;
    return n;
  }

  noteMint(mint, source = 'live-ws') {
    // Callout Shadow Lab (record-only): a graduation feed is a would-call
    // moment. Fires BEFORE the early returns below on purpose — the call is
    // about the graduation itself, not about whether the mint is new to the
    // watchlist (already-watched/held/blacklisted mints still graduated).
    if (mint && source === 'graduated' && this.calloutLab) {
      try {
        const lv = this.latest.get(mint);
        this.calloutLab.record({ trigger: 'graduation', ts: this.now(), mint, symbol: lv ? lv.symbol : null, v: lv || { address: mint }, mc: lv ? lv.mc : null, liquidity: lv ? lv.liq : null, setup: 'graduation', source: 'gradwatch', holding: this.positions.some(p => p.mint === mint), linkId: null }).catch(() => {});
      } catch { /* observer only */ }
    }
    if (!mint || this.watch.has(mint)) return false;
    if (this.journal.blacklistedMints().has(mint)) return false;
    if (this.positions.some(p => p.mint === mint)) return false;
    const n = this.now();
    const sliceCap = Math.max(10, Math.floor(this.cfg.watchMax * 0.25));
    let wsCount = 0, oldestWs = null, oldestWsTs = Infinity, oldestAny = null, oldestAnyTs = Infinity;
    for (const [m, w] of this.watch) {
      if (w.ts < oldestAnyTs) { oldestAnyTs = w.ts; oldestAny = m; }
      if (w.source === source) { wsCount++; if (w.ts < oldestWsTs) { oldestWsTs = w.ts; oldestWs = m; } }
    }
    if (wsCount >= sliceCap && oldestWs) this.watch.delete(oldestWs);
    else if (this.watch.size >= this.cfg.watchMax && oldestAny) this.watch.delete(oldestAny);
    this.watch.set(mint, { ts: n, source });
    this.intakeCounts[source] = (this.intakeCounts[source] || 0) + 1; // scan record (record-only)
    return true;
  }

  /** Mints whose trades the live feed should stream: freshest watch entries + open positions.
   *  Open positions always come first — a held mint keeps its subscription for the life of
   *  the position, ahead of the capped fresh-watch slice. With fast pop off, held mints are
   *  still streamed while the shadow ratchet judge (record-only) is on: it reads their flow.
   *  Open SHADOW positions' mints ride along (after held) while the judge is on — the
   *  stream judge's shadow-book sample (v2) reads the same feed. */
  tradeWatchMints() {
    const held = this.positions.map(p => p.mint);
    const shadow = this.cfg.ratchetShadow && this.shadowTrades ? this.shadowTrades.pendingMints().map(x => x.mint) : [];
    if (!this.cfg.fastPop) return this.cfg.ratchetShadow ? [...new Set([...held, ...shadow])] : [];
    const fresh = [...this.watch.entries()].sort((a, b) => b[1].ts - a[1].ts).slice(0, this.cfg.fastPopMaxSubs).map(([m]) => m);
    return [...new Set([...held, ...shadow, ...fresh])];
  }

  /**
   * A streamed trade for a watched mint (fast pop detection, user 2026-10-13).
   * Buffers the print and, throttled per mint, judges it with the pure fastPop
   * detector. A fire routes into the exact same onSignal pipeline as a classic
   * pop — name block, gates, risk, round-trip all unchanged. Fail-open throughout:
   * the stream is an accelerator, never a dependency.
   */
  noteTrade(mint, trade) {
    // shadow ratchet judge feed (record-only): held + shadow-book mints' trades, independent of fast pop
    if (this.cfg.ratchetShadow) this.noteShadowTrade(mint, trade);
    if (!this.cfg.fastPop || !trade || !(trade.price > 0)) return;
    let buf = this.streamBuf.get(mint);
    if (!buf) { buf = []; this.streamBuf.set(mint, buf); }
    buf.push(trade);
    const cutoff = trade.ts - (this.cfg.fastPopWindowSec * 1000 + 60000);
    while (buf.length && buf[0].ts < cutoff) buf.shift();
    if (buf.length > 600) buf.splice(0, buf.length - 600);
    const n = this.now();
    if (n - (this.fastEvalAt.get(mint) || 0) < this.cfg.fastPopEvalMs) return;
    this.fastEvalAt.set(mint, n);
    this._evalFastPop(mint, buf, n).catch(e => this.err('fastPop', e));
  }

  /** Buffer a streamed trade for the shadow ratchet judges — held mints and open
   *  shadow positions' mints only, everything else ignored (buffered once when a
   *  mint is both). Each target's stream-trade count is its coverage record.
   *  After buffering, the STREAM judge (v2) evaluates on the trade path itself,
   *  throttled per mint exactly like the fast-pop evaluation above. */
  noteShadowTrade(mint, trade) {
    if (!trade || !(trade.sol > 0)) return;
    const pos = this.positions.find(p => p.mint === mint) || null;
    const virt = this.shadowTrades ? this.shadowTrades.openVirtual(mint) : null;
    if (!pos && !virt) return;
    this.shadowFlow.note(mint, trade);
    if (pos) pos.streamTrades = (pos.streamTrades || 0) + 1;
    let st = null;
    if (virt) { st = this._shadowStreamStateFor(virt.id); st.mint = mint; st.streamTrades = (st.streamTrades || 0) + 1; }
    const n = trade.ts || this.now();
    if (n - (this.streamEvalAt.get(mint) || 0) < this.cfg.ratchetStreamEvalMs) return;
    this.streamEvalAt.set(mint, n);
    try { this._judgeRatchetStream(mint, pos, virt, st, n); } catch { /* observer only — the stream path must never disturb the feed */ }
  }

  /**
   * One stream-judge step against a state holder (a real position, or a shadow
   * virtual's Bot-side state): given the stream VWAP move off the entry price,
   * track the STREAM's own peak, arm off it, and run the unchanged pure fire
   * test. Returns { fire, move, peakMove } on the position's first stream
   * would-fire, else null. A holder with no usable entry price has no opinion.
   */
  _streamJudgeStep(holder, entryPrice, tp1Done, vwPrice, flow) {
    if (!(entryPrice > 0)) return null;
    const move = vwPrice / entryPrice;
    if (holder.streamPeakMove == null || move > holder.streamPeakMove) holder.streamPeakMove = move;
    if (ratchetArmed(holder.streamPeakMove, tp1Done, this.cfg)) holder.streamArmed = true;
    if (holder.streamFired) return null; // at most one stream would-fire per position: the first
    const fire = ratchetShadowFire({ peakMove: holder.streamPeakMove, tp1Done, move, flow, cfg: this.cfg });
    if (!fire) return null;
    holder.streamFired = true;
    return { fire, move, peakMove: holder.streamPeakMove };
  }

  /**
   * STREAM ratchet judge (user 2026-10-15, RECORD-ONLY — this can never sell).
   * The tick judge (judgeRatchetShadow) asks its question on 4s quote polls;
   * this one asks the SAME question as the trades themselves land: is the
   * flow an exit wave while the stream VWAP comes off the stream's own peak?
   * The price basis differs by design (stream prints off the actual entry
   * fill, not the realizable quote), so every record cross-tags the other
   * judge's state (jupArmed, and jupMove sampled fresh at fire time) and the
   * completion records carry both fire timestamps — lead time is only ever
   * read where both judges armed. Runs for held positions (source 'real')
   * and open shadow-book virtuals (source 'shadow', counted separately).
   * A VWAP window holding fewer than 2 prints is no opinion at all: neither
   * a peak update nor a fire evaluation, so one dust print decides nothing.
   */
  _judgeRatchetStream(mint, pos, virt, st, n) {
    const vw = this.shadowFlow.vwap(mint, n, this.cfg.ratchetStreamVwapSec);
    if (!vw || vw.prints < 2) return;
    const flow = this.shadowFlow.window(mint, n, this.cfg.ratchetFlowWindowSec);
    if (pos) {
      const hit = this._streamJudgeStep(pos, pos.entryFillSol, pos.tp1Done, vw.price, flow);
      if (hit) {
        pos.streamFireTs = n;
        this.stats.ratchetShadow = this.stats.ratchetShadow || { wouldFire: 0, completed: 0 };
        this.stats.ratchetShadow.streamWouldFire = (this.stats.ratchetShadow.streamWouldFire || 0) + 1;
        const jupArmed = ratchetArmed(pos.peakMove, pos.tp1Done, this.cfg); // was the QUOTE judge armed at this same moment?
        this._journalStreamFireReal(pos, hit, jupArmed, n).catch(() => { /* observer only */ });
        console.log(`[ratchet-shadow] ${pos.symbol}: STREAM WOULD FIRE — sells ${Math.round(hit.fire.sellShare * 100)}% of last ${this.cfg.ratchetFlowWindowSec}s flow (${hit.fire.sellSol.toFixed(2)} SOL), stream move ${hit.move.toFixed(3)} off stream peak ${hit.peakMove.toFixed(3)} (record only)`);
      }
    }
    if (virt && st) {
      // A virtual restored across a restart never got the open-time SOL basis:
      // resolve it lazily off the current rate (open-time capture is preferred
      // and already set for virtuals opened by this process).
      if (st.entryPriceSol == null && virt.entryPrice > 0 && this.lastSolUsd > 0) st.entryPriceSol = virt.entryPrice / this.lastSolUsd;
      const hit = this._streamJudgeStep(st, st.entryPriceSol, virt.tp1Done, vw.price, flow);
      if (hit) {
        st.streamFireTs = n;
        this.stats.ratchetShadow = this.stats.ratchetShadow || { wouldFire: 0, completed: 0 };
        this.stats.ratchetShadow.streamShadowWouldFire = (this.stats.ratchetShadow.streamShadowWouldFire || 0) + 1;
        const markMove = virt.entrySol > 0 && virt.remainingFrac > 0 ? (virt.lastValueSol / (virt.entrySol * virt.remainingFrac)) / (virt.entryRoundTrip > 0 ? virt.entryRoundTrip : 1) : null;
        this.journal.ratchetShadow({ kind: 'would-fire-stream', source: 'shadow', id: virt.id, ts: n, mint, symbol: virt.symbol, setup: virt.setup, streamMove: +hit.move.toFixed(4), streamPeakMove: +hit.peakMove.toFixed(4), sellShare: +hit.fire.sellShare.toFixed(3), sellSol: +hit.fire.sellSol.toFixed(4), buySol: +hit.fire.buySol.toFixed(4), windowSec: this.cfg.ratchetFlowWindowSec, jupArmed: ratchetArmed(virt.peakMove, virt.tp1Done, this.cfg), jupMove: markMove != null && Number.isFinite(markMove) ? +markMove.toFixed(4) : null });
        console.log(`[ratchet-shadow] ${virt.symbol}: STREAM WOULD FIRE (shadow book) — sells ${Math.round(hit.fire.sellShare * 100)}% of last ${this.cfg.ratchetFlowWindowSec}s flow (${hit.fire.sellSol.toFixed(2)} SOL), stream move ${hit.move.toFixed(3)} off stream peak ${hit.peakMove.toFixed(3)} (record only)`);
      }
    }
  }

  /**
   * Journal a real position's stream would-fire. jupMove is a FRESH Jupiter
   * mark sampled at fire time (fires are rare; one quote is cheap and exact),
   * converted to a move exactly as positionTick computes it — fail-silent to
   * the last tick's move when the quote fails or the exec layer can't quote.
   * Async by necessity; the caller has already latched the fire state.
   */
  async _journalStreamFireReal(pos, hit, jupArmed, n) {
    let jupMove = pos.ratchetShadowMove != null ? pos.ratchetShadowMove : null;
    try {
      if (this.exec && typeof this.exec.markValue === 'function') {
        const valueSol = await this.exec.markValue(pos.mint, pos.tokensRaw);
        const basis = pos.entrySol * pos.remainingFrac;
        const base = pos.entryRoundTrip > 0 ? pos.entryRoundTrip : 1;
        if (valueSol != null && basis > 0) jupMove = (valueSol / basis) / base;
      }
    } catch { /* quote failed — the last tick move stands */ }
    this.journal.ratchetShadow({ kind: 'would-fire-stream', source: 'real', id: pos.id, ts: n, mint: pos.mint, symbol: pos.symbol, setup: pos.setup, streamMove: +hit.move.toFixed(4), streamPeakMove: +hit.peakMove.toFixed(4), sellShare: +hit.fire.sellShare.toFixed(3), sellSol: +hit.fire.sellSol.toFixed(4), buySol: +hit.fire.buySol.toFixed(4), windowSec: this.cfg.ratchetFlowWindowSec, jupArmed, jupMove: jupMove != null ? +jupMove.toFixed(4) : null });
  }

  /** Callout Shadow Lab tap for wallet-detector events (record-only): a
   *  dev-launch or confluence event journaled by walletWatch is a would-call
   *  moment. The view for thesis generation is rebuilt from the event plus the
   *  freshest view the bot holds; buildThesis researches the rest itself. */
  noteCalloutEvent(ev) {
    try {
      if (!ev || !this.calloutLab) return;
      const trigger = ev.kind === 'dev' ? 'devlaunch' : ev.kind === 'confluence' ? 'confluence' : null;
      if (!trigger) return;
      const lv = this.latest.get(ev.mint);
      const v = lv || { address: ev.mint, symbol: ev.symbol || null, name: ev.symbol || null, mc: ev.mc ?? null, pairAddress: ev.pool || null };
      this.calloutLab.record({
        trigger, ts: ev.ts || this.now(), mint: ev.mint, symbol: ev.symbol || (lv ? lv.symbol : null), v,
        mc: ev.mc ?? (lv ? lv.mc : null), liquidity: lv ? lv.liq : null, pool: ev.pool || null,
        setup: trigger, source: 'walletwatch', holding: this.positions.some(p => p.mint === ev.mint), linkId: ev.id || null,
      }).catch(() => {});
    } catch { /* observer only */ }
  }

  /** Confluence Shadow Signal tap for walletWatch events (record-only):
   *  a confluence fire opens its SCALP + LADDER virtual pair inside the
   *  signal module, stamped at detection with the bot's book at that
   *  moment attached (held: a real position is open on the mint;
   *  signaled: the mint appears in this process's signal memory or the
   *  journal's in-memory signal tail). Dev events return immediately. */
  noteConfluenceEvent(ev) {
    try {
      if (!ev || ev.kind !== 'confluence' || !this.confluenceSignal) return;
      const held = this.positions.some(p => p.mint === ev.mint);
      const signaled = !!(this.lastSignal && this.lastSignal.has(ev.mint))
        || !!((this.journal && Array.isArray(this.journal.signals)) && this.journal.signals.some(s => s && s.mint === ev.mint));
      this.confluenceSignal.noteEvent(ev, { held, signaled });
    } catch { /* observer only */ }
  }

  /** Read-only /confluencesignal payload — the Confluence Shadow Signal
   *  card (record-only, user 2026-10-16): per-profile aggregates over the
   *  FULL confluence_signal.jsonl (see confluenceSignal.js; ~60s cached
   *  there), ready at 50 closes per profile. */
  confluenceSignalCard() {
    try { return this.confluenceSignal ? this.confluenceSignal.card() : { enabled: false }; }
    catch { return { enabled: false }; }
  }

  /** Read-only /callouts payload — the lab's scorecard over the FULL
   *  callout_shadow.jsonl (see calloutLab.js; ~60s cached there). */
  calloutCard() {
    try { return this.calloutLab.scorecard(); } catch { return { enabled: false }; }
  }

  /** Read-only /resignals payload — the Answered Re-signals scorecard over
   *  resignal_shadow.jsonl (see resignalLab.js; ~60s cached in the journal). */
  resignalCard() {
    try { return this.journal.resignalCard(); } catch { return { enabled: false }; }
  }

  /** Read-only /deadentry payload — the Dead-Entry Veto study scorecard
   *  (see deadEntryLab.js; ~30s cached in the journal). */
  deadEntryCard() {
    try { return this.journal.deadEntryCard(); } catch { return { enabled: false }; }
  }

  /** Flow-Exit Watcher feed (record-only): the position's own mark state in
   *  the same measure the exit stack judges — the realizable move of the
   *  remaining position vs its entry round-trip, off the last live sell-quote
   *  mark (pos.lastValueSol, refreshed by every managePosition). Nulls when
   *  the position has never been marked. */
  _flowExitPosState(id) {
    const pos = this.positions.find(p => p.id === id);
    if (!pos) return { open: false };
    const basis = pos.entrySol * (pos.remainingFrac || 0);
    let movePct = null, markSol = null;
    if (pos.lastValueSol != null && basis > 0) {
      const base = pos.entryRoundTrip > 0 ? pos.entryRoundTrip : 1;
      movePct = +(((pos.lastValueSol / basis) / base - 1) * 100).toFixed(2);
      markSol = +pos.lastValueSol.toFixed(6);
    }
    return {
      open: true, movePct, markSol,
      peakPct: pos.peakMove != null ? +((pos.peakMove - 1) * 100).toFixed(2) : null,
      bankedSol: pos.realizedSol || 0,
      botRemainingFrac: pos.remainingFrac != null ? pos.remainingFrac : null,
    };
  }

  /** Read-only /flowexits payload — the Flow-Exit Watcher scorecard over the
   *  FULL flow_exits.jsonl (see flowExits.js; ~60s cached there). */
  flowExitsCard() {
    try { return this.flowExits.scorecard(); } catch { return { enabled: false }; }
  }

  /** Read-only /structurewatch payload — the Structure Watch scorecard over
   *  the FULL structure_watch.jsonl (see structureWatch.js; ~60s cached there). */
  structureWatchCard() {
    try { return this.structureWatch.scorecard(); } catch { return { enabled: false }; }
  }

  /** Read-only /staircase payload — the Staircase-3 Shadow Signal card
   *  (record-only, user 2026-10-16): ordinal >= 3 marks journaled as named
   *  shadow signals, forward scores joined at read time from the structure
   *  journal (see staircaseSignal.js). ready = 30 finalized. */
  staircaseCard() {
    try { return this.staircaseSignal ? this.staircaseSignal.card() : { enabled: false }; }
    catch { return { enabled: false }; }
  }

  /** Read-only /nevergreen payload — the Never-Green Cut shadow card
   *  (record-only, owner 2026-10-17): would-fires paired against the
   *  actual close outcomes on the same remainders (see neverGreen.js);
   *  ready at 30 paired. */
  neverGreenCard() {
    try { return this.neverGreen ? this.neverGreen.card() : { enabled: false }; }
    catch { return { enabled: false }; }
  }

  /** Read-only /bottomwatch payload — the Bottom Tracker card
   *  (record-only, user 2026-10-16): 'first move off the bottom' marks on
   *  dumped watched coins, forward-scored with the structure tailer,
   *  split by source (bot-exited vs watched) and move band; ready = 30
   *  finalized. */
  bottomWatchCard() {
    try { return this.bottomWatch ? this.bottomWatch.card() : { enabled: false }; }
    catch { return { enabled: false }; }
  }

  /** Read-only /rangewatch payload — the Range Study card (owner
   *  2026-10-16): tight sideways bases journaled one mark per episode,
   *  forward-scored with the structure tailer and classed expanded /
   *  broke down / ranged; ready = 30 finalized. The aggregates stay
   *  mark-based; liveRouting rides along as a note (RANGE_LIVE evals +
   *  the 'range' signal journal's fired/taken counts). */
  rangeWatchCard() {
    try {
      const card = this.rangeWatch ? this.rangeWatch.card() : { enabled: false };
      if (!card || card.enabled === false) return card;
      const sigs = (this.journal.signals || []).filter(s => s.setup === 'range');
      const st = this.stats.range || {};
      return { ...card, liveRouting: { live: !!this.cfg.rangeLive, evals: st.evals || 0, retries: st.retries || 0, noView: st.noView || 0, noViewFinal: st.noViewFinal || 0, signals: sigs.length, taken: sigs.filter(s => s.decision === 'taken').length } };
    }
    catch { return { enabled: false }; }
  }

  /** Read-only /scanledger payload — the Scan Ledger (record-only, user
   *  2026-10-16): totals + latest sessions + the near-miss list (biggest
   *  runs while watched that never signaled), r15/r60 joined from the
   *  ScanLab score map. */
  scanLedgerCard() {
    try { return buildScanCard(this.journal.scanSessions || [], (id) => this.scanLab ? this.scanLab.scoreOf(id) : null, this.now()); }
    catch { return { enabled: false }; }
  }

  /** Read-only /shadowseller payload — the Shadow Seller (record-only, user
   *  2026-10-16): the learned judge's would-fires paired against the ladder's
   *  actual outcomes on the same remainders, with post-exit moves joined at
   *  read time. ready = 30 paired fires. */
  shadowSellerCard() {
    try { return this.shadowSeller ? this.shadowSeller.card() : { enabled: false }; }
    catch { return { enabled: false }; }
  }

  /**
   * Read-only /ratchetshadow payload (record-only, like the layer itself):
   * counters off stats, aggregates over the journal's in-memory ratchet tail
   * (the last 500 records — months of this journal's traffic). The arm
   * comparison reads REAL completions only: a shadow virtual has no tick
   * judge, so its tickArmed is null and it can never pollute the pairing.
   * bothArmed counts completions where BOTH judges fired (leadSec != null
   * is exactly that set); lead time is never averaged over anything else.
   */
  ratchetShadowView() {
    const cfg = this.cfg || {};
    const st = this.stats.ratchetShadow || {};
    const recs = (this.journal && this.journal.ratchet) || [];
    const byKind = { wouldFire: 0, streamReal: 0, streamShadow: 0, fireQuality: 0, closedReal: 0, closedShadow: 0 };
    const leads = [];
    let closedN = 0, covered = 0, streamOnlyArms = 0, tickOnlyArms = 0;
    for (const r of recs) {
      if (!r) continue;
      if (r.kind === 'would-fire') byKind.wouldFire++;
      else if (r.kind === 'would-fire-stream') { if (r.source === 'shadow') byKind.streamShadow++; else byKind.streamReal++; }
      else if (r.kind === 'fire-quality') byKind.fireQuality++;
      else if (r.kind === 'closed') {
        closedN++;
        if (r.source === 'shadow') byKind.closedShadow++; else byKind.closedReal++;
        if (r.streamCovered) covered++;
        if (r.leadSec != null) leads.push(r.leadSec);
        if (typeof r.tickArmed === 'boolean') {
          if (r.streamArmed && !r.tickArmed) streamOnlyArms++;
          else if (r.tickArmed && !r.streamArmed) tickOnlyArms++;
        }
      }
    }
    leads.sort((a, b) => a - b);
    const medianLeadSec = leads.length ? +(leads.length % 2 ? leads[(leads.length - 1) / 2] : (leads[leads.length / 2 - 1] + leads[leads.length / 2]) / 2).toFixed(2) : null;
    return {
      enabled: !!cfg.ratchetShadow,
      knobs: { evalMs: cfg.ratchetStreamEvalMs, vwapSec: cfg.ratchetStreamVwapSec, flowWindowSec: cfg.ratchetFlowWindowSec, flowSellShare: cfg.ratchetFlowSellShare, flowMinSellSol: cfg.ratchetFlowMinSellSol, beArmPct: cfg.beArmPct, beTriggerPct: cfg.beTriggerPct },
      counters: { wouldFire: st.wouldFire || 0, completed: st.completed || 0, streamWouldFire: st.streamWouldFire || 0, streamShadowWouldFire: st.streamShadowWouldFire || 0 },
      journalRecords: recs.length,
      byKind,
      bothArmed: { n: leads.length, medianLeadSec, streamOnlyArms, tickOnlyArms },
      coverage: { closed: closedN, covered },
      recent: recs.slice(-15).reverse(),
    };
  }

  /**
   * Shadow ratchet flow judge (user 2026-10-14, RECORD-ONLY — this can never sell).
   * Runs on every position check with a live mark, right after evaluateExit has
   * updated the position's peakMove, so it reads the same move/peakMove the live
   * ratchet (§4c) just judged. For an armed position it asks the stream: is the
   * flow over the last ratchetFlowWindowSec an exit wave while the price comes
   * off its high? The first would-fire per position is journaled to
   * ratchet_shadow.jsonl; the completion record lands in ensureClose. Fail-silent:
   * no streamed flow for the mint = no opinion, nothing recorded.
   */
  judgeRatchetShadow(pos, move, n) {
    if (!this.cfg.ratchetShadow) return;
    pos.ratchetShadowMove = move; // the close record's exit move, whichever exit ends it
    // fire-quality probes (record-only, v2): if the STREAM judge already
    // would-fired this position, what did the realizable move do at the first
    // ticks >= 30s / >= 60s after its fire? An early fire is only a good fire
    // if the price kept falling — a probe back at the peak exposes a shakeout.
    try {
      if (pos.streamFired && pos.streamFireTs) {
        for (const atSec of [30, 60]) {
          const key = atSec === 30 ? 'streamProbe30' : 'streamProbe60';
          if (pos[key] || n - pos.streamFireTs < atSec * 1000) continue;
          pos[key] = true;
          this.journal.ratchetShadow({ kind: 'fire-quality', source: 'real', id: pos.id, ts: n, mint: pos.mint, symbol: pos.symbol, atSec, jupMove: +move.toFixed(4) });
        }
      }
    } catch { /* observer only */ }
    if (ratchetArmed(pos.peakMove, pos.tp1Done, this.cfg)) pos.ratchetShadowArmed = true;
    if (pos.ratchetShadowFired) return; // at most one would-fire per position: the first
    const flow = this.shadowFlow.window(pos.mint, n, this.cfg.ratchetFlowWindowSec);
    const fire = ratchetShadowFire({ peakMove: pos.peakMove, tp1Done: pos.tp1Done, move, flow, cfg: this.cfg });
    if (!fire) return;
    pos.ratchetShadowFired = true;
    pos.ratchetShadowFireTs = n; // the completion record pairs this with streamFireTs for lead time
    this.stats.ratchetShadow = this.stats.ratchetShadow || { wouldFire: 0, completed: 0 };
    this.stats.ratchetShadow.wouldFire++;
    this.journal.ratchetShadow({ kind: 'would-fire', id: pos.id, ts: n, mint: pos.mint, symbol: pos.symbol, setup: pos.setup, moveAtFire: +move.toFixed(4), peakMove: +pos.peakMove.toFixed(4), sellShare: +fire.sellShare.toFixed(3), sellSol: +fire.sellSol.toFixed(4), buySol: +fire.buySol.toFixed(4), windowSec: this.cfg.ratchetFlowWindowSec, streamArmed: !!pos.streamArmed, streamFireTs: pos.streamFireTs ?? null });
    console.log(`[ratchet-shadow] ${pos.symbol}: WOULD FIRE — sells ${Math.round(fire.sellShare * 100)}% of last ${this.cfg.ratchetFlowWindowSec}s flow (${fire.sellSol.toFixed(2)} SOL), move ${move.toFixed(3)} off peak ${pos.peakMove.toFixed(3)} (record only)`);
  }

  async _evalFastPop(mint, buf, n, liqRechecks = 0) {
    if (this.positions.some(p => p.mint === mint)) return;
    if (n - (this.lastSignal.get(mint) || 0) < this.cfg.signalCooldownMin * 60000) return;
    const sig = fastPop(buf, this.cfg, n);
    if (!sig) return;
    if (liqRechecks > 0) sig.liqRechecks = liqRechecks;
    // The pipeline needs a DexScreener view for gates/sizing. Reuse the poll's
    // latest; refresh just this mint if it's missing or stale.
    let v = this.latest.get(mint);
    if (!v || n - (this.latestAt.get(mint) || 0) > 20000) {
      const views = await this.d.fetchViews([mint]).catch(() => null);
      if (views && views.get(mint)) { v = views.get(mint); this.latest.set(mint, v); this.latestAt.set(mint, n); this.history.record(v, n); this._foldScan(v, n); }
    }
    if (!v) return;
    // Same tradability floor the classic detectors apply — with the LIQ
    // RE-CHECK deferral (owner order 2026-10-17): a young coin whose only
    // failure is the $0/missing liquidity read is queued and this eval
    // re-runs on the healed view (the stream buffer is re-read at resume
    // time; if its window has gone stale the re-judged fire simply does
    // not recur — exactly as if fresh). No expire journal: this path's
    // legacy liq drop is silent and the re-check invents no record.
    const elcFP = eligibleChecks(v, this.cfg, n);
    if (elcFP.length) {
      if (liqFamilyChecks(elcFP).length === elcFP.length && this._queueLiqRecheck({
        mint, setup: 'pop', v, n,
        resume: (fv, checks) => this._evalFastPop(mint, this.streamBuf.get(mint) || buf, this.now(), checks),
        expire: null,
      })) return;
      return;
    }
    const streamVolSol = sig.metrics.volM5; // fastPop reports window volume in SOL
    sig.metrics.streamVolSol = streamVolSol;
    const solUsd = await this.d.fetchSolUsd().catch(() => null);
    if (solUsd) sig.metrics.volM5 = Math.round(streamVolSol * solUsd); // USD for journal parity with classic pops
    this.lastSignal.set(mint, this.now());
    this.stats.fastPop = this.stats.fastPop || { fires: 0 };
    this.stats.fastPop.fires++;
    console.log(`[fastpop] ${v.symbol} fired from the trade stream: +${sig.metrics.gainPct}% in ${sig.metrics.windowSec}s, ${sig.metrics.trades} trades, buy share ${sig.metrics.buyRatioM5}`);
    // Fast-pop floors (user 2026-10-15): the burst must carry real size on
    // BOTH volume measures or the fire is journaled as a skip with the reason
    // — never silently swallowed, never taken. Fail-closed on missing data:
    // if the SOL/USD conversion failed, the USD figure is unknown (null
    // here) and cannot clear its floor.
    const floors = fastPopFloors({ volM5Usd: solUsd ? sig.metrics.volM5 : null, streamVolSol }, this.cfg);
    if (!floors.pass) {
      this.stats.fastPopFloors = this.stats.fastPopFloors || { blocked: 0, missing: 0 };
      this.stats.fastPopFloors.blocked++;
      if (floors.missing) this.stats.fastPopFloors.missing++;
      console.log(`[fastpop] skip: ${v.symbol} — ${floors.reasons.join('; ')}`);
      return this.skip(v, sig, floors.reasons.map(r => `fastPop: ${r}`), [], { fastPop: { pass: false, reason: floors.reasons.join('; ') } });
    }
    await this.onSignal(v, sig);
  }

  // TRENDING SEEDING (owner order 2026-10-18 18:54 EDT): offer the scraped
  // trending list to the structure watch — its second supply line, so a
  // coin climbing quietly can become a staircase candidate without first
  // doing something loud. Guarded hard: kill switch, free watch slots
  // only (signal seeds are never crowded out — the headroom check runs
  // before every seed call, so the watch's own cap-skip journal stays
  // silent), an hourly budget, the mc floor inside pickTrendSeeds, and
  // the blacklist. Fail-silent: an observer seam can never disturb
  // discovery.
  _seedStructureFromTrending(rows, n, bl) {
    try {
      if (!(this.cfg.structureTrendSeed > 0) || !this.structureWatch) return;
      const hourKey = Math.floor(n / 3600000);
      if (!this._trendSeedHour || this._trendSeedHour.key !== hourKey) this._trendSeedHour = { key: hourKey, count: 0 };
      const budget = (this.cfg.structureTrendSeedPerHour || 0) - this._trendSeedHour.count;
      if (budget <= 0) return;
      // Room = the reserved trending slice: the signal funnel refills
      // freed slots within seconds (first live read: watch pinned at
      // 30/30, zero trending seeds), so trending seeds get RESERVE slots
      // of their own on top of the shared cap — never evicting a signal
      // watch, never exceeding MAX + RESERVE total.
      let trendActive = 0;
      for (const w of this.structureWatch.active.values()) if (w.rec && w.rec.seedSource === 'trending') trendActive++;
      const room = Math.min(STRUCTURE_TREND_RESERVE - trendActive, STRUCTURE_MAX_WATCHES + STRUCTURE_TREND_RESERVE - this.structureWatch.active.size);
      if (room <= 0) return;
      // The scraped trending rows carry only {address, name, symbol} —
      // no market cap (first live read, 2026-10-18). The floor still has
      // to be VERIFIED, so the cap is read from the bot's own latest
      // market view for the mint instead (fresher than any list field);
      // a mint with no view yet is skipped this tick and retried on a
      // later one — it joined the watchlist in this same discover pass.
      const enriched = (rows || []).map(r => {
        const mint = r && (r.mint || r.address);
        const v = mint ? this.latest.get(mint) : null;
        return { ...r, mc: r.usd_market_cap ?? r.market_cap ?? r.mc ?? (v ? v.mc : undefined), price: r.price ?? (v ? v.price : undefined), symbol: r.symbol || (v ? v.symbol : undefined) };
      });
      const picks = pickTrendSeeds(enriched, { minMc: this.cfg.structureSeedMinMc || 0, limit: Math.min(budget, room), exclude: new Set(this.structureWatch.activeMint.keys()) });
      for (const p of picks) {
        if (bl && bl.has(p.mint)) continue;
        const rec = this.structureWatch.seed({ ts: n, mint: p.mint, symbol: p.symbol, mc: p.mc, price: p.price, setup: 'trending', decision: 'seed', seedSource: 'trending' }, { reserve: STRUCTURE_TREND_RESERVE });
        if (rec) this._trendSeedHour.count++;
      }
    } catch { /* observer only — never disturb discovery */ }
  }

  async discoverTick() {
    if (this.busy.discover) return;
    this.busy.discover = true;
    try {
      const found = await this.d.discover(this.cfg);
      const n = this.now();
      const bl = this.journal.blacklistedMints();
      for (const [mint, source] of found) if (!bl.has(mint)) this.watch.set(mint, { ts: n, source });
      // Feed scraped pump.fun lists into the watchlist
      let reallistsAdded = 0;
      try {
        const rl = JSON.parse(fs.readFileSync(path.join(this.cfg.dataDir, 'reallists.json'), 'utf8'));
        for (const row of [...(rl.trending || []), ...(rl.movers || []), ...(rl.graduated || []), ...(rl.new || [])]) {
          const mint = row.mint || row.address;
          if (mint && !bl.has(mint) && !this.watch.has(mint)) { this.watch.set(mint, { ts: n, source: 'reallists' }); reallistsAdded++; }
        }
        this._seedStructureFromTrending(rl.trending || [], n, bl);
      } catch {}
      this.evictBlacklisted();
      this.stats.sourceCounts = found.counts || {};
      this.stats.discoverTicks++; this.stats.lastDiscoverTs = n;
      // prune: stale entries first; hard cap keeps the freshest, never drops open positions.
      // Churn-pinned mints (dumped coins on the basing watch) are exempt from both prunes
      // until their pin expires — non-pinned mints behave exactly as before.
      const ttl = this.cfg.watchTtlMin * 60000;
      const held = new Set(this.positions.map(p => p.mint));
      for (const [m, w] of this.watch) if (!held.has(m) && !this.churnPinned(m, n) && n - w.ts > ttl) this.watch.delete(m);
      if (this.watch.size > this.cfg.watchMax) {
        const sorted = [...this.watch.entries()].sort((a, b) => b[1].ts - a[1].ts);
        for (const [m] of sorted.slice(this.cfg.watchMax)) if (!held.has(m) && !this.churnPinned(m, n)) this.watch.delete(m);
      }
      this.history.prune(n, new Set([...this.watch.keys(), ...held]));
      // graduation-handoff bookkeeping only tracks mints we still watch or hold
      if (this.curveSeen.size) { const keep = new Set([...this.watch.keys(), ...held]); for (const m of this.curveSeen) if (!keep.has(m)) this.curveSeen.delete(m); }
      // Scan record (record-only, freeze work 1b — user 2026-10-14): persist
      // ONE compact line per discovery cycle — post-prune watchlist size +
      // per-source intake — so "coins scanned per hour" is recoverable later
      // (the funnel analysis found it wasn't: nothing persisted scan counts).
      // Intake = distinct mints each source contributed this cycle: discover()
      // sources by their quota `taken`, reallists by actual adds above, and the
      // async noteMint sources (live-ws / graduated / flow) by the adds counted
      // since the previous cycle. Fail-silent: journaling never breaks discovery.
      try {
        const intake = {};
        for (const [name, c] of Object.entries(found.counts || {})) intake[name] = (c && c.taken) || 0;
        if (reallistsAdded) intake.reallists = reallistsAdded;
        for (const [name, c] of Object.entries(this.intakeCounts)) intake[name] = (intake[name] || 0) + c;
        this.intakeCounts = {};
        this.journal.scan({ ts: n, watchSize: this.watch.size, intake });
      } catch { /* record-only */ }
    } catch (e) { this.err('discover', e); } finally { this.busy.discover = false; this.saveStats(); }
  }

  // ------------------------------------------------------------ scan ledger
  // Scan Ledger (user order 2026-10-16, RECORD-ONLY — nothing in trading
  // branches on any of this): the signal journal only ever held coins where
  // a detector fired (~10 of ~760 scanned); every other watched coin left
  // no trace when its in-memory history evaporated. The ledger folds cheap
  // scalars per watched mint wherever views already fold into History, and
  // a throttled sweeper finalizes a session — idle past SCAN_SESSION_IDLE_SEC
  // or 3h old — into the journal (scan_sessions.jsonl) with the signaled
  // verdict joined from the signal journal at finalize time. A mint that
  // re-enters the watch starts a NEW session: the ledger accumulates, which
  // is the point — the study surface is every coin the bot ever scanned.
  _foldScan(v, n) {
    try {
      if (!this.cfg.scanLedger || !v || !(v.price > 0) || !v.address) return;
      let s = this.scanFold.get(v.address);
      if (!s) {
        s = { mint: v.address, symbol: v.symbol || null, firstTs: n, lastTs: n, samples: 0, firstPrice: v.price, firstMc: v.mc ?? null, peakPrice: v.price, peakMc: v.mc ?? null, peakTs: n, lastPrice: v.price, lastMc: v.mc ?? null, maxVolM5: v.volM5 ?? null };
        this.scanFold.set(v.address, s);
      }
      s.lastTs = n;
      s.samples++;
      if (v.symbol) s.symbol = v.symbol;
      s.lastPrice = v.price;
      if (v.mc != null) s.lastMc = v.mc;
      if (v.price > s.peakPrice) { s.peakPrice = v.price; s.peakTs = n; if (v.mc != null) s.peakMc = v.mc; }
      if (v.volM5 != null && (s.maxVolM5 == null || v.volM5 > s.maxVolM5)) s.maxVolM5 = v.volM5;
    } catch { /* record-only — never disturb the poll */ }
  }

  // Scan evaluation stamps (record-only, user order 2026-10-16): fold one
  // poll evaluation's per-setup verdicts into the live session, keeping the
  // BEST verdict per setup (a pass beats everything; then the further stage;
  // then the tighter bottleneck margin — see betterScanVerdict). Bounded by
  // construction: four small verdict objects ride the fold, however many
  // ticks the session runs. Inert unless the ledger + stamps are both on.
  _foldScanVerdicts(mint, verdicts) {
    if (!this.cfg.scanLedger || !this.cfg.scanStamps || !verdicts) return;
    const s = this.scanFold.get(mint);
    if (!s) return;
    s.evalTicks = (s.evalTicks || 0) + 1;
    if (!s.verdicts) s.verdicts = {};
    for (const [setup, vd] of Object.entries(verdicts)) {
      s.verdicts[setup] = betterScanVerdict(s.verdicts[setup] || null, vd);
    }
  }

  /** A view folded while the mint sat in an open position: the scan
   *  detectors never judge held mints (the poll loop skips them), so a
   *  session that only ever folded this way must SAY it was never evaluated
   *  rather than sit blank at finalize. */
  _noteScanHeld(mint) {
    if (!this.cfg.scanLedger || !this.cfg.scanStamps) return;
    const s = this.scanFold.get(mint);
    if (s) s.heldFold = true;
  }

  _finalizeScanSession(s) {
    const inWin = (this.journal.signals || []).filter(g => g.mint === s.mint && g.ts >= s.firstTs && g.ts <= s.lastTs);
    const rec = {
      type: 'scan', id: `${s.mint.slice(0, 6)}-${s.firstTs}`, mint: s.mint, symbol: s.symbol,
      firstTs: s.firstTs, lastTs: s.lastTs, durMin: Math.round((s.lastTs - s.firstTs) / 6000) / 10, samples: s.samples,
      firstPrice: s.firstPrice, firstMc: s.firstMc, peakPrice: s.peakPrice, peakMc: s.peakMc, peakTs: s.peakTs,
      lastPrice: s.lastPrice, lastMc: s.lastMc,
      runFromFirst: s.firstPrice > 0 ? Math.round((s.peakPrice / s.firstPrice) * 1000) / 1000 : null,
      maxVolM5: s.maxVolM5,
      signaled: inWin.length > 0,
      decisions: [...new Set(inWin.map(g => g.decision))],
      setups: [...new Set(inWin.map(g => g.setup))],
      stamp: this.cfgStamp,
    };
    // Evaluation stamps ride the record (SCAN_STAMPS=0 = the record is
    // exactly what it was before stamps shipped): the best verdict per
    // setup + the closest-call summary when the session was poll-evaluated,
    // or an explicit evaluated:false + why when views folded but the
    // detector loop never judged the mint (held, or stream/position folds).
    if (this.cfg.scanStamps) {
      rec.evals = s.evalTicks || 0;
      if (s.verdicts) {
        rec.verdicts = s.verdicts;
        rec.closest = closestCall(s.verdicts);
      } else {
        rec.evaluated = false;
        rec.evalWhy = s.heldFold
          ? 'watched while held as an open position — the scan detectors do not judge held mints'
          : 'views folded outside the detector loop (stream/position folds) — never poll-evaluated while watched';
      }
    }
    this.journal.scanSession(rec);
    try { if (this.scanLab) this.scanLab.register(rec); } catch { /* scorer is best-effort */ }
    return rec;
  }

  /** Throttled (~30s) finalization sweep, ridden on the poll tick next to
   *  the other observer ticks; also drives the ScanLab's housekeeping. */
  _scanSweep(n) {
    if (!this.cfg.scanLedger) return;
    if (n - this.lastScanSweepTs < 30000) return;
    this.lastScanSweepTs = n;
    const idleMs = (this.cfg.scanSessionIdleSec ?? 600) * 1000;
    for (const [mint, s] of [...this.scanFold]) {
      if (n - s.lastTs >= idleMs || n - s.firstTs >= SCAN_SESSION_MAX_MS) {
        this.scanFold.delete(mint);
        try { this._finalizeScanSession(s); } catch { /* record-only */ }
      }
    }
    try { if (this.scanLab) this.scanLab.tick(n); } catch { /* record-only */ }
  }

  // ------------------------------------------------------------ outcome observer
  // Outcome observer (2026-10-14, RECORD-ONLY — can never trade, never touches
  // the watchlist, history, or latest-view maps the detectors read). The
  // journal's outcome tracker used to be fed only as a side effect of the
  // trading poll (watchlist ∪ positions), so a signal's r5/r15/r60 depended
  // on its coin KEEPING a watch seat — 20-minute TTL versus a 60-minute last
  // checkpoint. This tick closes that gap: every ~30s it polls prices (the
  // same deps.fetchViews source, same chunking) for exactly the mints with
  // outcome tracking in flight that the trading poll hasn't covered in the
  // last ~25s, oldest signals first, capped per tick, and feeds the views to
  // journal.observe ONLY. A mint whose pair is gone simply returns no view;
  // its outcome finalizes at the horizon flagged partial (see journal.js).
  async outcomeTick(n) {
    if (n - (this.lastOutcomeTickTs || 0) < 30000) return;
    this.lastOutcomeTickTs = n;
    this.stats.outcomeObs = this.stats.outcomeObs || { ticks: 0, fetched: 0, views: 0 };
    try { this.journal.flushPending(); } catch { /* persistence is best-effort */ }
    const pend = this.journal.pendingMints ? this.journal.pendingMints() : [];
    // Trade-grade shadow (record-only): open virtual mints join the fetch
    // set, so a virtual position keeps being marked after its signal's own
    // outcome tracking (and any watchlist seat) ends — marks never depend on
    // watch residence, the same guarantee this observer exists to give.
    if (this.shadowTrades) {
      const have = new Set(pend.map(p => p.mint));
      for (const vm of this.shadowTrades.pendingMints()) if (!have.has(vm.mint)) pend.push(vm);
    }
    // Scan Ledger (record-only): mints with session scoring in flight join
    // the fetch set too, so r15/r60 never depend on watch residence either.
    if (this.scanLab) {
      const have = new Set(pend.map(p => p.mint));
      for (const pm of this.scanLab.pendingMints()) if (!have.has(pm.mint)) pend.push(pm);
    }
    // Confluence Shadow Signal (record-only): open virtual mints join the
    // fetch set on the same terms — a shadow pair keeps being marked after
    // every other tracker lets the mint go.
    if (this.confluenceSignal) {
      const have = new Set(pend.map(p => p.mint));
      for (const pm of this.confluenceSignal.pendingMints()) if (!have.has(pm.mint)) pend.push(pm);
    }
    // Bottom Tracker (record-only): mints with an open dump episode join
    // the fetch set on the same terms — the bottom and its first move are
    // followed even after the coin leaves the watchlist.
    if (this.bottomWatch) {
      const have = new Set(pend.map(p => p.mint));
      for (const pm of this.bottomWatch.pendingMints()) if (!have.has(pm.mint)) pend.push(pm);
    }
    // Range Study (record-only): mints with an open range episode join
    // the fetch set on the same terms — the range's exit (expansion or
    // breakdown) is followed even after the coin leaves the watchlist.
    if (this.rangeWatch) {
      const have = new Set(pend.map(p => p.mint));
      for (const pm of this.rangeWatch.pendingMints()) if (!have.has(pm.mint)) pend.push(pm);
    }
    const due = pend.filter(p => n - (this.outcomeSeenAt.get(p.mint) || 0) >= 25000).slice(0, 150);
    if (!due.length) return;
    this.stats.outcomeObs.ticks++;
    this.stats.outcomeObs.fetched += due.length;
    const views = await this.d.fetchViews(due.map(p => p.mint)).catch(() => null);
    if (views) {
      for (const [mint, v] of views) {
        if (!v || !(v.price > 0)) continue;
        this.journal.observe(v);
        try { if (this.scanLab) this.scanLab.observe(v, n); } catch { /* scan scorer — record-only */ }
        try { if (this.bottomWatch) this.bottomWatch.observe(v, n); } catch { /* bottom tracker — record-only */ }
        try { if (this.rangeWatch) this.rangeWatch.observe(v, n); } catch { /* range study — record-only */ }
        this.outcomeSeenAt.set(mint, n);
        this.stats.outcomeObs.views++;
      }
    }
    // Finalization must not depend on views existing at all: past-horizon
    // pendings close out flagged-partial even when every pair is gone.
    try { this.journal.expireSweep(n); } catch { /* observer only */ }
    // Trade-grade shadow: the SAME fetched views drive the virtual exit
    // stack (cap expiry included — it runs even when the fetch came back
    // empty). No price fetch exists anywhere for the virtuals but this one
    // and the trading poll's.
    try { if (this.shadowTrades) { this.shadowTrades.tick(mint => (views ? views.get(mint) : null) || null, n, this.cfg, this.lastSolUsd); this._syncShadowStats(); } } catch { /* observer only */ }
    // Confluence Shadow Signal: the same fetched views drive its virtual
    // pairs (cap expiry included — it runs even when the fetch came back
    // empty). No price fetch exists anywhere for the pairs but this one
    // and the trading poll's.
    try { if (this.confluenceSignal) this.confluenceSignal.tick(mint => (views ? views.get(mint) : null) || null, n, this.cfg, this.lastSolUsd); } catch { /* observer only */ }
  }

  // ------------------------------------------------------------ polling + signals
  async pollTick() {
    if (this.busy.poll) return;
    this.busy.poll = true;
    try {
      this.evictBlacklisted(); // marked coins never even get priced, let alone signal
      const mints = [...new Set([...this.watch.keys(), ...this.positions.map(p => p.mint)])];
      if (!mints.length) { try { await this.outcomeTick(this.now()); } catch { /* observer only */ } try { await this._flowRetryTick(this.now()); } catch { /* record-only retry */ } try { await this._staircaseRetryTick(this.now()); } catch { /* staircase retry */ } try { await this._rangeRetryTick(this.now()); } catch { /* range-live retry */ } try { await this._bottomRetryTick(this.now()); } catch { /* bottom-live retry */ } try { await this._preEntryTick(this.now()); } catch { /* pre-entry census */ } try { await this._rangeDipTick(this.now()); } catch { /* range dip watch */ } try { await this._walletRetryTick(this.now()); } catch { /* wallet-live retry */ } try { await this._liqRecheckTick(this.now()); } catch { /* liq re-check */ } try { await this.walletWatch.finalizeTick(this.now()); } catch { /* shadow outcomes */ } try { await this.calloutLab.tick(this.now()); } catch { /* shadow callouts */ } try { await this.flowExits.tick(this.now()); } catch { /* shadow flow exits */ } try { await this.structureWatch.tick(this.now()); } catch { /* shadow structure watch */ } try { await this.bottomWatch.tick(this.now()); } catch { /* shadow bottom tracker */ } try { await this.rangeWatch.tick(this.now()); } catch { /* shadow range study */ } try { this._scanSweep(this.now()); } catch { /* scan ledger */ } return; }
      const views = await this.d.fetchViews(mints);
      const n = this.now();
      // D4 (user 2026-10-13): market breadth — the share of sampled coins green on the hour —
      // feeds the streak pause's resume test. Logged on transitions so the pause/resume
      // decisions are auditable in the journal of record (console + /state fields).
      {
        let green = 0, total = 0;
        for (const v of views.values()) { if (v && v.chgH1 != null) { total++; if (v.chgH1 > 0) green++; } }
        if (total > 0) {
          const wasPaused = this.risk.s.streakPausedAt != null;
          const ev = this.risk.noteBreadth(green / total, total);
          if (ev === 'resumed') console.log(`[streakpause] breadth recovered (${(green / total * 100).toFixed(0)}% of ${total} coins green on the hour, sustained) — entries resumed`);
          else if (!wasPaused && this.risk.s.streakPausedAt != null) console.log(`[streakpause] ${this.risk.s.lossStreak} straight losses — entries paused until market breadth recovers`);
        }
      }
      // Pace keeper: get relaxed cfg once per tick if behind target
      const { cfg: tickCfg } = this.paceCfg(n);
      const candidates = [];
      for (const [mint, v] of views) {
        this.latest.set(mint, v);
        this.latestAt.set(mint, n);
        this.history.record(v, n);
        this._foldScan(v, n);
        this._noteGraduation(mint, v, n);
        this.journal.observe(v);
        try { if (this.scanLab) this.scanLab.observe(v, n); } catch { /* scan scorer — record-only */ }
        try { if (this.bottomWatch) this.bottomWatch.observe(v, n); } catch { /* bottom tracker — record-only */ }
        try { if (this.rangeWatch) this.rangeWatch.observe(v, n); } catch { /* range study — record-only */ }
        this.outcomeSeenAt.set(mint, n); // the trading poll just fed the outcome tracker for this mint
        if (this.positions.some(p => p.mint === mint)) { try { if (this.cfg.scanStamps) this._noteScanHeld(mint); } catch { /* record-only */ } continue; }
        if (tickCfg.churnEnabled) this._updateChurnPins(mint, n);
        // Pop/trend first, exactly as before; churn is an ADDITIONAL detector judged
        // only when the classic pair passed (user 2026-10-14: "we still keep pop tho,
        // this is just adding more signals"). Liftoff likewise, judged only when
        // pop/trend and churn both passed — it reads the same samples for the START
        // of a move (flat base → stepped climb), the grind shape the burst
        // detectors structurally miss (UNTXED/CODE, user 2026-10-14).
        let sig = detect(v, this.history.get(mint), tickCfg, n);
        if (!sig && tickCfg.churnEnabled) sig = detectChurn(v, this.history.get(mint), tickCfg, n);
        if (!sig && tickCfg.liftoffEnabled) sig = detectLiftoff(v, this.history.get(mint), tickCfg, n);
        // Scan evaluation stamps (record-only instrumentation, user order
        // 2026-10-16): the detectors above are pure and silent — a null left
        // no trace of WHICH numbers rejected the coin, so ledger sessions
        // carried empty decisions/setups for everything that never fired.
        // judgeScan re-walks the same legs (the same code the detectors are
        // wrappers over) and the verdicts fold into the session's stamp
        // accumulator. This cannot affect sig — the detect* calls above
        // already decided — and nothing anywhere branches on a stamp.
        try { if (this.cfg.scanStamps) this._foldScanVerdicts(mint, judgeScan(v, this.history.get(mint), tickCfg, n)); } catch { /* stamps are record-only */ }
        if (!sig) {
          // LIQ RE-CHECK (owner order 2026-10-17): a young coin the
          // detectors turned away SOLELY at the eligibility door's
          // liquidity legs gets the deferred re-read like every other
          // lane — the queue keeps fetching it for up to the window
          // even if it falls off the watch lists, and on recovery the
          // detect chain re-judges it exactly as a fresh poll view.
          // (No expire journal: the poll's legacy drop of a non-signal
          // writes no record, and the re-check invents none.)
          const elc = eligibleChecks(v, tickCfg, n);
          if (elc.length && liqFamilyChecks(elc).length === elc.length) {
            this._queueLiqRecheck({
              mint, setup: 'poll', v, n,
              resume: async (fv, checks) => {
                const n2 = this.now();
                this.latest.set(mint, fv); this.latestAt.set(mint, n2); this.history.record(fv, n2);
                if (this.positions.some(p => p.mint === mint)) return;
                if (n2 - (this.lastSignal.get(mint) || 0) < this.cfg.signalCooldownMin * 60000) return;
                const { cfg: pc } = this.paceCfg(n2);
                let s2 = detect(fv, this.history.get(mint), pc, n2);
                if (!s2 && pc.churnEnabled) s2 = detectChurn(fv, this.history.get(mint), pc, n2);
                if (!s2 && pc.liftoffEnabled) s2 = detectLiftoff(fv, this.history.get(mint), pc, n2);
                if (!s2) return;
                this.lastSignal.set(mint, n2);
                s2.liqRechecks = checks;
                await this.onSignal(fv, s2);
              },
              expire: null,
            });
          }
          continue;
        }
        const last = this.lastSignal.get(mint) || 0;
        if (n - last < this.cfg.signalCooldownMin * 60000) continue;
        candidates.push({ v, sig });
      }
      this.stats.pollTicks++; this.stats.lastPollTs = n;
      // fast-pop hygiene: drop stream buffers for mints no longer watched or held
      if (this.streamBuf.size) {
        const keep = new Set([...this.watch.keys(), ...this.positions.map(p => p.mint)]);
        for (const [m, buf] of this.streamBuf) if (!keep.has(m) && (!buf.length || n - buf[buf.length - 1].ts > 600000)) { this.streamBuf.delete(m); this.fastEvalAt.delete(m); }
      }
      // post-exit observer: feed the tracker the prices this poll already fetched (no extra calls)
      try { this.postExit.tick(mint => { const v = this.latest.get(mint); return v ? v.price : null; }, n); } catch { /* observer only */ }
      // D1 paired shadow exits: run the virtual exit stack for manually-closed
      // positions on the same views (observer only — can never trade)
      try { this.paired.tick(mint => this.latest.get(mint) || null, n, this.cfg, this.lastSolUsd); } catch { /* observer only */ }
      // Trade-grade shadow: the same already-fetched views mark the virtual
      // positions of gate-passing shadow signals (observer only)
      try { this.shadowTrades.tick(mint => this.latest.get(mint) || null, n, this.cfg, this.lastSolUsd); this._syncShadowStats(); } catch { /* observer only */ }
      // Confluence Shadow Signal: the same already-fetched views mark its
      // virtual pairs (observer only — can never trade)
      try { if (this.confluenceSignal) this.confluenceSignal.tick(mint => this.latest.get(mint) || null, n, this.cfg, this.lastSolUsd); } catch { /* observer only */ }
      // Outcome observer (2026-10-14, record-only): price the mints with
      // outcome tracking in flight that the trading poll did NOT just cover,
      // so checkpoints stop depending on watchlist residence.
      try { await this.outcomeTick(n); } catch { /* observer only */ }
      try { await this._flowRetryTick(n); } catch { /* record-only retry */ }
      try { await this._staircaseRetryTick(n); } catch { /* staircase retry */ }
      try { await this._rangeRetryTick(n); } catch { /* range-live retry */ } try { await this._bottomRetryTick(n); } catch { /* bottom-live retry */ } try { await this._preEntryTick(n); } catch { /* pre-entry census */ } try { await this._rangeDipTick(n); } catch { /* range dip watch */ }
      try { await this._walletRetryTick(n); } catch { /* wallet-live retry */ }
      try { await this._liqRecheckTick(n); } catch { /* liq re-check */ }
      try { await this.walletWatch.finalizeTick(n); } catch { /* shadow outcomes */ }
      try { await this.calloutLab.tick(n); } catch { /* shadow callouts */ }
      try { await this.flowExits.tick(n); } catch { /* shadow flow exits */ }
      try { await this.structureWatch.tick(n); } catch { /* shadow structure watch */ }
      try { await this.bottomWatch.tick(n); } catch { /* shadow bottom tracker */ }
      try { await this.rangeWatch.tick(n); } catch { /* shadow range study */ }
      try { this._scanSweep(n); } catch { /* scan ledger */ }
      candidates.sort((a, b) => b.sig.strength - a.sig.strength);
      for (const c of candidates.slice(0, this.cfg.maxSignalsPerTick)) {
        this.lastSignal.set(c.v.address, this.now());
        if (c.sig.setup === 'churn') { this.stats.churn = this.stats.churn || { fires: 0 }; this.stats.churn.fires++; }
        if (c.sig.setup === 'liftoff') { this.stats.liftoff = this.stats.liftoff || { fires: 0 }; this.stats.liftoff.fires++; }
        await this.onSignal(c.v, c.sig).catch(e => this.err('onSignal', e));
      }
    } catch (e) { this.err('poll', e); } finally { this.busy.poll = false; this.saveStats(); }
  }

  // Signal fields (record-only, 2026-10-14): sampled-history context for the
  // signal record — holder growth, curve fill speed, buy velocity — computed
  // by src/signalFields.js from the coin's own samples + this process's
  // RugCheck holder reads. Fail-silent: an error yields null and the record
  // simply omits the block; nothing anywhere branches on these values.
  _signalFields(v, metrics = null) {
    let f = null;
    // Dead-entry study stamp: the signal's own 5m volume USD as detection
    // judged it rides in the signal metrics (classic pop: the view figure;
    // fast pop: the stream figure converted to USD at fire time). One
    // fast-pop wart to guard: when that SOL/USD conversion failed, metrics
    // still carries the raw stream SOL number — a SOL figure must never be
    // stamped as USD volume, so it reads as unknown and the view's figure
    // (or null) stands instead. Record-only either way.
    let mVol = null;
    if (metrics && Number.isFinite(metrics.volM5)) {
      mVol = metrics.volM5;
      if (metrics.fastStream && Number.isFinite(metrics.streamVolSol) && mVol === metrics.streamVolSol) mVol = null;
    }
    try { f = computeSignalFields({ samples: this.history.get(v.address), view: v, holders: holderSamples(v.address), now: this.now(), veto: { distPct: this.cfg.peakVetoDistPct, ageSec: this.cfg.peakVetoAgeSec }, volM5: mVol }); }
    catch { f = null; }
    // Peak-veto shadow counters (record-only): one count per journaled signal —
    // stamped when the samples supported the peak stamps, unstamped when they
    // didn't, wouldBlock when the shadow verdict would have vetoed. The verdict
    // is never read back for any decision; /state just exposes the tallies.
    this.stats.peakVeto = this.stats.peakVeto || { stamped: 0, wouldBlock: 0, unstamped: 0 };
    if (f && f.distFromPeakPct != null) {
      this.stats.peakVeto.stamped++;
      if (f.peakVeto && f.peakVeto.wouldBlock) this.stats.peakVeto.wouldBlock++;
    } else this.stats.peakVeto.unstamped++;
    // Chg1m shadow counters (record-only, owner order 2026-10-16): the same
    // one-count-per-journaled-signal discipline as the peak-veto tallies —
    // the falling-minute verdict computed in signalFields is tallied here
    // and NEVER read back for any decision; /state exposes the running
    // score of the shadow test while it earns (or loses) its case.
    this.stats.shadowChg1m = this.stats.shadowChg1m || { wouldBlock: 0, pass: 0, unknown: 0 };
    if (f && f.chg1mShadow === 'would-block') this.stats.shadowChg1m.wouldBlock++;
    else if (f && f.chg1mShadow === 'pass') this.stats.shadowChg1m.pass++;
    else this.stats.shadowChg1m.unknown++;
    return f;
  }

  // Holder-count sampling, second source (record-only, 2026-10-14): a Helius
  // DAS token-account count (gate.js fetchHolderCount, wired as a dep) rides
  // alongside every RugCheck fetch that feeds the holder series — gate eval,
  // shadow gate record, manual-exit snapshot — so mints RugCheck has no
  // report for still accumulate holder samples and holderGrowth can fill.
  // The result is NEVER read: no gate, skip, or buy branches on it, and the
  // helper resolves null on knob-off, missing dep, or any DAS failure, so a
  // dark DAS leaves behavior byte-identical to the RugCheck-only path.
  async _dasHolderSample(mint) {
    try {
      if (!this.cfg.holderDas || !this.d.fetchHolderCount) return null;
      return await this.d.fetchHolderCount(mint);
    } catch { return null; }
  }

  skip(v, sig, reasons, warnings = [], gates = null, gatePass = null, shadowGates = null, shadowGatePass = null) {
    this.journal.signal({ mint: v.address, symbol: v.symbol, setup: sig.setup, decision: 'skipped', reasons, price: v.price, mc: v.mc, metrics: sig.metrics, warnings, label: sig.label || null, gates, gatePass, fields: this._fieldsFor(v, sig), shadowGates, shadowGatePass, liqRechecks: sig.liqRechecks ?? null });
  }

  // Setups currently in shadow-only mode (user 2026-10-14, forward plan step 1b):
  // the detector still fires and the signal is journaled + outcome-tracked, but it
  // never reaches the gate/risk/buy machinery and never touches the position slot.
  // TREND went LIVE by owner order 2026-10-16 ("make them all go live"):
  // cfg.trendLive (TREND_LIVE, default on) decides — off is the kill switch and
  // restores shadow routing. trendShadow is consulted only when a hand-built
  // cfg carries no trendLive at all (the pre-flip unit rigs), so their pinned
  // behavior is byte-identical. Liftoff keeps its own shadow knob, untouched.
  shadowedSetup(setup) {
    const trendShadowed = this.cfg.trendLive == null ? !!this.cfg.trendShadow : !this.cfg.trendLive;
    return (setup === 'trend' && trendShadowed) || (setup === 'liftoff' && !!this.cfg.liftoffShadow);
  }

  shadow(v, sig, gates = null, gatePass = null) {
    this.stats.shadowSignals = this.stats.shadowSignals || {};
    this.stats.shadowSignals[sig.setup] = (this.stats.shadowSignals[sig.setup] || 0) + 1;
    const sigId = this.journal.signal({ mint: v.address, symbol: v.symbol, setup: sig.setup, decision: 'shadow', reasons: [sig.shadowReason || `shadow: ${sig.setup} is shadow-only — logged + outcome-tracked, no buy`], price: v.price, mc: v.mc, metrics: sig.metrics, warnings: [], label: sig.label || null, gates, gatePass, fields: this._fieldsFor(v, sig), liqRechecks: sig.liqRechecks ?? null });
    // Trade-grade shadow (record-only, user 2026-10-14): a shadow signal that
    // PASSED its gate evaluation opens a VIRTUAL position at the signal
    // price, managed by the real exit stack (src/shadowTrades.js) — the
    // signal record and flow above stay byte-identical; this only registers
    // the tracker. Gate-failed shadow signals open nothing.
    if (gatePass === true) {
      try {
        if (this.shadowTrades.open({ id: sigId, mint: v.address, symbol: v.symbol, setup: sig.setup, price: v.price, mc: v.mc, ts: this.now(), sizeSol: this.cfg.tradeSol, volH1: v.volH1 || 0 })) {
          this._syncShadowStats();
          // stream judge (record-only): the virtual's entry price in SOL/token,
          // captured at open from the same SOL/USD the bot just saw — the stream
          // judge measures its move off this, never off a later rate.
          const st = this._shadowStreamStateFor(sigId);
          st.mint = v.address;
          st.entryPriceSol = this.lastSolUsd > 0 ? v.price / this.lastSolUsd : null;
        }
      } catch { /* observer only — never disturb the signal path */ }
    }
  }

  // Fast-bonder measurement (owner order 2026-10-16): the mint's bonding-
  // curve lifespan in seconds via the optional fetchCurveLife dep (wired in
  // index.js; absent in unit rigs → null = unknown = fail open, exactly like
  // the ran-rebuy lookup). Cached per mint: a MEASURED lifespan can never
  // change (graduation is one-way), so it is kept forever; an UNKNOWN read
  // (non-graduated, fetch failure, missing stamps) is negatively cached for
  // 60s only, so repeat signals on one mint can't turn the seam into a
  // DexScreener hammer, yet a coin that graduates a minute later still gets
  // measured on its next signal. Never throws.
  _birthStats() { const s = this.stats.birthMemory || (this.stats.birthMemory = {}); s.blocked = s.blocked || 0; s.written = s.written || 0; s.known = s.known || 0; return s; }

  _baseStats() { const s = this.stats.baseMode || (this.stats.baseMode = { enrolled: 0, bySetup: {}, dipWatches: 0, dipEntries: 0, structureStops: 0, pulseSkips: { total: 0, bySetup: {} }, rangeUnenrolled: 0 }); if (!s.bySetup) s.bySetup = {}; if (!s.pulseSkips) s.pulseSkips = { total: 0, bySetup: {} }; if (!s.pulseSkips.bySetup) s.pulseSkips.bySetup = {}; return s; }

  // PULSE FLOOR (owner decision 2026-10-16 23:16 EDT): a base-shape
  // entry needs a LIVE TAPE at eval time — the fresh view's volM5 at or
  // above BASE_MIN_VOL_M5. Under the floor (or unmeasurable: a base
  // with no measurable pulse is dead by definition here) the eval
  // journal-skips with the pulse reason and tallies, and the caller
  // stops. Returns true when the candidate was pulse-skipped. Callers
  // gate on cfg.baseMode — BASE_MODE=0 leaves every path untouched.
  _basePulseSkip(v, sig) {
    // Staircase evals judge against their own floor (owner order
    // 2026-10-18: BASE_STAIRCASE_MIN_VOL_M5, default 0 = exempt — the
    // mark's structure is its aliveness proof); every other base shape
    // uses the shared floor.
    const floor = sig && sig.setup === 'staircase' ? this.cfg.baseStaircaseMinVolM5 : this.cfg.baseMinVolM5;
    if (!(floor > 0)) return false;
    const vol = v && Number.isFinite(v.volM5) ? v.volM5 : null;
    if (vol != null && vol >= floor) return false;
    const bm = this._baseStats();
    bm.pulseSkips.total++;
    bm.pulseSkips.bySetup[sig.setup] = (bm.pulseSkips.bySetup[sig.setup] || 0) + 1;
    const reason = vol == null
      ? `base pulse: volM5 unknown under the ${fmtUsd(floor)} floor — dead base`
      : `base pulse: volM5 ${fmtUsd(vol)} under the ${fmtUsd(floor)} floor — dead base`;
    this.skip(v, sig, [reason], [], {});
    console.log(`[basemode] ${v.symbol} (${sig.setup}): ${reason}`);
    return true;
  }

  // ENROLLMENT (owner decision 2026-10-16 23:16 EDT): is this mint
  // currently NOMINATED — a live signal demoted into an enrollment for
  // it inside ENROLL_TTL_H? The demotion block writes the map live;
  // _restoreBaseEnrollments re-arms it at boot from the journal.
  _baseEnrolled(mint, n) {
    const e = this.baseEnrolled && this.baseEnrolled.get(mint);
    if (!e) return false;
    const ttlH = this.cfg.enrollTtlH > 0 ? this.cfg.enrollTtlH : 24;
    return n - e.ts <= ttlH * 3600000;
  }

  // Boot restore: enrollment records are journal facts (decision
  // 'skipped', fields.enrolledBy) — fold the ones inside the TTL back
  // into the live map, the _backfillBirthVerdicts discipline. A
  // restart must not un-nominate every coin the signals pointed at.
  _restoreBaseEnrollments() {
    let restored = 0;
    try {
      const ttlH = this.cfg.enrollTtlH > 0 ? this.cfg.enrollTtlH : 24;
      const n = this.now();
      for (const rec of (this.journal && this.journal.signals) || []) {
        if (!rec || !rec.mint || !rec.ts) continue;
        const by = rec.fields && rec.fields.enrolledBy;
        if (!by) continue;
        if (n - rec.ts > ttlH * 3600000) continue;
        const cur = this.baseEnrolled.get(rec.mint);
        if (!cur || rec.ts > cur.ts) { this.baseEnrolled.set(rec.mint, { setup: by, ts: rec.ts }); restored++; }
      }
    } catch { /* best effort — live demotions re-arm enrollments as they fire */ }
    if (restored) console.log(`[basemode] boot restore: ${restored} enrollment(s) recovered from journal history`);
  }

  // Signal-record fields for a journaled signal: the computed
  // _signalFields block plus the BASE MODE stamps the signal object
  // itself carries (enrollment provenance, a deferred-dip provenance,
  // the base-entry TP1 stamp). A signal carrying none of them gets the
  // computed block back untouched — records byte-identical to before.
  _fieldsFor(v, sig) {
    const f = this._signalFields(v, sig && sig.metrics);
    if (!sig || (!sig.enrolledBy && !sig.deferredDip && !sig.baseTp1)) return f;
    const out = { ...(f || {}) };
    if (sig.enrolledBy) out.enrolledBy = sig.enrolledBy;
    if (sig.deferredDip) out.deferredDip = true;
    if (sig.baseTp1) out.baseTp1 = true;
    return out;
  }

  // Birth-verdict memory (owner order 2026-10-16, the FMR hole — see gate.js
  // birthMemoryVerdict for the incident): _absorbBirthVerdict is the single
  // door into the memory. The FIRST establishment of a verdict is its
  // provenance: a mint already known keeps its original kind/evidence/
  // firstSeenTs, and later re-fires (or a later-stamped backfill row) never
  // move it; an earlier-stamped row from the boot backfill replaces a
  // later one, because the earlier stamp is when the truth was actually
  // established. Only DISQUALIFYING verdicts are absorbed — a passing
  // measurement is never stored (the curve-life cache keeps passes).
  _absorbBirthVerdict(rec) {
    if (!rec || !rec.mint || !rec.kind) return false;
    const cur = this.birthVerdicts.get(rec.mint);
    if (cur && cur.firstSeenTs <= rec.firstSeenTs) return false;
    this.birthVerdicts.set(rec.mint, { mint: rec.mint, kind: rec.kind, evidence: String(rec.evidence || ''), firstSeenTs: Number(rec.firstSeenTs) || this.now() });
    this.saveBirthVerdicts();
    return true;
  }

  _recordBirthVerdict(mint, kind, evidence) {
    if (this._absorbBirthVerdict({ mint, kind, evidence, firstSeenTs: this.now() })) {
      const bs = this._birthStats(); bs.written++; bs.known = this.birthVerdicts.size;
      console.log(`[birthmemory] verdict recorded: ${String(mint).slice(0, 8)}… (${kind}: ${evidence})`);
    }
  }

  // Write tap for the gate stack: an instantGrad bought-out fire is
  // established the moment ANY runGates consumer sees it — the live
  // onSignal path AND shadowGateRecord (shadow evaluations, walletWatch
  // records, risk-preempted records) both call this, because knowledge is
  // knowledge wherever it was measured. Writing is always-on bookkeeping,
  // deliberately independent of the FAST_BOND_BLOCK enforcement switch:
  // the memory keeps accruing while enforcement is off, ready for the
  // moment it is switched back on. Never throws into the signal path.
  _noteInstantGradVerdict(mint, g) {
    try {
      const ig = g && g.checks && g.checks.instantGrad;
      if (ig && ig.pass === false && ig.reason) this._recordBirthVerdict(mint, 'instantGrad', ig.reason);
    } catch { /* bookkeeping only — never disturb the signal path */ }
  }

  // Boot backfill: the journal's own signal records carry the gate stamps
  // of every past evaluation — an instantGrad fire or a fastBond block
  // journaled before this fix existed is still knowledge, and FMR's trend
  // skip sat in exactly that form while its pop re-evaluation forgot.
  // Folds the summarized stamps from gates AND shadowGates (live skips and
  // shadow evaluations alike); the record's own ts is the verdict's
  // firstSeenTs. Best-effort: if anything here fails, the live write taps
  // still protect every verdict established from now on.
  _backfillBirthVerdicts() {
    let added = 0;
    try {
      for (const rec of (this.journal && this.journal.signals) || []) {
        if (!rec || !rec.mint || !rec.ts) continue;
        for (const src of [rec.gates, rec.shadowGates]) {
          if (!src) continue;
          const ig = src.instantGrad;
          if (ig && ig.pass === false && ig.reason && this._absorbBirthVerdict({ mint: rec.mint, kind: 'instantGrad', evidence: ig.reason, firstSeenTs: rec.ts })) added++;
          const fb = src.fastBond;
          if (fb && fb.pass === false && fb.reason && this._absorbBirthVerdict({ mint: rec.mint, kind: 'fastBond', evidence: fb.reason, firstSeenTs: rec.ts })) added++;
        }
      }
    } catch { /* best effort — see note above */ }
    if (added) console.log(`[birthmemory] boot backfill: ${added} verdict(s) recovered from journal history (${this.birthVerdicts.size} mint(s) known)`);
  }

  async _curveLifeSec(mint) {
    const hit = this.curveLifeCache.get(mint);
    if (hit && (hit.lifeSec != null || this.now() - hit.ts < 60000)) return hit.lifeSec;
    let lifeSec = null;
    if (this.d.fetchCurveLife) { try { lifeSec = await this.d.fetchCurveLife(mint); } catch { lifeSec = null; } }
    if (!(Number.isFinite(lifeSec) && lifeSec >= 0)) lifeSec = null;
    this.curveLifeCache.set(mint, { lifeSec, ts: this.now() });
    return lifeSec;
  }

  // Ran-rebuy verdict (user 2026-10-15): the already-ran rebuy check from
  // gate.js, reached through the optional ranRebuyCheck dep (wired in
  // index.js; absent in unit rigs → no verdict and the gate simply doesn't
  // run). Only mints with a prior closed trade are judged at all — a mint the
  // bot never traded returns null here (no stamp, no candle lookup spent).
  // Never throws: a dep error reads as a failed lookup, which the check
  // treats as fail-open. Returns the verdict object or null.
  async _ranRebuyVerdict(v, n) {
    if (!this.cfg.ranRebuy || !this.d.ranRebuyCheck) return null;
    const prior = this.lastTrades ? this.lastTrades.get(v.address) : null;
    if (!prior) return null;
    try {
      return await this.d.ranRebuyCheck(prior, { mult: this.cfg.ranRebuyMult, hours: this.cfg.ranRebuyHours, now: n });
    } catch {
      return { pass: true, lookupFailed: true, peakRatio: null, blockedUntil: null, priorCloseTs: prior.closeTs, reason: 'ran-peak lookup failed — passed open (fail-open)' };
    }
  }

  // D1 (record-only): for a shadow signal, evaluate the same pre-checks and gate
  // stack a live signal would face — purely so the shadow RECORD carries the
  // per-gate results. The outcome is never branched on: the caller journals
  // decision 'shadow' regardless, and no risk/round-trip/buy step runs here.
  // Fail-silent: any error yields a null gate record, never a behavior change.
  async shadowGateRecord(v, sig, n) {
    try {
      const checks = {};
      if (!(sig.metrics && sig.metrics.fastStream)) {
        const ex = extensionCheck(this.history.get(v.address), v.price, n, { maxExt: this.cfg.extMaxFromBase });
        checks.extension = { pass: !!ex.pass, reason: ex.reason || null };
        const fc = freshHistoryCheck(this.history.get(v.address), v, n, { maxChgM5: this.cfg.freshMaxChgM5, smallMc: this.cfg.freshSmallMc, m5ShareH1: this.cfg.freshM5ShareH1, bypassMinVolM5: this.cfg.freshBypassMinVolM5, bypassMinBuyRatio: this.cfg.freshBypassMinBuyRatio, bypassMaxBuyRatio: this.cfg.maxBuyRatioM5 > 0 ? this.cfg.maxBuyRatioM5 : 0.85 });
        checks.fresh = { pass: !!fc.pass, reason: fc.reason || null };
        if (fc.bypass) checks.fresh.bypassed = true;
        if (sig.setup === 'pop' || sig.setup === 'trend' || sig.setup === 'liftoff') {
          const sd = shallowDipCheck(this.history.get(v.address), v.price, n, { maxPct: this.cfg.shallowDipMaxPct, windowMin: this.cfg.shallowDipWindowMin });
          checks.shallowDip = { pass: !!sd.pass, reason: sd.reason || null };
        }
      }
      // Flow snapshot verdict for the record (user 2026-10-15): the same
      // collapse check the live flow path runs — journaled here so records
      // written before the live check is reached (shadow, risk-preempted)
      // carry it too. Record-only in this path, never branched on.
      if (sig.setup === 'flow') {
        const fs = flowSnapshotCheck(v, { minChgM5: this.cfg.flowSnapshotMinChgM5 });
        checks.flowSnapshot = { pass: !!fs.pass, reason: `flow snapshot: ${fs.reason}` };
      }
      // Ran-rebuy verdict for the record (user 2026-10-15): the same
      // already-ran check the gate path runs — journaled here so shadow
      // records and the scans.jsonl verdicts (walletWatch's shadowGates dep
      // lands here) carry it too. Record-only, never branched on; the peak
      // measurement is cached 5 min per mint, so a mint the live path just
      // judged costs no second lookup.
      const rrRec = await this._ranRebuyVerdict(v, n);
      if (rrRec) checks.ranRebuy = { pass: !!rrRec.pass, reason: rrRec.reason || null, peakRatio: rrRec.peakRatio ?? null, blockedUntil: rrRec.blockedUntil ?? null };
      const [rug, curve] = await Promise.all([
        this.d.fetchRug(v.address).catch(() => null),
        this.d.fetchCurve ? this.d.fetchCurve(v.address).catch(() => null) : null,
        this._dasHolderSample(v.address),
      ]);
      const { cfg: gateCfg } = this.paceCfg(n);
      const g = runGates({ view: v, rug, curve, cfg: gateCfg, now: n });
      Object.assign(checks, summarizeGateChecks(g.checks) || {});
      // Birth-verdict write tap (owner order 2026-10-16): a shadow
      // evaluation that establishes a bought-out birth remembers it too —
      // knowledge is knowledge, wherever it was measured (see onSignal).
      this._noteInstantGradVerdict(v.address, g);
      return { gates: checks, gatePass: g.pass };
    } catch { return { gates: null, gatePass: null }; }
  }

  // ------------------------------------------------------------ churn basing watch
  // A coin that dumped ≥ churnMinDropPct from its sampled peak gets pinned in the
  // watchlist for churnWatchH hours past the normal TTL, so its basing phase stays
  // sampled (a dumped coin otherwise falls off discovery within ~20 minutes and the
  // churn detector never sees the base form). Capped, oldest pin evicted first.
  _updateChurnPins(mint, n) {
    const a = this.history.get(mint);
    if (a.length >= 2) {
      let peak = 0, low = Infinity;
      for (const s of a) { if (s.price > peak) peak = s.price; if (s.price < low) low = s.price; }
      if (peak > 0 && low > 0 && (peak - low) / peak * 100 >= this.cfg.churnMinDropPct) {
        const existing = this.churnPins.get(mint);
        this.churnPins.set(mint, { at: existing ? existing.at : n, until: n + this.cfg.churnWatchH * 3600000 });
      }
    }
    if (this.churnPins.size > this.cfg.churnWatchMax) {
      const sorted = [...this.churnPins.entries()].sort((x, y) => x[1].at - y[1].at);
      for (const [m] of sorted.slice(0, this.churnPins.size - this.cfg.churnWatchMax)) this.churnPins.delete(m);
    }
  }

  churnPinned(mint, n) {
    const p = this.churnPins.get(mint);
    if (!p) return false;
    if (n > p.until) { this.churnPins.delete(mint); return false; }
    return true;
  }

  // ------------------------------------------------------------ graduation handoff
  // A coin already on the watchlist that GRADUATES mid-watch gets a fresh full TTL
  // from the graduation moment (user 2026-10-14). Without this, a coin that sat
  // quiet on the curve for most of WATCH_TTL_MIN flips to PumpSwap just as its
  // watch entry expires — the post-graduation run (Plois: +41% in the 5m right
  // after the flip) happens with the bot no longer sampling it. The flip signal is
  // the view's dex: 'pumpfun' (bonding curve) on one poll, any AMM dex on a later
  // poll. selectView's live-AMM preference makes the flip visible as soon as the
  // PumpSwap pair prints trades. One-shot per mint: once flipped, the mint leaves
  // curveSeen and normal TTL/discovery rules govern it from the refreshed entry.
  _noteGraduation(mint, v, n) {
    if (!v || !v.dex) return;
    if (v.dex === 'pumpfun') { this.curveSeen.add(mint); return; }
    if (!this.curveSeen.delete(mint)) return; // only a mint previously seen on the curve can flip
    const w = this.watch.get(mint);
    if (!w) return;
    this.watch.set(mint, { ...w, ts: n });
    this.stats.gradHandoffs = (this.stats.gradHandoffs || 0) + 1;
    console.log(`[gradwatch] ${v.symbol} graduated (curve → ${v.dex}) — watch TTL refreshed`);
  }

  // ------------------------------------------------------------ smart-wallet flow
  /**
   * Flow live eligibility (user 2026-10-15): with FLOW_LIVE_WALLETS set, only a
   * SOLO trigger fired by one of those wallets may reach the live pipeline —
   * through exactly the same gates/checks as any flow trigger today. Every
   * other trigger (the other solos, size triggers, confluence — even a
   * confluence a live wallet took part in) is journaled as a shadow signal:
   * detected, labelled, outcome-tracked, never bought. Knob unset (null) =
   * legacy: every trigger is live-eligible.
   */
  flowLiveTrigger(agg) {
    // ALL-LIVE flip (owner order 2026-10-16, "make them all go live"): with
    // FLOW_ALL_LIVE on (default), every tracked-wallet trigger is live — the
    // roster below no longer gates routing. FLOW_ALL_LIVE=0 restores the
    // roster behavior exactly (the pre-flip unit rigs, which build cfgs
    // without the knob, read undefined → roster path, byte-identical).
    if (this.cfg.flowAllLive) return true;
    const live = this.cfg.flowLiveWallets;
    if (!live) return true;
    return !!(agg && agg.kind === 'solo' && agg.wallet && live.includes(agg.wallet));
  }

  /**
   * A 'flow' trigger from the FlowWatch poller (tracked smart-wallet buys).
   * Mirrors _evalFastPop: position + per-mint signal-cooldown guards, the shared
   * eligible() tradability floor, then the exact same onSignal pipeline — gates,
   * risk, exits all unchanged. The wallet nominates; it never bypasses.
   */

  // ------------------------------------------------------------ FLOW CONFIRMATION LANE
  // (owner order 2026-10-17, "Go ahead and. Build." — the morning's audits
  // in one line: first catches lose; coins that already fired, stayed
  // liquid, and fire AGAIN win.) While BASE_MODE is on, a live flow fire
  // on a mint with a PRIOR distinct flow event inside the confirmation
  // window, at mc >= FLOW_CONFIRM_MIN_MC with the standard floors passing
  // on this fire's own view, is NOT enrolled for base watch — it routes
  // into the standard live pipeline at exactly FLOW_CONFIRM_SOL, with
  // every gate binding and only the winner/loser/closed mint cooldowns
  // waived (the lane's own re-entry timer + per-mint cap govern instead).
  // First fires and non-qualifying repeats enroll exactly as before.

  /** Identity of one wallet-buy EVENT on a flow agg: the deciding buy's
   *  chain stamp + wallet + size. One buy re-evaluated (overlapping
   *  trigger windows, the no-view retry re-invoking _evalFlow with the
   *  same agg) carries the same key and is ONE fire — the morning audit's
   *  records-vs-fires lesson, enforced here instead of cleaned up later. */
  _laneEventKey(agg) {
    if (!agg || agg.buyTs == null) return null;
    return `${agg.buyTs}|${agg.wallet || ''}|${agg.walletSol ?? ''}`;
  }

  /** Register a flow EVENT in the lane's per-mint registry. Runs at the
   *  TOP of _evalFlow — before the view fetch, before every floor — on
   *  the owner's ruling: a first fire blocked by the $0-liquidity read or
   *  the $5K min-MC floor STILL counts as the coin's first fire ("a coin
   *  that fired at $3K and fires again at $60K is exactly the shape").
   *  Bookkeeping only: registration never changes any evaluation. */
  _laneRecordFire(mint, agg, n) {
    try {
      const st = this.flowConfirmState;
      if (!st || !mint) return;
      const key = this._laneEventKey(agg) || `nots:${n}`;
      const ts = agg && Number.isFinite(agg.buyTs) ? agg.buyTs : n;
      let m = st.mints[mint];
      if (!m) m = st.mints[mint] = { fires: [], anchorTs: 0, windowEntries: 0, entries: 0, lastCloseTs: 0 };
      if (m.fires.some(f => f.k === key)) return; // same event re-evaluated — one fire
      const winMs = (this.cfg.flowConfirmWindowH || 3) * 3600000;
      // Episode anchor: no earlier fire inside the window behind this
      // one → this fire opens a fresh episode (anchor + cap reset).
      if (!m.fires.some(f => f.ts <= ts && ts - f.ts <= winMs)) { m.anchorTs = ts; m.windowEntries = 0; }
      m.fires.push({ k: key, ts });
      m.fires = m.fires.filter(f => ts - f.ts <= 24 * 3600000);
      st.fires++;
      // Housekeeping sweep: dead records (no fires in 48h, never entered,
      // no lane close) leave the registry so the map tracks the live tape.
      for (const [k, mm] of Object.entries(st.mints)) {
        if (k === mint) continue;
        const newest = mm.fires && mm.fires.length ? mm.fires[mm.fires.length - 1].ts : 0;
        if (!(mm.entries > 0) && !(mm.windowEntries > 0) && n - Math.max(newest, mm.lastCloseTs || 0) > 48 * 3600000) delete st.mints[k];
      }
      this.saveFlowConfirm();
    } catch { /* bookkeeping only — never disturb the flow path */ }
  }

  /** Does THIS live flow fire qualify for the lane? Judged in _evalFlow
   *  after the standard guards have passed on this fire's own view (so
   *  the eligible() liq/mc floors already hold for it — the qualifying
   *  fire is judged on its own merits). Returns the would-be entry
   *  ordinal, or null (→ ordinary enrollment). Counts the qualification
   *  either way the pipeline ends — starved-test bookkeeping starts here:
   *  a qualified fire the risk layer later blocks is still a qualified
   *  fire, tallied in blocked{} at the block point. */
  _laneQualify(mint, v, n, agg) {
    const cfg = this.cfg;
    if (!cfg.flowConfirmLive || !cfg.baseMode) return null;
    const st = this.flowConfirmState;
    if (!st || st.disabled) return null;
    const m = st.mints[mint];
    if (!m || !m.fires.length) return null;
    const key = this._laneEventKey(agg);
    const winMs = (cfg.flowConfirmWindowH || 3) * 3600000;
    // A PRIOR distinct event inside the window — however its own
    // evaluation ended (the registry is events, not survivors).
    if (!m.fires.some(f => f.k !== key && f.ts <= n && n - f.ts <= winMs)) return null;
    if ((m.windowEntries || 0) >= (cfg.flowConfirmMaxEntries || 2)) return null; // per-mint cap inside the window
    if (m.lastCloseTs && n - m.lastCloseTs < (cfg.flowConfirmReentryMin || 0) * 60000) return null; // lane re-entry timer
    if (!(v.mc >= (cfg.flowConfirmMinMc || 0))) return null; // the qualifying fire's own mc floor
    st.qualifiedFires++;
    this.saveFlowConfirm();
    return { ordinal: (m.windowEntries || 0) + 1 };
  }

  /** An actual lane entry executed: count it against the mint's window
   *  cap and the lane totals; returns the entry's ordinal. Called once,
   *  at position creation in onSignal. */
  _laneRecordEntry(mint, n) {
    const st = this.flowConfirmState;
    let m = st.mints[mint];
    if (!m) m = st.mints[mint] = { fires: [], anchorTs: n, windowEntries: 0, entries: 0, lastCloseTs: 0 };
    m.windowEntries = (m.windowEntries || 0) + 1;
    m.entries = (m.entries || 0) + 1;
    st.entries++;
    this.saveFlowConfirm();
    return m.windowEntries;
  }

  /** A qualifying lane fire died at the risk layer (slot / halt /
   *  down-stop / other risk): tally it so the lane test's coverage —
   *  and its biases — stay measurable. The skip record itself already
   *  carries the lane marker (metrics.flowConfirm) + the exact reason,
   *  outcome-tracked like every skipped signal; this is only the count.
   *  Blocked fires NEVER count toward the kill-rule sample. */
  _laneBlocked(reason) {
    try {
      const st = this.flowConfirmState;
      if (!st) return;
      const r = String(reason || '');
      const cat = /positions open/.test(r) ? 'slot' : (/HALT file|down-stop|kill switch/.test(r) ? 'halt' : 'risk');
      st.blocked[cat] = (st.blocked[cat] || 0) + 1;
      this.saveFlowConfirm();
    } catch { /* bookkeeping only */ }
  }

  /** A lane position closed (called from ensureClose — the one funnel
   *  every close passes through exactly once): stamp the mint's lane
   *  re-entry timer and, when the close carries a real PnL, feed the
   *  kill-rule sample. At FLOW_CONFIRM_KILL_N closes the check runs
   *  ONCE: a negative mean disables the lane (persisted + journaled as
   *  a flowConfirmDisabled event); a non-negative mean retires the
   *  check and the lane keeps running. Open positions are never
   *  force-closed by the rule. */
  _laneOnClose(pos, rec) {
    try {
      const st = this.flowConfirmState;
      if (!st || !pos || !pos.mint) return;
      let m = st.mints[pos.mint];
      if (!m) m = st.mints[pos.mint] = { fires: [], anchorTs: 0, windowEntries: 0, entries: 0, lastCloseTs: 0 };
      m.lastCloseTs = (rec && rec.ts) || this.now();
      const pnl = rec ? rec.pnlSol : null;
      if (Number.isFinite(pnl)) {
        st.closes++;
        st.pnlSumSol = +(((st.pnlSumSol || 0) + pnl)).toFixed(6);
        const N = this.cfg.flowConfirmKillN || 0;
        if (N > 0 && !st.killChecked && st.closes >= N) {
          st.killChecked = true; // the gate is one-time, win or lose
          const mean = st.pnlSumSol / st.closes;
          if (mean < 0) {
            st.disabled = true;
            st.disabledAt = m.lastCloseTs;
            st.disabledMeanPnlSol = +mean.toFixed(6);
            try { this.journal.flowConfirm({ type: 'flowConfirmDisabled', ts: st.disabledAt, closes: st.closes, meanPnlSol: st.disabledMeanPnlSol, killN: N }); } catch { /* journaling never blocks the close */ }
            console.log(`[flowconfirm] KILL RULE: ${st.closes} lane closes at mean ${st.disabledMeanPnlSol} SOL < 0 — lane disabled (qualifying fires enroll again)`);
          } else {
            console.log(`[flowconfirm] kill-rule check at ${st.closes} closes: mean ${(+mean.toFixed(6))} SOL >= 0 — lane stays live`);
          }
        }
      }
      this.saveFlowConfirm();
    } catch { /* bookkeeping only — never disturb the close */ }
  }

  /** The /state flowConfirm block: lane on/off, the kill-rule state
   *  (including the mean AT disablement, not just the running mean),
   *  coverage tallies and the per-mint entry ledger. */
  _flowConfirmState() {
    const st = this.flowConfirmState || {};
    const closes = st.closes || 0;
    const byMint = {};
    for (const [mint, m] of Object.entries(st.mints || {})) {
      if ((m.entries || 0) > 0) byMint[mint] = { entries: m.entries, windowEntries: m.windowEntries || 0, lastCloseTs: m.lastCloseTs || null };
    }
    return {
      enabled: !!(this.cfg.flowConfirmLive && !st.disabled),
      killSwitch: !!this.cfg.flowConfirmLive,
      disabled: !!st.disabled,
      disabledAt: st.disabledAt ?? null,
      disabledMeanPnlSol: st.disabledMeanPnlSol ?? null,
      killN: this.cfg.flowConfirmKillN,
      killChecked: !!st.killChecked,
      fires: st.fires || 0,
      qualifiedFires: st.qualifiedFires || 0,
      blocked: { slot: 0, halt: 0, risk: 0, ...(st.blocked || {}) },
      entries: st.entries || 0,
      closes,
      meanPnlSol: closes > 0 ? +(((st.pnlSumSol || 0) / closes)).toFixed(6) : null,
      sizeSol: this.cfg.flowConfirmSol,
      minMc: this.cfg.flowConfirmMinMc,
      windowH: this.cfg.flowConfirmWindowH,
      reentryMin: this.cfg.flowConfirmReentryMin,
      maxEntries: this.cfg.flowConfirmMaxEntries,
      byMint,
    };
  }

  async _evalFlow(mint, agg, liqRechecks = 0) {

    const n = this.now();
    this._laneRecordFire(mint, agg, n);
    const views = await this.d.fetchViews([mint]).catch(() => null);
    const v = views && views.get(mint);
    if (!v) { this._queueFlowRetry(mint, agg, n); return; }
    if (this.flowPending) this.flowPending.delete(mint);
    this.latest.set(mint, v); this.latestAt.set(mint, n); this.history.record(v, n);
    this.noteMint(mint, 'flow'); // keep sampling it so classic/churn detectors can judge it too
    const metrics = { wallets: agg.wallets || [], maxSol: agg.maxSol || 0, count: agg.count || 0, kind: agg.kind || null, wallet: agg.wallet || null, walletSol: agg.walletSol != null ? agg.walletSol : null, buyTs: agg.buyTs || null }; // wallet/walletSol/buyTs: the firing wallet's attribution (flow-exit watcher, record-only)
    // User (2026-10-15): a tracked wallet's buy must LAND on the signals feed
    // whether or not the coin passes parameters — the guards below used to
    // swallow triggers whole (no record at all, so the buy was invisible and
    // its impact unmeasurable). Now a blocked trigger still journals a
    // record-only signal (decision 'skipped', the blocker as its reason, the
    // wallet label intact) so it shows on the feed and gets outcome-tracked.
    // What proceeds still faces the exact same pipeline; nothing about buying
    // changes — the gates judge, the record just always exists.
    const blocked = [];
    if (this.positions.some(p => p.mint === mint)) blocked.push('already holding this coin — buy recorded, not re-evaluated');
    else if (n - (this.lastSignal.get(mint) || 0) < this.cfg.signalCooldownMin * 60000) blocked.push(`this coin was already signaled in the last ${this.cfg.signalCooldownMin}m — buy recorded, not re-evaluated`);
    if (!blocked.length) {
      const elc = eligibleChecks(v, this.cfg, n);
      if (elc.length) {
        // LIQ RE-CHECK (owner order 2026-10-17): the eligibility failure
        // is SOLELY the $0/missing liquidity read on a young coin — a
        // broken read, not a decision. Queue the re-check instead of
        // recording the skip: nothing journals, the cooldown is not
        // stamped, and on recovery this eval re-runs whole. On expiry
        // the record-only skip lands once with the original reasons.
        if (liqFamilyChecks(elc).length === elc.length && this._queueLiqRecheck({
          mint, setup: 'flow', v, n,
          resume: (fv, checks) => this._evalFlow(mint, agg, checks),
          expire: (fv, checks) => this._recordFlowOnly(fv, agg, metrics, elc.map(c => c.reason), this.now(), checks),
        })) return;
        blocked.push(...elc.map(c => c.reason));
      }
    }
    if (blocked.length) { this._recordFlowOnly(v, agg, metrics, blocked, n); return; }
    this.lastSignal.set(mint, n);
    this.stats.flow = this.stats.flow || { fires: 0 };
    // Flow shadow-only split (user 2026-10-15): a non-live trigger proceeds to
    // the same onSignal pipeline carrying flowShadowOnly — it journals there
    // as decision 'shadow' (the trend/liftoff treatment) and never buys. The
    // guards above already ran identically for both paths, so a live wallet's
    // trigger faces exactly the checks it always did, cooldown included.
    const live = this.flowLiveTrigger(agg);
    if (live) {
      this.stats.flow.fires++;
      console.log(`[flow] ${v.symbol} fired from wallet flow: ${agg.label}`);
    } else {
      this.stats.flow.shadow = (this.stats.flow.shadow || 0) + 1;
      console.log(`[flow] ${v.symbol} flow trigger is shadow-only (not a live-flow wallet) — logged + outcome-tracked, no buy: ${agg.label}`);
    }

    const sig = { setup: 'flow', strength: agg.maxSol || 0, metrics, label: agg.label || null, flowShadowOnly: !live, shadowReason: live ? null : 'shadow: flow is shadow-only for this wallet — logged + outcome-tracked, no buy', ...(liqRechecks > 0 ? { liqRechecks } : {}) };
    // FLOW CONFIRMATION LANE: a LIVE flow fire that qualifies (prior
    // distinct event in the window, this fire's own mc/liq merits, cap +
    // re-entry timer clear) carries the lane marker into the pipeline —
    // onSignal sizes it at FLOW_CONFIRM_SOL, waives only the mint
    // cooldowns for it, and lets it past the base-mode enrollment. A
    // shadow-only trigger never qualifies: the lane spends real entries,
    // it does not promote shadow wallets.
    if (live && this._laneQualify(mint, v, n, agg)) {
      sig.flowConfirmLane = true;
      metrics.flowConfirm = 1;
      console.log(`[flowconfirm] ${v.symbol} QUALIFIES — repeat flow fire inside the window at mc $${Math.round(v.mc)} — direct lane entry attempt`);
    }
    await this.onSignal(v, sig);

  }

  /** Journal a flow buy that a pipeline guard kept out of evaluation (record-only). */
  _recordFlowOnly(v, agg, metrics, reasons, n, liqRechecks = null) {
    this.stats.flow = this.stats.flow || { fires: 0 };
    // One record-only entry per mint per cooldown window — a wallet dribbling
    // buys into the same coin must not spam the feed.
    this.flowOnlyAt = this.flowOnlyAt || new Map();
    if (n - (this.flowOnlyAt.get(v.address) || 0) < this.cfg.signalCooldownMin * 60000) return;
    this.flowOnlyAt.set(v.address, n);
    this.journal.signal({ mint: v.address, symbol: v.symbol, setup: 'flow', decision: 'skipped', reasons, price: v.price, mc: v.mc, metrics, label: agg.label || null, fields: this._signalFields(v, metrics), liqRechecks });
    this.stats.flow.recordOnly = (this.stats.flow.recordOnly || 0) + 1;
    console.log(`[flow] ${v.symbol} recorded (not evaluated: ${reasons[0]}) — ${agg.label}`);
  }

  /**
   * STAIRCASE-3 LIVE (user order 2026-10-16, "flip it live" — the shadow
   * signal in staircaseSignal.js keeps journaling untouched; this is its
   * live twin). An ordinal>=3 structure mark routes into the exact same
   * onSignal pipeline as every setup — gates, risk, sizing, exits all
   * unchanged — via the same guard shape as _evalFlow: fetch a fresh view,
   * refuse a coin already held or signaled inside the per-mint cooldown,
   * apply the eligible() tradability floor, then let the pipeline judge
   * EVERY metric. Self-guarded on cfg.staircaseLive + ordinal, invoked from
   * the watch's onMark seam for every mark, fail-silent by construction
   * (fire-and-forget with its own catch). A mark whose view is missing is
   * dropped and counted — marks recur on surviving coins, so the next
   * higher low retries naturally. Kill switch: STAIRCASE_LIVE=0.
   */
  _evalStaircase(rec) {
    if (!this.cfg.staircaseLive) return;
    if (!rec || rec.type !== 'mark' || !rec.mint || !(rec.ordinal >= 3)) return;
    const mint = rec.mint;
    (async () => {
      const n = this.now();
      this.stats.staircase = this.stats.staircase || { evals: 0, noView: 0, retries: 0 };
      this.stats.staircase.evals++;
      const views = await this.d.fetchViews([mint]).catch(() => null);
      const v = views && views.get(mint);
      if (!v) {
        // Marks confirm in candle-close clusters — exactly when the process
        // is busiest — and the first live sample proved a single instant
        // fetch unreliable there (28/28 evals no-viewed at fire time while
        // the same call succeeded in sweeps). Queue and retry off-cluster
        // for up to 5 minutes, the _evalFlow discipline.
        this.stats.staircase.noView++;
        this._queueStaircaseRetry(rec, n);
        return;
      }
      await this._evalStaircaseWithView(rec, v, n);
    })().catch(e => this.err('staircaseEval', e));
  }

  /** The judged half of a staircase live eval: a fresh view exists, so run
   *  the guards and route into onSignal. Shared by the fire-time path and
   *  the retry tick. */
  async _evalStaircaseWithView(rec, v, n, liqRechecks = 0) {
    const mint = rec.mint;
    this.latest.set(mint, v); this.latestAt.set(mint, n); this.history.record(v, n);
    if (this.positions.some(p => p.mint === mint)) return; // already holding — the shadow record carries the mark; nothing to decide
    if (n - (this.lastSignal.get(mint) || 0) < this.cfg.signalCooldownMin * 60000) return; // signaled moments ago — the mark's shadow record is the trace; no re-judge spam
    const metrics = { staircase: { ordinal: rec.ordinal, markId: rec.markId || null, watchId: rec.watchId || null, markPrice: rec.price ?? null, lowPrev: rec.lowPrev ?? null, lowNew: rec.lowNew ?? null, seedSource: rec.seedSource || 'signal' } };
    const sig = { setup: 'staircase', strength: rec.ordinal, metrics };
    if (liqRechecks > 0) sig.liqRechecks = liqRechecks;
    // BASE MODE (owner order 2026-10-16): a staircase higher low is one
    // of the three formed-base shapes — while the strategy is on, its
    // entries are born with TP1 pinned at +50% (see onSignal's birth
    // stamps). No structure low: a staircase is a continuation shape,
    // not a range — the structural stop is range/bottom only.
    if (this.cfg.baseMode) sig.baseTp1 = true;
    const elc = eligibleChecks(v, this.cfg, n);
    if (elc.length) {
      // LIQ RE-CHECK (owner order 2026-10-17): a sole $0/missing-liquidity
      // failure on a young coin defers (see _queueLiqRecheck) — the mark's
      // evaluation resumes whole on the healed view; on expiry the skip
      // lands once with the original reasons.
      if (liqFamilyChecks(elc).length === elc.length && this._queueLiqRecheck({
        mint, setup: 'staircase', v, n,
        resume: (fv, checks) => this._evalStaircaseWithView(rec, fv, this.now(), checks),
        expire: (fv, checks) => this.skip(fv, { ...sig, liqRechecks: checks }, elc.map(c => `staircase-live: ${c.reason}`), [], {}),
      })) return;
      this.skip(v, sig, elc.map(c => `staircase-live: ${c.reason}`), [], {}); return;
    }
    // PULSE FLOOR (owner decision 2026-10-16 23:16 EDT): a base-shape
    // entry needs a live tape at eval time — see _basePulseSkip. (No
    // enrollment gate on this path: a confirmed higher-low mark is
    // itself a structure nomination.)
    if (this.cfg.baseMode && this._basePulseSkip(v, sig)) return;
    this.lastSignal.set(mint, n);
    console.log(`[staircase] ${v.symbol}: higher low #${rec.ordinal} — STAIRCASE-3 LIVE eval`);
    await this.onSignal(v, sig);
  }

  /** A staircase mark whose mint had no market view at fire time: queue it
   *  and retry for up to 5 minutes instead of dropping it silently (the
   *  flow path's _queueFlowRetry pattern). A newer mark for the same mint
   *  supersedes the queued record; the retry window stays anchored to the
   *  first queueing. */
  _queueStaircaseRetry(rec, n) {
    this.staircasePending = this.staircasePending || new Map();
    const cur = this.staircasePending.get(rec.mint);
    if (cur) { cur.rec = rec; return; }
    this.staircasePending.set(rec.mint, { rec, firstTs: n, nextAt: n + 20000 });
  }

  async _staircaseRetryTick(n) {
    if (!this.staircasePending || !this.staircasePending.size) return;
    for (const [mint, p] of [...this.staircasePending]) {
      if (n - p.firstTs > 5 * 60000) {
        this.staircasePending.delete(mint);
        this.stats.staircase = this.stats.staircase || { evals: 0, noView: 0, retries: 0 };
        this.stats.staircase.noViewFinal = (this.stats.staircase.noViewFinal || 0) + 1;
        console.log(`[staircase] ${p.rec.symbol || mint}: live eval dropped — no market view within 5m of higher low #${p.rec.ordinal}`);
        continue;
      }
      if (n < p.nextAt) continue;
      p.nextAt = n + 20000;
      this.stats.staircase.retries = (this.stats.staircase.retries || 0) + 1;
      const views = await this.d.fetchViews([mint]).catch(() => null);
      const v = views && views.get(mint);
      if (!v) continue; // still no view — the next tick retries until the window closes
      this.staircasePending.delete(mint);
      await this._evalStaircaseWithView(p.rec, v, n);
    }
  }

  /**
   * RANGE LIVE (owner correction 2026-10-16, minutes after the Range
   * Study shipped as a shadow: "None of this is shadow btw — Real"). A
   * range mark — a tight sideways base that held the full trailing
   * window, the range intact by construction at the mark moment —
   * routes into the exact same onSignal pipeline as every setup:
   * gates, risk, sizing, exits all unchanged. The guard shape mirrors
   * _evalStaircase exactly: fetch a fresh view, refuse a coin already
   * held or signaled inside the per-mint cooldown, apply the eligible()
   * tradability floor (a floor failure journals a skipped 'range'
   * signal), then let the pipeline judge EVERY metric. The study in
   * rangeWatch.js keeps journaling + forward-scoring untouched — this
   * tap is the only bridge, wired as the watch's onMark dep and
   * self-guarded on cfg.rangeLive (default 1, his order), invoked for
   * every mark, fail-silent by construction. A mark whose view is
   * missing queues and retries off-cluster for up to 5 minutes (the
   * _evalFlow/_evalStaircase discipline). The entry is judged at the
   * MARK moment — the eval is anchored to the mark record and the one
   * mark per episode is the only trigger; later expansion never
   * re-judges. Kill switch: RANGE_LIVE=0 (study reverts to pure
   * record-only: marks + scores, zero signal records).
   */
  _evalRange(rec, opts = {}) {
    if (!this.cfg.rangeLive) return;
    if (!rec || rec.type !== 'mark' || !rec.mint) return;
    const mint = rec.mint;
    (async () => {
      const n = this.now();
      this.stats.range = this.stats.range || { evals: 0, noView: 0, retries: 0 };
      this.stats.range.evals++;
      const views = await this.d.fetchViews([mint]).catch(() => null);
      const v = views && views.get(mint);
      if (!v) {
        this.stats.range.noView++;
        this._queueRangeRetry(rec, n);
        return;
      }
      await this._evalRangeWithView(rec, v, n, opts);
    })().catch(e => this.err('rangeEval', e));
  }

  /** The judged half of a range live eval: a fresh view exists, so run
   *  the guards and route into onSignal. Shared by the fire-time path,
   *  the retry tick and the deferred dip watch (opts.deferredDip). */
  async _evalRangeWithView(rec, v, n, opts = {}) {
    const mint = rec.mint;
    this.latest.set(mint, v); this.latestAt.set(mint, n); this.history.record(v, n);
    if (this.positions.some(p => p.mint === mint)) return; // already holding — the study record carries the mark; nothing to decide
    if (n - (this.lastSignal.get(mint) || 0) < this.cfg.signalCooldownMin * 60000) return; // signaled moments ago — the mark's study record is the trace; no re-judge spam
    const metrics = { range: { markId: rec.markId || null, episodeId: rec.episodeId || null, bandPct: rec.bandPct ?? null, tightness: rec.tightness ?? null, durationMin: rec.durationMin ?? null, rangeHi: rec.rangeHi ?? null, rangeLo: rec.rangeLo ?? null, rangeMid: rec.rangeMid ?? null, markMc: rec.markMc ?? null, markPrice: rec.markPrice ?? null } };
    const sig = { setup: 'range', strength: rec.bandPct != null ? Math.max(1, Math.round(100 - rec.bandPct)) : 1, metrics };
    // BASE MODE stamps (owner order 2026-10-16): while the strategy is
    // on, a range entry is born with TP1 pinned at +50% and carries the
    // range's own low for the structural stop. A deferred-dip eval also
    // stamps its provenance — the journal record shows HOW the entry
    // was reached, not just that it was.
    if (opts.deferredDip) sig.deferredDip = true;
    if (opts.liqRechecks > 0) sig.liqRechecks = opts.liqRechecks;
    if (this.cfg.baseMode) {
      sig.baseTp1 = true;
      if (Number.isFinite(rec.rangeLo) && rec.rangeLo > 0) sig.structureLow = rec.rangeLo;
    }
    const elc = eligibleChecks(v, this.cfg, n);
    if (elc.length) {
      // LIQ RE-CHECK (owner order 2026-10-17): a sole $0/missing-liquidity
      // failure on a young coin defers (see _queueLiqRecheck) — the mark's
      // evaluation resumes whole on the healed view; on expiry the skip
      // lands once with the original reasons.
      if (liqFamilyChecks(elc).length === elc.length && this._queueLiqRecheck({
        mint, setup: 'range', v, n,
        resume: (fv, checks) => this._evalRangeWithView(rec, fv, this.now(), { ...opts, liqRechecks: checks }),
        expire: (fv, checks) => this.skip(fv, { ...sig, liqRechecks: checks }, elc.map(c => `range-live: ${c.reason}`), [], {}),
      })) return;
      this.skip(v, sig, elc.map(c => `range-live: ${c.reason}`), [], {}); return;
    }
    // ENROLLMENT + PULSE gates (owner decision 2026-10-16 23:16 EDT,
    // off tonight's range burst — the path bought DEAD coins: entry
    // volM5 stamps of $0 / $17 / $137 / $186 / $524 / $958 against a
    // $22.1K loser-median in his last-50 study). They sit here, with
    // the eligible() floor guards, BEFORE the band test and onSignal —
    // and because the deferred-dip eval runs through this same method,
    // both gates re-judge it too:
    // (1) ENROLLMENT — a range is not a nomination: the entry routes
    // only when a live signal (pop/flow/confluence/trend/devlaunch)
    // was demoted into an enrollment for this mint inside
    // ENROLL_TTL_H. Something with a pulse pointed at the coin first;
    // the base alone never nominates. The study layer is untouched —
    // unenrolled coins still mark and score; only the entry is gated.
    // (2) PULSE FLOOR — the fresh view must carry a live tape
    // (volM5 >= BASE_MIN_VOL_M5, unknown counting as dead).
    // Base-strategy machinery: BASE_MODE=0 leaves the range path
    // exactly as it shipped.
    if (this.cfg.baseMode && !this._baseEnrolled(mint, n)) {
      const bm = this._baseStats();
      bm.rangeUnenrolled = (bm.rangeUnenrolled || 0) + 1;
      this.skip(v, sig, ['range: coin never enrolled by a signal — base alone is not a nomination'], [], {});
      console.log(`[range] ${v.symbol}: range mark not enrolled by any signal — no entry (base alone is not a nomination)`);
      return;
    }
    if (this.cfg.baseMode && this._basePulseSkip(v, sig)) return;
    // BASE STRATEGY range refinement: enter INSIDE the base — the mark's
    // current mc must sit in the LOWER TWO-THIRDS of its band. A mark
    // printing in the top third is the range's own local top: no buy.
    // The episode instead opens a DEFERRED DIP WATCH (one entry attempt
    // per episode, ever): if the sampled mc later dips into the lower
    // two-thirds while the range is still intact, the deferred eval
    // runs then. Judged on the fresh view's mc against the mark's band;
    // an unmeasurable band or mc never blocks (fail-open, the house
    // discipline). Base-strategy machinery: BASE_MODE=0 leaves the
    // range path exactly as it shipped.
    if (this.cfg.baseMode && Number.isFinite(v.mc) && v.mc > 0 && Number.isFinite(rec.rangeHi) && Number.isFinite(rec.rangeLo) && rec.rangeHi >= rec.rangeLo) {
      const frac = rec.rangeHi > rec.rangeLo ? (v.mc - rec.rangeLo) / (rec.rangeHi - rec.rangeLo) : 0; // a zero-width band counts as lower
      if (frac > 2 / 3) {
        if (!opts.deferredDip) this._openRangeDipWatch(rec, n);
        this.skip(v, sig, ['range top-third — watching for the dip'], [], {});
        console.log(`[range] ${v.symbol}: range mark in the top third of its band (${(frac * 100).toFixed(0)}% up) — no buy${opts.deferredDip ? ' (deferred attempt spent)' : ', dip watch open'}`);
        return;
      }
    }
    this.lastSignal.set(mint, n);
    console.log(`[range] ${v.symbol}: range base held ${rec.durationMin}m at a ${rec.bandPct}% band — RANGE LIVE eval${opts.deferredDip ? ' (deferred dip)' : ''}`);
    await this.onSignal(v, sig);
  }

  /** Open the deferred dip watch for a top-third range mark (base
   *  strategy): one per episode, keyed by episodeId so a later episode
   *  on the same mint gets its own watch. The watch's max life is the
   *  episode end + 30 minutes (see _rangeDipTick). */
  _openRangeDipWatch(rec, n) {
    if (!rec.episodeId || this.rangeDipWatch.has(rec.episodeId)) return;
    this.rangeDipWatch.set(rec.episodeId, { rec, mint: rec.mint, openedTs: n, nextAt: n + 60000, endedAt: null });
    this._baseStats().dipWatches++;
  }

  /** Deferred dip watch tick (base strategy): rides the poll loop's
   *  retry seam, each watch re-checked at most every ~60s against the
   *  bot's OWN sampled history (no external fetch for the check — the
   *  entry eval itself fetches its fresh view as always). A watch fires
   *  its ONE deferred entry eval when the mint's latest sampled mc sits
   *  in the lower two-thirds of the mark's band WHILE the rangeWatch
   *  episode (same episodeId) is still intact. An ended episode makes
   *  the watch inert; it is collected 30 minutes after the end was
   *  first seen. RANGE_LIVE=0 retires every watch — the deferred path
   *  is part of the live range path it refines. */
  async _rangeDipTick(n) {
    if (!this.rangeDipWatch || !this.rangeDipWatch.size) return;
    if (!this.cfg.rangeLive) { this.rangeDipWatch.clear(); return; }
    for (const [episodeId, w] of [...this.rangeDipWatch]) {
      if (n < w.nextAt) continue;
      w.nextAt = n + 60000;
      const ep = this.rangeWatch ? this.rangeWatch.episodeFor(w.mint) : null;
      if (!ep || ep.episodeId !== episodeId) {
        if (w.endedAt == null) w.endedAt = n;
        if (n - w.endedAt > 30 * 60000) this.rangeDipWatch.delete(episodeId);
        continue;
      }
      const samples = this.history.get(w.mint);
      const last = samples && samples[samples.length - 1];
      const mc = last && Number.isFinite(last.mc) && last.mc > 0 ? last.mc : null;
      if (mc == null) continue;
      const { rangeHi, rangeLo } = w.rec;
      if (!(Number.isFinite(rangeHi) && Number.isFinite(rangeLo) && rangeHi >= rangeLo)) continue;
      const frac = rangeHi > rangeLo ? (mc - rangeLo) / (rangeHi - rangeLo) : 0;
      if (frac <= 2 / 3) {
        this.rangeDipWatch.delete(episodeId);
        this._baseStats().dipEntries++;
        console.log(`[range] ${w.rec.symbol || w.mint}: dipped to ${(frac * 100).toFixed(0)}% of its base band with the range intact — deferred range entry eval`);
        this._evalRange(w.rec, { deferredDip: true });
      }
    }
  }

  /** A range mark whose mint had no market view at fire time: queue it
   *  and retry for up to 5 minutes instead of dropping it silently (the
   *  _queueStaircaseRetry pattern). A newer mark for the same mint
   *  supersedes the queued record; the retry window stays anchored to
   *  the first queueing. */
  _queueRangeRetry(rec, n) {
    this.rangePending = this.rangePending || new Map();
    const cur = this.rangePending.get(rec.mint);
    if (cur) { cur.rec = rec; return; }
    this.rangePending.set(rec.mint, { rec, firstTs: n, nextAt: n + 20000 });
  }

  async _rangeRetryTick(n) {
    if (!this.rangePending || !this.rangePending.size) return;
    for (const [mint, p] of [...this.rangePending]) {
      if (n - p.firstTs > 5 * 60000) {
        this.rangePending.delete(mint);
        this.stats.range = this.stats.range || { evals: 0, noView: 0, retries: 0 };
        this.stats.range.noViewFinal = (this.stats.range.noViewFinal || 0) + 1;
        console.log(`[range] ${p.rec.symbol || mint}: live eval dropped — no market view within 5m of the range mark`);
        continue;
      }
      if (n < p.nextAt) continue;
      p.nextAt = n + 20000;
      this.stats.range.retries = (this.stats.range.retries || 0) + 1;
      const views = await this.d.fetchViews([mint]).catch(() => null);
      const v = views && views.get(mint);
      if (!v) continue; // still no view — the next tick retries until the window closes
      this.rangePending.delete(mint);
      await this._evalRangeWithView(p.rec, v, n);
    }
  }

  /**
   * BOTTOM LIVE (owner order 2026-10-16, the base strategy's third
   * shape): a QUALIFIED bottom mark — a coin that ran (episode peak mc
   * over the BOTTOM_MIN_PEAK_MC floor), dumped, held a quiet low and
   * printed its first move off it — routes into the exact same
   * onSignal pipeline as every setup, via the same guard shape as
   * _evalRange/_evalStaircase: fetch a fresh view, refuse a coin
   * already held or signaled inside the per-mint cooldown, apply the
   * eligible() tradability floor (a floor failure journals a skipped
   * 'bottom' signal), then let the pipeline judge EVERY metric. DUST
   * marks (qualified !== true) never route — they stay the tracker's
   * dataset, exactly as before. The tracker in bottomWatch.js keeps
   * journaling + forward-scoring untouched; this tap is the only
   * bridge, wired as the watch's onMark dep and self-guarded on
   * cfg.bottomLive (default 1; BOTTOM_LIVE=0 keeps bottoms
   * record-only). A mark whose view is missing queues and retries
   * off-cluster for up to 5 minutes (the sibling discipline). The
   * entry carries the episode's low as its structural low — the base
   * this shape formed on — stamped from the mark record itself.
   * Qualified marks are rare (zero finalized at build time):
   * correctness over eagerness, no backfill, no catch-up fires.
   */
  _evalBottom(rec) {
    if (!this.cfg.bottomLive) return;
    if (!rec || rec.type !== 'mark' || !rec.mint || rec.qualified !== true) return;
    const mint = rec.mint;
    (async () => {
      const n = this.now();
      this.stats.bottom = this.stats.bottom || { evals: 0, noView: 0, retries: 0 };
      this.stats.bottom.evals++;
      const views = await this.d.fetchViews([mint]).catch(() => null);
      const v = views && views.get(mint);
      if (!v) {
        this.stats.bottom.noView++;
        this._queueBottomRetry(rec, n);
        return;
      }
      await this._evalBottomWithView(rec, v, n);
    })().catch(e => this.err('bottomEval', e));
  }

  /** The judged half of a bottom live eval: a fresh view exists, so
   *  run the guards and route into onSignal. Shared by the fire-time
   *  path and the retry tick. */
  async _evalBottomWithView(rec, v, n, liqRechecks = 0) {
    const mint = rec.mint;
    this.latest.set(mint, v); this.latestAt.set(mint, n); this.history.record(v, n);
    if (this.positions.some(p => p.mint === mint)) return; // already holding — the tracker record carries the mark; nothing to decide
    if (n - (this.lastSignal.get(mint) || 0) < this.cfg.signalCooldownMin * 60000) return; // signaled moments ago — the mark's tracker record is the trace; no re-judge spam
    const metrics = { bottom: { markId: rec.markId || null, episodeId: rec.episodeId || null, peakMc: rec.peakMc ?? null, peakPrice: rec.peakPrice ?? null, lowMc: rec.lowMc ?? null, lowPrice: rec.lowPrice ?? null, lowTs: rec.lowTs ?? null, drawdownPct: rec.drawdownPct ?? null, pctOffLow: rec.pctOffLow ?? null, pctOfPeakRecovered: rec.pctOfPeakRecovered ?? null, markPrice: rec.markPrice ?? null } };
    const sig = { setup: 'bottom', strength: rec.pctOffLow != null ? rec.pctOffLow : 1, metrics };
    if (liqRechecks > 0) sig.liqRechecks = liqRechecks;
    // BASE MODE stamps (owner order 2026-10-16): a bottom entry is born
    // with TP1 pinned at +50% and carries the episode low as its
    // structural low — the base it retraces from is the stop.
    if (this.cfg.baseMode) {
      sig.baseTp1 = true;
      if (Number.isFinite(rec.lowMc) && rec.lowMc > 0) sig.structureLow = rec.lowMc;
    }
    const elc = eligibleChecks(v, this.cfg, n);
    if (elc.length) {
      // LIQ RE-CHECK (owner order 2026-10-17): a sole $0/missing-liquidity
      // failure on a young coin defers (see _queueLiqRecheck) — the mark's
      // evaluation resumes whole on the healed view; on expiry the skip
      // lands once with the original reasons.
      if (liqFamilyChecks(elc).length === elc.length && this._queueLiqRecheck({
        mint, setup: 'bottom', v, n,
        resume: (fv, checks) => this._evalBottomWithView(rec, fv, this.now(), checks),
        expire: (fv, checks) => this.skip(fv, { ...sig, liqRechecks: checks }, elc.map(c => `bottom-live: ${c.reason}`), [], {}),
      })) return;
      this.skip(v, sig, elc.map(c => `bottom-live: ${c.reason}`), [], {}); return;
    }
    // PULSE FLOOR (owner decision 2026-10-16 23:16 EDT): a base-shape
    // entry needs a live tape at eval time — see _basePulseSkip. (No
    // enrollment gate on this path: a qualified bottom mark is itself
    // a structure nomination.)
    if (this.cfg.baseMode && this._basePulseSkip(v, sig)) return;
    this.lastSignal.set(mint, n);
    console.log(`[bottom] ${v.symbol}: qualified bottom — low ${rec.drawdownPct}% under a $${Math.round(rec.peakMc || 0)} peak, +${rec.pctOffLow}% off the low — BOTTOM LIVE eval`);
    // PRE-ENTRY CENSUS (owner order 2026-10-18): the buy waits out a
    // short wallet watch first; a clear puppet tape vetoes it live.
    // Fail-open — PREENTRY_CENSUS=0 restores the direct route exactly.
    if (this.cfg.preEntryCensus) { this._startPreEntryWatch(rec, v, sig, n); return; }
    await this.onSignal(v, sig);
  }

  /** Start a pre-entry census watch for a qualified bottom mark that has
   *  passed every other guard. The decision lands in _preEntryTick when
   *  the window closes: veto -> skipped signal journaled with the reason;
   *  pass -> onSignal with the census read stamped on the signal. One
   *  watch per mint; a second mark during a watch is the same decision. */
  _startPreEntryWatch(rec, v, sig, n) {
    const mint = rec.mint;
    this.preEntryWatch = this.preEntryWatch || new Map();
    if (this.preEntryWatch.has(mint)) return;
    this.stats.preEntry = this.stats.preEntry || { watched: 0, vetoed: 0, passed: 0, thin: 0, cancelled: 0 };
    this.stats.preEntry.watched++;
    this.preEntryWatch.set(mint, {
      rec, sig, view: v, startedAt: n, startPrice: v.price || null,
      minPrice: v.price || null, endPrice: v.price || null, lastSampleAt: 0,
      census: newCensus(n), done: false,
    });
    console.log(`[preentry] ${v.symbol || mint}: census watch started (${this.cfg.preEntryWindowSec}s) before the bottom buy`);
    this._syncCensus();
  }

  /** Pre-entry watch lifecycle: sample the price sparsely during the
   *  window; at window close, judge the tape and route. Fail-open on
   *  every error path — a watcher failure routes the ORIGINAL signal
   *  rather than losing the play. */
  async _preEntryTick(n) {
    if (!this.preEntryWatch || !this.preEntryWatch.size) return;
    const windowMs = this.cfg.preEntryWindowSec * 1000;
    for (const [mint, w] of [...this.preEntryWatch]) {
      try {
        if (w.done) { this.preEntryWatch.delete(mint); continue; }
        if (this.positions.some(p => p.mint === mint)) {
          w.done = true; this.preEntryWatch.delete(mint);
          this.stats.preEntry.cancelled++;
          this._syncCensus();
          continue;
        }
        if (n - w.startedAt < windowMs) {
          if (n - w.lastSampleAt >= 20000) {
            w.lastSampleAt = n;
            const views = await this.d.fetchViews([mint]).catch(() => null);
            const fv = views && views.get(mint);
            if (fv && fv.price > 0) {
              if (w.minPrice == null || fv.price < w.minPrice) w.minPrice = fv.price;
              w.endPrice = fv.price;
            }
          }
          continue;
        }
        // Window closed — finalize exactly once.
        w.done = true; this.preEntryWatch.delete(mint);
        this._syncCensus();
        const views = await this.d.fetchViews([mint]).catch(() => null);
        const fv = (views && views.get(mint)) || w.view;
        if (fv && fv.price > 0) {
          if (w.minPrice == null || fv.price < w.minPrice) w.minPrice = fv.price;
          w.endPrice = fv.price;
        }
        const win = censusWindow(w.census, n, Math.max(1, n - w.startedAt) + 1000);
        const res = evaluatePreEntry({ win, startPrice: w.startPrice, minPrice: w.minPrice, endPrice: w.endPrice, cfg: this.cfg });
        const sig = { ...w.sig, metrics: { ...(w.sig.metrics || {}), preEntry: res.read } };
        if (res.why === 'thin') this.stats.preEntry.thin++;
        if (res.veto && this.cfg.preEntryVeto) {
          this.stats.preEntry.vetoed++;
          console.log(`[preentry] ${fv.symbol || mint}: VETOED — ${res.why} (buys ${res.read.buys}/sells ${res.read.sells}, uniq ${res.read.uniqBuyers}, drop ${res.read.dropPct}%)`);
          this.skip(fv, sig, [preEntryReason(res)], [], {});
          continue;
        }
        if (res.veto) sig.metrics.preEntry.wouldVeto = res.why; // veto switch off: stamp the shadow read, buy proceeds
        this.stats.preEntry.passed++;
        console.log(`[preentry] ${fv.symbol || mint}: passed (${res.why}) — routing the bottom buy`);
        await this.onSignal(fv, sig);
      } catch (e) {
        // Fail-open: never let a watcher bug eat a qualified play.
        this.err('preEntryTick', e);
        if (!w.done) {
          w.done = true; this.preEntryWatch.delete(mint);
          try { await this.onSignal(w.view, w.sig); } catch { /* routing has its own guards */ }
        }
      }
    }
  }

  /** A bottom mark whose mint had no market view at fire time: queue it
   *  and retry for up to 5 minutes instead of dropping it silently (the
   *  _queueRangeRetry pattern). A newer mark for the same mint
   *  supersedes the queued record; the retry window stays anchored to
   *  the first queueing. */
  _queueBottomRetry(rec, n) {
    this.bottomPending = this.bottomPending || new Map();
    const cur = this.bottomPending.get(rec.mint);
    if (cur) { cur.rec = rec; return; }
    this.bottomPending.set(rec.mint, { rec, firstTs: n, nextAt: n + 20000 });
  }

  async _bottomRetryTick(n) {
    if (!this.bottomPending || !this.bottomPending.size) return;
    for (const [mint, p] of [...this.bottomPending]) {
      if (n - p.firstTs > 5 * 60000) {
        this.bottomPending.delete(mint);
        this.stats.bottom = this.stats.bottom || { evals: 0, noView: 0, retries: 0 };
        this.stats.bottom.noViewFinal = (this.stats.bottom.noViewFinal || 0) + 1;
        console.log(`[bottom] ${p.rec.symbol || mint}: live eval dropped — no market view within 5m of the bottom mark`);
        continue;
      }
      if (n < p.nextAt) continue;
      p.nextAt = n + 20000;
      this.stats.bottom.retries = (this.stats.bottom.retries || 0) + 1;
      const views = await this.d.fetchViews([mint]).catch(() => null);
      const v = views && views.get(mint);
      if (!v) continue; // still no view — the next tick retries until the window closes
      this.bottomPending.delete(mint);
      await this._evalBottomWithView(p.rec, v, n);
    }
  }

  /**
   * WALLET-EVENT LIVE (owner order 2026-10-16, "make them all go live"): a
   * walletWatch dev-launch or confluence event routes a live entry attempt
   * through the exact same pipeline as every setup — fresh view, already-held
   * and per-mint signal-cooldown guards, the eligible() tradability floor,
   * then onSignal (gates, risk, sizing, exits all unchanged) — via the same
   * guard shape as _evalFlow / _evalStaircase. The detectors stay record-only
   * journalers; this tap is the only bridge, wired as WalletWatch's liveEval
   * dep and self-guarded per kind (DEVLAUNCH_LIVE / CONFLUENCE_LIVE kill
   * switches restore record-only exactly). A guard failure journals the
   * attempt as 'skipped' with its reason; a mint with no obtainable view is
   * retried for up to 5 minutes (the flow/staircase discipline) and then
   * journaled skipped — a buy is never forced on missing data.
   */
  _evalWalletLive(ev) {
    if (!ev || !ev.mint) return;
    let setup = null;
    if (ev.kind === 'dev') { if (!this.cfg.devlaunchLive) return; setup = 'devlaunch'; }
    else if (ev.kind === 'confluence') { if (!this.cfg.confluenceLive) return; setup = 'confluence'; }
    else return;
    const mint = ev.mint;
    (async () => {
      const n = this.now();
      const st = this._walletLiveStats(setup);
      st.evals++;
      const views = await this.d.fetchViews([mint]).catch(() => null);
      const v = views && views.get(mint);
      if (!v) {
        st.noView++;
        this._queueWalletRetry(ev, setup, n);
        return;
      }
      await this._evalWalletLiveWithView(ev, setup, v, n);
    })().catch(e => this.err('walletLiveEval', e));
  }

  _walletLiveStats(setup) {
    this.stats.walletLive = this.stats.walletLive || {
      confluence: { evals: 0, fires: 0, skipped: 0, noView: 0, noViewFinal: 0, retries: 0 },
      devlaunch: { evals: 0, fires: 0, skipped: 0, noView: 0, noViewFinal: 0, retries: 0 },
    };
    return this.stats.walletLive[setup];
  }

  _walletLiveSig(ev, setup) {
    if (setup === 'devlaunch') {
      return {
        setup, strength: ev.buySol || 0,
        metrics: { devlaunch: { eventId: ev.id || null, dev: ev.dev || null, devName: ev.devName || null, sub: ev.sub || null, buySol: ev.buySol ?? null, launchTs: ev.launchTs ?? null } },
        label: `devlaunch: ${ev.devName || ev.dev || 'dev'} ${ev.sub || ''} ${ev.symbol || ''}`.trim(),
      };
    }
    return {
      setup, strength: ev.maxSol || 0,
      metrics: { confluence: { eventId: ev.id || null, clusters: ev.clusters || [], entities: ev.entities || [], names: ev.names || [], maxSol: ev.maxSol ?? null, walletCount: ev.walletCount ?? null } },
      label: `confluence: ${(ev.clusters || []).length} entities (${(ev.names || []).join(', ')})`,
    };
  }

  /** The judged half of a wallet-event live eval: a fresh view exists, so run
   *  the guards and route into onSignal. Shared by the fire-time path and the
   *  retry tick. */
  async _evalWalletLiveWithView(ev, setup, v, n, liqRechecks = 0) {
    const mint = ev.mint;
    this.latest.set(mint, v); this.latestAt.set(mint, n); this.history.record(v, n);
    const st = this._walletLiveStats(setup);
    const sig = this._walletLiveSig(ev, setup);
    if (liqRechecks > 0) sig.liqRechecks = liqRechecks;
    const blocked = [];
    if (this.positions.some(p => p.mint === mint)) blocked.push('already holding this coin — event recorded, not re-evaluated');
    else if (n - (this.lastSignal.get(mint) || 0) < this.cfg.signalCooldownMin * 60000) blocked.push(`this coin was already signaled in the last ${this.cfg.signalCooldownMin}m — event recorded, not re-evaluated`);
    let elc = [];
    if (!blocked.length) { elc = eligibleChecks(v, this.cfg, n); if (elc.length) blocked.push(...elc.map(c => c.reason)); }
    if (blocked.length) {
      // LIQ RE-CHECK (owner order 2026-10-17): the blockers are SOLELY
      // the eligible() $0/missing-liquidity legs on a young coin — a
      // broken read, not a decision. Queue the re-check instead of
      // journaling the skip (the lane's skipped tally, like the signal
      // cooldown, is stamped only by the final verdict — at expiry).
      if (elc.length && blocked.length === elc.length && liqFamilyChecks(elc).length === elc.length && this._queueLiqRecheck({
        mint, setup, v, n,
        resume: (fv, checks) => this._evalWalletLiveWithView(ev, setup, fv, this.now(), checks),
        expire: (fv, checks) => { st.skipped++; this.skip(fv, { ...this._walletLiveSig(ev, setup), liqRechecks: checks }, elc.map(c => `${setup}-live: ${c.reason}`)); },
      })) return;
      st.skipped++;
      this.skip(v, sig, blocked.map(r => `${setup}-live: ${r}`));
      return;
    }
    this.lastSignal.set(mint, n);
    st.fires++;
    console.log(`[${setup}] ${v.symbol} — WALLET-EVENT LIVE eval (${sig.label})`);
    await this.onSignal(v, sig);
  }

  /** A wallet event whose mint had no market view at fire time: queue it and
   *  retry for up to 5 minutes (the _evalFlow/_evalStaircase discipline). A
   *  newer event for the same setup+mint supersedes the queued record; the
   *  retry window stays anchored to the first queueing. Expiry journals the
   *  attempt as skipped — the event is never silently dropped and never
   *  bought blind. */
  _queueWalletRetry(ev, setup, n) {
    this.walletPending = this.walletPending || new Map();
    const key = `${setup}:${ev.mint}`;
    const cur = this.walletPending.get(key);
    if (cur) { cur.ev = ev; return; }
    this.walletPending.set(key, { ev, setup, firstTs: n, nextAt: n + 20000 });
  }

  async _walletRetryTick(n) {
    if (!this.walletPending || !this.walletPending.size) return;
    for (const [key, p] of [...this.walletPending]) {
      if (n - p.firstTs > 5 * 60000) {
        this.walletPending.delete(key);
        const st = this._walletLiveStats(p.setup);
        st.noViewFinal++;
        st.skipped++;
        const v = { address: p.ev.mint, symbol: p.ev.symbol || null, price: p.ev.viewPrice || 0, mc: p.ev.mc ?? null };
        try { this.skip(v, this._walletLiveSig(p.ev, p.setup), [`${p.setup}-live: no market view within 5m of the event — attempt dropped, not bought blind`]); } catch { /* journaling best-effort on the drop path */ }
        console.log(`[${p.setup}] ${p.ev.symbol || p.ev.mint}: live eval dropped — no market view within 5m of the event`);
        continue;
      }
      if (n < p.nextAt) continue;
      p.nextAt = n + 20000;
      this._walletLiveStats(p.setup).retries++;
      const views = await this.d.fetchViews([p.ev.mint]).catch(() => null);
      const v = views && views.get(p.ev.mint);
      if (!v) continue; // still no view — the next tick retries until the window closes
      this.walletPending.delete(key);
      await this._evalWalletLiveWithView(p.ev, p.setup, v, n);
    }
  }

  /** A flow trigger whose mint has no DexScreener view yet (a just-launched coin
   *  often isn't indexed for the first seconds): queue it and retry for up to
   *  5 minutes instead of dropping it silently. If no view ever appears the
   *  mint can't be priced or outcome-tracked, so it is counted and dropped. */
  _queueFlowRetry(mint, agg, n) {
    this.flowPending = this.flowPending || new Map();
    const cur = this.flowPending.get(mint);
    if (cur) { cur.agg = agg; return; }
    this.flowPending.set(mint, { agg, firstTs: n, nextAt: n + 20000 });
  }

  async _flowRetryTick(n) {
    if (!this.flowPending || !this.flowPending.size) return;
    for (const [mint, p] of [...this.flowPending]) {
      if (n - p.firstTs > 5 * 60000) {
        this.flowPending.delete(mint);
        this.stats.flow = this.stats.flow || { fires: 0 };
        this.stats.flow.noViewDropped = (this.stats.flow.noViewDropped || 0) + 1;
        console.log(`[flow] ${String(mint).slice(0, 4)}… dropped — no market view within 5m of the wallet buy`);
        continue;
      }
      if (n < p.nextAt) continue;
      p.nextAt = n + 20000;
      await this._evalFlow(mint, p.agg); // re-queues itself (same entry) if the view is still missing
    }
  }

  // ------------------------------------------------------------ LIQ RE-CHECK
  // (owner order 2026-10-17, "Ship the liquidity fix" — every lane, not
  // just confluence: "A $0 reading on a coin that's seconds old is a
  // broken read, not a decision.") When an entry evaluation of a YOUNG
  // coin (pair age <= LIQ_RECHECK_MAX_AGE_MIN at the read) is about to
  // terminal-skip SOLELY because liquidity read $0/missing — the
  // eligible() 'liq' / 'liqToMc' legs, which a seconds-old curve coin
  // fails on a view artifact (DexScreener prints liq $0 for a pool that
  // exists; the step-6 audit found this read was the FIRST blocker on
  // 46% of never-taken confluence mints) — the skip does NOT happen.
  // The evaluation is queued instead: the view is re-fetched every
  // LIQ_RECHECK_INTERVAL_SEC for up to LIQ_RECHECK_WINDOW_SEC, and the
  // moment liquidity reads real the SAME evaluation resumes through ALL
  // remaining gates exactly as if fresh (insider block, fast-bond,
  // birth-memory, top guard, round-trip sell check all still bind — the
  // re-check bypasses nothing but the broken read). If liquidity is
  // still $0/missing when the window closes, the lane's terminal skip
  // lands ONCE with the original liq reasons.
  // COOLDOWN DISCIPLINE: a queued evaluation journals nothing and never
  // stamps the per-mint signal cooldown — only the final verdict does.
  // A fresh signal for the same mint inside the window is therefore
  // never deduped by the pending re-check: it evaluates normally, and
  // if it stamps the cooldown the queued entry is dropped quietly (the
  // coin got its evaluation). Kill switch LIQ_RECHECK=0: _queueLiqRecheck
  // always declines and every lane falls through to its legacy
  // one-and-done skip, byte-identical.
  _liqStats() {
    this.stats.liqRecheck = this.stats.liqRecheck || { queued: 0, recovered: 0, expired: 0 };
    return this.stats.liqRecheck;
  }

  /** Young enough for a $0 read to be a broken read: pair age at the
   *  read <= the configured ceiling. The view's own createdAt is the age
   *  source every lane already carries; an unmeasurable age is NOT young
   *  (an old coin's $0 print is a real judgment, never deferred).
   *  Negative age is clock skew and reads as just-born, the same
   *  tolerance eligible() applies. */
  _liqYoung(v, n) {
    if (!v || !v.createdAt) return false;
    const ageMin = (n - v.createdAt) / 60000;
    return ageMin >= -1 && ageMin <= (this.cfg.liqRecheckMaxAgeMin ?? 10);
  }

  /**
   * Offer an about-to-skip evaluation to the re-check queue. Callers
   * invoke this ONLY when the evaluation's failures are exclusively
   * liq-family (detect.js liqFamilyChecks) — mixed failures keep their
   * legacy terminal skip. The queue itself applies the two remaining
   * conditions centrally, so no lane can defer a real judgment: the
   * coin must be YOUNG (_liqYoung) and the read must be BROKEN — the
   * view's liq is not a positive number ($0, or missing, which
   * sources.js normalizes to 0). A positive-but-thin liquidity print is
   * a real read: it declines here and the caller's legacy skip stands
   * with the true figure. `resume(freshView, checks)` re-runs the
   * lane's full evaluation on the healed view with the re-check count
   * to stamp; `expire(bestView, checks)` journals the lane's terminal
   * skip with the ORIGINAL liq reasons (null for lanes whose legacy
   * drop is silent — poll/fast-pop). Returns true when queued: the
   * caller must return WITHOUT journaling a skip or stamping the
   * cooldown. A mint already queued for the same setup is never
   * double-queued: the newest evaluation's resume/expire supersede,
   * and the window stays anchored to the first queueing (the sibling
   * retry discipline).
   */
  _queueLiqRecheck({ mint, setup, v, n, resume, expire }) {
    if (!this.cfg.liqRecheck) return false;
    if (!mint || typeof resume !== 'function') return false;
    if (!this._liqYoung(v, n)) return false;
    if (Number(v.liq) > 0) return false; // a real (if thin) read — a judgment, not a glitch
    this.liqPending = this.liqPending || new Map();
    const key = `${setup}:${mint}`;
    const cur = this.liqPending.get(key);
    if (cur) { cur.resume = resume; cur.expire = expire; cur.lastView = v; return true; }
    this.liqPending.set(key, {
      mint, setup, firstTs: n, lastView: v, checks: 0,
      nextAt: n + (this.cfg.liqRecheckIntervalSec ?? 10) * 1000,
      resume, expire,
    });
    this._liqStats().queued++;
    const ageMin = Math.max(0, (n - v.createdAt) / 60000);
    console.log(`[liqrecheck] ${v.symbol || mint} (${setup}): liquidity read $0/missing on a ${ageMin.toFixed(1)}m-old coin — broken read, re-checking for up to ${this.cfg.liqRecheckWindowSec ?? 90}s before the skip stands`);
    return true;
  }

  async _liqRecheckTick(n) {
    if (!this.liqPending || !this.liqPending.size) return;
    if (!this.cfg.liqRecheck) { this.liqPending.clear(); return; }
    const windowMs = (this.cfg.liqRecheckWindowSec ?? 90) * 1000;
    const intervalMs = (this.cfg.liqRecheckIntervalSec ?? 10) * 1000;
    for (const [key, p] of [...this.liqPending]) {
      // The coin was evaluated by a fresh signal while its re-check was
      // pending (the pending read never stamped the cooldown, so the
      // fresh signal ran) — the queue's work is done; drop it quietly.
      if ((this.lastSignal.get(p.mint) || 0) > p.firstTs) { this.liqPending.delete(key); continue; }
      if (n < p.nextAt) continue;
      p.nextAt = n + intervalMs;
      p.checks++;
      const views = await this.d.fetchViews([p.mint]).catch(() => null);
      const v = views && views.get(p.mint);
      if (v) p.lastView = v;
      // Recovered = the READ works again: a view exists and its liq is a
      // positive number. Whether the coin then CLEARS the liquidity
      // floors is a judgment for the resumed evaluation, not the
      // re-check: it re-judges everything fresh and terminal-skips on
      // the true current figures exactly as a first-read evaluation
      // would (and _queueLiqRecheck's broken-read gate stops it
      // re-deferring on a thin-but-real print).
      const healed = !!v && Number(v.liq) > 0;
      if (healed) {
        this.liqPending.delete(key);
        this._liqStats().recovered++;
        console.log(`[liqrecheck] ${v.symbol || p.mint} (${p.setup}): liquidity read real after ${p.checks} re-check(s) — resuming the evaluation`);
        try { await p.resume(v, p.checks); } catch (e) { this.err('liqRecheckResume', e); }
        continue;
      }
      if (n - p.firstTs >= windowMs) {
        this.liqPending.delete(key);
        this._liqStats().expired++;
        console.log(`[liqrecheck] ${p.lastView.symbol || p.mint} (${p.setup}): liquidity still $0/missing after ${p.checks} re-check(s) over ${Math.round((n - p.firstTs) / 1000)}s — the skip stands`);
        if (typeof p.expire === 'function') {
          try { await p.expire(p.lastView, p.checks); } catch (e) { this.err('liqRecheckExpire', e); }
        }
      }
    }
  }

  async onSignal(v, sig) {
    this.stats.signals++;
    const n = this.now();
    // D1 (record-only): per-check results accumulate here as the pipeline runs,
    // so the signal record (skip / shadow / taken) shows EVERY check's verdict,
    // not just the one that stopped it. Never read for any decision.
    const checks = {};
    // User blacklist (per-token): if they've marked this specific mint as bad, skip it
    const blacklistedMints = this.journal.blacklistedMints();
    if (blacklistedMints.has(v.address)) {
      console.log(`[learn] skip: user blacklisted token ${v.symbol} — skipping`);
      checks.userBlacklist = { pass: false, reason: `token "${v.symbol}" marked bad by user` };
      return this.skip(v, sig, [`user-blacklist: token "${v.symbol}" marked bad`], [], checks);
    }
    // User blacklist (setup): configurable via SETUP_BLACKLIST_MIN (0 = off, per-token only)
    const blacklisted = this.cfg.setupBlacklistMin > 0 ? this.journal.blacklistedSetups(this.cfg.setupBlacklistMin) : new Set();
    if (blacklisted.has(sig.setup)) {
      console.log(`[learn] skip: user blacklisted setup "${sig.setup}" — skipping ${v.symbol}`);
      checks.setupBlacklist = { pass: false, reason: `setup "${sig.setup}" marked bad ${10}+ times` };
      return this.skip(v, sig, [`user-blacklist: setup "${sig.setup}" marked bad ${10}+ times`], [], checks);
    }
    // User name block (2026-10-13): any coin whose name contains a blocked word (default "inu")
    // is hard-skipped. Sits before runGates, so no pace boost, mandatory-ape forcing or
    // contested-gate override can let one through.
    const blockedWord = blockedNameWord(v.name, this.cfg.nameBlockWords);
    if (blockedWord) {
      console.log(`[nameblock] skip: "${v.name}" contains blocked word "${blockedWord}"`);
      checks.nameblock = { pass: false, reason: `name "${v.name || v.symbol}" contains blocked word "${blockedWord}"` };
      return this.skip(v, sig, [`nameblock: name "${v.name || v.symbol}" contains blocked word "${blockedWord}"`], [], checks);
    }
    // Ran-rebuy block (user 2026-10-15, "for tonight" — RAN_REBUY lifts it):
    // a mint the bot already traded whose coin already printed >= RAN_REBUY_MULT x
    // that trade's entry price (at any point since the entry, the exit
    // included — BOOT was ridden 2026-10-14 and re-bought the next night after
    // its run was over) cannot be re-bought until RAN_REBUY_HOURS after that
    // trade's close. Mint-exact, anchored on the most recent prior close,
    // judged on GeckoTerminal minute candles vs the journaled entry fill.
    // Sits with the other user-ruling vetoes before runGates, so no pace
    // boost, mandatory-ape forcing or contested-gate override can push a
    // re-run through; the wait's expiry re-allows the rebuy regardless of the
    // run. Fail-open: an unmeasurable peak passes the candidate (counted in
    // stats.ranRebuy).
    {
      const rr = await this._ranRebuyVerdict(v, n);
      if (rr) {
        this.stats.ranRebuy = this.stats.ranRebuy || { blocked: 0, lookupFailed: 0, partialCoverage: 0 };
        if (rr.lookupFailed) this.stats.ranRebuy.lookupFailed++;
        if (rr.partialCoverage) this.stats.ranRebuy.partialCoverage = (this.stats.ranRebuy.partialCoverage || 0) + 1;
        checks.ranRebuy = { pass: !!rr.pass, reason: rr.reason || null, peakRatio: rr.peakRatio ?? null, blockedUntil: rr.blockedUntil ?? null };
        if (!rr.pass) {
          this.stats.ranRebuy.blocked++;
          sig.metrics = sig.metrics || {};
          sig.metrics.ranRebuy = { peakRatio: rr.peakRatio ?? null, priorCloseTs: rr.priorCloseTs ?? null, blockedUntil: rr.blockedUntil ?? null };
          console.log(`[ranrebuy] skip: ${v.symbol} — ${rr.reason}`);
          return this.skip(v, sig, [`ranRebuy: ${rr.reason}`], [], checks);
        }
      }
    }
    // Shadow-only setups (user 2026-10-14, forward plan step 1b): a shadowed setup's
    // signal is journaled with decision 'shadow' — journal.signal registers it for the
    // same r5/r15/r60 outcome tracking every taken/skipped signal gets — and the
    // pipeline stops here as a TRADING matter: no risk check, no buy, no position,
    // stats.entries untouched. User vetoes above (blacklists, name block) still journal
    // as ordinary skips, exactly as before. D1 adds one record-only step: the
    // extension/fresh/shallow-dip checks and the gate stack are evaluated into the
    // record (shadowGateRecord) — their results change nothing.
    if (this.shadowedSetup(sig.setup) || sig.flowShadowOnly) {
      console.log(`[shadow] ${v.symbol} (${sig.setup}) — shadow-only: logged + outcome-tracked, no buy`);
      // D1: the gates are still EVALUATED for the record (shadowGateRecord) —
      // the decision stays 'shadow' whatever they say.
      const sg = await this.shadowGateRecord(v, sig, n);
      return this.shadow(v, sig, sg.gates, sg.gatePass);
    }
    // Extension cap (user 2026-10-13): how far above the trailing-hour sampled low — the base
    // the move broke out from — an entry may sit. OTTO was bought at the ceiling of a long
    // range after a +162%/5m print and stopped 23s later by the range's own chop; at extreme
    // extension, an ordinary retracement toward the base is a full stop-out. Classic entries
    // only (pop + trend), judged on the bot's own samples, fail-open on thin history.
    // Fast-stream pops are EXEMPT: their 90s window IS the breakout measurement — they enter
    // near the launch by construction.
    if (!(sig.metrics && sig.metrics.fastStream)) {
      const ex = extensionCheck(this.history.get(v.address), v.price, n, { maxExt: this.cfg.extMaxFromBase });
      checks.extension = { pass: !!ex.pass, reason: ex.reason || null };
      if (!ex.pass) {
        console.log(`[extension] skip: ${v.symbol} — ${ex.reason}`);
        return this.skip(v, sig, [`extension: ${ex.reason}`], [], checks);
      }
    }
    // Fresh-history fail-closed (user 2026-10-13, entry-fixes A3): a coin discovered mid-run
    // (trending/movers lists) with too little sampled history for the guards above to judge
    // gets judged on DexScreener's aggregates instead of waved through — BORING arrived with
    // no samples at +41.6% in 5m on a $14.5k cap and the sample guard passed it by default.
    // Fast-stream pops exempt (the stream IS the history).
    if (!(sig.metrics && sig.metrics.fastStream)) {
      const fc = freshHistoryCheck(this.history.get(v.address), v, n, { maxChgM5: this.cfg.freshMaxChgM5, smallMc: this.cfg.freshSmallMc, m5ShareH1: this.cfg.freshM5ShareH1, bypassMinVolM5: this.cfg.freshBypassMinVolM5, bypassMinBuyRatio: this.cfg.freshBypassMinBuyRatio, bypassMaxBuyRatio: this.cfg.maxBuyRatioM5 > 0 ? this.cfg.maxBuyRatioM5 : 0.85 });
      checks.fresh = { pass: !!fc.pass, reason: fc.reason || null };
      if (fc.bypass) checks.fresh.bypassed = true;
      if (!fc.pass) {
        console.log(`[fresh] skip: ${v.symbol} — ${fc.reason}`);
        return this.skip(v, sig, [`fresh: ${fc.reason}`], [], checks);
      }
      if (fc.bypass) {
        // the flow bypass lifted the fresh move cap (user 2026-10-14) — leave the mark on the
        // signal's journaled metrics so the entry's record shows why it was let in
        sig.metrics = sig.metrics || {};
        sig.metrics.freshBypass = fc.bypass;
        console.log(`[fresh] bypass: ${v.symbol} — ${fc.reason}`);
      }
    }
    // Flow-entry snapshot collapse check (user 2026-10-15, from the DACITY forensic):
    // a flow entry fires on a tracked wallet's buy and carries NO detector price-shape
    // of its own — pop/trend/liftoff/fast-pop signals can only exist while their
    // shape legs hold, so a mid-collapse coin never produces them, but DACITY's flow
    // entry was taken with chgM5 -41.8% printed in its own snapshot (~62% under the
    // peak) because nothing in the shared stack reads the downside of that print:
    // the fresh check above caps only the upside and only on thin history. Judge the
    // flow entry on its own snapshot here (gate.js flowSnapshotCheck); flow only —
    // every other setup's pipeline is byte-identical.
    if (sig.setup === 'flow') {
      const fs = flowSnapshotCheck(v, { minChgM5: this.cfg.flowSnapshotMinChgM5 });
      checks.flowSnapshot = { pass: !!fs.pass, reason: `flow snapshot: ${fs.reason}` };
      if (!fs.pass) {
        console.log(`[flow] skip: ${v.symbol} — flow snapshot: ${fs.reason}`);
        return this.skip(v, sig, [`flow snapshot: ${fs.reason}`], [], checks);
      }
    }
    // Shallow-dip veto (user 2026-10-14): classic entries (pop + trend + liftoff) may be
    // taken at the trailing-hour sampled top, breaking above it, or on a real dip
    // (SHALLOW_DIP_MAX_PCT or more under the top, deep dips included) — but not a few
    // percent under the top, which is the rollover spot (his example: -5% under).
    // Judged on the bot's own samples, fail-open on thin history. This replaces the
    // stale-pop veto (removed earlier today for CODE): a signal 10%+ under its sampled
    // high is NOT distance-vetoed by anything anymore — each setup's own volume /
    // buy-inflow legs judge deep dips. Fast-stream pops are EXEMPT: they judge their
    // own 90s window, and their max-drop rule already pins entries near the stream peak.
    if (!(sig.metrics && sig.metrics.fastStream) && (sig.setup === 'pop' || sig.setup === 'trend' || sig.setup === 'liftoff')) {
      const sd = shallowDipCheck(this.history.get(v.address), v.price, n, { maxPct: this.cfg.shallowDipMaxPct, windowMin: this.cfg.shallowDipWindowMin });
      checks.shallowDip = { pass: !!sd.pass, reason: sd.reason || null };
      if (!sd.pass) {
        console.log(`[shallowdip] skip: ${v.symbol} — ${sd.reason}`);
        return this.skip(v, sig, [`shallow dip: ${sd.reason}`], [], checks);
      }
    }
    // Re-entry quality: same coin signaled again — only re-enter on a dip, never the top of a green candle.
    // Require price at least 20% below the recent 15-min high (unless it's a fresh pop breakout).
    if (this.enteredMints.has(v.address) && sig.setup !== 'pop') {
      const samples = this.history.get(v.address) || [];
      const recent = samples.filter(s => this.now() - s.ts <= 15 * 60 * 1000);
      const high = recent.length ? Math.max(...recent.map(s => s.price)) : v.price;
      if (v.price >= high * 0.8) {
        console.log(`[reentry] skip: ${v.symbol} at top (price within 20% of 15m high) — waiting for dip`);
        checks.reentry = { pass: false, reason: 'no dip (price within 20% of recent high)' };
        return this.skip(v, sig, [`reentry: no dip (price within 20% of recent high)`], [], checks);
      }
    }
    const [solUsd, walletSol] = await Promise.all([this.d.fetchSolUsd(), this.exec.solBalance()]);
    const open = this.positions.reduce((a, p) => a + p.entrySol * p.remainingFrac, 0);
    this.risk.checkKill(walletSol, open);
    this.risk.checkBalanceHalt(walletSol, open);

    // Slot ordinal for sizing (owner order 2026-10-17: "open up one more
    // trading slot but .025"): an entry opened while a position is already
    // open is the SECOND slot and sizes at SLOT2_SOL; slot 1 sizes at
    // tradeSol. The count is this.positions.length — the same count the
    // canEnter cap below judges (adopted bags sit in this list too), so
    // the cap and the size can never disagree about which slot this is.
    const slot = this.positions.length >= 1 ? 2 : 1;
    // FLOW CONFIRMATION LANE (owner order 2026-10-17): a qualifying
    // repeat flow fire (sig.flowConfirmLane, judged in _evalFlow) sizes
    // at the lane's own FLOW_CONFIRM_SOL — not tradeSol, not the slot
    // size, not the brake-halved effective size: the test measures the
    // lane. Its canEnter calls waive ONLY the winner/loser/closed mint
    // cooldowns (skipMintCooldowns); halts, the slot cap, the down-stop
    // and every other risk check bind exactly as for any entry.
    const laneEntry = !!sig.flowConfirmLane;
    let size = this.risk.sizeFor(v.liq, solUsd, this.positions.length);
    if (laneEntry) size = this.risk.sizeForLane(v.liq, solUsd);
    const gate0 = this.risk.canEnter({ mint: v.address, walletSol, openCount: this.positions.length, sizeSol: size, halted: this.halted(), ...(laneEntry ? { skipMintCooldowns: true } : {}) });
    if (!gate0.ok) {
      checks.risk = { pass: false, reason: gate0.reason || null };
      if (laneEntry) this._laneBlocked(gate0.reason); // starved-test tally: the skip record itself carries the lane marker + exact reason
      // Freeze work 1b (record-only, user 2026-10-14): a risk-layer preemption
      // used to end the pipeline here, so the record never showed whether the
      // GATE STACK would have passed the coin — the gate-pricing question was
      // unanswerable for exactly the halted/streak-paused stretches. Evaluate
      // the same checks + gate stack in shadow (the D1 shadowGateRecord
      // mechanism) and journal the would-be verdict as shadowGates /
      // shadowGatePass. The live outcome is byte-identical: same decision,
      // same `risk: ...` reason, no buy path entered, no slot touched — the
      // shadow result is never branched on. (The later gate1 re-check needs
      // no shadow verdict: the real gates already ran by then and their
      // results are on that record.)
      const sg = await this.shadowGateRecord(v, sig, n);
      return this.skip(v, sig, [`risk: ${gate0.reason}`], [], checks, null, sg.gates, sg.gatePass);
    }

    // one-trade temporary rules (user-set via POST /temprules; cleared on the next executed entry)
    if (this.stats.tempRules) {
      const violation = tempRuleViolation(v, sig.metrics, this.stats.tempRules);
      if (violation) { checks.tempRule = { pass: false, reason: violation }; return this.skip(v, sig, [violation], [], checks); }
    }

    // gates: RugCheck + curve history in parallel (the DAS holder sample rides
    // along record-only; its result is deliberately not destructured or read)
    const [rug, curve] = await Promise.all([
      this.d.fetchRug(v.address).catch(() => null),
      this.d.fetchCurve ? this.d.fetchCurve(v.address).catch(() => null) : null,
      this._dasHolderSample(v.address),
    ]);
    // Pace keeper: if behind the hourly target, use relaxed gate thresholds
    const { cfg: gateCfg, boosted, pace } = this.paceCfg(n);
    const g = runGates({ view: v, rug, curve, cfg: gateCfg, now: n });
    // D1: the full per-gate map joins the pipeline checks for the record
    Object.assign(checks, summarizeGateChecks(g.checks) || {});
    // Birth-verdict write tap (owner order 2026-10-16): if this gate run
    // ESTABLISHED a bought-out birth (instantGrad fired), remember it for
    // every later evaluation of this mint — this signal skips on the fire
    // itself, but a later path whose curve read fails open must not be
    // able to resurrect the coin (the FMR hole). Bookkeeping only.
    this._noteInstantGradVerdict(v.address, g);
    if (!g.pass) {
      // Mandatory ape mode: if under N entries/hour, force through soft gate fails only.
      // Structural (HARD_GATES) fails are never forced — that bypass is what let rigged launches in.
      const hourEntries = this.entryTimes.filter(t => t > n - 3600000).length;
      const unsurvivable = hasHardFail(g.fails) || (g.fails || []).some(f => /^(rugged|mintAuthority|freezeAuthority)/.test(String(f).split(':')[0]));
      const mandatoryTarget = this.cfg.mandatoryApesPerHour || 0;
      if (mandatoryTarget > 0 && hourEntries < mandatoryTarget && !unsurvivable) {
        console.log(`[mandatory] forcing ${v.symbol} through gates (${hourEntries}/${mandatoryTarget} this hour) — skipped: ${g.fails.join('; ').slice(0, 120)}`);
        // Don't skip, continue to round-trip check below
      } else {
        // User override: if ALL failing gates are contested by the user (they marked
        // 3+ similar skips as "good"), don't skip — let it through with a warning.
        const contested = this.journal.contestedGates();
        const failReasons = g.fails.map(f => String(f).split(':')[0]);
        const allContested = failReasons.length > 0 && failReasons.every(r => contested.has(r));
        // Structural gates (insiders, farm, SOL-side depth, ladder, mint/freeze, ...) can NEVER be overridden
        if (allContested && !hasHardFail(g.fails)) {
          console.log(`[learn] override: user contested gates ${failReasons.join(',')} — letting ${v.symbol} through`);
          // Don't skip, continue to round-trip check below
        } else {
          return this.skip(v, sig, g.fails, g.warnings, checks, g.pass);
        }
      }
    }

    // Insider-count block (owner order 2026-10-16, off the last-50 separation
    // study: insider wallets at entry were its best separator — winner median
    // 0 vs loser median 4; a >=3 block scored net +0.26 SOL on the sample).
    // Judged HERE, after the gate stack has resolved to PROCEED — clean pass,
    // mandatory-ape force and contested override all land on this seam — so
    // the block binds exactly where forcing used to wave coins through. Every
    // live entry path funnels through onSignal, so this one seam covers
    // pop/churn/trend/liftoff, flow, staircase, confluence and dev-launch.
    // The count is the RugCheck report's graphInsidersDetected — the same
    // field the entry snapshot records as insiderWallets; the gates' own
    // insiders check (linked-supply %) is a different measurement and stays
    // untouched. Judged on cfg, NOT the pace-relaxed gateCfg: the block never
    // relaxes. An unavailable count never blocks and is never invented — the
    // entry proceeds and the verdict stamp says unknown. Kill switch
    // INSIDER_BLOCK=0: no stamp, no tally, records exactly as before.
    if (this.cfg.insiderBlock) {
      const ib = insiderCountVerdict(rug, this.cfg.insiderBlockN);
      this.stats.insiderBlock = this.stats.insiderBlock || { blocked: 0, unknown: 0 };
      checks.insiderBlock = { pass: ib.pass, insiders: ib.insiders, max: this.cfg.insiderBlockN, reason: ib.reason };
      if (ib.unknown) { checks.insiderBlock.unknown = true; this.stats.insiderBlock.unknown++; }
      if (!ib.pass) {
        this.stats.insiderBlock.blocked++;
        console.log(`[insiders] skip: ${v.symbol} — ${ib.reason}`);
        return this.skip(v, sig, [ib.reason], g.warnings, checks, g.pass);
      }
    }

    // Fast-bonder block (owner order 2026-10-16, "live gate now: block
    // sub-2-minute bonders"): a KNOWN graduated coin whose bonding curve
    // lived less than FAST_BOND_MAX_SEC seconds never buys. Judged HERE,
    // immediately after the insider block on the same post-gates seam, so
    // it binds clean passes, mandatory-ape forces and contested overrides
    // alike — and every live path funnels through onSignal. The lifespan is
    // measured lazily at this seam only (never for gate-failed candidates)
    // from DexScreener pairCreatedAt stamps and cached per mint (see
    // _curveLifeSec); the fetch is timeout-bounded and a slow or failed
    // read degrades to unknown. FAIL OPEN, ALWAYS: a non-graduated coin has
    // no lifespan and is definitionally untouched, and missing data never
    // blocks and is never rounded into an invented number — the stamp says
    // unknown and the entry proceeds exactly as today. Distinct from the
    // gates' instantGrad check, which counts curve buy txs (a count the
    // split-wallet pattern defeats); this judges elapsed time, which it
    // cannot fake. Judged on cfg, never the pace-relaxed gateCfg. Kill
    // switch FAST_BOND_BLOCK=0: no fetch, no stamp, no tally, records
    // exactly as before.
    // Birth-verdict MEMORY block (owner order 2026-10-16, the FMR hole):
    // before the fresh fastBond measurement below is consulted, ask what
    // the bot already KNOWS about this mint's birth. A stored verdict —
    // an instantGrad bought-out fire or a measured sub-line lifespan,
    // established by ANY earlier evaluation on ANY path and persisted
    // across restarts — blocks here, so an evaluation whose fresh fetches
    // fail open (GeckoTerminal 429 -> 'curve history unknown'; degenerate
    // same-second DexScreener stamps -> lifespan unknown) can never
    // resurrect a known bought-out / fast-bonded launch. Judged on cfg on
    // the same post-gates seam as the insider/fastBond blocks, so it binds
    // clean passes, mandatory-ape forces and contested overrides alike.
    // Enforcement follows the FAST_BOND_BLOCK kill switch: with the switch
    // off there is no stamp, no tally and no block — records exactly as
    // before the memory existed (verdict WRITING stays always-on; see
    // _noteInstantGradVerdict). A mint with no stored verdict gets no
    // stamp either: this block speaks only when it knows something, and
    // unmeasured mints fall through to the fresh gates untouched.
    if (this.cfg.fastBondBlock) {
      const bv = birthMemoryVerdict(this.birthVerdicts.get(v.address), n);
      if (!bv.pass) {
        const bs = this._birthStats(); bs.blocked++; bs.known = this.birthVerdicts.size;
        checks.birthMemory = { pass: false, kind: bv.kind, evidence: bv.evidence, firstSeenTs: bv.firstSeenTs, reason: bv.reason };
        console.log(`[birthmemory] skip: ${v.symbol} — ${bv.reason}`);
        return this.skip(v, sig, [bv.reason], g.warnings, checks, g.pass);
      }
    }

    // Top guard (owner order 2026-10-16, "Do not buy a coin if it's at the
    // literal fucking top"): every live trigger — pop's gain print,
    // confluence's wallet coincidence, flow's tracked buy — peaks exactly
    // when the vertical peaks, so fills land on the tip (blocus taken at
    // the exact top tick of a single vertical candle; MM taken with the
    // entry minute already -13.6% off a seconds-old high; 'long' taken at
    // $50,158, $33.9K three minutes later). Judged HERE, on the same
    // post-gates seam as the insider/birth-memory blocks and BEFORE the
    // fastBond fetch, so it binds clean passes, mandatory-ape forces and
    // contested overrides alike — and costs no network: the verdict reads
    // ONLY the bot's own sampled mc history (the per-mint history the
    // chg1m sampler maintains), so it can never fail open on a
    // GeckoTerminal 429 or a DexScreener stamp collapse. A candidate
    // within TOP_GUARD_DIST_PCT of its trailing TOP_GUARD_LOOKBACK_MIN-
    // minute high is blocked when that high was MADE by a >=
    // TOP_GUARD_SURGE_PCT rise inside the TOP_GUARD_SURGE_WINDOW_SEC
    // before it printed and is <= TOP_GUARD_HIGH_MAX_AGE_SEC old; a high
    // that was ground out (no 2-minute surge — the staircase shape) or
    // held (the surge aged out) passes untouched. UNKNOWN (thin history,
    // unmeasured surge base, no current mc) never blocks and is never
    // rounded into an invented number — the stamp says unknown and the
    // entry proceeds. Judged on cfg, never the pace-relaxed gateCfg.
    // Kill switch TOP_GUARD_BLOCK=0: no stamp, no tally, records exactly
    // as before.
    if (this.cfg.topGuardBlock) {
      const tg = topGuardVerdict(this.history.get(v.address), n, { currentMc: v.mc, lookbackMin: this.cfg.topGuardLookbackMin, surgeWindowSec: this.cfg.topGuardSurgeWindowSec, maxDistPct: this.cfg.topGuardDistPct, minSurgePct: this.cfg.topGuardSurgePct, highMaxAgeSec: this.cfg.topGuardHighMaxAgeSec });
      this.stats.topGuard = this.stats.topGuard || { blocked: 0, passed: 0, unknown: 0 };
      checks.topGuard = { pass: tg.pass, distPct: tg.distPct, surgePct: tg.surgePct, highAgeSec: tg.highAgeSec, reason: tg.reason };
      if (tg.unknown) { checks.topGuard.unknown = true; this.stats.topGuard.unknown++; }
      else if (!tg.pass) {
        this.stats.topGuard.blocked++;
        console.log(`[topguard] skip: ${v.symbol} — ${tg.reason}`);
        return this.skip(v, sig, [tg.reason], g.warnings, checks, g.pass);
      } else this.stats.topGuard.passed++;
    }

    if (this.cfg.fastBondBlock) {
      const fb = fastBondVerdict(await this._curveLifeSec(v.address), this.cfg.fastBondMaxSec);
      this.stats.fastBond = this.stats.fastBond || { blocked: 0, passed: 0, unknown: 0 };
      checks.fastBond = { pass: fb.pass, curveLifeSec: fb.lifeSec, max: this.cfg.fastBondMaxSec, reason: fb.reason };
      if (fb.unknown) { checks.fastBond.unknown = true; this.stats.fastBond.unknown++; }
      else if (!fb.pass) {
        this.stats.fastBond.blocked++;
        // Remember the measurement as a birth verdict: a later evaluation
        // whose DexScreener stamps come back degenerate must find this
        // truth in the memory instead of re-fetching it into oblivion.
        this._recordBirthVerdict(v.address, 'fastBond', fb.reason);
        console.log(`[fastbond] skip: ${v.symbol} — ${fb.reason}`);
        return this.skip(v, sig, [fb.reason], g.warnings, checks, g.pass);
      } else this.stats.fastBond.passed++;
    }

    // BASE MODE demotion (owner order 2026-10-16 23:00 EDT, "Build the
    // base strategy" — his diagnosis: "the parameters, the rules,
    // everything is just noise blocking the bot... the same way bad
    // coins run, good coins do, and the same way they die, so do bad
    // coins" — the signals were never the problem; the ENTRIES were:
    // every live trigger fires on the move itself, so fills land on the
    // blast, not the base). "Buy the base, not the blast": while
    // BASE_MODE is on, a candidate that survived the whole stack above
    // (vetoes, gates, insider / birth-memory / top-guard / fast-bond
    // seams — all of which still judge and still write their verdicts
    // to the memory) but whose setup is NOT a formed-base shape is not
    // bought. It is ENROLLED: journaled 'skipped' with the enrollment
    // reason and fields.enrolledBy, tallied in stats.baseMode, its
    // provenance remembered — a watch order. The bot buys only when a
    // base actually forms under the coin: a range mark (lower two
    // thirds, or the deferred dip), a staircase-3 higher low, a
    // qualified bottom — the BASE_ENTRY_SETUPS allowlist, default-deny
    // for any future setup. Shadow evaluations never reach here (they
    // returned at the shadow branch above), so record-only judging is
    // untouched. BASE_MODE=0: no stamp, no tally, no record — the
    // pipeline below runs exactly as tonight.
    // FLOW CONFIRMATION LANE bypass (owner order 2026-10-17): a
    // qualifying repeat flow fire is the ONE non-base setup that does
    // not enroll — it has already proven itself by firing twice, and
    // the lane is its own entry rule ("a base trigger cannot block a
    // pop trigger" — lanes are independent). The verdict is stamped on
    // the record so the taken/skipped journal shows WHY this flow fire
    // was allowed to spend.
    if (laneEntry && this.cfg.baseMode && !BASE_ENTRY_SETUPS.has(sig.setup)) {
      checks.flowConfirm = { lane: true, enrolledBypass: true, reason: 'flow confirmation lane: qualifying repeat fire — direct entry instead of base-watch enrollment' };
    }
    if (this.cfg.baseMode && !BASE_ENTRY_SETUPS.has(sig.setup) && !laneEntry) {
      const bm = this._baseStats();
      bm.enrolled++;
      bm.bySetup[sig.setup] = (bm.bySetup[sig.setup] || 0) + 1;
      this.baseEnrolled.set(v.address, { setup: sig.setup, ts: n });
      sig.enrolledBy = sig.setup;
      checks.baseMode = { pass: false, enrolled: true, reason: 'base mode: enrolled for base watch — entries only from a formed base' };
      console.log(`[basemode] ${v.symbol} (${sig.setup}) enrolled for base watch — no direct entry`);
      return this.skip(v, sig, ['base mode: enrolled for base watch — entries only from a formed base'], g.warnings, checks, g.pass);
    }

    // exit-value check: price a buy AND the immediate sell-back before spending anything
    let rt;
    try { rt = await this.exec.roundTrip(v.address, size); }
    catch (e) { checks.roundtrip = { pass: false, reason: `no sellable route (${e.message})` }; return this.skip(v, sig, [`roundtrip: no sellable route (${e.message})`], g.warnings, checks, g.pass); }
    checks.roundtrip = { pass: rt.ratio >= this.cfg.minRoundTrip, reason: `sell-back worth ${(rt.ratio * 100).toFixed(0)}% of spend` };
    if (rt.ratio < this.cfg.minRoundTrip) return this.skip(v, sig, [`roundtrip: sell-back worth ${(rt.ratio * 100).toFixed(0)}% of spend < ${(this.cfg.minRoundTrip * 100).toFixed(0)}% (impact ${rt.impactPct.toFixed(1)}%)`], g.warnings, checks, g.pass);

    // Price-move vetoes REMOVED 2026-10-12 (user order): both the quote-level freshness
    // guard (±10% vs decision price) and the older DexScreener re-pull check (-30%/+100%)
    // rejected any coin that moved while the gates were running — the user wants the buy
    // to go through at whatever the live price is. Entries are instant from here.

    // re-check limits right before spending (state may have changed during the awaits above)
    const gate1 = this.risk.canEnter({ mint: v.address, walletSol: await this.exec.solBalance(), openCount: this.positions.length, sizeSol: size, halted: this.halted(), ...(laneEntry ? { skipMintCooldowns: true } : {}) });
    if (!gate1.ok) { checks.risk = { pass: false, reason: gate1.reason || null }; if (laneEntry) this._laneBlocked(gate1.reason); return this.skip(v, sig, [`risk: ${gate1.reason}`], g.warnings, checks, g.pass); }

    let fill;
    try { fill = await this.exec.buy(v.address, size, rt.buyQuote); }
    catch (e) { this.err('buy', e); checks.exec = { pass: false, reason: `buy failed (${e.message})` }; return this.skip(v, sig, [`exec: buy failed (${e.message})`], g.warnings, checks, g.pass); }

    // D1 (record-only): entry-time facts the close record will need — token
    // decimals + the real buy fill (SOL per whole token, from the executed
    // quote) + SOL/USD at entry, the full per-check map, and this build's
    // config stamp. None of these are read by any trading decision.
    const dec = rug && rug.token && rug.token.decimals != null ? Number(rug.token.decimals) : null;
    const tokensWhole = dec != null && Number(fill.tokensRaw) > 0 ? Number(fill.tokensRaw) / 10 ** dec : null;
    // FLOW CONFIRMATION LANE: the entry is real — count it against the
    // mint's window cap (authoritative increment, here at execution) and
    // stamp the lane ordinal onto the signal metrics, the position and
    // the open record, so the kill rule can read the close back off the
    // position (ensureClose) and any audit can find lane trades by the
    // marker alone.
    const laneOrdinal = laneEntry ? this._laneRecordEntry(v.address, n) : null;
    if (laneEntry) { sig.metrics = sig.metrics || {}; sig.metrics.flowConfirmOrdinal = laneOrdinal; }
    const pos = {
      id: `${v.address.slice(0, 6)}-${n}`, mint: v.address, symbol: v.symbol, setup: sig.setup,
      entryTs: n, entrySol: fill.solSpent, tokensRaw: fill.tokensRaw, entryTokensRaw: fill.tokensRaw, remainingFrac: 1, peakRatio: 1, tp1Done: false, tp2Done: false, tp1Arm: null, flowHist: [], suspectUnbookedSell: false,
      // BASE MODE birth stamps (owner order 2026-10-16): a base-setup
      // entry (sig.baseTp1, set by the base eval routes while BASE_MODE
      // is on) is born with TP1 pinned at +50% — the /tp1at override
      // mechanism, applied by the strategy instead of by hand — and a
      // range/bottom entry also carries its base's low (sig.structureLow)
      // as an entry-side record (the dip-watch/enrollment machinery and
      // the close record read the base; since the structural stop's
      // removal on 2026-10-17 NO exit reads it). A signal carrying
      // neither stamp produces the exact position shape of tonight.
      ...(sig.baseTp1 ? { tp1AtPct: 0.5 } : {}), ...(sig.structureLow > 0 ? { structureLow: sig.structureLow } : {}),
      // FLOW CONFIRMATION LANE stamp: a lane entry carries its ordinal
      // (the kill rule + re-entry timer read it back at close). A lane
      // entry is never slot-stamped — its size came from the lane rule,
      // not the slot rule, and the records must not claim otherwise.
      ...(laneEntry ? { flowConfirm: { ordinal: laneOrdinal } } : {}),
      // SLOT stamp (owner order 2026-10-17): a second-slot entry (priced at
      // SLOT2_SOL by the seam above) carries slot: 2 on the position and
      // its open record. With SLOT2_SOL=0 (kill switch) nothing is priced
      // by the slot rule and nothing is stamped — the record is exactly
      // the pre-slot shape, like every other disabled knob tonight.
      ...(slot === 2 && !laneEntry && this.cfg.slot2Sol > 0 ? { slot: 2 } : {}),
      entryPrice: v.price, entryMc: v.mc, realizedSol: 0, simulated: fill.simulated, sigBuy: fill.sig, markFails: 0,
      stamp: this.cfgStamp, gates: checks, gatePass: g.pass, decimals: dec,
      entryFillSol: tokensWhole > 0 ? fill.solSpent / tokensWhole : null, solUsdEntry: solUsd || null, ticks: [],
      entryVolH1: v.volH1 || 0,
      entryRoundTrip: rt.ratio, peakMove: 1, stopArmedTs: null, floorChecks: 0, floorSince: null, probationSince: null, moveHist: [], exitPending: {}, stallPending: null, bagDeadWaves: 0, bagDeadHot: false, feesSol: this.cfg.txFeeSol || 0, // buy tx fee // entry stall: price is at entry (move 1.0) by definition; the 60s clock runs from entryTs
      bw: { tracked: null, supply: rug && rug.token ? Number(rug.token.supply) || 0 : 0, creator: rug && rug.creator ? String(rug.creator) : null, weights: linkedWeights(rug), snaps: [], vals: [], lastTs: 0, trimmed: false },
      entry: snapshotFeatures({ v, sig, rug, g, now: n }), lastTickTs: 0, lastChainTs: 0, chainDropStrikes: 0,
    };
    this.positions.push(pos); this.savePositions();
    this.enteredMints.add(v.address); this.saveEnteredMints();
    this.risk.recordEntry(v.address);
    this.stats.entries++;
    this.entryTimes.push(n);
    // Callout Shadow Lab (record-only): the would-call for this entry is
    // journaled whether or not live callouts are on — the lab scores what a
    // follower would have made. Fire-and-forget; it can never post or trade.
    this.calloutLab.record({ trigger: 'entry', ts: n, mint: v.address, symbol: v.symbol, v, sig, setup: sig.setup, source: 'entry', holding: true, linkId: pos.id }).catch(() => {});
    // Fire a pump.fun callout for this entry (non-blocking; rewards accrue to the user).
    // The thesis is generated from the signal that triggered the entry.
    // GATED (user 2026-10-15): live callouts OFF unless CALLOUTS_ENABLED=1 —
    // postCallout is gated internally too, so a disabled bot makes no attempt.
    if (this.cfg.calloutsEnabled) {
      postCallout(v, sig, { enabled: true }).then(r => {
        console.log('[callout] posted for', v.symbol);
        this.lastCallout = { ok: true, symbol: v.symbol, ts: Date.now() };
      }).catch(e => {
        console.log('[callout] failed:', e.message);
        this.lastCallout = { ok: false, error: e.message, symbol: v.symbol, ts: Date.now() };
      });
    }

this.journal.signal({ mint: v.address, symbol: v.symbol, setup: sig.setup, decision: 'taken', reasons: [], price: v.price, mc: v.mc, metrics: { ...sig.metrics, roundTrip: +rt.ratio.toFixed(3), sizeSol: size }, warnings: g.warnings, label: sig.label || null, gates: checks, gatePass: g.pass, fields: this._fieldsFor(v, sig), liqRechecks: sig.liqRechecks ?? null });
    this.journal.trade({ type: 'open', id: pos.id, mint: pos.mint, symbol: pos.symbol, setup: pos.setup, entrySol: pos.entrySol, sig: fill.sig, simulated: fill.simulated, ts: n, stamp: pos.stamp, tokensRaw: fill.tokensRaw, entryFillSol: pos.entryFillSol, entryFillUsd: pos.entryFillSol != null && solUsd > 0 ? +(pos.entryFillSol * solUsd).toFixed(10) : null, ...(slot === 2 && !laneEntry && this.cfg.slot2Sol > 0 ? { slot: 2 } : {}), ...(laneEntry ? { flowConfirm: 1, flowConfirmOrdinal: laneOrdinal } : {}) });

    // Flow-Exit Watcher (record-only): a flow-triggered entry starts a watch
    // on the wallet whose buy nominated it — its trim/exit get journaled and
    // scored against this position's own close in ensureClose. No-op for
    // every other setup and whenever the trigger wallet is unresolvable.
    try { if (this.flowExits) this.flowExits.start(pos, sig); } catch { /* observer only — never disturb trading */ }
    // one-trade rules are spent the moment an entry executes
    if (this.stats.tempRules) { console.log(`[temp] one-trade rules spent on ${pos.symbol} — cleared`); this.stats.tempRules = null; this.saveStats(); }
  }

  // Arm (or clear, with an empty body) the one-trade temporary entry rules.
  // Persisted in stats so a restart can't quietly drop or resurrect them.
  setTempRules(rules) {
    if (!rules || (!(rules.maxMc > 0) && !(rules.maxDropPct > 0))) this.stats.tempRules = null;
    else this.stats.tempRules = { maxMc: rules.maxMc > 0 ? Number(rules.maxMc) : 0, maxDropPct: rules.maxDropPct > 0 ? Number(rules.maxDropPct) : 0, armedTs: this.now() };
    this.saveStats();
    return this.stats.tempRules;
  }

  // ------------------------------------------------------------ position management
  async positionTick() {
    this._syncCensus();
    if (!this._grindKillAt || this.now() - this._grindKillAt >= 60000) { this._grindKillAt = this.now(); this._grindKillCheck(); }
    if (this.busy.pos || !this.positions.length) return;
    this.busy.pos = true;
    try {
      const solUsd = await this.d.fetchSolUsd();
      this.lastSolUsd = solUsd || this.lastSolUsd;
      for (const pos of [...this.positions]) {
        try { await this.managePosition(pos, solUsd); } catch (e) { this.err(`position ${pos.symbol}`, e); }
      }
      const walletSol = await this.exec.solBalance().catch(() => null);
      if (walletSol != null) { const oc = this.positions.reduce((a, p) => a + p.entrySol * p.remainingFrac, 0); this.risk.checkKill(walletSol, oc); this.risk.checkBalanceHalt(walletSol, oc); }
      this.stats.positionTicks++;
    } finally { this.busy.pos = false; this.saveStats(); }
  }

  async bundleCheck(pos, valueSol, n) {
    const bw = pos.bw; if (!bw || n - (bw.lastTs || 0) < this.cfg.bundleCheckSec * 1000) return null;
    bw.lastTs = n;
    const amts = await this.exec.largestAccounts(pos.mint);
    if (!bw.tracked) bw.tracked = Object.entries(amts).sort((a, b) => b[1] - a[1]).slice(1, 21).map(e => e[0]);
    if (bw.creator) { const cb = await this.exec.ownerBalance(bw.creator, pos.mint).catch(() => null); if (cb != null) { amts[CREATOR_KEY] = cb; if (!bw.tracked.includes(CREATOR_KEY)) bw.tracked.push(CREATOR_KEY); } }
    bw.snaps.push({ ts: n, amts }); if (bw.snaps.length > 24) bw.snaps.shift();
    const basis = pos.entrySol * pos.remainingFrac;
    bw.vals.push({ ts: n, r: basis > 0 ? valueSol / basis : 0 }); if (bw.vals.length > 24) bw.vals.shift();
    const win = bw.vals.filter(x => x.ts >= n - this.cfg.bundleWindowSec * 1000);
    const hi = Math.max(...win.map(x => x.r)), now = bw.vals[bw.vals.length - 1].r;
    const priceDropPct = hi > 0 ? Math.max(0, (1 - now / hi) * 100) : 0;
    const r = bundleRisk({ snapshots: bw.snaps, tracked: bw.tracked, weights: bw.weights, supply: bw.supply, priceDropPct, windowSec: this.cfg.bundleWindowSec, dumpFrac: this.cfg.bundleDumpFrac, now: n });
    pos.bundleScore = r.score;
    return bundleDecision(r, this.cfg, bw.trimmed);
  }

  /** Position-tick journal (RECORD-ONLY, user 2026-10-16): one compact record
   *  per position check of exactly what the bot itself saw when it judged —
   *  the realizable quote ratio and net gain as evaluateExit computes them,
   *  the stage the position judged under, the running peak, and the
   *  flow/market fields already in hand at the check (5m buy share, buy/sell
   *  counts, mc). Until now these marks lived only in memory (pos.flowHist,
   *  capped at 45 and discarded at close), so the bracket classifier's
   *  features existed nowhere (measurement pass 2026-10-16, workstream D).
   *  The record is built ONLY from values the check already holds — it never
   *  fetches — and a field the check doesn't have is null, never invented.
   *  NOTHING reads position_ticks.jsonl back: no decision path may consume
   *  it. TICK_JOURNAL=0 disables. Fail-silent like every observer here: a
   *  journaling fault must never disturb the position loop. */
  _tickJournal(pos, v, valueSol, n) {
    if (!this.cfg.tickJournal) return;
    try {
      const basis = pos.entrySol * pos.remainingFrac;
      const ratio = valueSol != null && basis > 0 ? valueSol / basis : null;
      // net gain exactly as exits.js judges it: quote ratio minus the round-trip fee fraction
      const feeFrac = basis > 0 ? (3 * (this.cfg.txFeeSol || 0)) / basis : 0;
      const buys = v && v.buysM5 != null ? v.buysM5 : null;
      const sells = v && v.sellsM5 != null ? v.sellsM5 : null;
      const tx = (buys != null || sells != null) ? (buys || 0) + (sells || 0) : null;
      this.journal.positionTick({
        ts: n, id: pos.id, mint: pos.mint, symbol: pos.symbol,
        stage: pos.tp2Done ? 'moonbag' : pos.tp1Done ? 'middle' : 'preTp1',
        heldMin: +((n - pos.entryTs) / 60000).toFixed(2),
        ratio: ratio != null ? +ratio.toFixed(4) : null,
        gainPct: ratio != null ? +((ratio - 1 - feeFrac) * 100).toFixed(2) : null,
        peakRatio: +(pos.peakRatio || 1).toFixed(4),
        valueSol: valueSol != null ? +valueSol.toFixed(6) : null,
        buyShare: tx > 0 && buys != null ? +(buys / tx).toFixed(3) : null,
        buysM5: buys, sellsM5: sells, txM5: tx,
        mc: v && v.mc != null ? v.mc : null,
        liq: v && v.liq != null ? v.liq : null,
        volH1: v && v.volH1 != null ? v.volH1 : null,
      });
      this.stats.tickJournal = this.stats.tickJournal || { records: 0, lastTs: 0 };
      this.stats.tickJournal.records++;
      this.stats.tickJournal.lastTs = n;
    } catch { /* record-only — never disturb trading */ }
  }

  async managePosition(pos, solUsd) {
    const n = this.now();
    const v = this.latest.get(pos.mint) || {};
    let valueSol = null;
    try { valueSol = await this.exec.markValue(pos.mint, pos.tokensRaw); pos.markFails = 0; pos.lastValueSol = valueSol; }
    catch { pos.markFails = (pos.markFails || 0) + 1; }

    // Books-vs-chain reconciliation (fix zero): if one of OUR sells reported failure
    // after its swap was sent (suspectUnbookedSell), the tokens may be gone while the
    // books still count them — every later ratio, stop and report would be computed
    // on tokens we no longer hold (DOGCART 2026-10-13: an unbooked TP1 left the
    // remainder reading -56% and the hard floor dumped it at a real +33%). Resync to
    // chain truth before judging exits. Only runs on the suspect flag, so genuine
    // manual exits still flow to the manual-exit detector below, untouched.
    if (this.cfg.realMode && !pos.simulated && pos.suspectUnbookedSell && valueSol != null) {
      const chain = await this.exec.tokenBalance(pos.mint).catch(() => null);
      if (chain != null) {
        if (!pos.entryTokensRaw) pos.entryTokensRaw = String(Math.max(1, Math.round(Number(pos.tokensRaw) / Math.max(1e-9, pos.remainingFrac))));
        const books = BigInt(pos.tokensRaw);
        if (chain < books && books > 0n && (books - chain) * 50n >= books) {
          const missing = books - chain;
          const estSol = valueSol * (Number(missing) / Number(books)); // mark-priced estimate of the unbooked proceeds
          pos.realizedSol += estSol;
          this.journal.trade({ type: 'sell', id: pos.id, mint: pos.mint, symbol: pos.symbol, fraction: +(Number(missing) / Number(pos.entryTokensRaw)).toFixed(4), solOut: +estSol.toFixed(6), reason: 'reconciled unbooked sell (chain resync)', sig: null, simulated: false, ts: n });
          console.log(`[reconcile] ${pos.symbol}: books ${books} vs chain ${chain} — booked the missing sell (~${estSol.toFixed(4)} SOL)`);
          pos.tokensRaw = chain.toString();
          pos.remainingFrac = Number(chain) / Number(pos.entryTokensRaw);
          if (!pos.tp1Done && Number(missing) / Number(pos.entryTokensRaw) >= (this.cfg.tp1Frac || 0.4) * 0.75) pos.tp1Done = true;
          pos.suspectUnbookedSell = false;
          if (chain <= 0n) {
            const pnl = pos.realizedSol - pos.entrySol - (pos.feesSol || 0);
            this.positions = this.positions.filter(p => p.id !== pos.id);
            this._recordClose(pnl, pos.mint, pos.entrySol);
            this.ensureClose(pos, { id: pos.id, mint: pos.mint, symbol: pos.symbol, setup: pos.setup, entrySol: pos.entrySol, exitSol: pos.realizedSol, pnlSol: +pnl.toFixed(6), heldMin: +((n - pos.entryTs) / 60000).toFixed(1), reason: 'reconciled unbooked sell (chain resync)', simulated: pos.simulated, ts: n });
            this.savePositions();
            return;
          }
          try { valueSol = await this.exec.markValue(pos.mint, pos.tokensRaw); pos.lastValueSol = valueSol; } catch { /* keep the pre-resync mark */ }
        } else if (chain >= books) {
          pos.suspectUnbookedSell = false; // the suspect sell truly never landed; books are right
        }
      }
    }

    let decision;
    if (valueSol == null) {
      // TAKEOVER: a position the user is driving himself is never force-exited —
      // not even by the no-quote fallback below; the pass is a hold like any other.
      if (pos.takenOver) decision = { fraction: 0, reason: null, newPeak: pos.peakRatio, takenOver: true };
      // no sell quote at all: after repeated failures, try to exit anyway — a coin we can't price is a coin we can't leave
      else if (pos.markFails >= 4) decision = { fraction: 1, reason: `no sell quote for ${pos.markFails} ticks`, newPeak: pos.peakRatio };
      else { this._tickJournal(pos, v, null, n); return; }
    } else {
      const markNow = { valueSol, liqUsd: v.liq != null ? v.liq : null, buysM5: v.buysM5 != null ? v.buysM5 : null, sellsM5: v.sellsM5 || 0, solUsd, volH1: v.volH1 || 0 };
      // flow history for the adaptive TP1's strength test: this position's own marks, every check
      pos.flowHist = pos.flowHist || [];
      pos.flowHist.push({ ts: n, buys: markNow.buysM5, sells: markNow.sellsM5, tx: (markNow.buysM5 != null || markNow.sellsM5 != null) ? (markNow.buysM5 || 0) + (markNow.sellsM5 || 0) : null });
      if (pos.flowHist.length > 45) pos.flowHist.splice(0, pos.flowHist.length - 45);
      decision = evaluateExit(pos, markNow, this.cfg, n);
    }
    // STRUCTURAL STOP REMOVED (owner order 2026-10-17, "Remove that" —
    // after BLOCUS was range-bought at 11:09:32 EDT and base-broke-sold
    // 12 seconds later at 11:09:44): the base-break exit — a range/bottom
    // position sold in full when two consecutive realizable prints fell
    // below its stamped base low ("base broke: fell below the base
    // low") — is GONE from the live exit path. Nothing here reads
    // pos.structureLow anymore. The ENTRY-side stamps are untouched:
    // the base low is still stamped at entry (onSignal's birth stamps,
    // the range/bottom eval routes), still rides the position and close
    // records, and the dip-watch / enrollment machinery still reads the
    // base — only the EXIT behavior died. The rest of the exit stack
    // (TP ladder, Tratchet, dead-flow, momentum-failure, stall/
    // probation, moonbag trim/floor, liquidity-death/undertaker) judges
    // base positions exactly as it judges every other position.
    // DEATH DETECTOR (owner design 2026-10-17, combination rule delegated):
    // judged HERE, beside the other managePosition overrides, on the same
    // check's own data — the fresh realizable sell quote (valueSol), the
    // latest view (v: price / liq / 5m flow) and this position's own liq
    // history. No price floor, no PnL input, no arming: the question is
    // re-asked from scratch on every check — "is this coin alive right
    // now?" Scope: pre-TP1 only, and only over a HOLD decision (a stack
    // decision to bank or sell on this check is never overridden).
    // Vitals (any one can read UNKNOWN — missing data never counts as bad):
    //   quote — execRatio = realizable quote value / screen value of the
    //     bag (tokens x view price). Bad <= DD_QUOTE_BAD; a collapse
    //     <= DD_QUOTE_COLLAPSE fires solo, instantly, no confirm.
    //   liq — slope across DD_LIQ_WINDOW_SEC from this position's own
    //     real (> 0) liq reads; down >= DD_LIQ_DROP_PCT is bad. A $0 or
    //     missing read is skipped entirely: one indexer's silence is
    //     unknown, never a drain (owner, 2026-10-17).
    //   flow — sells >= DD_FLOW_SELL_MULT x buys in the 5m window AND
    //     estimated sell-side $ (volM5 x sell share) >= DD_FLOW_MIN_USD.
    // Fire rule: collapse, OR >= 2 vitals bad on this check AND still
    // >= 2 bad on the first check at/after DD_CONFIRM_SEC from the
    // pending stamp. The read rides pos.ddVitals for /state.
    if (this.cfg.deathDetector && valueSol != null && decision.fraction === 0 && !pos.tp1Done && !pos.protected && !pos.takenOver) {
      try {
        const dd = this.stats.deathDetector = this.stats.deathDetector || { pendings: 0, cancelled: 0, fires: 0, collapses: 0 };
        // --- quote vital: realizable vs screen value of the whole bag
        let execRatio = null;
        if (v.price > 0 && solUsd > 0 && pos.decimals != null && Number(pos.tokensRaw) > 0) {
          const screenSol = (Number(pos.tokensRaw) / 10 ** pos.decimals) * v.price / solUsd;
          if (screenSol > 0) execRatio = valueSol / screenSol;
        }
        const quoteBad = execRatio != null && execRatio <= this.cfg.ddQuoteBad;
        const collapse = execRatio != null && execRatio <= this.cfg.ddQuoteCollapse;
        // --- liq vital: slope over this position's own real reads
        pos.ddLiqHist = pos.ddLiqHist || [];
        if (v.liq > 0) { pos.ddLiqHist.push({ ts: n, liq: v.liq }); if (pos.ddLiqHist.length > 90) pos.ddLiqHist.splice(0, pos.ddLiqHist.length - 90); }
        let liqDropPct = null;
        if (v.liq > 0 && pos.ddLiqHist.length >= 2) {
          const winMs = this.cfg.ddLiqWindowSec * 1000;
          const ref = pos.ddLiqHist.filter(s => s.ts <= n - winMs * 0.5 && s.ts >= n - winMs * 1.5).pop();
          const first = pos.ddLiqHist[0];
          const base = ref || (n - first.ts >= 60000 ? first : null);
          if (base && base.liq > 0 && base.ts < n) liqDropPct = 1 - v.liq / base.liq;
        }
        const liqBad = liqDropPct != null && liqDropPct >= this.cfg.ddLiqDropPct;
        // --- flow vital: sized sell pressure in the 5m window
        let sellMult = null, sellUsd = null, flowBad = false;
        if (v.buysM5 != null && v.sellsM5 != null && (v.buysM5 + v.sellsM5) >= 10) {
          sellMult = v.sellsM5 / Math.max(1, v.buysM5);
          sellUsd = (v.volM5 || 0) * (v.sellsM5 / (v.buysM5 + v.sellsM5));
          flowBad = sellMult >= this.cfg.ddFlowSellMult && sellUsd >= this.cfg.ddFlowMinUsd;
        }
        const bad = [];
        if (quoteBad) bad.push('quote');
        if (liqBad) bad.push('liq');
        if (flowBad) bad.push('flow');
        pos.ddVitals = { ts: n, execRatio: execRatio != null ? +execRatio.toFixed(3) : null, liqDropPct: liqDropPct != null ? +liqDropPct.toFixed(3) : null, sellMult: sellMult != null ? +sellMult.toFixed(2) : null, sellUsd: sellUsd != null ? Math.round(sellUsd) : null, bad, pending: !!pos.ddPendingSince };
        const vitalsStr = `exec ${execRatio != null ? execRatio.toFixed(2) : '?'}, liq ${liqDropPct != null ? (liqDropPct * 100).toFixed(0) + '%/' + this.cfg.ddLiqWindowSec + 's' : '?'}, sells ${sellMult != null ? sellMult.toFixed(1) + 'x $' + Math.round(sellUsd) : '?'}`;
        if (collapse) {
          dd.collapses++; dd.fires++;
          console.log(`[deathdetector] ${pos.symbol}: QUOTE COLLAPSE — realizable quote at ${execRatio.toFixed(2)} of screen value; selling in full now (${vitalsStr})`);
          decision = { fraction: 1, reason: `death detector: quote collapse (${vitalsStr})`, newPeak: decision.newPeak || pos.peakRatio, deathDetector: true };
          pos.ddPendingSince = null;
        } else if (bad.length >= 2) {
          if (!pos.ddPendingSince) {
            pos.ddPendingSince = n; dd.pendings++;
            console.log(`[deathdetector] ${pos.symbol}: vitals bad (${bad.join('+')}) — confirm window ${this.cfg.ddConfirmSec}s started (${vitalsStr})`);
          } else if (n - pos.ddPendingSince >= this.cfg.ddConfirmSec * 1000) {
            dd.fires++;
            console.log(`[deathdetector] ${pos.symbol}: vitals still bad (${bad.join('+')}) after the confirm window — selling in full (${vitalsStr})`);
            decision = { fraction: 1, reason: `death detector: ${bad.join('+')} (${vitalsStr})`, newPeak: decision.newPeak || pos.peakRatio, deathDetector: true };
            pos.ddPendingSince = null;
          }
        } else if (pos.ddPendingSince) {
          pos.ddPendingSince = null; dd.cancelled++;
          console.log(`[deathdetector] ${pos.symbol}: vitals recovered inside the confirm window — pending cancelled (${vitalsStr})`);
        }
        pos.ddVitals.pending = !!pos.ddPendingSince;
      } catch (e) { this.err(`death detector ${pos.symbol}`, e); }
    }
    // GRIND JUDGE (owner order 2026-10-18; src/grindJudge.js): the
    // puppeted-bid judge. Same scope discipline as the death detector —
    // pre-TP1, HOLD decisions only, protect/takeover silence it — but
    // its witnesses are the two the volume bot cannot fake: the trailing
    // fake-alive share and the wallet census. Slow confirm, undertaker
    // idiom: the conjunction must still hold grindConfirmSec after the
    // first hot check before it can sell. A kill-rule-disabled judge and
    // GRIND_JUDGE_LIVE=0 both reduce it to shadow would-fires.
    if (this.cfg.grindJudge && !this.grindState.disabled && !decision.fraction && !pos.tp1Done && !pos.protected && !pos.takenOver) {
      try {
        const gRatio = valueSol / Math.max(1e-9, pos.entrySol * pos.remainingFrac);
        const faWin = fakeAliveWindow(pos, n, this.cfg.grindFaWindowMin * 60000);
        const cenWin = pos.census ? censusWindow(pos.census, n, this.cfg.censusWindowMin * 60000) : null;
        const verdict = evaluateGrind({ cfg: this.cfg, ageSec: (n - pos.entryTs) / 1000, ratio: gRatio, faWin, cenWin, censusAgeMs: pos.census ? n - pos.census.startedTs : null });
        if (verdict.hot) {
          if (!pos.grindPendingSince) {
            pos.grindPendingSince = n;
            try { this.journal.grind({ type: 'grindHot', id: pos.id, mint: pos.mint, symbol: pos.symbol, ts: n, faShare: faWin.share, faSamples: faWin.samples, buysW: cenWin.buys, uniqW: cenWin.uniqBuyers, newW: cenWin.newBuyers, ratio: +gRatio.toFixed(3) }); } catch { /* record-only */ }
            console.log(`[grindjudge] ${pos.symbol}: HOT — fake-alive ${faWin.share} (${this.cfg.grindFaWindowMin}m), census ${cenWin.buys} buys/${cenWin.uniqBuyers} uniq/${cenWin.newBuyers} new (${this.cfg.censusWindowMin}m); confirm window ${this.cfg.grindConfirmSec}s started`);
          } else if (n - pos.grindPendingSince >= this.cfg.grindConfirmSec * 1000) {
            const reason = grindReason({ faShare: faWin.share, faWinMin: this.cfg.grindFaWindowMin, buys: cenWin.buys, uniq: cenWin.uniqBuyers, fresh: cenWin.newBuyers, winMin: this.cfg.censusWindowMin });
            if (this.cfg.grindJudgeLive) {
              decision = { fraction: 1, reason, newPeak: pos.peakRatio, grindJudge: true };
              pos.grindFired = true;
              this.grindState.fires++;
              this.saveGrindState();
              try { this.journal.grind({ type: 'grindFire', id: pos.id, mint: pos.mint, symbol: pos.symbol, ts: n, faShare: faWin.share, buysW: cenWin.buys, uniqW: cenWin.uniqBuyers, newW: cenWin.newBuyers, ratio: +gRatio.toFixed(3), pendingSec: +((n - pos.grindPendingSince) / 1000).toFixed(0) }); } catch { /* record-only */ }
              console.log(`[grindjudge] ${pos.symbol}: FIRING — ${reason}`);
            } else if (!pos.grindWouldFired) {
              pos.grindWouldFired = true;
              try { this.journal.grind({ type: 'grindWouldFire', id: pos.id, mint: pos.mint, symbol: pos.symbol, ts: n, faShare: faWin.share, buysW: cenWin.buys, uniqW: cenWin.uniqBuyers, newW: cenWin.newBuyers, ratio: +gRatio.toFixed(3) }); } catch { /* record-only */ }
              console.log(`[grindjudge] ${pos.symbol}: WOULD FIRE (live switch off) — ${reason}`);
            }
            pos.grindPendingSince = null;
          }
        } else if (pos.grindPendingSince) {
          pos.grindPendingSince = null;
          try { this.journal.grind({ type: 'grindCancel', id: pos.id, mint: pos.mint, symbol: pos.symbol, ts: n, why: verdict.why }); } catch { /* record-only */ }
          console.log(`[grindjudge] ${pos.symbol}: pending cancelled (${verdict.why})`);
        }
      } catch (e) { this.err(`grind judge ${pos.symbol}`, e); }
    }
    pos.peakRatio = decision.newPeak || pos.peakRatio;
    // position-tick journal (record-only): this check's mark, recorded AFTER the
    // peak update so peakRatio in the record includes this check — the write
    // sits beside the other observers and feeds no decision (see _tickJournal).
    this._tickJournal(pos, v, valueSol, n);
    if (decision.newPeakMove != null) pos.peakMove = decision.newPeakMove;
    if ('stallSince' in decision) pos.stallSince = decision.stallSince;
    if ('stopArmedTs' in decision) pos.stopArmedTs = decision.stopArmedTs;
    if ('floorChecks' in decision) pos.floorChecks = decision.floorChecks;
    if ('floorSince' in decision) pos.floorSince = decision.floorSince;
    if ('probationSince' in decision) pos.probationSince = decision.probationSince;
    if ('moveHist' in decision) pos.moveHist = decision.moveHist;
    if ('exitPending' in decision) pos.exitPending = decision.exitPending;
    if ('killZone' in decision) pos.killZone = decision.killZone;
    if ('postTp1PeakMove' in decision) pos.postTp1PeakMove = decision.postTp1PeakMove;
    if ('deadflowArmed' in decision) pos.deadflowArmed = decision.deadflowArmed;
    if ('stallPending' in decision) pos.stallPending = decision.stallPending;
    if ('bagDeadWaves' in decision) pos.bagDeadWaves = decision.bagDeadWaves;
    if ('bagDeadHot' in decision) pos.bagDeadHot = decision.bagDeadHot;
    if ('bagTrailSince' in decision) pos.bagTrailSince = decision.bagTrailSince;
    if ('bagFloorSince' in decision) pos.bagFloorSince = decision.bagFloorSince;
    if ('bagTp2Ratio' in decision) pos.bagTp2Ratio = decision.bagTp2Ratio;
    if ('bagTrimDone' in decision) pos.bagTrimDone = decision.bagTrimDone;
    // fail-safe confirmation outcomes (user 2026-10-14): count the windows that held to a
    // sell vs the triggers that recovered and were cancelled — the layer's report card.
    if (decision.exitConfirmEvents && decision.exitConfirmEvents.length) {
      this.stats.exitConfirm = this.stats.exitConfirm || { confirmed: 0, cancelled: 0 };
      for (const ev of decision.exitConfirmEvents) {
        if (ev.type === 'confirmed') { this.stats.exitConfirm.confirmed++; console.log(`[exit-confirm] ${pos.symbol}: ${ev.kind} breakdown held through the ${this.cfg.exitConfirmSec}s window — selling`); }
        else if (ev.type === 'cancelled') { this.stats.exitConfirm.cancelled++; console.log(`[exit-confirm] ${pos.symbol}: ${ev.kind} trigger recovered inside the window — pending sell cancelled`); }
      }
    }
    // Two-path redesign (user 2026-10-15): kill-zone lifecycle counts — arming,
    // lapse fires, recovery cancels and instant re-entry kills, across modest
    // remainders and overlay ladder remainders alike (the class rides the
    // journal records, so the two stay separable in the sample).
    if (decision.killzoneEvents && decision.killzoneEvents.length) {
      this.stats.killzone = this.stats.killzone || { armed: 0, fired: 0, cancelled: 0, reentryKills: 0 };
      for (const ev of decision.killzoneEvents) {
        if (ev.type === 'armed') { this.stats.killzone.armed++; console.log(`[killzone] ${pos.symbol}: zone armed (post-TP1 peak reached ${this.cfg.killZoneArmMult}x)`); }
        else if (ev.type === 'fired') this.stats.killzone.fired++;
        else if (ev.type === 'cancelled') this.stats.killzone.cancelled++;
        else if (ev.type === 'reentry') this.stats.killzone.reentryKills++;
      }
    }
    // Dead-flow exit (user 2026-10-15; repositioned post-TP2 by exit-stack
    // v2): count armings (a post-TP2 position's peak move reached the arm
    // line — counted once per position, exits.js emits the event only on the
    // transition) and fires. STAGED (user order 2026-10-16): a staged wave
    // counts as a fire AND in the waves tally; the post-wave-2 stub floor
    // counts in the floor tally.
    if (decision.deadflowEvents && decision.deadflowEvents.length) {
      this.stats.deadflow = this.stats.deadflow || { armed: 0, fired: 0, waves: 0, floor: 0 };
      for (const ev of decision.deadflowEvents) {
        if (ev.type === 'armed') { this.stats.deadflow.armed++; console.log(`[deadflow] ${pos.symbol}: armed (peak move reached +${Math.round(this.cfg.deadflowArmPct * 100)}% post-TP2)`); }
        else if (ev.type === 'fired') this.stats.deadflow.fired++;
        else if (ev.type === 'wave') { this.stats.deadflow.fired++; this.stats.deadflow.waves = (this.stats.deadflow.waves || 0) + 1; console.log(`[deadflow] ${pos.symbol}: wave ${ev.wave} — sold 50% of the bag`); }
        else if (ev.type === 'floor') { this.stats.deadflow.floor = (this.stats.deadflow.floor || 0) + 1; console.log(`[deadflow] ${pos.symbol}: stub floor (+${Math.round(this.cfg.bagFloorPct * 100)}% over entry) — selling the rest`); }
        else if (ev.type === 'trail-pending') { this.stats.deadflow.trailPends = (this.stats.deadflow.trailPends || 0) + 1; console.log(`[bagtrail] ${pos.symbol}: moonbag trail breached — ${this.cfg.bagTrailConfirmSec}s confirm window started, bag rides unless it holds`); }
        else if (ev.type === 'trail-cleared') { this.stats.deadflow.trailClears = (this.stats.deadflow.trailClears || 0) + 1; console.log(`[bagtrail] ${pos.symbol}: back above the trail line inside the window — pending bag sell disarmed`); }
        else if (ev.type === 'floor-pending') { this.stats.deadflow.floorPends = (this.stats.deadflow.floorPends || 0) + 1; console.log(`[bagfloor] ${pos.symbol}: small-bag floor breached — ${this.cfg.bagFloorConfirmSec}s confirm window started, bag rides unless it holds`); }
        else if (ev.type === 'floor-cleared') { this.stats.deadflow.floorClears = (this.stats.deadflow.floorClears || 0) + 1; console.log(`[bagfloor] ${pos.symbol}: back above the floor line inside the window — pending floor sell disarmed`); }
      }
    }
    // STALL EXIT (user order 2026-10-16 19:24 EDT): lifecycle counts —
    // pendings stamped (dead flow first seen past the age gate), pendings
    // cancelled (the tape showed life inside the confirm window) and
    // fires. The fire itself rides the normal sell path: the close
    // journals the decision's "stall exit (...)" reason.
    if (decision.stallEvents && decision.stallEvents.length) {
      this.stats.stallExit = this.stats.stallExit || { pendings: 0, cancelled: 0, fires: 0 };
      for (const ev of decision.stallEvents) {
        if (ev.type === 'pending') { this.stats.stallExit.pendings++; console.log(`[stall-exit] ${pos.symbol}: dead flow — ${this.cfg.stallExitConfirmSec}s confirm window started`); }
        else if (ev.type === 'cancelled') { this.stats.stallExit.cancelled++; console.log(`[stall-exit] ${pos.symbol}: flow revived inside the window — pending cancelled`); }
        else if (ev.type === 'fired') this.stats.stallExit.fires++;
      }
    }
    // PROTECT switch (user 2026-10-15): count the checks where protection suppressed
    // a stop-loss/ratchet exit on this position (first suppressed kind per check,
    // as reported by exits.js on the decision).
    if (decision.protectedBlock) {
      this.stats.protect = this.stats.protect || { set: 0, blocked: 0 };
      this.stats.protect.blocked++;
      console.log(`[protect] ${pos.symbol}: ${decision.protectedBlock} suppressed by protection`);
    }
    // TAKEOVER switch (user 2026-10-15): count the position checks whose exit
    // judging was suppressed by a takeover — one per check while the flag is set.
    // This counts suppressed JUDGING PASSES, not individual would-be exits: the
    // judges never ran, so which exits would have fired is unknowable without
    // running them — and running them is exactly what takeover forbids.
    if (decision.takenOver) {
      this.stats.takeover = this.stats.takeover || { set: 0, released: 0, sellsSuppressed: 0 };
      this.stats.takeover.sellsSuppressed++;
    }
    if ('tp1Arm' in decision) pos.tp1Arm = decision.tp1Arm;
    // shadow ratchet judge (record-only): judged on the same check, off the same
    // realizable move evaluateExit just used — it only ever writes journal records.
    if (valueSol != null) {
      const basis = pos.entrySol * pos.remainingFrac;
      const base = pos.entryRoundTrip > 0 ? pos.entryRoundTrip : 1;
      if (basis > 0) this.judgeRatchetShadow(pos, (valueSol / basis) / base, n);
    }
    // Shadow Seller (record-only): the learned judge reads the same check —
    // same realizable mark, the position's just-updated peak and flowHist —
    // and journals its first would-sell per position when its evidence table
    // (built from the bot's own completed history) condemns the bucket. It
    // only ever writes journal records; the ladder's decision above is untouched.
    if (valueSol != null) {
      try { if (this.shadowSeller) this.shadowSeller.observe(pos, { valueSol, view: v, n }); } catch { /* observer only — never disturb trading */ }
    }
    // Never-Green Cut SHADOW (record-only, owner 2026-10-17): judged on the
    // same check, off the same realizable ratio the tick journal computes
    // and the position's just-updated running peak. It only ever stamps
    // its own ngCut* fields on the position (persisted by this tick's
    // savePositions, like bagTrailSince) and writes journal records; the
    // ladder's decision above is untouched and nothing reads it back.
    if (valueSol != null) {
      try {
        if (this.neverGreen) {
          const ngBasis = pos.entrySol * pos.remainingFrac;
          const ngRatio = ngBasis > 0 ? valueSol / ngBasis : null;
          const rec = this.neverGreen.noteCheck(pos, { ratio: ngRatio, peakRatio: pos.peakRatio, valueSol, now: n });
          if (rec) { this.stats.neverGreen = this.stats.neverGreen || { fires: 0, paired: 0, deltaSol: 0 }; this.stats.neverGreen.fires++; }
        }
      } catch { /* observer only — never disturb trading */ }
    }
    // +20% progress callout: let the timeline know it's climbing (once per position)
    if (valueSol != null && !pos.climbCalloutDone) {
      const ratio = valueSol / Math.max(1e-9, pos.entrySol * pos.remainingFrac);
      if (ratio >= 1.2) {
        pos.climbCalloutDone = true; this.savePositions();
        // GATED with the entry callout (CALLOUTS_ENABLED): the moment is still
        // consumed either way; only the live post is skipped while disabled.
        if (this.cfg.calloutsEnabled) {
          postCallout({ address: pos.mint, symbol: pos.symbol, mc: v.mc }, { setup: pos.setup, metrics: {}, progress: true, gainPct: Math.round((ratio - 1) * 100) }, { enabled: true })
            .then(() => console.log('[callout] climbing update posted for', pos.symbol))
            .catch(e => console.log('[callout] climbing update failed:', e.message));
        }
      }
    }
    // learning log: trajectory sample every ~10s, and detection of a sell the human made in their own wallet
    if (valueSol != null && n - (pos.lastTickTs || 0) >= 10000) {
      pos.lastTickTs = n;
      // FAKE-ALIVE STAMP (record-only, owner 2026-10-18): score this sample
      // against the position's sampled history BEFORE the tick is written, so
      // the tick itself carries the running share. Fail-silent observer —
      // nothing anywhere branches on the result.
      if (this.cfg.fakeAliveStamp) {
        try { sampleFakeAlive(pos, { ratio: +(valueSol / Math.max(1e-9, pos.entrySol * pos.remainingFrac)).toFixed(3), buysM5: v.buysM5 ?? null, sellsM5: v.sellsM5 ?? null, ts: n }); } catch { /* record-only */ }
      }
      this.journal.tick({ id: pos.id, mint: pos.mint, symbol: pos.symbol, ts: n, heldMin: +((n - pos.entryTs) / 60000).toFixed(2), valueSol: +valueSol.toFixed(6), ratio: +(valueSol / Math.max(1e-9, pos.entrySol * pos.remainingFrac)).toFixed(3), peak: +(pos.peakRatio || 1).toFixed(3), mc: v.mc ?? null, liq: v.liq ?? null, buysM5: v.buysM5 ?? null, sellsM5: v.sellsM5 ?? null, bundle: pos.bundleScore || 0, fakeAlive: fakeAliveStamp(pos)?.share ?? null, censusUniqW: pos.census ? censusWindow(pos.census, n, this.cfg.censusWindowMin * 60000)?.uniqBuyers ?? null : null, censusNewW: pos.census ? censusWindow(pos.census, n, this.cfg.censusWindowMin * 60000)?.newBuyers ?? null : null });
      // D1 (record-only): the position's own recent path rides on the position
      // itself (≤24 samples ≈ last 4 min) so a manual exit can attach its
      // last-120s price path without re-reading the tick journal.
      pos.ticks = pos.ticks || [];
      pos.ticks.push({ ts: n, price: v.price ?? null, ratio: +(valueSol / Math.max(1e-9, pos.entrySol * pos.remainingFrac)).toFixed(4) });
      if (pos.ticks.length > 24) pos.ticks.splice(0, pos.ticks.length - 24);
      // manual exit detection: on-chain balance far below what the bot holds, 2 checks in a row
      if (this.cfg.realMode && n - pos.entryTs > 60000 && n - (pos.lastChainTs || 0) >= 15000) {
        pos.lastChainTs = n;
        const walletAddr = await this.exec.address().catch(() => null);
        const onchain = walletAddr ? await this.exec.ownerBalance(walletAddr, pos.mint).catch(() => null) : null;
        if (onchain != null && externalExit(pos.tokensRaw, onchain)) {
          pos.chainDropStrikes = (pos.chainDropStrikes || 0) + 1;
          if (pos.chainDropStrikes >= 2) {
            console.log(`[learn] manual exit detected for ${pos.symbol} — recording`);
            await this.recordManualExit(pos, valueSol, n, 'sold in own wallet');
            return;
          }
        } else {
          pos.chainDropStrikes = 0;
        }
      }
    }
    // bundle exit risk: watch the big wallets while we hold; fail-open (any error = no signal).
    // TAKEOVER: the bundle watcher is an exit judge too — it never runs on a taken-over position.
    if (valueSol != null && this.cfg.bundleWatch && !pos.takenOver && !(decision.fraction >= 1)) {
      const bd = await this.bundleCheck(pos, valueSol, n).catch(() => null);
      if (bd && bd.fraction > (decision.fraction || 0)) decision = { ...bd, newPeak: pos.peakRatio };
    }
    // Full-exit corroboration (remainder protection): one bad quote print must never
    // be able to dump a whole position. Before a full exit fires, re-quote NOW — a
    // real crash still reads crashed half a second later, while a glitch (DOGCART:
    // Jupiter quoted through the coin's dead bonding-curve pair, printing -56%
    // while the live pool sat at +33%) flips back. Disagreement beyond
    // STOP_XCHECK_PCT vetoes the exit for this tick only; the next tick re-judges,
    // so a real crash is delayed by seconds, not denied.
    if (decision.fraction >= 1 && this.cfg.stopXcheck && valueSol != null) {
      const basis = Math.max(1e-9, pos.entrySol * pos.remainingFrac);
      const ratioNow = valueSol / basis;
      const reValue = await this.exec.markValue(pos.mint, pos.tokensRaw).catch(() => null);
      if (reValue != null) {
        const reRatio = reValue / basis;
        if (reRatio > ratioNow * (1 + this.cfg.stopXcheckPct) || reRatio < ratioNow * (1 - this.cfg.stopXcheckPct)) {
          console.log(`[xcheck] ${pos.symbol}: vetoed full exit '${decision.reason}' — mark ${ratioNow.toFixed(3)} vs instant re-quote ${reRatio.toFixed(3)} disagree`);
          pos.xcheckVetoes = (pos.xcheckVetoes || 0) + 1;
          this.savePositions();
          return;
        }
      }
    }
    if (!(decision.fraction > 0)) { this.savePositions(); return; }

    const sellRaw = decision.fraction >= 1 ? BigInt(pos.tokensRaw) : (BigInt(pos.tokensRaw) * BigInt(Math.round(decision.fraction * 1000))) / 1000n;
    let res;
    try { res = await this.exec.sell(pos.mint, sellRaw.toString()); }
    catch (e) { pos.suspectUnbookedSell = true; this.savePositions(); throw e; } // the swap may have landed anyway — reconcile next tick
    const sold = BigInt(res.tokensSold || '0');
    if (sold <= 0n) { pos.suspectUnbookedSell = true; pos.markFails = (pos.markFails || 0) + 1; this.savePositions(); return; }
    pos.suspectUnbookedSell = false;
    pos.tokensRaw = (BigInt(pos.tokensRaw) - sold).toString();
    pos.realizedSol += res.solOut;
    pos.feesSol = (pos.feesSol || 0) + (this.cfg.txFeeSol || 0);
    this.stats.exits++;
    if (decision.tp1) {
      pos.tp1Done = true; pos.remainingFrac *= (1 - decision.fraction);
      delete pos.tp1AtPct; // a TP1 override (POST /tp1at) is spent by its fire — and by ANY TP1 fire, since tp1Done makes the field inert from here on
      // Two-path classification (user 2026-10-15): exits.js stamped the class from
      // the TP1 fire's realized gain — persist it on the position (the journal
      // records below pick it up via pos.pathClass) and count modest classifications.
      if (decision.pathClass) {
        pos.pathClass = decision.pathClass;
        pos.killZoneOverlay = !!decision.killZoneOverlay;
        if (decision.pathClass === 'modest') {
          this.stats.modestPath = this.stats.modestPath || { classified: 0, targetHits: 0, splits: 0 };
          this.stats.modestPath.classified++;
        }
        console.log(`[paths] ${pos.symbol}: TP1 classified ${decision.pathClass}${pos.killZoneOverlay ? ' + kill-zone overlay' : ''}`);
      }
    }
    if (decision.modestSplit) {
      // The modest target banked modestSplitBankFrac of the remainder; the
      // surviving slice converts to the ladder path from this moment — TP2, the
      // trails and the moonbag judge it as a ladder remainder from here on.
      pos.pathClass = 'ladder';
      pos.splitDone = true;
      pos.remainingFrac *= (1 - decision.fraction);
      this.stats.modestPath = this.stats.modestPath || { classified: 0, targetHits: 0, splits: 0 };
      this.stats.modestPath.targetHits++;
      this.stats.modestPath.splits++;
      console.log(`[paths] ${pos.symbol}: modest target hit — remainder split banked, slice converted to ladder`);
    }
    if (decision.tp2) { pos.tp2Done = true; pos.remainingFrac *= (1 - decision.fraction); }
    if (decision.bagWave) {
      // Staged moonbag dead flow (user order 2026-10-16): the wave sold a
      // fraction of the CURRENT bag — shrink the book's remainder by the
      // same fraction, exactly as a TP bank books; the position stays open.
      pos.remainingFrac *= (1 - decision.fraction);
      console.log(`[deadflow] ${pos.symbol}: wave ${decision.bagWave} booked — bag remainder now ${(pos.remainingFrac * 100).toFixed(1)}% of the original position`);
    }
    if (decision.bagTrim) {
      // Moonbag trim (owner order 2026-10-17 ~00:27 EDT): the +200%-from-TP2
      // take sold half the CURRENT bag — shrink the book's remainder exactly
      // as a wave booking does; the position stays open. bagTrimDone rode
      // the decision's threaded state above, so it can never fire twice.
      pos.remainingFrac *= (1 - decision.fraction);
      console.log(`[bagtrim] ${pos.symbol}: moonbag trim booked — bag remainder now ${(pos.remainingFrac * 100).toFixed(1)}% of the original position`);
    }
    this.journal.trade({ type: 'sell', id: pos.id, mint: pos.mint, symbol: pos.symbol, fraction: decision.fraction, solOut: res.solOut, reason: decision.reason, sig: res.sig, simulated: res.simulated, ts: n, path: pos.pathClass || undefined });
    // Callout Shadow Lab (record-only): a banked TP is a would-call moment —
    // journaled off the EXECUTED sell above, never off a decision alone.
    if (decision.tp1) this.calloutLab.record({ trigger: 'tp1', ts: n, mint: pos.mint, symbol: pos.symbol, v, mc: v.mc ?? null, setup: pos.setup, source: 'position', holding: true, linkId: pos.id }).catch(() => {});
    if (decision.tp2) this.calloutLab.record({ trigger: 'tp2', ts: n, mint: pos.mint, symbol: pos.symbol, v, mc: v.mc ?? null, setup: pos.setup, source: 'position', holding: true, linkId: pos.id }).catch(() => {});

    if (decision.fraction >= 1 || BigInt(pos.tokensRaw) <= 0n) {
      const pnl = pos.realizedSol - pos.entrySol - (pos.feesSol || 0); // net of SOL network fees
      if (this.cfg.closeEmptyAccounts && this.exec.closeEmptyAccounts) this.exec.closeEmptyAccounts(pos.mint).catch(e => this.err('close account', e));
      this.positions = this.positions.filter(p => p.id !== pos.id);
      this._recordClose(pnl, pos.mint, pos.entrySol);
      // D1: the final sell's real fill (SOL per whole token, from the executed
      // quote's solOut ÷ tokens actually sold) rides on the close record.
      const soldWhole = pos.decimals != null && sold > 0n ? Number(sold) / 10 ** pos.decimals : null;
      const exitFillSol = soldWhole > 0 ? res.solOut / soldWhole : null;
      this.ensureClose(pos, { id: pos.id, mint: pos.mint, symbol: pos.symbol, setup: pos.setup, entrySol: pos.entrySol, exitSol: pos.realizedSol, pnlSol: +pnl.toFixed(6), heldMin: +((n - pos.entryTs) / 60000).toFixed(1), reason: decision.reason, simulated: pos.simulated, ts: n, exitFillSol, exitFillUsd: exitFillSol != null && solUsd > 0 ? +(exitFillSol * solUsd).toFixed(10) : null });
    }
    this.savePositions();
  }

  // D1 (record-only): the exit snapshot attached to every live-detected manual
  // sell, on the SAME manual_exits record the /exittag reason lands on. Built
  // from data the bot already holds: the position's own tick ring (last 120s
  // price path), its peak, the streamed-flow windows for held mints, and a
  // fresh RugCheck holder count vs the entry snapshot's. Anything with no
  // source at record time is null — largeHolderSells is always null today:
  // no holder-delta feed exists at exit time (named in the D1 report).
  async _manualSnapshot(pos, valueSol, n, pnlSol) {
    try {
      const basis = Math.max(1e-9, pos.entrySol * pos.remainingFrac);
      const ratioNow = valueSol != null ? valueSol / basis : null;
      const path = (pos.ticks || []).filter(t => n - t.ts <= 120000).map(t => ({ ts: t.ts, price: t.price ?? null, ratio: t.ratio ?? null }));
      const win = (a, b) => { const r = this.shadowFlow.windowRange(pos.mint, a, b); return r ? { buys: r.buys, sells: r.sells, buySol: +r.buySol.toFixed(4), sellSol: +r.sellSol.toFixed(4) } : null; };
      const f30 = win(n - 30000, n), f60 = win(n - 60000, n), fPrior = win(n - 120000, n - 60000);
      let holdersNow = null;
      try { const rug = await this.d.fetchRug(pos.mint); holdersNow = rug && rug.totalHolders != null ? rug.totalHolders : null; } catch { /* holder count is best-effort */ }
      await this._dasHolderSample(pos.mint); // record-only: the snapshot read also leaves a DAS holder sample in the series
      const holdersEntry = pos.entry && pos.entry.holders != null ? pos.entry.holders : null;
      return {
        path, pathSec: 120,
        ratioNow: ratioNow != null ? +ratioNow.toFixed(4) : null,
        peakRatio: pos.peakRatio ?? null,
        distFromPeakPct: ratioNow != null && pos.peakRatio > 0 ? +(((ratioNow / pos.peakRatio) - 1) * 100).toFixed(2) : null,
        flow: { last30s: f30, last60s: f60, prior60s: fPrior, source: (f30 || f60 || fPrior) ? 'stream' : null },
        holdersEntry, holdersNow, holdersChange: holdersEntry != null && holdersNow != null ? holdersNow - holdersEntry : null,
        largeHolderSells: null,
        heldMin: +((n - pos.entryTs) / 60000).toFixed(1),
        pnlSol: pnlSol != null ? +pnlSol.toFixed(6) : null,
        pnlPct: pnlSol != null && pos.entrySol > 0 ? +(pnlSol / pos.entrySol * 100).toFixed(2) : null,
      };
    } catch { return null; }
  }

  // D1 (record-only): the virtual-position state the paired shadow-exit
  // tracker runs the real exit stack against after a manual close — a copy of
  // exactly the fields evaluateExit reads, frozen at the manual exit.
  _pairedState(pos, n, manual) {
    return {
      id: pos.id, mint: pos.mint, symbol: pos.symbol, setup: pos.setup,
      entryTs: pos.entryTs, entrySol: pos.entrySol, entryPrice: pos.entryPrice,
      entryRoundTrip: pos.entryRoundTrip, entryVolH1: pos.entryVolH1 || 0,
      remainingFrac: pos.remainingFrac, peakRatio: pos.peakRatio || 1, peakMove: pos.peakMove || 1,
      tp1Done: !!pos.tp1Done, tp2Done: !!pos.tp2Done, tp1Arm: pos.tp1Arm || null,
      stallSince: pos.stallSince ?? null, stopArmedTs: pos.stopArmedTs ?? null,
      floorChecks: pos.floorChecks || 0, floorSince: pos.floorSince ?? null,
      probationSince: pos.probationSince ?? null, moveHist: pos.moveHist || [], exitPending: {}, stallPending: pos.stallPending ?? null, bagDeadWaves: pos.bagDeadWaves || 0, bagDeadHot: !!pos.bagDeadHot,
      flowHist: (pos.flowHist || []).slice(-45),
      manualTs: n, manualPnlSol: manual.pnlSol, manualMarkSol: manual.valueSol ?? null,
      // D1 follow-up: when the manual side was priced from the real sell tx,
      // the paired record says so (and carries the per-token fill)
      manualFillSource: manual.fillSource || null, manualFillSol: manual.fillSol ?? null,
      basisSol: pos.entrySol * pos.remainingFrac,
    };
  }

  // the human closed this one outside the bot: record entry snapshot + estimated result, drop the position, await a reason tag
  async recordManualExit(pos, valueSol, n, how) {
    if (!this.positions.some(p => p.id === pos.id)) return null; // already closed (e.g. by reconcile) — don't log it twice
    const est = valueSol != null ? valueSol : 0;
    const estPnl = pos.realizedSol + est - pos.entrySol - (pos.feesSol || 0);
    const chain = await this.chainPnl(pos);
    const pnl = chain ? chain.pnl : estPnl;
    // D1 follow-up: the real fill from the detected sell tx, when readable —
    // async gravy on the recorded close; unreadable keeps today's nulls.
    const ff = this._manualFill(pos, await this.chainSellFill(pos));
    const hasFill = ff.exitFillSol != null;
    const snapshot = await this._manualSnapshot(pos, valueSol, n, pnl);
    const rec = this.journal.manualExit({ id: pos.id, mint: pos.mint, symbol: pos.symbol, ts: n, how, entry: pos.entry || null, heldMin: +((n - pos.entryTs) / 60000).toFixed(1), peakRatio: pos.peakRatio, bundleScore: pos.bundleScore || 0, pnlSolEstimate: +estPnl.toFixed(6), pnlSol: chain ? +pnl.toFixed(6) : null, pnlSource: chain ? 'chain' : 'estimate', reason: null, snapshot, exitFillSol: hasFill ? ff.exitFillSol : null, fillSource: hasFill ? ff.fillSource : null });
    this.positions = this.positions.filter(p => p.id !== pos.id);
    this._recordClose(pnl, pos.mint, pos.entrySol);
    this.ensureClose(pos, { manual: true, id: pos.id, mint: pos.mint, symbol: pos.symbol, setup: pos.setup, entrySol: pos.entrySol, pnlSol: +pnl.toFixed(6), estimated: !chain, pnlSource: chain ? 'chain' : 'estimate', heldMin: rec.heldMin, reason: `manual exit (${how})`, simulated: pos.simulated, entry: pos.entry, ts: n, ...(hasFill ? { exitFillSol: ff.exitFillSol, exitFillUsd: ff.exitFillUsd, fillSource: ff.fillSource, sellTxFeeSol: ff.sellTxFeeSol, sellSigs: ff.sellSigs, feesSol: ff.feesSol, feesSource: ff.feesSource } : {}) });
    // D1 paired shadow exit: keep judging this position's remainder virtually
    // (its manual side prices off the REAL fill when one was read)
    try { this.paired.watch(this._pairedState(pos, n, { pnlSol: +pnl.toFixed(6), valueSol: hasFill ? ff.manualValueSol : valueSol, fillSource: hasFill ? ff.fillSource : null, fillSol: hasFill ? ff.exitFillSol : null })); } catch { /* observer only */ }
    this.savePositions();
    return rec;
  }
  async markManualExit(id) {
    const pos = this.positions.find(p => p.id === id); if (!pos) return null;
    const valueSol = await this.exec.markValue(pos.mint, pos.tokensRaw).catch(() => null);
    return this.recordManualExit(pos, valueSol, this.now(), 'marked in dashboard');
  }

  // ------------------------------------------------------------ introspection
  state() {
    return {
      mode: this.cfg.realMode ? 'REAL' : 'SHADOW',
      modeWarning: this.cfg.modeWarning,
      halted: this.halted(),
      risk: this.risk.snapshot(),
      limits: { tradeSol: this.risk.effectiveTradeSol(), maxPositions: this.cfg.maxPositions, dailyLossSol: this.cfg.dailyLossSol, maxTradesPerHour: this.cfg.maxTradesPerHour, tp1Pct: this.cfg.tp1Pct, tp1Frac: this.cfg.tp1Frac },
      flowConfirm: this._flowConfirmState(),
      grindJudge: this._grindJudgeState(),
      census: this.stats.census || null,
      archive: this.archiveStats || null,
      watchlist: this.watch.size,
      pairedShadow: this.paired ? { pending: this.paired.pending.size, done: this.paired.done.length } : { pending: 0, done: 0 },
      positions: this.positions.map(p => ({ id: p.id, symbol: p.symbol, mint: p.mint, setup: p.setup, entrySol: p.entrySol, remainingFrac: p.remainingFrac, peakRatio: +(p.peakRatio || 1).toFixed(2), heldMin: +((this.now() - p.entryTs) / 60000).toFixed(1), simulated: p.simulated, noTp: !!p.noTp, protected: p.protected || null, takenOver: p.takenOver || null, tp1AtPct: p.tp1AtPct ?? null, path: p.pathClass || null, stallPending: p.stallPending ?? null, bagDeadWaves: p.bagDeadWaves ?? null, ddVitals: p.ddVitals ?? null, fakeAlive: fakeAliveStamp(p), census: censusStamp(p, this.now(), this.cfg.censusWindowMin * 60000) })),
      // stats.shadowTrades is read from the tracker at read time so /state can
      // never show a stale report card between the maintained sync points
      // gtOutcomes is read from the gtFetch tallies at read time (same pattern
      // as shadowTrades) so /state never shows a stale split between syncs
      stats: { ...this.stats, gtOutcomes: gtOutcomesSnapshot(), ...(this.shadowTrades ? { shadowTrades: this.shadowTrades.totalsView() } : {}) },
    };
  }
}
