// vetoLab.js — Killswitch Veto Shadow (owner order 2026-10-19 15:33 EDT,
// RECORD-ONLY).
//
// The Part 1 entry vetoes from the killswitch overhaul brief were backtested
// against the stored journal (~/workspace/analysis/killswitch-backtest-
// 2026-10-19.md) and then held by the owner: the combined set did not beat a
// random block of the same size (follow-up: killswitch-random-overlap-slots-
// 2026-10-19.md), so NOTHING goes live on that evidence. Instead all 8 rules
// run here in shadow: at the same point in the entry pipeline where the
// entry snapshot/stamps are produced, every rule is evaluated and any firing
// is journaled to veto_shadow.jsonl with the signal's tracked r15/r60 joined
// at read time — the out-of-sample scorecard the promotion decision (one
// rule at a time, only a rule that clearly beats random) will be judged on.
//
// HARD BOUNDARIES: this module never blocks, delays, sizes, or alters any
// entry. evaluateVetoes is pure and total (garbage in -> no fires out, never
// a throw); every caller wraps the journaling in try/catch so a shadow
// failure can never reach a trading path.
//
// Feature basis — read the stamp wherever the pipeline actually produces it
// (the follow-up report's ZeroFee lesson: the linkedDump stamp may live in
// the shadow-gate record instead of the live checks):
//   chgM5 / chgH1 / chgH24 / ageMin  <- the live view, exactly as
//     learn.snapshotFeatures stamps them onto the trade's entry snapshot
//     (ageMin = whole minutes from view.createdAt).
//   linkedDrain <- checks.linkedDump.drain when a raw check carries it;
//     else the gate's own reason text parsed ("linked stack could pull 36%
//     of pool SOL" -> 0.36; "no linked stack" -> 0.0), read from the live
//     checks first, then the shadow gates. The backtest validated the parse
//     against the numeric stamp (agree within 0.005; identical blocked set).
//   topGuard distPct / highAgeSec <- checks.topGuard when the pipeline
//     stamped it this evaluation; else measured on the spot with
//     gate.topGuardVerdict over the bot's own sampled history (same inputs,
//     same function — the raw measurements, NOT the guard's own pass/fail:
//     rule 7's lines are the brief's, not the guard's).
//   fakeAlive.share <- NOT an entry-time quantity: the stamp is sampled over
//     a position's life (src/fakeAlive.js), so R1 is evaluated where the
//     pipeline produces it — at position close, in Bot.ensureClose, on
//     taken trades only — exactly the basis the backtest judged it on
//     (closes). Signal-time records therefore carry fakeAliveShare: null
//     and R1 never fires on them; R1 records carry basis: 'close'.
//
// R8 post-pump-bounce tag (owner directive #1, 2026-10-19): R8 records
// carry postPumpBounce — whether the falling knife fell off a coin that
// had ALREADY pumped before the flagged dump (chgH1 >= +50% or
// chgH24 >= +100% at flag time, the Gemma/KIM pattern: catching those is
// a core goal). The tag is descriptive only; it changes no rule's fire.
//
// Live-tape stamp (owner order 2026-10-19 21:37 EDT): every journaled
// record also carries a liveTape stamp — the entry-moment BUY-SIDE tape
// from the wallet census, last 2 minutes: { buys, sells, uniqBuyers,
// windowMin: 2, wouldSkip }. The bot's other checks measure how much
// traded, never direction; the census is the one instrument that sees
// who is buying. wouldSkip = buys < sells OR uniqBuyers <
// LIVE_TAPE_MIN_UNIQ (default 5) — a one-buyer tape like Rockstar's
// 1-buy/899-sell census is the shape it exists to catch. SHADOW ONLY,
// like everything here: no blocking mode exists in this build; the raw
// counts ride the record so any threshold re-judges offline, and
// promotion is a separate owner call gated on beating random. When no
// census sample exists for the mint at the decision moment the stamp is
// nulls with wouldSkip: null — the scoreboard's noSample bucket (the
// codebase's missing-data posture for shadow fields: unstamped is
// unknown, never a guessed verdict).
//
// Entry-quality stamp (owner decision #1, 2026-10-19 20:05 EDT, from the
// step-4 fingerprint report §9): every journaled record also carries an
// entryQuality stamp — the flag-time entry snapshot's activity fields
// (volM5 / buysM5 / sellsM5 / chgH1) banded by 5-minute volume against
// the fingerprint base's terciles. Step 4 found total 5m activity is the
// one real winner/loser separator (volM5 AUC 0.608; win rate by tercile
// 25% -> 33% -> 44%); the bottom tercile is the "dead tape" cohort
// (22-25% win rate), shadowed here as a skip CANDIDATE under the owner's
// beats-random gate. The stamp is a scoreboard, not a gate: deadTape is
// a flag on the record, the bot's real decision stands untouched beside
// it, and nothing is ever skipped because of it.
import { mean, median, round } from './util.js';

