// server.js — HTTP status + control endpoints (POST /halt, /resume, /risk/reset, /positions/*).
// Nothing secret is ever exposed. HALT file in DATA_DIR stops new entries.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { listState } from './pumpLists.js';
import { EXIT_REASONS, EXIT_REASON_LABELS, learnReport } from './learn.js';

// Browser-scraped "real" pump.fun lists (from hourly browser task, not the API relay).
// Stored in DATA_DIR so it persists across deploys.
const DATA_DIR = process.env.DATA_DIR || './data';
const REAL_LISTS_FILE = path.join(DATA_DIR, 'reallists.json');
let realLists = { trending: [], movers: [], ts: 0 };
try {
  const raw = fs.readFileSync(REAL_LISTS_FILE, 'utf8');
  realLists = JSON.parse(raw);
} catch {}
function saveRealLists() {
  try { fs.writeFileSync(REAL_LISTS_FILE, JSON.stringify(realLists)); } catch {}
}

export function startServer(bot, port) {
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(body, null, 2)); };
  // D1 pagination: { limit, offset } when the caller asks to page, else null.
  // Endpoints that never had paging keep their EXACT legacy response when null
  // is returned, so the dashboard and existing consumers cannot break.
  const paging = (u) => {
    if (!u.searchParams.has('limit') && !u.searchParams.has('offset')) return null;
    return {
      limit: Math.min(5000, Math.max(1, parseInt(u.searchParams.get('limit') || '50', 10) || 50)),
      offset: Math.max(0, parseInt(u.searchParams.get('offset') || '0', 10) || 0),
    };
  };
  // Admin guard (user 2026-10-13: "only I can manage that"): write/control endpoints require
  // the x-admin-key header to match ADMIN_KEY when one is set. GETs stay public (the dashboard
  // is view-first and the user shares it for viewing), and POST /reallists stays open — the
  // hourly browser scrape posts there and its worst case is cosmetic mirror data. With no
  // ADMIN_KEY set (local/tests), everything behaves as before.
  const ADMIN_KEY = process.env.ADMIN_KEY || '';
  if (!ADMIN_KEY) console.log('[server] ADMIN_KEY not set — write endpoints are OPEN');
  const GUARDED = new Set(['/feedback', '/feedback/clear', '/feedback/note', '/exittag', '/temprules', '/positions/clear', '/positions/notp', '/protect', '/unprotect', '/takeover', '/release', '/tp1at', '/tp1clear', '/halt', '/resume', '/risk/reset']);
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(200, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type, x-admin-key',
      });
      res.end();
      return;
    }
    if (ADMIN_KEY && req.method !== 'GET' && (GUARDED.has(u.pathname) || u.pathname.startsWith('/positions/')) && req.headers['x-admin-key'] !== ADMIN_KEY) {
      return json(res, 401, { error: 'admin key required' });
    }
    // POST /feedback — human marks a skipped signal as good/bad
    if (req.method === 'POST' && u.pathname === '/feedback') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 10000) req.destroy(); });
      req.on('end', () => {
        try {
          const { mint, symbol, good, signalId } = JSON.parse(body);
          if (!mint) return json(res, 400, { error: 'mint required' });
          const rec = bot.journal.recordFeedback({ mint, symbol, good, signalId });
          return json(res, 200, { ok: true, feedback: rec });
        } catch (e) {
          return json(res, 400, { error: 'invalid JSON' });
        }
      });
      return;
    }
    // GET /feedback — the user's answered signals with notes + joined outcomes (Answers tab)
    if (req.method === 'GET' && u.pathname === '/feedback') {
      return json(res, 200, { feedback: bot.journal.feedbackList() });
    }
    // POST /feedback/note {key, note} — attach the user's "why I answered that way" to one mark (label only; cannot trade)
    if (req.method === 'POST' && u.pathname === '/feedback/note') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 5000) req.destroy(); });
      req.on('end', () => {
        try {
          const { key, note } = JSON.parse(body);
          if (!key || typeof key !== 'string') return json(res, 400, { error: 'key required' });
          if (typeof note !== 'string') return json(res, 400, { error: 'note must be a string' });
          const rec = bot.journal.setFeedbackNote(key, note);
          return rec ? json(res, 200, { ok: true, feedback: rec }) : json(res, 404, { error: 'no such feedback mark' });
        } catch { return json(res, 400, { error: 'invalid JSON' }); }
      });
      return;
    }
    // POST /feedback/clear — wipe all human feedback (fresh start)
    if (req.method === 'POST' && u.pathname === '/feedback/clear') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 1000) req.destroy(); });
      req.on('end', () => {
        try {
          const n = bot.journal.clearFeedback();
          return json(res, 200, { ok: true, cleared: n });
        } catch (e) {
          return json(res, 500, { error: e.message });
        }
      });
      return;
    }
    // POST /exittag {id, reason} — label WHY you closed a position yourself (label only; cannot trade)
    if (req.method === 'POST' && u.pathname === '/exittag') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 5000) req.destroy(); });
      req.on('end', () => {
        try {
          const { id, reason, note } = JSON.parse(body);
          if (!EXIT_REASONS.includes(reason)) return json(res, 400, { error: 'reason must be one of ' + EXIT_REASONS.join(', ') });
          const m = bot.journal.tagExit(id, reason, typeof note === 'string' ? note.slice(0, 300) : undefined);
          return m ? json(res, 200, { ok: true, exit: m }) : json(res, 404, { error: 'no such manual exit' });
        } catch { return json(res, 400, { error: 'invalid JSON' }); }
      });
      return;
    }
    // POST /manualexit {id} — SHADOW mode only: "I'd have closed this one". Needs header x-learn-key == LEARN_KEY.
    if (req.method === 'POST' && u.pathname === '/manualexit') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 5000) req.destroy(); });
      req.on('end', async () => {
        const key = process.env.LEARN_KEY;
        if (bot.cfg.realMode) return json(res, 400, { error: 'real mode: just sell in your wallet — the bot detects it' });
        if (!key || req.headers['x-learn-key'] !== key) return json(res, 401, { error: 'bad or missing key' });
        try { const { id } = JSON.parse(body); const r = await bot.markManualExit(id); return r ? json(res, 200, { ok: true, exit: r }) : json(res, 404, { error: 'no such open position' }); }
        catch { return json(res, 400, { error: 'invalid JSON' }); }
      });
      return;
    }
    // GET /learn — recent manual exits + comparison with bot winners.
    // D1: exit items now carry the entry snapshot + exit snapshot (they were
    // stripped here before, which hid exactly the fields learnReport compares),
    // and ?limit&offset walk the full manual-exit history (default: last 20,
    // unchanged shape plus the two additive fields).
    if (req.method === 'GET' && u.pathname === '/learn') {
      const report = learnReport(bot.journal.manual, bot.journal.trades);
      // D1 follow-up: the live settable reason set, inspectable from the API
      report.exitReasons = EXIT_REASONS.map(key => ({ key, label: EXIT_REASON_LABELS[key] }));
      const mapExit = (m) => ({ id: m.id, symbol: m.symbol, mint: m.mint, ts: m.ts, heldMin: m.heldMin, peakRatio: m.peakRatio, pnlSolEstimate: m.pnlSolEstimate, reason: m.reason || null, note: m.note || null, how: m.how, entry: m.entry || null, snapshot: m.snapshot || null });
      const pg = paging(u);
      if (pg) {
        const all = bot.journal.manual.slice().reverse(); // newest first
        const exits = all.slice(pg.offset, pg.offset + pg.limit).map(mapExit);
        report.exits = exits;
        report.recent = exits;
        report.total = all.length; report.offset = pg.offset; report.limit = pg.limit;
      } else {
        const exits = bot.journal.manual.slice(-20).reverse().map(mapExit);
        report.exits = exits;
        report.recent = exits; // dashboard expects `recent`
      }
      return json(res, 200, report);
    }
    // POST /reallists — browser task pushes scraped pump.fun lists (trending/movers/graduated/new, 50 each)
    if (req.method === 'POST' && u.pathname === '/reallists') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 1000000) req.destroy(); });
      req.on('end', () => {
        try {
          const { trending, movers, graduated, new: newCoins } = JSON.parse(body);
          if (!Array.isArray(trending) || !Array.isArray(movers)) return json(res, 400, { error: 'trending and movers arrays required' });
          realLists = {
            trending: trending.slice(0, 50),
            movers: movers.slice(0, 50),
            graduated: Array.isArray(graduated) ? graduated.slice(0, 50) : [],
            new: Array.isArray(newCoins) ? newCoins.slice(0, 50) : [],
            ts: Date.now()
          };
          saveRealLists();
          return json(res, 200, { ok: true, trending: realLists.trending.length, movers: realLists.movers.length, graduated: realLists.graduated.length, new: realLists.new.length, ts: realLists.ts });
        } catch (e) {
          return json(res, 400, { error: 'invalid JSON' });
        }
      });
      return;
    }
    if (req.method === 'DELETE' && u.pathname.startsWith('/positions/')) {
      const id = decodeURIComponent(u.pathname.slice(11));
      const removed = bot.dropPosition ? bot.dropPosition(id) : 0;
      return json(res, 200, { ok: true, removed });
    }
    if (req.method === 'POST' && u.pathname === '/positions/clear') {
      const cleared = bot.clearAllPositions ? bot.clearAllPositions() : 0;
      return json(res, 200, { ok: true, cleared });
    }
    if (req.method === 'POST' && u.pathname === '/temprules') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 2000) req.destroy(); });
      req.on('end', () => {
        try {
          const r = JSON.parse(body || '{}');
          const armed = bot.setTempRules ? bot.setTempRules(r) : null;
          return json(res, 200, { ok: true, tempRules: armed });
        } catch { return json(res, 400, { error: 'invalid JSON' }); }
      });
      return;
    }
    if (req.method === 'GET' && u.pathname === '/postexit') {
      if (!bot.postExit) return json(res, 200, { pending: [], done: [] });
      const pg = paging(u);
      let base;
      if (pg) {
        const all = bot.postExit.done.slice().reverse(); // newest first
        base = {
          pending: [...bot.postExit.pending.values()].map(e => ({ id: e.id, mint: e.mint, symbol: e.symbol, exitTs: e.exitTs, samples: e.samples.length })),
          done: all.slice(pg.offset, pg.offset + pg.limit),
          total: all.length, offset: pg.offset, limit: pg.limit,
        };
      } else {
        base = bot.postExit.recent(50);
      }
      // D1: paired shadow exits (would-be bot exits for manual closes) ride
      // along — additive key; pg walks their completed history too.
      base.paired = bot.paired ? bot.paired.page(pg || {}) : { pending: [], total: 0, offset: 0, limit: 50, done: [] };
      return json(res, 200, base);
    }
    if (req.method === 'GET' && u.pathname === '/shadowtrades') {
      // Trade-grade shadow (record-only): completed virtual trades + open
      // virtuals, the /postexit paired shape — page envelope when paging is
      // requested, the same envelope at the default page otherwise.
      if (!bot.shadowTrades) return json(res, 200, { pending: [], total: 0, offset: 0, limit: 50, done: [] });
      const pg = paging(u);
      return json(res, 200, bot.shadowTrades.page(pg || {}));
    }
    if (req.method === 'GET' && u.pathname === '/devwatch') {
      // Wallet-task shadow detectors (record-only): dev launches + survivor
      // confluence — per-dev aggregates with qualification FLAGS (promotion is
      // the user's call), the confluence stream aggregate, recent events.
      if (!bot.walletWatch) return json(res, 200, { enabled: false, devs: [], confluence: null, recent: [] });
      return json(res, 200, bot.walletWatch.snapshot());
    }
    if (req.method === 'GET' && u.pathname === '/ratchetshadow') {
      // Shadow ratchet judges (record-only): tick judge vs stream judge —
      // counters, per-kind journal tallies, the both-armed lead-time pairing,
      // stream coverage, and the newest records for the LAB card.
      if (!bot.ratchetShadowView) return json(res, 200, { enabled: false });
      return json(res, 200, bot.ratchetShadowView());
    }
    if (req.method === 'GET' && u.pathname === '/callouts') {
      // Callout Shadow Lab (record-only): would-call scorecard computed from
      // the full callout_shadow.jsonl — per-trigger follower-PnL aggregates
      // with readiness flags, per-day rows, the first-3-per-day simulation,
      // and the newest would-calls with their scores. Live callouts stay
      // governed by CALLOUTS_ENABLED; this endpoint never posts anything.
      if (!bot.calloutCard) return json(res, 200, { enabled: false });
      return json(res, 200, bot.calloutCard());
    }
    if (req.method === 'GET' && u.pathname === '/resignals') {
      // Answered re-signals (record-only): coins the user already marked
      // signaling again — per-verdict outcome aggregates (joined at read time
      // to each re-signal's tracked outcome) plus the recent records. The
      // baseline block is the pinned taken-pop context, labeled as such.
      if (!bot.resignalCard) return json(res, 200, { enabled: false });
      return json(res, 200, bot.resignalCard());
    }
    if (req.method === 'GET' && u.pathname === '/deadentry') {
      // Dead-Entry Veto study (record-only): every pop signal's stamp —
      // its own 5m volume + buy velocity and the would-block verdicts at
      // four volume lines and a 30/min velocity line — folded against the
      // signals' forward outcomes, vetoed vs passed, split into time
      // halves. Nothing gates on any of it; the card reports progress
      // toward the judging bar (>=300 vetoed + >=14 days).
      if (!bot.deadEntryCard) return json(res, 200, { enabled: false });
      return json(res, 200, bot.deadEntryCard());
    }
    if (req.method === 'GET' && u.pathname === '/flowexits') {
      // Flow-Exit Watcher (record-only): for flow-triggered entries, whether
      // the wallet that took the bot in exited first, how long it held, what
      // the bot made in those races, and the counterfactual delta of having
      // exited with the wallet — aggregates over the full flow_exits.jsonl
      // plus the newest trim/exit events (finals joined at read time).
      if (!bot.flowExitsCard) return json(res, 200, { enabled: false });
      return json(res, 200, bot.flowExitsCard());
    }
    if (req.method === 'GET' && u.pathname === '/structurewatch') {
      // Structure Watch (record-only): the 'healthy trend' dataset — coins
      // seeded at signal time and followed for hours: staircase state on 5m
      // candles, a holder-count series (DAS), would-enter marks at each
      // confirmed higher low scored forward, split by holder growth at the
      // mark. Aggregates over the full structure_watch.jsonl; nothing here
      // gates, buys, or sells.
      if (!bot.structureWatchCard) return json(res, 200, { enabled: false });
      return json(res, 200, bot.structureWatchCard());
    }
    if (req.method === 'GET' && u.pathname === '/reports') {
      return json(res, 200, (bot.journal.tradeReports || []).slice().reverse());
    }
    if (req.method === 'GET' && u.pathname === '/scans') {
      // Freeze work 1b: per-discovery-cycle scan records (watchlist size +
      // per-source intake), newest first. Default: the in-memory tail as a
      // bare array; limit/offset switches to the paging envelope, /trades-style.
      const all = (bot.journal.scans || []).slice().reverse();
      const pg = paging(u);
      if (!pg) return json(res, 200, all);
      return json(res, 200, { total: all.length, offset: pg.offset, limit: pg.limit, items: all.slice(pg.offset, pg.offset + pg.limit) });
    }
    if (req.method === 'GET' && u.pathname === '/scanledger') {
      // Scan Ledger (record-only, user 2026-10-16): the per-coin watch-session
      // ledger — totals, latest 100 sessions, and the near-miss list (biggest
      // runs while watched that never signaled) with r15/r60 joined when
      // scored. Deliberately NOT /scans: that route is the freeze-work-1b
      // per-discovery-cycle records and its shape is pinned.
      if (!bot.scanLedgerCard) return json(res, 200, { enabled: false });
      return json(res, 200, bot.scanLedgerCard());
    }
    if (req.method === 'GET' && u.pathname === '/shadowseller') {
      // Shadow Seller (record-only, user 2026-10-16): the learned exit
      // judge's would-fires paired against the ladder's actual outcomes on
      // the same remainders — totals { fires, paired, shadowWins, deltaSol },
      // recent pairings with post-exit moves joined, ready at 30 paired.
      if (!bot.shadowSellerCard) return json(res, 200, { enabled: false });
      return json(res, 200, bot.shadowSellerCard());
    }
    if (req.method === 'GET' && u.pathname === '/staircase') {
      // Staircase-3 Shadow Signal (record-only, user 2026-10-16): the
      // structure study's headline finding minted as a named signal —
      // every mark at ordinal >= 3 (3rd-or-later confirmed higher low)
      // journaled to staircase_signals.jsonl and outcome-tracked by the
      // watch's own forward scores, split fresh (3–5) vs deep (6+)
      // ordinals; ready at 30 finalized. Nothing here gates or trades.
      if (!bot.staircaseCard) return json(res, 200, { enabled: false });
      return json(res, 200, bot.staircaseCard());
    }
    if (req.method === 'GET' && u.pathname === '/nevergreen') {
      // Never-Green Cut SHADOW (record-only, owner 2026-10-17): positions
      // that never peaked above +2%, are 5+ min old, and print realizable
      // <= -10% for 2 consecutive checks would have been cut in full —
      // journaled to nevergreen.jsonl and paired against the actual close
      // on the same remainder; ready at 30 paired. Nothing here gates,
      // sells, or feeds any decision.
      if (!bot.neverGreenCard) return json(res, 200, { enabled: false });
      return json(res, 200, bot.neverGreenCard());
    }
    if (req.method === 'GET' && u.pathname === '/bottomwatch') {
      // Bottom Tracker (record-only, user 2026-10-16): watched coins that
      // dumped >= BOTTOM_DROP_PCT off their sampled peak, and the first
      // move back up off the established bottom — journaled to
      // bottom_marks.jsonl, forward-scored with the structure tailer,
      // split bot-exited vs watched; ready at 30 finalized. Nothing here
      // gates or trades.
      if (!bot.bottomWatchCard) return json(res, 200, { enabled: false });
      return json(res, 200, bot.bottomWatchCard());
    }
    if (req.method === 'GET' && u.pathname === '/rangewatch') {
      // Range Study (owner 2026-10-16): tight sideways bases held over
      // the trailing window, journaled one mark per range episode to
      // range_marks.jsonl, forward-scored with the structure tailer
      // and classed expanded / broke down / ranged; ready at 30
      // finalized. Aggregates stay mark-based; liveRouting notes the
      // RANGE_LIVE tap's evals + fired/taken 'range' signals (the
      // entries themselves run through Bot._evalRange → onSignal —
      // this endpoint only reports).
      if (!bot.rangeWatchCard) return json(res, 200, { enabled: false });
      return json(res, 200, bot.rangeWatchCard());
    }
    if (req.method === 'GET' && u.pathname === '/confluencesignal') {
      // Confluence Shadow Signal (record-only, user 2026-10-16): every
      // walletWatch confluence fire as a pair of DETECTION-time virtual
      // positions — SCALP (100% at +20% net) vs LADDER (the live exit
      // stack) on a 0.05 SOL shadow stake — per-profile aggregates over
      // the full confluence_signal.jsonl, scalp touch rate + median
      // time-to-touch, ready at 50 closes per profile. Nothing here
      // gates or trades.
      if (!bot.confluenceSignalCard) return json(res, 200, { enabled: false });
      return json(res, 200, bot.confluenceSignalCard());
    }
    if (req.method === 'POST' && u.pathname === '/positions/notp') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 2000) req.destroy(); });
      req.on('end', () => {
        try {
          const { id } = JSON.parse(body);
          const pos = bot.positions.find(p => p.id === id || p.mint === id);
          if (!pos) return json(res, 404, { error: 'no such position' });
          pos.noTp = true; bot.savePositions();
          return json(res, 200, { ok: true, symbol: pos.symbol });
        } catch { return json(res, 400, { error: 'invalid JSON' }); }
      });
      return;
    }
    // POST /protect {mint|symbol} — the user's one-time per-coin switch (user
    // 2026-10-15, "just the stop loss… no ratchet", "no SL until I say"): while the
    // flag is set on the open position, exits.js skips ONLY its stop-loss family
    // (dip stop, hard floor, grace stop) and the break-even ratchet; the bleed,
    // probation, stall, trails and the full TP ladder keep running. The flag holds
    // for the LIFE of the position — no timeout, survives restarts (it is stored on
    // the persisted position record) — and clears only when the position closes or
    // POST /unprotect clears it. A rebuy of the same mint starts unprotected.
    // POST /unprotect {mint|symbol} clears the flag early and re-arms both exits.
    if (req.method === 'POST' && (u.pathname === '/protect' || u.pathname === '/unprotect')) {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 2000) req.destroy(); });
      req.on('end', () => {
        try {
          const { mint, symbol } = JSON.parse(body || '{}');
          const key = mint || symbol;
          if (!key) return json(res, 400, { error: 'mint required' });
          const snap = (p) => ({ id: p.id, symbol: p.symbol, mint: p.mint, setup: p.setup, entrySol: p.entrySol, remainingFrac: p.remainingFrac, protected: p.protected || null });
          if (u.pathname === '/protect') {
            const pos = bot.protectPosition ? bot.protectPosition(key) : null;
            if (!pos) return json(res, 404, { error: 'no open position for that mint' });
            return json(res, 200, { ok: true, protected: pos.protected, position: snap(pos) });
          }
          const r = bot.unprotectPosition ? bot.unprotectPosition(key) : null;
          if (r === null) return json(res, 404, { error: 'no open position for that mint' });
          if (r === false) return json(res, 404, { error: 'position is not protected' });
          return json(res, 200, { ok: true, protected: null, position: snap(r) });
        } catch { return json(res, 400, { error: 'invalid JSON' }); }
      });
      return;
    }
    // POST /takeover {mint|symbol} — the manual takeover switch (user 2026-10-15,
    // the XZON race): the user takes the open position fully manual and the bot
    // must never sell it again — exit judging is skipped ENTIRELY for that
    // position (ladder, trails, stops, bleed, leash, time stops, liquidity death)
    // until POST /release hands it back with fresh arming, or the position closes
    // (his own manual sell books through the usual detector, race-free). The flag
    // lives on the persisted position record, holds for the life of the position,
    // and supersedes the protect flag when both are set. A rebuy starts untaken.
    if (req.method === 'POST' && (u.pathname === '/takeover' || u.pathname === '/release')) {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 2000) req.destroy(); });
      req.on('end', () => {
        try {
          const { mint, symbol } = JSON.parse(body || '{}');
          const key = mint || symbol;
          if (!key) return json(res, 400, { error: 'mint required' });
          const snap = (p) => ({ id: p.id, symbol: p.symbol, mint: p.mint, setup: p.setup, entrySol: p.entrySol, remainingFrac: p.remainingFrac, protected: p.protected || null, takenOver: p.takenOver || null });
          if (u.pathname === '/takeover') {
            const pos = bot.takeoverPosition ? bot.takeoverPosition(key) : null;
            if (!pos) return json(res, 404, { error: 'no open position for that mint' });
            return json(res, 200, { ok: true, takenOver: pos.takenOver, position: snap(pos) });
          }
          const r = bot.releasePosition ? bot.releasePosition(key) : null;
          if (r === null) return json(res, 404, { error: 'no open position for that mint' });
          if (r === false) return json(res, 404, { error: 'position is not taken over' });
          return json(res, 200, { ok: true, takenOver: null, position: snap(r) });
        } catch { return json(res, 400, { error: 'invalid JSON' }); }
      });
      return;
    }
    // POST /tp1at {mint|symbol, pct} — the per-coin TP1 override (user
    // 2026-10-16 19:12 EDT, "arm tp1 to hit at 50% / not 20%-60% / just for
    // this coin"): pct is a net-gain fraction (0.5 = +50%). While set on a
    // pre-TP1 position, exits.js section 3 bypasses the adaptive TP1
    // machinery for that coin and banks cfg.tp1Frac flat at the line; later
    // stages are unchanged. The value lives on the persisted position
    // record and is spent when the position closes, when its TP1 fires, or
    // when cleared — POST /tp1clear {mint|symbol}, or /tp1at with pct 0.
    if (req.method === 'POST' && (u.pathname === '/tp1at' || u.pathname === '/tp1clear')) {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 2000) req.destroy(); });
      req.on('end', () => {
        try {
          const { mint, symbol, pct } = JSON.parse(body || '{}');
          const key = mint || symbol;
          if (!key) return json(res, 400, { error: 'mint required' });
          const snap = (p) => ({ id: p.id, symbol: p.symbol, mint: p.mint, setup: p.setup, entrySol: p.entrySol, remainingFrac: p.remainingFrac, protected: p.protected || null, takenOver: p.takenOver || null, tp1AtPct: p.tp1AtPct ?? null });
          const clear = () => {
            const r = bot.tp1ClearPosition ? bot.tp1ClearPosition(key) : null;
            if (r === null) return json(res, 404, { error: 'no open position for that mint' });
            if (r === false) return json(res, 404, { error: 'position has no TP1 override' });
            return json(res, 200, { ok: true, tp1AtPct: null, position: snap(r) });
          };
          if (u.pathname === '/tp1clear') return clear();
          if (pct === 0) return clear(); // /tp1at with pct 0 clears, like the sibling route
          const v = Number(pct);
          if (!Number.isFinite(v) || v <= 0 || v > 3) return json(res, 400, { error: 'pct must be a number in (0, 3] — a net-gain fraction, 0.5 = +50%' });
          const pos = bot.tp1AtPosition ? bot.tp1AtPosition(key, v) : null;
          if (!pos) return json(res, 404, { error: 'no open position for that mint' });
          return json(res, 200, { ok: true, tp1AtPct: pos.tp1AtPct, position: snap(pos) });
        } catch { return json(res, 400, { error: 'invalid JSON' }); }
      });
      return;
    }
    if (req.method === 'POST' && u.pathname === '/halt') {
      try { fs.writeFileSync(path.join(bot.cfg.dataDir, 'HALT'), String(Date.now())); } catch {}
      return json(res, 200, { ok: true, halted: true });
    }
    if (req.method === 'POST' && u.pathname === '/resume') {
      try { fs.unlinkSync(path.join(bot.cfg.dataDir, 'HALT')); } catch {}
      try { bot.risk.clearDownHalt(); } catch {}
      try { bot.risk.clearStreakPause(); } catch {}
      try { bot.risk.clearBrakeWipe(); } catch {}
      // Equity kill release (2026-10-17): clearKill nulls the anchor, so
      // re-anchor NOW at the live wallet balance — the equity the human
      // is deliberately resuming with becomes the kill floor's basis.
      try { bot.risk.clearKill(); bot.exec.solBalance().then(bal => { if (bal != null) bot.risk.initEquity(bal); }).catch(() => {}); } catch {}
      return json(res, 200, { ok: true, halted: false });
    }
    if (req.method === 'POST' && u.pathname === '/risk/reset') {
      bot.risk.s.dayPnlSol = 0;
      bot.risk.s.day = new Date().toISOString().slice(0, 10);
      try { bot.risk.clearBrake(); } catch {} // the deliberate reset also lifts the risk brake (counter + halving)
      bot.risk.save();
      return json(res, 200, { ok: true, dayPnlSol: 0, brakeRed: 0, sizeHalved: false });
    }
    if (req.method === 'GET' && u.pathname === '/ticks') {
      const mint = u.searchParams.get('mint') || '';
      const id = u.searchParams.get('id') || '';
      const limit = Math.min(parseInt(u.searchParams.get('limit') || '500', 10) || 500, 2000);
      let lines = [];
      try {
        const raw = fs.readFileSync(path.join(DATA_DIR, 'ticks.jsonl'), 'utf8').trim().split('\n');
        for (const ln of raw) {
          try {
            const t = JSON.parse(ln);
            if (mint && t.mint !== mint) continue;
            if (id && t.id !== id) continue;
            lines.push(t);
          } catch {}
        }
      } catch {}
      return json(res, 200, lines.slice(-limit));
    }
    if (req.method === 'GET' && u.pathname === '/watchlist') {
      const out = [];
      for (const [mint, w] of bot.watch) {
        const v = bot.latest.get(mint);
        out.push({
          mint,
          symbol: v?.symbol || '?',
          name: v?.name || '',
          mc: v?.mc || null,
          source: w.source || '?',
        });
      }
      return json(res, 200, { count: out.length, coins: out });
    }
    if (req.method === 'GET' && u.pathname === '/reallists') {
      return json(res, 200, {
        trending: { n: realLists.trending.length, rows: realLists.trending, ts: realLists.ts },
        movers: { n: realLists.movers.length, rows: realLists.movers, ts: realLists.ts },
        graduated: { n: (realLists.graduated || []).length, rows: realLists.graduated || [], ts: realLists.ts },
        new: { n: (realLists.new || []).length, rows: realLists.new || [], ts: realLists.ts },
      });
    }
    if (req.method !== 'GET') return json(res, 405, { error: 'read-only' });
    if (u.pathname === '/health') {
      const h = { ok: true, mode: bot.cfg.realMode ? 'REAL' : 'SHADOW', uptimeSec: Math.round(process.uptime()) };
      if (bot.lastCallout) h.lastCallout = bot.lastCallout;
      return json(res, 200, h);
    }
    if (u.pathname === '/state') return json(res, 200, bot.state());
    if (u.pathname === '/pumplists') return json(res, 200, listState());
    if (u.pathname === '/report') return json(res, 200, bot.journal.report());
    if (u.pathname === '/signals') {
      // D1 pagination: /signals already had a bare-array `limit` (≤200) — that
      // legacy shape is preserved exactly. Passing `offset`, or a limit above
      // the old 200 cap, switches to the paging envelope so the FULL history
      // (not just the newest 200) can be walked.
      const rawLimit = Number(u.searchParams.get('limit'));
      if (u.searchParams.has('offset') || (Number.isFinite(rawLimit) && rawLimit > 200)) {
        const pg = paging(u);
        return json(res, 200, bot.journal.signalsPage(pg));
      }
      return json(res, 200, bot.journal.recent(Math.min(200, rawLimit || 50)));
    }
    if (u.pathname === '/trades') {
      // D1 pagination: default stays the legacy last-100 bare array; any
      // limit/offset switches to the envelope over the full trade history.
      const pg = paging(u);
      if (!pg) return json(res, 200, bot.journal.trades.slice(-100).reverse());
      const all = bot.journal.trades.slice().reverse(); // newest first
      return json(res, 200, { total: all.length, offset: pg.offset, limit: pg.limit, items: all.slice(pg.offset, pg.offset + pg.limit) });
    }
    return json(res, 404, { error: 'not found', routes: ['/health', '/state', '/pumplists', '/report', '/signals', '/trades', '/postexit', '/shadowtrades'] });
  });
  srv.listen(port, () => console.log(`[server] listening on :${port}`));
  return srv;
}
