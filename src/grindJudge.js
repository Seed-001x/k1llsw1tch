// grindJudge.js — THE GRIND JUDGE (owner order 2026-10-18 ~10:11 EDT,
// "do what must be done", after his two diagnoses of the same morning:
// (1) volume bots puppet the flow vitals — a coin can print a balanced
// tape while dying; (2) liquidity barely moves on this coin family, so
// the pool-based legs are blind in a grind. The death detector's counters
// said it plainly: fires 3, collapses 3 — the combination path had never
// carried a fire. The specimen was 🤗: 88K -> 32K over 171 minutes, never
// green, every vital healthy, exited by hand at -65%.)
//
// The judge asks the one question the volume bot cannot fake an answer
// to: IS THE BID REAL? It needs BOTH independent witnesses, conjunctively:
//   WITNESS 1 — the fake-alive trailing read (src/fakeAlive.js): over the
//     trailing window, a high share of samples where the tape looked
//     balanced while the price fell through it.
//   WITNESS 2 — the wallet census (src/census.js): over the trailing
//     window the buy COUNT is alive (the tape is printing) but the buyer
//     CENSUS is dead — few distinct buyer wallets and ZERO first-seen
//     buyers arriving.
// Plus the position must be underwater and old enough for a grind to have
// declared itself. A dark or thin census is NO evidence: the judge cannot
// fire on one witness, ever.
//
// Shape: the undertaker's idiom, slowed down — first hot check stamps a
// pending; the fire needs the conjunction to STILL hold at the first
// check at/after the confirm lapse. Scope mirrors the death detector:
// pre-TP1 only, HOLD decisions only, protect/takeover silence it.
//
// PRE-REGISTERED KILL RULE (the flow-confirm lane's pattern, adapted to
// an exit judge — its closes are losers by construction, so the metric
// is post-exit recovery, not close PnL): at grindKillN finalized judge
// closes (post-exit outcomes), if at least grindKillWrong of them ripped
// >= grindWrongPeakPct within the 5-minute post-exit window (the judge
// sold into a bounce — the unambiguous harm), the judge disables itself
// (persisted) and journals the event. GRIND_JUDGE=0 kills the whole
// module; GRIND_JUDGE_LIVE=0 leaves the census + shadow would-fires
// running with no live firing.

/**
 * Pure evaluation. Inputs are the reads computed by the caller:
 *   faWin: fakeAliveWindow() result ({ samples, fake, share } | null)
 *   cenWin: censusWindow() result (windowed census read | null)
 *   censusAgeMs: how long this position's census has been accumulating
 * Returns { hot, why } — `why` names the failing leg for journaling.
 */
export function evaluateGrind({ cfg, ageSec, ratio, faWin, cenWin, censusAgeMs }) {
  const no = (why) => ({ hot: false, why });
  if (!cfg.grindJudge) return no('off');
  if (ageSec < cfg.grindMinAgeSec) return no('young');
  if (ratio == null || !(ratio < cfg.grindMaxRatio)) return no('not-underwater');
  if (!faWin || faWin.samples < cfg.grindFaMinSamples) return no('fa-thin');
  if (!(faWin.share >= cfg.grindFaShare)) return no('fa-low');
  if (!cenWin) return no('census-dark');
  if (censusAgeMs != null && censusAgeMs < cfg.censusWindowMin * 60000) return no('census-young');
  if (cenWin.buys < cfg.grindMinBuysWindow) return no('tape-quiet');
  if (cenWin.uniqBuyers > cfg.grindMaxUniqBuyers) return no('buyers-alive');
  if (cenWin.newBuyers > cfg.grindMaxNewBuyers) return no('new-arriving');
  return { hot: true, why: 'hot' };
}

/** The reason string a grind fire carries (values at fire time). */
export function grindReason({ faShare, faWinMin, buys, uniq, fresh, winMin }) {
  return `grind judge: fake-alive ${faShare} (${faWinMin}m), census ${buys} buys/${uniq} uniq/${fresh} new (${winMin}m)`;
}

/**
 * Kill-rule evaluation over finalized post-exit outcomes of judge closes.
 * done: PostExitTracker.done records (each carries reason + peakMovePct).
 * Returns { finalized, wrong } — caller applies the persisted gate.
 */
export function grindKillTally(done, cfg) {
  let finalized = 0, wrong = 0;
  for (const r of done || []) {
    if (!r || typeof r.reason !== 'string' || !r.reason.startsWith('grind judge')) continue;
    finalized++;
    if (r.peakMovePct != null && r.peakMovePct >= cfg.grindWrongPeakPct) wrong++;
  }
  return { finalized, wrong };
}