export const VETO_RULES = [
  { id: 'R1', label: 'fake-alive share', text: 'fakeAlive.share > 0.30', basis: 'close' },
  { id: 'R2', label: 'linked drain', text: 'linkedDrain > 0.10', basis: 'signal' },
  { id: 'R3', label: 'fresh dump', text: 'ageMin < 5 & chgM5 <= -30', basis: 'signal' },
  { id: 'R4', label: 'hot 5m', text: 'chgM5 > +20', basis: 'signal' },
  { id: 'R5', label: 'hot 1h', text: 'chgH1 > +150', basis: 'signal' },
  { id: 'R6', label: 'post-run bleed', text: 'chgH24 > +500 & chgH1 < -25', basis: 'signal' },
  { id: 'R7', label: 'fresh top', text: 'topGuard dist < 5% & high < 300s old', basis: 'signal' },
  { id: 'R8', label: 'falling knife', text: 'chgM5 < -15 · confluence/bottom only', basis: 'signal' },
];

const num = (x) => (Number.isFinite(Number(x)) && x != null && x !== '' ? Number(x) : null);

/** The linkedDump gate's drain share from its reason text — the backtest's
 *  validated fallback for records whose check carries no numeric drain.
 *  "no linked stack" is a MEASURED zero (the gate ran and found nothing);
 *  "pool data missing" and anything unparseable stay null (untestable). */
export function parseLinkedDrainReason(reason) {
  if (typeof reason !== 'string') return null;
  if (/no linked stack/i.test(reason)) return 0;
  const m = reason.match(/pull\s+(\d+(?:\.\d+)?)\s*%\s*of pool SOL/i);
  if (m) { const p = Number(m[1]); return Number.isFinite(p) ? p / 100 : null; }
  return null;
}

/** linkedDrain wherever the pipeline produced it: a raw check's numeric
 *  drain first (live checks, then shadow gates), then the reason-text parse
 *  in the same order. Null when the gate never ran or could not measure. */
export function linkedDrainFromChecks(checks, shadowGates) {
  for (const src of [checks, shadowGates]) {
    const c = src && src.linkedDump;
    if (c && Number.isFinite(c.drain)) return Number(c.drain);
  }
  for (const src of [checks, shadowGates]) {
    const c = src && src.linkedDump;
    if (c) { const p = parseLinkedDrainReason(c.reason); if (p != null) return p; }
  }
  return null;
}

/** Evaluate all 8 rules exactly as written in the brief/backtest against one
 *  feature set. A rule fires only when every feature it reads is present —
 *  an unstamped feature is untestable, never a guessed zero (the one
 *  exception is linkedDrain's measured "no linked stack" zero, resolved by
 *  linkedDrainFromChecks before it gets here). Pure and total: any input
 *  shape returns an array, possibly empty; it cannot throw. */
export function evaluateVetoes(f) {
  const fired = [];
  try {
    if (!f || typeof f !== 'object') return fired;
    const chgM5 = num(f.chgM5), chgH1 = num(f.chgH1), chgH24 = num(f.chgH24);
    const ageMin = num(f.ageMin), drain = num(f.linkedDrain);
    const dist = num(f.topGuardDistPct), highAge = num(f.topGuardHighAgeSec);
    const faShare = num(f.fakeAliveShare);
    if (faShare != null && faShare > 0.30) fired.push('R1');
    if (drain != null && drain > 0.10) fired.push('R2');
    if (ageMin != null && chgM5 != null && ageMin < 5 && chgM5 <= -30) fired.push('R3');
    if (chgM5 != null && chgM5 > 20) fired.push('R4');
    if (chgH1 != null && chgH1 > 150) fired.push('R5');
    if (chgH24 != null && chgH1 != null && chgH24 > 500 && chgH1 < -25) fired.push('R6');
    if (dist != null && highAge != null && dist < 5 && highAge < 300) fired.push('R7');
    if ((f.setup === 'confluence' || f.setup === 'bottom') && chgM5 != null && chgM5 < -15) fired.push('R8');
  } catch { /* shadow evaluation must never throw into the pipeline */ }
  return fired;
}

