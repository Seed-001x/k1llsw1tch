// journal.js — the part that tells you whether any of this actually works.
//
// EVERY signal is logged — taken AND skipped — with the price at signal time. Then each signal is
// followed forward and its return is recorded at +5 / +15 / +60 minutes (plus best/worst seen).
// /report aggregates by setup and decision, and for skipped signals by skip reason, so you can see:
//   • does each detector have any edge at all?  (taken vs. nothing)
//   • are the gates SAVING you (skipped coins do badly) or COSTING you (skipped coins do great)?
// Files are append-only JSONL under DATA_DIR. Use a persistent disk or they vanish on redeploy.
//
// OUTCOME-TRACKING FIX (2026-10-14, record-only — diagnosed from the live journal, 3,367 signals):
// checkpoints used to starve because observe() was fed ONLY by the trading poll (watchlist ∪
// positions). A skipped coin leaves the watch within WATCH_TTL_MIN (20m) unless rediscovered —
// r60 needs 60m of views, so it starved by construction; coins evicted inside 5 minutes lost
// everything (19% of finished skips were never observed again after their signal: excursions
// exactly 0/0; the young-coin 'no RugCheck report' cohort: 8/12 never re-observed, 9/12 expired,
// only 4/12 with any checkpoint). Taken trades starved too (r60 on 72%: positions close in
// minutes, then the mint is on the same 20m TTL). Restarts compounded it: progress was
// memory-only (reset at boot) and signals ≥90m old at boot were orphaned forever (14, up to
// 95h). The fix: (1) Bot.outcomeTick polls pending mints independently of the watchlist and
// feeds observe() — observations no longer depend on watch residence; (2) pending progress is
// persisted (outcome_pending.json) and restored at boot, with past-horizon signals finalized
// at boot; (3) finish() flags completeness (partial / missing / fillAgeMin / unobserved)
// instead of silent nulls.

import fs from 'node:fs';
import path from 'node:path';
import { mean, median, round } from './util.js';
import { pickResignalMark, verdictOf, buildResignalCard } from './resignalLab.js';
import { foldStampedPopSignals, buildDeadEntryCard } from './deadEntryLab.js';

const CPS = [5, 15, 60];          // minutes
const EXPIRE_MIN = 90;
const KEEP = 5000;

