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
  const recent = joined.slice(-12).reverse().map(({ r, out }) => ({
    ts: r.ts, mint: r.mint, symbol: r.symbol || null, setup: r.setup || null,
    decision: r.decision || null, basis: r.basis || 'signal', rules: r.rules,
    reason: r.reason || null, pnlSol: r.pnlSol ?? null,
    out: out ? { done: !!out.done, r15: out.r15 ?? null, r60: out.r60 ?? null, maxRet: out.maxRet ?? null, partial: !!out.partial } : null,
  }));
  return {
    perRule, totals, recent,
    notes: [
      'shadow only — no rule blocks, delays, or alters any entry; promotion is one rule at a time on the owner\'s call, and only for a rule that clearly beats a random block',
      'live column = would-vetoed signals the bot actually took (real entries the rule would have stopped); shadow column = all would-vetoes',
      'R1 (fakeAlive) is judged at position close — the share is sampled over a hold, so it has no entry-time value; its records are taken closes and carry realized PnL',
      'a rule fires only when every feature it reads was stamped; unstamped features are untestable, never guessed',
    ],
  };
}