/** R8 post-pump-bounce tag (owner directive #1, 2026-10-19): true when a
 *  record that fired R8 did so on a coin that had already pumped before
 *  this dump — chgH1 >= +50 or chgH24 >= +100, percent units exactly as
 *  evaluateVetoes reads them (R5's written line is chgH1 > +150 in the
 *  same units). Missing features -> false, never guessed; no R8 fire ->
 *  false (the caller stamps the field on R8 records only). Pure, total. */
export function r8PostPumpBounce(f, rules) {
  try {
    if (!f || typeof f !== 'object' || !Array.isArray(rules) || !rules.includes('R8')) return false;
    const h1 = num(f.chgH1), h24 = num(f.chgH24);
    return (h1 != null && h1 >= 50) || (h24 != null && h24 >= 100);
  } catch { return false; }
}

/** Entry-quality tercile cutoffs for entry volM5 (USD volume over the
 *  trailing 5 minutes at flag time), from the step-4 fingerprint base:
 *  n=244 feature-bearing closes (83 W / 161 L), ks2-scratch/rows.json
 *  joined to each close's entry.volM5 (ks2-scratch/trades.json),
 *  computed 2026-10-19. The base's tercile segments ran
 *  [0 .. 13,062.89] / [13,155.71 .. 27,486.32] / [27,529.46 .. 349,820.03]
 *  with win rates 25% / 33% / 44%; these constants are the 33 1/3 and
 *  66 2/3 percentiles of that distribution. Frozen on purpose: the
 *  out-of-sample scoreboard judges new records against the SAME lines
 *  the fingerprint drew, never a silently re-based set. */
export const EQ_VOLM5_TERCILE_LOW = 13155.71;  // volM5 < this -> activityBand 'low'
export const EQ_VOLM5_TERCILE_HIGH = 27529.46; // volM5 >= this -> 'high'; between -> 'mid'

/** The entry-quality stamp for one journaled record (owner decision #1,
 *  2026-10-19): the flag-time entry snapshot's activity fields, read with
 *  the same numeric coercion learn.snapshotFeatures stamps them with.
 *  Raw values ride along (null when the pipeline never produced them —
 *  unstamped is unknown, never a guessed zero). activityBand bands volM5
 *  by the frozen step-4 terciles; deadTape is exactly the low band, the
 *  shadowed skip candidate — a flag only: the record's own decision
 *  field is the bot's real, untouched outcome. Pure and total. */
export function entryQualityStamp(s) {
  const blank = { volM5: null, buysM5: null, sellsM5: null, chgH1: null, activityBand: null, deadTape: false };
  try {
    if (!s || typeof s !== 'object') return blank;
    const volM5 = num(s.volM5), buysM5 = num(s.buysM5), sellsM5 = num(s.sellsM5), chgH1 = num(s.chgH1);
    const activityBand = volM5 == null ? null
      : volM5 < EQ_VOLM5_TERCILE_LOW ? 'low'
      : volM5 < EQ_VOLM5_TERCILE_HIGH ? 'mid' : 'high';
    return { volM5, buysM5, sellsM5, chgH1, activityBand, deadTape: activityBand === 'low' };
  } catch { return blank; }
}

export const LIVE_TAPE_WINDOW_MIN = 2;

/** The live-tape stamp for one journaled record (owner order
 *  2026-10-19): `sample` is the census's last-2-minute read for the mint
 *  at the decision moment ({ buys, sells, uniqBuyers }) or null when no
 *  census covers the mint. Raw counts ride along verbatim; wouldSkip is
 *  the shadow verdict at the LIVE_TAPE_MIN_UNIQ dial — buys < sells OR
 *  uniqBuyers < minUniq. A null (or partial) sample stamps nulls with
 *  wouldSkip: null — unknown, never a guessed verdict, counted by the
 *  scoreboard as noSample. Pure and total: it cannot throw. */