function readTail(file, n) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-n).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function readAll(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// Stable identity for one human feedback mark, used to attach the user's
// free-text note (2026-10-15) to the exact mark it belongs to. Marks made from
// a signal card carry that signal's id; anything older falls back to
// mint+timestamp, which is unique in practice (one mark per tap).
export function feedbackKeyOf(rec) {
  if (!rec) return null;
  return rec.signalId ? `sid:${rec.signalId}` : `mt:${rec.mint}:${rec.ts}`;
}

export class Journal {
  constructor(dir, { now = Date.now } = {}) {
    this.now = now;
    this.dir = dir;
    this.f = { sig: path.join(dir, 'signals.jsonl'), out: path.join(dir, 'outcomes.jsonl'), trades: path.join(dir, 'trades.jsonl'), fb: path.join(dir, 'feedback.jsonl'), ticks: path.join(dir, 'ticks.jsonl'), manual: path.join(dir, 'manual_exits.jsonl'), reports: path.join(dir, 'trade_reports.jsonl'), rshadow: path.join(dir, 'ratchet_shadow.jsonl'), pend: path.join(dir, 'outcome_pending.json'), scan: path.join(dir, 'scans.jsonl'), sses: path.join(dir, 'scan_sessions.jsonl'), cshadow: path.join(dir, 'callout_shadow.jsonl'), rsig: path.join(dir, 'resignal_shadow.jsonl'), fexit: path.join(dir, 'flow_exits.jsonl'), swatch: path.join(dir, 'structure_watch.jsonl'), ssell: path.join(dir, 'shadow_sell.jsonl'), stair: path.join(dir, 'staircase_signals.jsonl'), pticks: path.join(dir, 'position_ticks.jsonl'), bwatch: path.join(dir, 'bottom_marks.jsonl'), rwatch: path.join(dir, 'range_marks.jsonl'), ngcut: path.join(dir, 'nevergreen.jsonl'), fconfirm: path.join(dir, 'flow_confirm.jsonl') };
    this._pendDirty = false;   // outcome-tracking progress changed since the last save
    this._pendSavedAt = 0;
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    this.signals = [];        // { id, ts, mint, symbol, setup, decision, reasons, price, mc, out:{} }
    this.byId = new Map();
    this.pending = new Map(); // id -> tracking state
    this.trades = [];
    this.feedback = [];       // human feedback on skipped signals
    this.manual = [];         // positions the HUMAN closed (with entry snapshot + optional reason tag)
    this.tradeReports = [];   // full report after every N closes (see reports.js)
    this.seq = 0;
    this.scans = [];     // one compact record per discovery cycle (freeze work 1b)
    for (const sc of readTail(this.f.scan, 200)) this.scans.push(sc);
    this.scanSessions = []; // Scan Ledger (2026-10-16): one record per coin watch session — the permanent trace of every scanned coin, signaled or not
    for (const ss of readTail(this.f.sses, KEEP)) this.scanSessions.push(ss);
    this.ratchet = [];   // ratchet_shadow.jsonl tail for the read-only /ratchetshadow endpoint (records are rare — a 500 tail spans months)
    for (const r of readTail(this.f.rshadow, 500)) this.ratchet.push(r);
    this.shadowSells = []; // Shadow Seller (2026-10-16): would-fire + paired records for the read-only /shadowseller endpoint — the capped tail feeds the card and the judge's fire-once/pairing rebuild at boot
    for (const r of readTail(this.f.ssell, KEEP)) this.shadowSells.push(r);
    this.neverGreenRecs = []; // Never-Green Cut shadow (2026-10-17): would-fire + paired records for the read-only /nevergreen endpoint — the capped tail feeds the card and the judge's fire-once/pairing rebuild at boot
    for (const r of readTail(this.f.ngcut, KEEP)) this.neverGreenRecs.push(r);
    this.resignalFired = new Set();   // answered-resignal shadow: mark keys that already produced a record (rebuilt from resignal_shadow.jsonl in boot())
    this._rsigCache = null; this._rsigCacheTs = 0;
    this.boot();
  }

  boot() {
    for (const s of readTail(this.f.sig, KEEP)) { s.out = {}; this.signals.push(s); this.byId.set(s.id, s); this.seq = Math.max(this.seq, Number(String(s.id).split('-').pop()) || 0); }
    for (const o of readTail(this.f.out, KEEP * 2)) { const s = this.byId.get(o.id); if (s) s.out = o; }
    this.trades = readTail(this.f.trades, KEEP);
    this.tradeReports = readTail(this.f.reports, 100);
    this.feedback = [];
    for (const r of readTail(this.f.fb, KEEP)) {
      // Note lines (type 'note', appended by setFeedbackNote) are NOT marks:
      // they annotate the mark their key names and must never be counted as
      // feedback by the learn aggregates that scan this array.
      if (r.type === 'note') { const f = this.feedback.find(x => feedbackKeyOf(x) === r.key); if (f) { if (r.note) f.note = r.note; else delete f.note; } }
      else this.feedback.push(r);
    }
    // Answered-resignal fired set: one record per (mint, mark) pair, ever —
    // rebuilt from the journal file itself so a restart can never re-fire a
    // mark that already produced a record. A NEWER mark on the same mint is
    // a different key and re-arms it (see resignalLab.js).
    for (const r of readTail(this.f.rsig, KEEP * 4)) if (r && r.kind === 'resignal' && r.markKey) this.resignalFired.add(r.markKey);
    for (const r of readTail(this.f.manual, KEEP)) {
      if (r.type === 'tag') { const m = this.manual.find(x => x.id === r.id); if (m) m.reason = r.reason; }
      else this.manual.push(r);
    }
    const n = this.now();
    // Outcome-tracking progress is PERSISTED (outcome_pending.json, saved by
    // savePending) because the pre-fix design kept it in memory only: every
    // restart reset earned checkpoints/excursions to the signal price, and any
    // signal already older than EXPIRE_MIN at boot was never re-registered —
    // it stayed out={} forever (14 such orphans in the live journal, up to 95h
    // old, when this was measured 2026-10-14). Now: unfinished signals restore
    // their saved progress; signals past the tracking horizon finalize AT BOOT
    // with whatever progress exists, flagged partial — never silent limbo.
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(this.f.pend, 'utf8')) || {}; } catch { /* no saved progress */ }
    for (const s of this.signals) {
      if (!s.out || s.out.done) continue;
      if (!(s.price > 0)) continue;
      const sv = saved[s.id];
      const st = sv ? {
        max: Number.isFinite(sv.max) ? sv.max : s.price, min: Number.isFinite(sv.min) ? sv.min : s.price,
        got: sv.got && typeof sv.got === 'object' ? sv.got : {}, at: sv.at && typeof sv.at === 'object' ? sv.at : {}, obs: sv.obs || 0,
      } : { max: s.price, min: s.price, got: {}, at: {}, obs: 0 };
      if (n - s.ts <= EXPIRE_MIN * 60000) this.pending.set(s.id, st);
      else { this.pending.set(s.id, st); this.finish(s.id, s, st, true); }
    }
    this.savePending(); // boot finalizations + restored set are the new baseline
  }

  /** Persist in-flight outcome progress so a restart resumes tracking instead
   *  of resetting it. Whole-map rewrite; the pending set is small (≤90 min of
   *  signals). Best-effort — a failed write must never disturb the bot. */
  savePending() {
    try {
      const o = {};
      for (const [id, st] of this.pending) o[id] = { max: st.max, min: st.min, got: st.got, at: st.at || {}, obs: st.obs || 0 };
      fs.writeFileSync(this.f.pend, JSON.stringify(o));
      this._pendDirty = false; this._pendSavedAt = this.now();
    } catch { /* disk full etc. — never crash the bot */ }
  }

  /** Throttled savePending for hot paths (observe marks dirty; the bot's
   *  outcome-observer tick flushes at most every 15s). */
  flushPending() {
    if (this._pendDirty && this.now() - this._pendSavedAt >= 15000) this.savePending();
  }

  /** Mints with outcome tracking in flight, oldest signal first — the
   *  outcome observer polls exactly these, independently of the watchlist. */
  pendingMints() {
    const byMint = new Map();
    for (const [id] of this.pending) {
      const s = this.byId.get(id);
      if (!s) continue;
      if (!byMint.has(s.mint) || s.ts < byMint.get(s.mint)) byMint.set(s.mint, s.ts);
    }
    return [...byMint.entries()].map(([mint, since]) => ({ mint, since })).sort((a, b) => a.since - b.since);
  }

  append(file, obj) { try { fs.appendFileSync(file, JSON.stringify(obj) + '\n'); } catch { /* disk full etc. — never crash the bot */ } }

  /** Wipe all human feedback. Returns count cleared. */
  clearFeedback() {
    const n = this.feedback.length;
    this.feedback = [];
    try { require('fs').writeFileSync(this.f.fb, ''); } catch {}
    this._blacklistCache = null;
    return n;
  }

  /** per-position trajectory sample (for replaying exit rules later) */
  tick(t) { this.append(this.f.ticks, t); }
  /** position-tick journal record (RECORD-ONLY, 2026-10-16): one per position
   *  check (~4s), written by Bot._tickJournal — what the bot itself saw when it
   *  judged the position. Append-only and deliberately NEVER read back by this
   *  process: the file is an offline dataset (the bracket classifier's raw
   *  material), not an input. No in-memory tail — at ~4s cadence a tail is
   *  pointless weight; the /state counter (stats.tickJournal) is the surface. */
  positionTick(t) { this.append(this.f.pticks, t); }
  /** a position the human closed outside the bot */
  manualExit(rec) { this.manual.push(rec); if (this.manual.length > KEEP) this.manual.shift(); this.append(this.f.manual, rec); return rec; }
  /** shadow ratchet flow judge record (would-fire / would-fire-stream / fire-quality / close completion) — observer only, append-only; the capped in-memory tail feeds the /ratchetshadow aggregates */
  ratchetShadow(rec) { this.ratchet.push(rec); if (this.ratchet.length > 500) this.ratchet.shift(); this.append(this.f.rshadow, rec); return rec; }
  /** Callout Shadow Lab record (would-call / score) — append-only, observer only. Deliberately NO in-memory tail: the scorecard reads the full file from disk (14-day windows outgrow any sane cap), so nothing is kept here. */
  calloutShadow(rec) { this.append(this.f.cshadow, rec); return rec; }
  /** Answered re-signal record (record-only, 2026-10-15): a coin the user
   *  already answered signaled again. Writing the record CLAIMS the mark key
   *  in the fired set — that claim is the dedupe (one record per mint+mark). */
  resignal(rec) { if (rec.markKey) this.resignalFired.add(rec.markKey); this.append(this.f.rsig, rec); return rec; }
  /** Flow-exit watcher record (start / trim / exit / final) — append-only, observer only (see flowExits.js). Like the callout lab: NO in-memory tail; the watcher folds the full file itself. */
  flowExit(rec) { this.append(this.f.fexit, rec); return rec; }

  /** FLOW CONFIRMATION LANE events (2026-10-17): lifecycle records for
   *  the lane — above all the pre-registered kill rule's self-disablement
   *  (type 'flowConfirmDisabled', carrying the closes count + mean PnL at
   *  trip time) in its own file, searchable long after /state rotated. */
  flowConfirm(rec) { this.append(this.f.fconfirm, rec); return rec; }
  /** Structure Watch record (seed / sample / mark / mark-score / end / skip) — append-only, observer only (see structureWatch.js). No in-memory tail; the watch folds the full file itself. */
  structure(rec) { this.append(this.f.swatch, rec); return rec; }
  /** Shadow Seller record (fire / paired) — observer only, append-only; the capped in-memory tail feeds the /shadowseller card and the judge's boot rebuild of fired/pending state (see shadowSeller.js). */
  shadowSell(rec) { this.shadowSells.push(rec); if (this.shadowSells.length > KEEP) this.shadowSells.shift(); this.append(this.f.ssell, rec); return rec; }
  /** Staircase-3 shadow signal record (record-only, user 2026-10-16) — append-only, observer only (see staircaseSignal.js). Like the structure watch: NO in-memory tail; the module folds its file itself and joins mark scores from the structure journal at read time. */
  staircaseSignal(rec) { this.append(this.f.stair, rec); return rec; }

  /** Never-Green Cut shadow record (record-only, owner 2026-10-17) — would-fires and their close pairings (see neverGreen.js). Kept in memory like the shadow sells: the card reads the tail and the judge rebuilds its fire-once/pairing state from it at boot. */
  neverGreen(rec) { this.neverGreenRecs.push(rec); if (this.neverGreenRecs.length > KEEP) this.neverGreenRecs.shift(); this.append(this.f.ngcut, rec); return rec; }
  /** Bottom Tracker record (episode / mark / mark-score / episode-end — record-only, user 2026-10-16): append-only, observer only (see bottomWatch.js). Like the structure watch: NO in-memory tail; the module folds its file itself. */
  bottomWatch(rec) { this.append(this.f.bwatch, rec); return rec; }
  /** Range Study record (mark / mark-score / episode-end — record-only, user 2026-10-16): append-only, observer only (see rangeWatch.js). Like the structure watch: NO in-memory tail; the module folds its file itself. */
  rangeWatch(rec) { this.append(this.f.rwatch, rec); return rec; }

  /** The resignal matcher, run on every freshly journaled signal (fail-silent
   *  at the call site): if the mint carries a user mark on an EARLIER signal
   *  and that mark has not fired yet, journal the re-signal with his verdict
   *  and note so the /resignals scorecard can join this signal's outcome by
   *  id at read time. Observer only — reads feedback, writes one record. */
  _noteResignal(rec) {
    if (!this.feedback.length) return;
    const hit = pickResignalMark(rec, this.feedback, this.byId, this.signals, this.resignalFired);
    if (!hit) return;
    const { mark, key, resolved } = hit;
    this.resignal({
      kind: 'resignal', ts: rec.ts, mint: rec.mint, symbol: rec.symbol || null,
      verdict: verdictOf(!!mark.good, resolved.markedDecision), good: !!mark.good, markKey: key,
      notePresent: !!mark.note, note: mark.note ? String(mark.note).slice(0, 500) : null,
      markedTs: resolved.markedTs, markedMc: resolved.markedMc, markedSetup: resolved.markedSetup, markedDecision: resolved.markedDecision,
      resignalMc: rec.mc ?? null, resignalSetup: rec.setup || null, resignalDecision: rec.decision || null,
      signalKey: rec.id,
    });
  }

  /** Full resignal_shadow.jsonl with a ~60s cache (the file only appends, so
   *  a fresh record can lag the card by up to the cache window — the same
   *  trade the callout scorecard makes; windows outgrow an in-memory tail). */
  resignalRecords() {
    const n = this.now();
    if (this._rsigCache && n - this._rsigCacheTs < 60000) return this._rsigCache;
    let recs = [];
    try {
      recs = fs.readFileSync(this.f.rsig, 'utf8').split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { recs = []; }
    this._rsigCache = recs; this._rsigCacheTs = n;
    return recs;
  }

  /** Read-only /resignals payload: resignal records joined at read time to
   *  the new signal's tracked outcome (journal.byId, restored across boots
   *  with the signals themselves) and split by the user's verdict. A record
   *  whose signal aged out of the in-memory window simply reads unfinalized. */
  resignalCard() {
    const outcomeOf = (id) => { const s = id ? this.byId.get(id) : null; return s && s.out && s.out.done ? s.out : null; };
    return { enabled: true, ...buildResignalCard(this.resignalRecords(), outcomeOf) };
  }

  /** Read-only /deadentry payload (record-only study, user GO 2026-10-15):
   *  the dead-entry veto stamps folded against forward outcomes. Computed
   *  from the FULL signals + outcomes files — the judging window spans
   *  >= 14 days, past the in-memory KEEP tail — with a ~30s cache (the
   *  callout lab's pattern). Outcomes are appended synchronously by
   *  finish(), so the file fold is current; still-tracking signals fold
   *  as pending, never as scored zeros. */
  deadEntryCard() {
    const n = this.now();
    if (this._deCard && n - this._deCardTs < 30000) return this._deCard;
    const rows = foldStampedPopSignals(readAll(this.f.sig), readAll(this.f.out));
    const card = buildDeadEntryCard(rows, n);
    this._deCard = card; this._deCardTs = n;
    return card;
  }
  /** attach the reason the human gave (see learn.js EXIT_REASONS) */
  tagExit(id, reason, note) {
    let m = this.manual.find(x => x.id === id);
    if (!m) {
      // also allow tagging regular closed trades (e.g. user closed it but bot recorded the close)
      const t = this.trades.find(x => x.type === 'close' && (x.id === id || x.mint === id));
      if (!t) return null;
      t.userTag = reason; if (note) t.userNote = note;
      this.saveTrades();
      return { id: t.id, symbol: t.symbol, userTag: reason };
    }
    m.reason = reason; if (note) m.note = note;
    this.append(this.f.manual, { type: 'tag', id, reason, note: note || undefined, ts: this.now() }); return m;
  }

  /** Human feedback: user marks a skipped signal as good (shouldn't have been skipped) or bad (correctly skipped). */
  recordFeedback({ mint, symbol, good, signalId = null }) {
    const rec = { ts: this.now(), mint, symbol, good: !!good, signalId };
    rec.key = feedbackKeyOf(rec);
    this.feedback.push(rec);
    if (this.feedback.length > KEEP) this.feedback.shift();
    this.append(this.f.fb, rec);
    return rec;
  }

  /** Attach (or clear, with an empty note) the user's free-text reason on one
   *  feedback mark — the "why I answered that way" the user asked for on
   *  2026-10-15 (e.g. "great coin, signal came too late"). Record-only data:
   *  nothing in the trading path reads notes. Persisted as an appended note
   *  line in feedback.jsonl and re-applied at boot (see boot()). */
  setFeedbackNote(key, note) {
    const f = this.feedback.find(x => feedbackKeyOf(x) === key);
    if (!f) return null;
    const clean = typeof note === 'string' ? note.trim().slice(0, 500) : '';
    if (clean) f.note = clean; else delete f.note;
    this.append(this.f.fb, { type: 'note', key, note: clean || null, ts: this.now() });
    return f;
  }

  /** The user's answered signals, newest first, each joined to its signal
   *  record (by signal id, else the latest signal for that mint at or before
   *  the mark) so the dashboard's Answers tab can show what the mark was on
   *  and how the coin actually did. Read-only view; notes included. */
  feedbackList() {
    const out = [];
    for (let i = this.feedback.length - 1; i >= 0; i--) {
      const f = this.feedback[i];
      let sig = f.signalId ? this.byId.get(f.signalId) : null;
      if (!sig) {
        for (let j = this.signals.length - 1; j >= 0; j--) {
          const s = this.signals[j];
          if (s.mint === f.mint && s.ts <= f.ts) { sig = s; break; }
        }
      }
      out.push({
        key: feedbackKeyOf(f), ts: f.ts, mint: f.mint, symbol: f.symbol, good: f.good, signalId: f.signalId || null, note: f.note || null,
        signal: sig ? {
          id: sig.id, ts: sig.ts, symbol: sig.symbol, setup: sig.setup, decision: sig.decision, mc: sig.mc, price: sig.price, label: sig.label || null,
          out: sig.out && sig.out.done
            ? { done: true, r5: sig.out.r5 ?? null, r15: sig.out.r15 ?? null, r60: sig.out.r60 ?? null, maxRet: sig.out.maxRet ?? null, minRet: sig.out.minRet ?? null, partial: !!sig.out.partial }
            : { done: false },
        } : null,
      });
    }
    return out;
  }

  /** Returns Set of setup names the user has marked as bad on TAKEN trades (minBad+ times). 0 disables. */
  blacklistedSetups(minBad = 10) {
    const now = this.now();
    if (this._blacklistCache && now - this._blacklistCache.ts < 60000) {
      return this._blacklistCache.setups;
    }
    // Find feedback on taken trades (good=false)
    // We need to match feedback to trades by mint
    const badBySetup = {};
    for (const fb of this.feedback) {
      if (fb.good) continue; // only bad feedback
      // Find the trade or signal for this mint to get setup
      const trade = this.trades.find(t => t.mint === fb.mint);
      const sig = trade ? null : [...this.signals].reverse().find(s => s.mint === fb.mint && s.decision === 'taken');
      const setup = trade?.setup || sig?.setup;
      if (!setup) continue;
      if (!badBySetup[setup]) badBySetup[setup] = 0;
      badBySetup[setup]++;
    }
    const setups = new Set(
      Object.entries(badBySetup)
        .filter(([_, n]) => n >= minBad)
        .map(([k, _]) => k)
    );
    this._blacklistCache = { ts: now, setups };
    return setups;
  }

  /** Returns Set of specific mints the user has marked as bad. Per-token blocking. */
  blacklistedMints() {
    const mints = new Set();
    for (const fb of this.feedback) {
      if (!fb.good && fb.mint) mints.add(fb.mint);
    }
    return mints;
  }
  contestedGates() {
    const now = this.now();
    // Cache for 60s to avoid recomputing on every signal
    if (this._contestedCache && now - this._contestedCache.ts < 60000) {
      return this._contestedCache.gates;
    }
    const byReason = {};
    for (const fb of this.feedback) {
      let reasons = ['unknown'];
      if (fb.signalId) {
        const s = this.byId.get(fb.signalId);
        if (s && s.reasons) reasons = s.reasons;
      } else {
        const sig = [...this.signals].reverse().find(s => s.mint === fb.mint);
        if (sig && sig.reasons) reasons = sig.reasons;
      }
      const r = String(reasons[0] || 'unknown').split(':')[0];
      if (!byReason[r]) byReason[r] = { good: 0, bad: 0 };
      if (fb.good) byReason[r].good++;
      else byReason[r].bad++;
    }
    const gates = new Set(
      Object.entries(byReason)
        .filter(([_, v]) => (v.good + v.bad) >= 3 && v.good > v.bad)
        .map(([k, _]) => k)
    );
    this._contestedCache = { ts: now, gates };
    return gates;
  }

  /** One scan record per discovery cycle (record-only, freeze work 1b,
   *  user 2026-10-14): { ts, watchSize, intake: { source: mintsAdded } }. The
   *  funnel analysis found "coins scanned per hour" unrecoverable because no
   *  scan counts were ever persisted — this JSONL is that record. Kept to a
   *  small in-memory tail for the read-only /scans endpoint; the file is the
   *  durable copy. Append is best-effort (Journal.append never throws). */
  scan(rec) {
    this.scans.push(rec);
    if (this.scans.length > 200) this.scans.shift();
    this.append(this.f.scan, rec);
  }

  /** Scan Ledger session record (record-only, user 2026-10-16): one per
   *  coin watch session, written by Bot._finalizeScanSession when a watched
   *  coin goes idle or ages out — first/peak/last price + mc, the biggest
   *  run while watched, and whether any detector ever signaled it (joined
   *  at finalize from this.signals). Deliberately a SEPARATE file + array
   *  from scan()/scans.jsonl above: those are per-discovery-cycle counts
   *  (freeze work 1b) and mixing the two record types in one stream would
   *  corrupt both consumers. Append-only; the in-memory tail feeds /scanledger. */
  scanSession(rec) {
    this.scanSessions.push(rec);
    if (this.scanSessions.length > KEEP) this.scanSessions.shift();
    this.append(this.f.sses, rec);
    return rec;
  }

  signal({ mint, symbol, setup, decision, reasons = [], price, mc, metrics = null, warnings = [], label = null, gates = null, gatePass = null, fields = null, shadowGates = null, shadowGatePass = null, liqRechecks = null }) {
    const ts = this.now();
    const id = `${ts}-${++this.seq}`;
    const rec = { id, ts, mint, symbol, setup, decision, reasons, price, mc, metrics, warnings, label };
    // D1 (record-only): per-gate results ride on the signal record when the
    // pipeline computed them (skips, shadow evaluations, takes). Omitted when
    // null so pre-D1 records and paths that never reach the gates keep their
    // exact old shape.
    if (gates != null) rec.gates = gates;
    if (gatePass != null) rec.gatePass = gatePass;
    // Freeze work 1b (record-only): the would-be gate verdict for a signal the
    // RISK layer preempted before the gate stack could run — evaluated in
    // shadow (Bot.shadowGateRecord) purely for the record. Namespaced apart
    // from `gates`/`gatePass` so it can never be read as a live verdict; the
    // live decision and reasons are untouched by it. Omitted when null.
    if (shadowGates != null) rec.shadowGates = shadowGates;
    if (shadowGatePass != null) rec.shadowGatePass = shadowGatePass;
    // Signal fields (record-only, 2026-10-14): sampled-history context computed
    // at signal time by src/signalFields.js (holder growth, curve fill speed,
    // buy velocity). Omitted only when the caller computed none.
    if (fields != null) rec.fields = fields;
    // LIQ RE-CHECK (record-only, owner order 2026-10-17): how many 10s
    // re-reads this evaluation needed before its liquidity read healed
    // (or the window expired) — the provable stamp that the deferred
    // path produced this record. Omitted when the evaluation never
    // deferred, so untouched records keep their exact old shape.
    if (liqRechecks != null) rec.liqRechecks = liqRechecks;
    this.signals.push(rec); this.byId.set(id, rec); rec.out = {};
    if (this.signals.length > KEEP) { const old = this.signals.shift(); this.byId.delete(old.id); }
    this.append(this.f.sig, rec);
    if (price > 0) { this.pending.set(id, { max: price, min: price, got: {}, at: {}, obs: 0 }); this._pendDirty = true; }
    // Answered re-signals (record-only): a mint the user already answered is
    // signaling again — journal the shadow record (see resignalLab.js).
    try { this._noteResignal(rec); } catch { /* observer only — never disturb the signal path */ }
    // Structure Watch seeding (record-only): every signaled mint seeds an
    // hours-long structure + holder-series watch (see structureWatch.js).
    // The hook is a Bot-wired callback (the journal owns no watch state).
    try { if (this.onStructureSignal) this.onStructureSignal(rec); } catch { /* observer only — never disturb the signal path */ }
    return id;
  }

  /** Feed every fresh view in; advances outcome checkpoints for pending signals on that mint.
   *  Checkpoint rule (documented tolerance): a checkpoint fills from the FIRST
   *  observation at or after its age — catch-up fills are accepted however late
   *  the observation arrives inside the tracking horizon, and the outcome
   *  record carries fillAgeMin so analysts can apply their own lateness
   *  tolerance downstream instead of trusting a silently-late r5. What the fix
   *  changes is that observations are GUARANTEED to exist near the checkpoints:
   *  the bot's outcome observer polls pending mints independently of the
   *  watchlist (see Bot.outcomeTick), so catch-up fills become rare instead of
   *  the norm. */
  observe(view) {
    if (!view || !(view.price > 0)) return;
    const n = this.now();
    for (const [id, st] of this.pending) {
      const s = this.byId.get(id);
      if (!s) { this.pending.delete(id); continue; }
      if (s.mint !== view.address) continue;
      st.obs = (st.obs || 0) + 1;
      st.max = Math.max(st.max, view.price); st.min = Math.min(st.min, view.price);
      const ageMin = (n - s.ts) / 60000;
      for (const cp of CPS) {
        if (ageMin >= cp && st.got[cp] == null) { st.got[cp] = view.price / s.price - 1; (st.at ||= {})[cp] = ageMin; }
      }
      this._pendDirty = true;
      if (st.got[60] != null) this.finish(id, s, st, false);
    }
    this.expireSweep(n);
  }

  /** Finalize every pending signal past the tracking horizon with whatever
   *  progress it has (flagged partial — see finish). Runs inside observe();
   *  the bot's outcome observer also calls it directly so finalization never
   *  depends on some other mint producing a view. */
  expireSweep(n = this.now()) {
    for (const [id, st] of this.pending) {
      const s = this.byId.get(id);
      if (s && (n - s.ts) / 60000 > EXPIRE_MIN) this.finish(id, s, st, true);
    }
  }

  finish(id, s, st, expired) {
    // Completeness is explicit now (2026-10-14): pre-fix, an expired outcome
    // with no checkpoints was indistinguishable from a flat coin — `done`
    // overstated coverage (the 'no RugCheck report' cohort read 12/13 "done"
    // while only 4 carried any checkpoint). missing names what never filled;
    // partial = anything missing; unobserved = no post-signal observation
    // ever arrived (excursions are then the signal price itself, 0/0).
    const missing = CPS.filter(cp => st.got[cp] == null).map(cp => `r${cp}`);
    const o = {
      id, mint: s.mint, symbol: s.symbol, setup: s.setup, decision: s.decision,
      r5: round(st.got[5]), r15: round(st.got[15]), r60: round(st.got[60]),
      maxRet: round(st.max / s.price - 1), minRet: round(st.min / s.price - 1), done: true, expired,
      partial: missing.length > 0, missing,
      fillAgeMin: { r5: st.at && st.at[5] != null ? round(st.at[5], 1) : null, r15: st.at && st.at[15] != null ? round(st.at[15], 1) : null, r60: st.at && st.at[60] != null ? round(st.at[60], 1) : null },
      unobserved: !(st.obs > 0),
    };
    s.out = o; this.pending.delete(id); this.append(this.f.out, o);
    this.savePending();
  }

  trade(t) { this.trades.push(t); if (this.trades.length > KEEP) this.trades.shift(); this.append(this.f.trades, t); }
  addTradeReport(rec) { this.tradeReports.push(rec); if (this.tradeReports.length > 100) this.tradeReports.shift(); this.append(this.f.reports, rec); return rec; }

  recent(limit = 50) { return this.signals.slice(-limit).reverse(); }

  /** D1 pagination: newest-first page over the FULL in-memory signal history
   *  (KEEP-bounded), so a caller can walk past the old 200-record cap. */
  signalsPage({ offset = 0, limit = 50 } = {}) {
    const all = this.signals.slice().reverse();
    const off = Math.max(0, offset | 0);
    const lim = Math.max(1, limit | 0);
    return { total: all.length, offset: off, limit: lim, items: all.slice(off, off + lim) };
  }

  report() {
    const live = (s) => {  // outcomes may be partial while pending
      const st = this.pending.get(s.id);
      return st ? { r5: st.got[5], r15: st.got[15], r60: st.got[60], maxRet: st.max / s.price - 1 } : s.out || {};
    };
    const agg = (arr) => {
      const o = arr.map(live);
      const col = (k) => o.map(x => x[k]).filter(Number.isFinite);
      const r15 = col('r15');
      return {
        n: arr.length, withR15: r15.length,
        avgR5: round(mean(col('r5'))), avgR15: round(mean(r15)), medR15: round(median(r15)), avgR60: round(mean(col('r60'))),
        winRate15: r15.length ? round(r15.filter(x => x > 0).length / r15.length, 3) : null,
        avgMaxRet: round(mean(col('maxRet'))),
      };
    };
    const groups = {};
    for (const s of this.signals) (groups[`${s.setup}/${s.decision}`] ||= []).push(s);
    const bySetup = Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, agg(v)]));

    const skipped = this.signals.filter(s => s.decision === 'skipped');
    const cats = {};
    for (const s of skipped) {
      const r = (s.reasons && s.reasons[0]) || 'unknown';
      (cats[String(r).split(':')[0]] ||= []).push(s);
    }
    const bySkipReason = Object.fromEntries(Object.entries(cats).map(([k, v]) => [k, agg(v)]));

    const closed = this.trades.filter(t => t.type === 'close');
    const withPnl = closed.filter(t => t.pnlSol != null);
    const pnl = withPnl.map(t => t.pnlSol);
    const tradeStats = {
      closed: closed.length, closedWithPnl: withPnl.length, wins: withPnl.filter(t => t.pnlSol > 0).length,
      totalPnlSol: round(pnl.reduce((a, b) => a + b, 0), 5), avgPnlSol: withPnl.length ? round(mean(pnl), 5) : 0,
      byExitReason: Object.fromEntries(Object.entries(closed.reduce((m, t) => { const k = String(t.reason || '').split(' (')[0].split(' ')[0] || 'unknown'; (m[k] ||= []).push(t.pnlSol); return m; }, {})).map(([k, v]) => { const known = v.filter(x => x != null); return [k, { n: v.length, nWithPnl: known.length, pnlSol: round(known.reduce((a, b) => a + b, 0), 5) }]; })),
    };
    // Human feedback aggregated by skip reason: shows which gates the user disagrees with
    const fbByReason = {};
    for (const fb of this.feedback) {
      // Find the signal to get its skip reasons
      let reasons = ['unknown'];
      if (fb.signalId) {
        const s = this.byId.get(fb.signalId);
        if (s && s.reasons) reasons = s.reasons;
      } else {
        // Fallback: find most recent signal for this mint
        const sig = [...this.signals].reverse().find(s => s.mint === fb.mint);
        if (sig && sig.reasons) reasons = sig.reasons;
      }
      const r = String(reasons[0] || 'unknown').split(':')[0];
      if (!fbByReason[r]) fbByReason[r] = { good: 0, bad: 0, total: 0 };
      if (fb.good) fbByReason[r].good++;
      else fbByReason[r].bad++;
      fbByReason[r].total++;
    }
    // Flag reasons where user consistently disagrees (good > bad and total >= 3)
    const contested = Object.fromEntries(
      Object.entries(fbByReason)
        .filter(([_, v]) => v.total >= 3 && v.good > v.bad)
        .map(([k, v]) => [k, { ...v, contested: true, recommendation: `User marked ${v.good}/${v.total} as good — consider loosening this gate` }])
    );
    return {
      note: 'avgR* are mean returns of price vs. price at signal time. Skipped-signal returns that are strongly negative mean the gate is saving you; strongly positive means it is costing you.',
      signals: this.signals.length, bySetup, bySkipReason, trades: tradeStats,
      feedback: { byReason: fbByReason, contested, total: this.feedback.length },
    };
  }
}