export function liveTapeStamp(sample, minUniq) {
  const blank = { buys: null, sells: null, uniqBuyers: null, windowMin: LIVE_TAPE_WINDOW_MIN, wouldSkip: null };
  try {
    if (!sample || typeof sample !== 'object') return blank;
    const buys = num(sample.buys), sells = num(sample.sells), uniqBuyers = num(sample.uniqBuyers);
    if (buys == null || sells == null || uniqBuyers == null) return { ...blank, buys, sells, uniqBuyers };
    const n = Number.isFinite(Number(minUniq)) && minUniq != null ? Number(minUniq) : 5;
    return { buys, sells, uniqBuyers, windowMin: LIVE_TAPE_WINDOW_MIN, wouldSkip: buys < sells || uniqBuyers < n };
  } catch { return blank; }
}

/** The /vetoshadow scorecard over would-veto records, outcomes joined at
 *  read time via outcomeOf(signalId) -> the signal's tracked outcome (or
 *  null while still tracking / aged out). Per rule: how many signals it
 *  would have vetoed, how many of those the bot actually TOOK live (the
 *  live column — real entries the veto would have stopped), and the joined
 *  forward returns of the would-vetoed set. R1's records are close-basis:
 *  their realized PnL rides the record itself and is summed as well. */
export function buildVetoCard(records, outcomeOf) {
  const recs = (records || []).filter(r => r && r.kind === 'veto' && Array.isArray(r.rules));
  const joined = recs.map(r => ({ r, out: r.signalId && outcomeOf ? outcomeOf(r.signalId) : null }));
  const agg = (arr) => {
    const fin = arr.filter(x => x.out && x.out.done);
    const r15 = fin.map(x => x.out.r15).filter(Number.isFinite);
    const r60 = fin.map(x => x.out.r60).filter(Number.isFinite);
    return {
      finalized: fin.length,
      medianR15: r15.length ? round(median(r15)) : null, meanR15: r15.length ? round(mean(r15)) : null,
      medianR60: r60.length ? round(median(r60)) : null, meanR60: r60.length ? round(mean(r60)) : null,
      sharePosR60: r60.length ? round(r60.filter(x => x > 0).length / r60.length, 3) : null,
    };
  };
  const perRule = {};
  for (const rule of VETO_RULES) {
    const mine = joined.filter(x => x.r.rules.includes(rule.id));
    const pnl = mine.map(x => x.r.pnlSol).filter(Number.isFinite);
    perRule[rule.id] = {
      label: rule.label, text: rule.text, basis: rule.basis,
      wouldVeto: mine.length,
      taken: mine.filter(x => x.r.decision === 'taken').length,
      skipped: mine.filter(x => x.r.decision === 'skipped').length,
      shadow: mine.filter(x => x.r.decision === 'shadow').length,
      ...agg(mine),
      realizedPnlSol: pnl.length ? round(pnl.reduce((a, b) => a + b, 0), 4) : null,
      realizedN: pnl.length,
    };
    // R8 only: how many of its flags carry the post-pump-bounce tag
    // (records journaled before the tag existed simply don't count).
    if (rule.id === 'R8') perRule[rule.id].postPumpBounce = mine.filter(x => x.r.postPumpBounce === true).length;
  }
  const sigRecs = recs.filter(r => r.basis !== 'close');
  const closeRecs = recs.filter(r => r.basis === 'close');
  const totals = {
    records: recs.length,
    wouldVetoSignals: sigRecs.length,
    takenLive: sigRecs.filter(r => r.decision === 'taken').length,
    skippedSignals: sigRecs.filter(r => r.decision === 'skipped').length,
    shadowSignals: sigRecs.filter(r => r.decision === 'shadow').length,
    r1TakenCloses: closeRecs.length,
  };
  // Entry-quality scoreboard (owner decision #1, 2026-10-19): the same
  // read-time outcome joins, cut by the stamp's activity band. Only
  // records carrying the stamp count — records journaled before the
  // stamp shipped are excluded, never back-filled. deadTape (the low
  // band) is the shadowed skip candidate: wouldSkip counts the records
  // it WOULD have skipped; every one kept the bot's real decision.
  const stamped = joined.filter(x => x.r.entryQuality && typeof x.r.entryQuality === 'object');
  const bandAgg = (arr) => {
    const fin = arr.filter(x => x.out && x.out.done);
    const r60 = fin.map(x => x.out.r60).filter(Number.isFinite);
    return {
      n: arr.length,
      finalized: fin.length,
      medianR60: r60.length ? round(median(r60)) : null,
      shareR60Positive: r60.length ? round(r60.filter(x => x > 0).length / r60.length, 3) : null,
    };
  };
  const deadAgg = bandAgg(stamped.filter(x => x.r.entryQuality.deadTape === true));
  const entryQuality = {
    total: stamped.length,
    noBand: stamped.filter(x => x.r.entryQuality.activityBand == null).length,
    bands: {
      low: bandAgg(stamped.filter(x => x.r.entryQuality.activityBand === 'low')),
      mid: bandAgg(stamped.filter(x => x.r.entryQuality.activityBand === 'mid')),
      high: bandAgg(stamped.filter(x => x.r.entryQuality.activityBand === 'high')),
    },
    deadTape: { wouldSkip: deadAgg.n, finalized: deadAgg.finalized, medianR60: deadAgg.medianR60, shareR60Positive: deadAgg.shareR60Positive },
  };
  // Live-tape scoreboard (owner order 2026-10-19): the same read-time
  // outcome joins, cut by the stamp's shadow verdict. Only records
  // carrying the stamp count (signal-basis records journaled since the
  // stamp shipped — close-basis R1 records carry no entry-moment census
  // sample and are excluded, never back-filled). wouldSkip: null is the
  // noSample bucket: no census covered the mint at decision time.
  const ltStamped = joined.filter(x => x.r.liveTape && typeof x.r.liveTape === 'object' && x.r.basis !== 'close');
  const liveTape = {
    total: ltStamped.length,
    noSample: ltStamped.filter(x => x.r.liveTape.wouldSkip == null).length,
    wouldSkip: bandAgg(ltStamped.filter(x => x.r.liveTape.wouldSkip === true)),
    pass: bandAgg(ltStamped.filter(x => x.r.liveTape.wouldSkip === false)),
  };
  const recent = joined.slice(-12).reverse().map(({ r, out }) => ({
    ts: r.ts, mint: r.mint, symbol: r.symbol || null, setup: r.setup || null,
    decision: r.decision || null, basis: r.basis || 'signal', rules: r.rules,
    reason: r.reason || null, pnlSol: r.pnlSol ?? null,
    entryQuality: r.entryQuality ?? null,
    liveTape: r.liveTape ?? null,
    out: out ? { done: !!out.done, r15: out.r15 ?? null, r60: out.r60 ?? null, maxRet: out.maxRet ?? null, partial: !!out.partial } : null,
  }));
  return {
    perRule, totals, entryQuality, liveTape, recent,
    notes: [
      'shadow only — no rule blocks, delays, or alters any entry; promotion is one rule at a time on the owner\'s call, and only for a rule that clearly beats a random block',
      'live column = would-vetoed signals the bot actually took (real entries the rule would have stopped); shadow column = all would-vetoes',
      'R1 (fakeAlive) is judged at position close — the share is sampled over a hold, so it has no entry-time value; its records are taken closes and carry realized PnL',
      'a rule fires only when every feature it reads was stamped; unstamped features are untestable, never guessed',
      'R8 records carry postPumpBounce: the coin had already pumped (chgH1 >= +50% or chgH24 >= +100%) before the flagged dump — the Gemma/KIM pattern, counted on the R8 aggregate',
      'entryQuality (step-4 fingerprint, record-only): each record is stamped with its flag-time entry activity (volM5/buysM5/sellsM5/chgH1) banded by the fingerprint base\'s volM5 terciles; deadTape = the low band, a skip CANDIDATE under the beats-random gate — it skips nothing, and its records keep the bot\'s real decision',
      'liveTape (record-only): each signal-basis record is stamped with the wallet census\'s last-2-minute buy-side tape at the decision moment {buys, sells, uniqBuyers, wouldSkip} — wouldSkip = buys < sells OR uniqBuyers < LIVE_TAPE_MIN_UNIQ (default 5); it skips nothing and has NO blocking mode; records with no census sample count as noSample; raw counts ride the record so any threshold re-judges offline',
    ],
  };
}
