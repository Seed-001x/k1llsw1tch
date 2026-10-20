// exits.js — pure exit logic. Judged on REALIZABLE value (Jupiter sell quote), not screen price.
//
// pos  = { entrySol, remainingFrac, peakRatio, peakMove, tp1Done, entryTs, entryRoundTrip? }
// mark = { valueSol, liqUsd, buysM5, sellsM5, solUsd }
// returns { fraction (0..1 of CURRENT holding; 0 = hold), reason, newPeak, newPeakMove, ratio }
//
// ratio = valueSol / (entrySol * remainingFrac): value of what's left vs its share of cost basis.
// move  = ratio / entryRoundTrip: the PRICE move since entry. Right after a buy the sell quote is already
//         below cost by the round-trip (fees + slippage), so a flat coin reads e.g. 0.93 on `ratio` but 1.00 on `move`.
//         The dip stop and the stall exit use `move`, so they fire on what the price did, not on sunk fees.

// EXIT-STACK STRIP (user order 2026-10-15 ~17:05 EDT — the user lifted his own exit
// freeze for this): the stack is reduced to the TP ladder (TP1 adaptive / TP2 /
// moonbag trail), the post-TP1 middle trail (3d), Tratchet (4c) and the 10-minute
// momentum-failure dead check (5), so positions get unrestrained time and produce
// clean, untruncated path data; the user accepts losing on some sells as the cost.
// The mechanisms flagged below are DISABLED IN CODE: their sections remain in
// place for reversibility, but the gates make them incapable of firing regardless
// of cfg/env values — re-enabling one is a code change, never a knob flip.
//   stopFamily     — 2a dip stop, 2a2 hard floor, 2b grace stop (the early
//                    below-entry stop family: the "instant stop" lineage)
//   stallProbation — 4b stall deadline sell + probation leash / expiry
//   bleed          — 4d bleed exit
//   genericTrail   — 4 trailing stop
//   profitLock     — 4a profit lock
//   modestBranch   — two-path branching on the TP1 lane: 3a modest target/split
//                    and the 4e kill zone. The lane STAMP on the TP1 decision
//                    (pathClass / killZoneOverlay) stays as record-only
//                    journaling; nothing below branches on it.
//
// EXIT-STACK V2 (user order 2026-10-15 ~20:26 EDT, "Go" — the user's final
// re-spec of the stack after the strip): three further closers come off and
// dead flow changes stage.
//   tratchet       — 4c break-even ratchet (the classic Tratchet: pre-TP1,
//                    arm at the BE_ARM line, fire at the BE_TRIGGER line). The
//                    "-30% from peak" trail the user calls tratchet in the v2
//                    spec is the MOONBAG trail (3c), which is unchanged.
//   volumeDecay    — 5b volume decay
//   timeStop       — 6 time stop
//   maxHold        — 7 absolute max hold
//   deadflow       — no longer a strip flag: the rule MOVED. Its pre-TP1
//                    placement (4d-pre) is removed outright and the machinery
//                    now judges ONLY the moonbag stage (new section 3c2): a
//                    post-TP2 remainder whose flow dies sells in full.
// KEPT LIVE in v2, as in the strip: the TP ladder (TP1 adaptive / TP2 /
// moonbag trail), TP2 rejection (3d-pre), liquidity death (1) and the
// 10-minute momentum-failure dead check (5) as the sole undertaker for
// never-movers.
//
// POST-TP1 TRAIL REMOVED (user order 2026-10-16 ~15:06 EDT, "remove the
// post tp1 trail"): the founding case is ref — TP1 fade-fired at +14% and
// 28s later the middle trail dumped the remaining 60% at +3.4% into a
// seconds-long dip; the coin then ran to ~2x the entry without the bot.
// The middle stage now has NO peak-retrace exit at all: after TP1 the
// remainder rides to TP2, TP2 rejection (3d-pre), the moonbag stage, or
// the undertaker. STRIP-gated like the other kills — the section remains
// in place but can never fire; re-enabling is a code change.
//
// THE SIMPLIFICATION (user order 2026-10-16 19:24 EDT, "remove the mess we
// just did. And simplify it" / "No SL rule aside from the 3M stall 60 sec
// confirm"): the SL ladder — a price-rung probation machine (arm −10%,
// deep −20% snap-back, −25% clock penalty, −30% final countdown, flow
// handoff) built earlier the same evening — is REMOVED ENTIRE, together
// with its per-coin ladder-off switch; and the 10-minute momentum-failure
// undertaker that stood at section 5 since the strip is REPLACED by the
// one rule the owner kept: the STALL EXIT (section 5) — the undertaker's
// own dead-flow conjunction (buysM5 ≤ 1 AND sellsM5 > 3 × buysM5), judged
// from 3 minutes of age instead of 10, with a 60-second confirm the
// undertaker never had: the first dead check only stamps a pending, and
// the sell needs the tape to STILL be dead when the window lapses. No
// price input anywhere: price alone can never trigger, arm or cancel it.
// What remains live in the stack: the TP ladder (TP1 adaptive / TP2 /
// moonbag trail), TP2 rejection (3d-pre), moonbag dead flow (3c2),
// liquidity death (1) and the stall exit (5) as the sole general downside
// exit for pre-TP1 + middle positions.
//
// STAGED MOONBAG DEAD FLOW (user order 2026-10-16 ~20:15 EDT, "once dead
// flow hits next time wave it sell another 50% and then let the rest ride
// until 10+% above avg entry" / "build it, trail stays alongside"): the
// moonbag's dead-flow exit (3c2) no longer dumps the whole bag at once.
// Each dead-flow WAVE sells 50% of the current remainder; waves are
// EDGE-based — after a wave fires, the dead-flow condition must clear on
// at least one check before another wave can count — and after wave 2
// dead flow never sells again on that position: the stub rides until the
// realizable quote falls to 1 + BAG_FLOOR_PCT of average entry (the
// "10% above avg entry" floor, new section 3c3), which sells it in full.
// Wave state persists on the position (bagDeadWaves / bagDeadHot, visible
// on /state). The −30% moonbag trail (3c) is untouched and stays armed on
// the whole remaining bag at every stage, stub included. BAG_DEAD_STAGED=0
// restores the legacy behavior entire: one dead-flow fire sells the whole
// bag and the floor does not exist.
//
// SMALL-BAG MOONBAG METHOD (owner order 2026-10-17 ~00:22-00:25 EDT, "no
// dead flow no 50% cut just hold" / "definitely closet this method… once
// we start leaving bigger moon bags we utilize it"): the staged design
// above is the CLOSETED method. While BAG_SMALL_HOLD is on (the live
// default), 3c2 sells nothing on a post-TP2 bag and the 3c3 floor — armed
// from TP2, confirming for BAG_FLOOR_CONFIRM_SEC (default 60) — is the
// bag's downside exit; mode off restores the staged design byte-for-byte.
// A MOONBAG TRIM (owner order 2026-10-17 ~00:27 EDT, section 3c1) rides
// alongside in both modes: at +200% from the TP2 print, half the bag
// banks, once per position.
// TRAIL REMOVED IN SMALL-BAG MODE (owner order 2026-10-17 ~04:38 EDT,
// "let's do that cause it wouldn't have cost me too much anyways"): the
// moonbag trail (3c) is closeted alongside the waves — in small-bag mode
// it never judges, never stamps a pending, never sells; the post-TP2
// stub (~5% of the original) simply rides to the 3c3 floor, its only
// full exit (the 3c1 trim still banks half at 3× the TP2 print).
// Founding case: MAKERS' stub trailed out at 8.05x while the coin kept
// running — at the moment he decided, the unstopped stub was worth
// ~3× what the trail banked, and the downside he actually risks is a
// 5%-of-original stub riding back to +10% over entry. Mode off restores
// the trail exactly as it was, confirm timer included.
//
// DEAD-FLOW LOSS EXIT (owner order 2026-10-20 00:32 EDT, "remove the 3m
// thing no SL at all only a dead flow once it's under -10%"): the entry
// clip (5a) is switched off by the owner (ENTRY_CLIP=0 — the section
// stays in code, fully gated on its switch) and there is NO price
// stop-loss anywhere in the stack. The one loss-side exit is new
// section 5c: a PRE-TP1 position at/below −DEAD_FLOW_PCT whose tape
// reads dead over the trailing DEAD_FLOW_WINDOW_SEC — the moonbag
// dead-flow test's own terms (buy count barely rises, no new peak) —
// sells in full. Price arms it; only dead tape fires it; missing tape
// holds. His earlier −15%/timer sketch from the same evening is
// superseded unbuilt. Untouched by the order: the TP ladder, the
// moonbag stack (3c–3c3, its dead flow included), liquidity death (1),
// the stall exit (5) and the bot-side death detector / no-quote
// failsafe.
const STRIP = {
  stopFamily: true,
  stallProbation: true,
  bleed: true,
  genericTrail: true,
  profitLock: true,
  modestBranch: true,
  tratchet: true,
  volumeDecay: true,
  timeStop: true,
  maxHold: true,
  postTp1Trail: true,
};

export function evaluateExit(pos, mark, cfg, now) {
  const basis = pos.entrySol * pos.remainingFrac;
  const ratio = basis > 0 ? mark.valueSol / basis : 0;
  const peakRatio = Math.max(pos.peakRatio || 1, ratio);
  const heldMin = (now - pos.entryTs) / 60000;
  const base = pos.entryRoundTrip > 0 ? pos.entryRoundTrip : 1;
  const move = ratio / base;

  // gain = what you'd actually pocket on the remaining position: the sell quote (already net of pool fees,
  // slippage and price impact) minus SOL network fees for the buy + up to two sells. Profit-side exits use this,
  // so a take-profit is always a real profit, never a "price is up but fees ate it" exit.
  const feeFrac = basis > 0 ? (3 * (cfg.txFeeSol || 0)) / basis : 0;
  const gain = ratio - 1 - feeFrac;
  const peakGain = peakRatio - 1 - feeFrac;

  // best price move seen so far (peak of `move`, NOT of ratio: peakRatio is floored at 1 while the
  // first realizable quote already sits at the round-trip ~0.95, so ratio/base would fake a breakout).
  // Positions opened before peakMove existed seed from their stored peakRatio — a one-off migration
  // approximation; every position opened since carries the exact peakMove from birth.
  const peakMove = Math.max(pos.peakMove != null ? pos.peakMove : (pos.peakRatio || 1) / base, move);

  // Adaptive-TP1 state + strength snapshot (user 2026-10-13): "strong" = the run still looks
  // supported RIGHT NOW — price at/near its high, buyers holding their share of the 5m flow, and
  // the trade count not collapsing — trended over the position's OWN recorded marks (bot.js appends
  // {ts, buys, sells, tx} to pos.flowHist at every position check, the freshest series available).
  // Missing data never counts against strength (null = unknown = neutral).
  let tp1Arm = pos.tp1Arm || null;
  const txNow = (mark.buysM5 != null || mark.sellsM5 != null) ? (mark.buysM5 || 0) + (mark.sellsM5 || 0) : null;
  const shareNow = txNow > 0 && mark.buysM5 != null ? mark.buysM5 / txNow : null;
  let shareTrend = null, txTrend = null;
  const fh = (pos.flowHist || []).filter(s => s && now - s.ts <= 90000 && now - s.ts >= 0);
  if (fh.length >= 2) {
    const f0 = fh[0], f1 = fh[fh.length - 1];
    const sh = s => (s.tx > 0 && s.buys != null) ? s.buys / s.tx : null;
    const s0 = sh(f0), s1 = sh(f1);
    if (s0 != null && s1 != null) shareTrend = s1 - s0;
    if (f0.tx > 0 && f1.tx != null) txTrend = f1.tx / f0.tx;
  }
  const strong = ratio >= peakRatio * 0.98
    && (shareNow == null || shareNow >= (cfg.tp1FlowMin ?? 0.5))
    && (shareTrend == null || shareTrend >= -0.10)
    && (txTrend == null || txTrend >= 0.6);
  // grace-stop state: armed the first tick the realizable value breaches the arm line (section 2b).
  // Recovery above the arm line cancels the arming outright (user 2026-10-13).
  let stopArmedTs = pos.stopArmedTs || null;
  if (ratio > 1 - cfg.stopLoss) stopArmedTs = null;
  // hard-floor confirmation (user 2026-10-13): consecutive checks seen at/below the floor.
  // Any check back above the floor resets the count — a wick that snaps back never fires it.
  // STRIP (stopFamily): the breach is never even registered — no floor state accrues.
  const hardBreached = !STRIP.stopFamily && cfg.stopHardPct > 0 && ratio <= 1 - cfg.stopHardPct;
  let floorChecks = hardBreached ? (pos.floorChecks || 0) : 0;
  // how long the breach has persisted: the floor also requires stopHardConfirmSec down there
  // before it fires (user 2026-10-13: 3s — "be sure it's still there"). Any check back above
  // the floor clears the clock together with the count.
  let floorSince = hardBreached ? (pos.floorSince ?? now) : null;
  // probation-leash state (user 2026-10-14): the tick the position was first caught inside
  // the entry-stall range at/after the stall deadline (section 4b). Null = not on probation.
  let probationSince = pos.probationSince ?? null;
  // bleed-exit move history (user 2026-10-14): the position's own per-check `move` prints —
  // appended here, persisted by the caller with the rest of the exit state, bounded to the
  // last 40 checks (~160s at the 4s cadence, comfortably past the bleed lookback). The bleed
  // section (4d) judges "still falling" against this series and nothing else.
  const moveHist = [...(pos.moveHist || []), { ts: now, move }].slice(-40);
  // Fail-safe confirmation state (user 2026-10-14, "a fail safe to the fail safe"): per-kind
  // pending triggers for the three fail-safe exits (leash / ratchet / bleed), persisted on
  // the position by the caller alongside probationSince/moveHist. A position carrying NO
  // exitPending field was opened before this layer existed and keeps the instant behavior —
  // the same legacy fail-open the ratchet's arming uses for a missing peakMove. bot.js
  // initializes exitPending: {} at entry, so every position it opens is covered.
  let exitPending = (pos.exitPending && typeof pos.exitPending === 'object') ? { ...pos.exitPending } : null;
  const exitConfirmEvents = [];
  // Two-path redesign state (user 2026-10-15, variant c): the kill-zone record
  // ({armed, entries}) and the POST-TP1 peak of `move` — both persisted by the
  // caller alongside exitPending. The peak is tracked per check once TP1 has
  // banked (the TP1 fire check itself still reads tp1Done=false here, so the
  // tracker seeds on the first judged check after the bank). A position with no
  // pathClass (opened before this build) is never modest and carries no overlay —
  // the new sections simply never engage for it.
  let killZone = (pos.killZone && typeof pos.killZone === 'object') ? { armed: !!pos.killZone.armed, entries: pos.killZone.entries || 0 } : null;
  let postTp1PeakMove = pos.postTp1PeakMove != null ? pos.postTp1PeakMove : null;
  if (pos.tp1Done) postTp1PeakMove = Math.max(postTp1PeakMove ?? 0, move);
  const killzoneEvents = [];
  // STRIP (modestBranch): the lane no longer branches anything — a modest-classified
  // remainder judges through the plain ladder exactly like any other remainder.
  const modestActive = !STRIP.modestBranch && !!pos.tp1Done && pos.pathClass === 'modest';
  const zoneEligible = !STRIP.modestBranch && !!pos.tp1Done && !pos.tp2Done && cfg.killZoneFloorPct > 0 && (modestActive || !!pos.killZoneOverlay);
  // Dead-flow arming (user 2026-10-15; REPOSITIONED to the moonbag stage by
  // exit-stack v2, user order 2026-10-15 ~20:26 EDT): a persisted flag on the
  // position, set on the first check the realizable peak move (peakMove)
  // reaches the arm line while the position is POST-TP2; counted once via
  // deadflowEvents. Arming is bookkeeping only — section 3c2 judges the fire
  // fresh from the flow/move history on every check. Window 0 (rule off)
  // never arms, and pre-TP2 positions are out of scope entirely: the ladder
  // owns them. (The rule's first incarnation armed PRE-TP1 at the same line;
  // v2 removed that placement outright — nothing pre-TP2 can arm or fire it.
  // A flag a pre-v2 position already carries simply stays inert until TP2.)
  let deadflowArmed = !!pos.deadflowArmed;
  const deadflowEvents = [];
  if (pos.tp2Done && cfg.deadflowWindowSec > 0 && !deadflowArmed && peakMove >= 1 + cfg.deadflowArmPct) {
    deadflowArmed = true;
    deadflowEvents.push({ type: 'armed' });
  }
  // Stall-exit state (user order 2026-10-16 19:24 EDT, section 5): the
  // pending stamp (ms) of the first dead-flow check inside the rule's
  // confirm window — null = no pending. Persisted by the caller with the
  // rest of the exit state, so a pending survives restarts; a position
  // opened before this build carries none and starts unpended.
  let stallPending = pos.stallPending ?? null;
  const stallEvents = [];
  // Entry-clip confirm state (owner amendment 2026-10-18 20:28 EDT,
  // section 5a): the pending stamp (ms) of the first check at/below the
  // clip line inside the rule's confirm window — null = no pending.
  // Persisted by the caller with the rest of the exit state, so a
  // pending survives restarts; a position opened before this build
  // carries none and starts unpended.
  let clipPending = pos.clipPending ?? null;
  // Scope, enforced here so no section below has to re-check it: the rule
  // exists only while its switch is on and the position is pre-moonbag —
  // reaching TP2 (or flipping STALL_EXIT off) drops any carried pending,
  // so no stale stamp can execute in a stage the rule does not own.
  if (!(cfg.stallExit > 0) || pos.tp2Done) stallPending = null;
  // Same enforcement for the clip: the rule exists only while its switch
  // is on and the position is pre-TP1 — banking TP1 (or flipping
  // ENTRY_CLIP off) drops any carried pending, so no stale stamp can
  // execute in a stage the rule does not own.
  if (!(cfg.entryClip > 0) || pos.tp1Done || pos.tp2Done) clipPending = null;
  // Dead-flow loss-exit events (owner order 2026-10-20 00:32 EDT,
  // section 5c): the fire is judged fresh from the recorded tape on
  // every check — the trailing window is the confirmation — so the
  // rule carries NO persisted state: no pending, no arming flag. The
  // events array is its only bookkeeping (the caller tallies fires).
  const deadLossEvents = [];
  // Staged moonbag dead-flow state (user order 2026-10-16 ~20:15 EDT,
  // sections 3c2/3c3): bagDeadWaves counts the dead-flow waves that have
  // sold on this bag (0, 1, 2 — a count of SOLD waves, never decremented);
  // bagDeadHot records whether the dead-flow trigger condition held on
  // the previous judged check, which is what makes the waves edge-based:
  // a wave can only fire on a check where the condition holds while the
  // previous check's did not. Both persist on the position (the caller
  // threads them back from every decision), so the staging survives
  // restarts; a position opened before this build carries neither and
  // starts at wave 0, not hot.
  let bagDeadWaves = pos.bagDeadWaves || 0;
  let bagDeadHot = !!pos.bagDeadHot;
  // Moonbag trim state (owner order 2026-10-17 ~00:27 EDT, section 3c1):
  // bagTp2Ratio is the realizable ratio the TP2 fire check printed — the
  // trim's baseline, stamped by that check's decision (below) and threaded
  // back by the caller like every other state field; null until TP2 banks
  // (a position that crossed TP2 before the stamp existed carries none and
  // 3c1 judges it against the TP2 trigger level instead). bagTrimDone is
  // the once-per-position flag: persisted, never reset, so no partial sell
  // or re-crossing can ever re-arm the trim.
  let bagTp2Ratio = pos.bagTp2Ratio ?? null;
  let bagTrimDone = !!pos.bagTrimDone;
  // Moonbag-trail confirmation state (owner order 2026-10-16 23:12 EDT,
  // "Give it a 1 min timer"): the ms stamp of the first check the 3c trail
  // line read breached — null = no breach pending. The trail no longer
  // sells on the first sub-line print: the breach must HOLD for
  // BAG_TRAIL_CONFIRM_SEC (default 60) before the bag sells, and any check
  // back above the line clears the stamp outright — a snap-back disarms,
  // the floorSince discipline. Founding case: Chameleon's bag trailed out
  // at a V-bottom that recovered above the peak within ~3 minutes; the bag
  // is ~$1, so a minute of patience costs nothing and keeps the coin
  // tracked through the dip. Judged here in state prep (like floorSince)
  // because the breach is a level read off this check's own peakRatio:
  // the stamp/clear transitions — and their deadflowEvents notes — are
  // computed once, and section 3c only reads the clock. The caller threads
  // the stamp back from every decision, so a pending survives restarts; a
  // position opened before this build carries none and starts unpended.
  // Scope: the trail exists only post-TP2 and only while its window is on
  // — anything else drops a carried stamp, and with the window at 0 no
  // stamp ever accrues (the instant fire is restored exactly).
  // SMALL-BAG MODE (owner order 2026-10-17 ~04:38 EDT): the trail is
  // closeted with the waves — bagSmallHold is declared HERE (above both
  // consumers) because the breach read itself is mode-gated: in small
  // mode trailBreached is always false, section 3c never judges, no
  // trail-pending ever stamps, and a stamp a position somehow carries
  // drops silently (no trail-cleared event — the trail simply isn't a
  // thing in this mode). The bag's only full exit is the 3c3 floor.
  const bagSmallHold = (cfg.bagSmallHold ?? 1) > 0;
  const bagTrailConfirmSec = cfg.bagTrailConfirmSec ?? 60;
  let bagTrailSince = pos.bagTrailSince ?? null;
  const trailBreached = !bagSmallHold && !!pos.tp2Done && ratio <= peakRatio * (1 - cfg.bagTrailPct);
  if (bagSmallHold || !(bagTrailConfirmSec > 0) || !pos.tp2Done) bagTrailSince = null;
  else if (trailBreached) {
    if (bagTrailSince == null) { bagTrailSince = now; deadflowEvents.push({ type: 'trail-pending' }); }
  } else if (bagTrailSince != null) {
    bagTrailSince = null;
    deadflowEvents.push({ type: 'trail-cleared' });
  }
  // Small-bag floor confirmation state (owner order 2026-10-17 ~00:22 EDT,
  // "no dead flow no 50% cut just hold" — section 3c3): in small-bag mode
  // the 3c3 floor is the bag's downside exit and it confirms exactly like
  // the trail above — the first check at/below the floor line stamps
  // bagFloorSince, the bag sells only after BAG_FLOOR_CONFIRM_SEC
  // (default 60) CONTINUOUS seconds at/below the line, and any check back
  // above the line clears the stamp with no accumulated credit. Judged
  // here in state prep for the same reason as the trail's: the breach is
  // a level read off this check's own ratio, so section 3c3 only reads
  // the clock. Scope: small-bag mode + post-TP2 + window on — anything
  // else drops a carried stamp, and with the window at 0 no stamp ever
  // accrues (the instant fire). The caller threads the stamp back from
  // every decision, so a pending survives restarts; a position opened
  // before this build carries none and starts unpended.
  const bagFloorConfirmSec = cfg.bagFloorConfirmSec ?? 60;
  let bagFloorSince = pos.bagFloorSince ?? null;
  const floorBreached = bagSmallHold && !!pos.tp2Done && ratio <= 1 + cfg.bagFloorPct;
  if (!bagSmallHold || !(bagFloorConfirmSec > 0) || !pos.tp2Done) bagFloorSince = null;
  else if (floorBreached) {
    if (bagFloorSince == null) { bagFloorSince = now; deadflowEvents.push({ type: 'floor-pending' }); }
  } else if (bagFloorSince != null) {
    bagFloorSince = null;
    deadflowEvents.push({ type: 'floor-cleared' });
  }
  // PROTECT switch (user 2026-10-15, "just the stop loss… no ratchet", "no SL until I
  // say"): a one-time, per-position flag set via POST /protect while the user rides a
  // coin himself. While protected, ONLY the stop-loss family (2a dip stop, 2a2 hard
  // floor, 2b grace stop), the break-even ratchet (4c) and the kill zone (4e — the
  // redesign widened the scope by exactly that one rule, user 2026-10-15) are
  // skipped — the stall exit (5) and the full TP ladder judge exactly
  // as normal. (Since the 2026-10-15 strip + v2, the stop family, kill zone, bleed,
  // probation/stall, the trails and Tratchet are off for EVERY position, protected or not;
  // the only suppression with live effect left is the post-TP2 dead flow's, 3c2 — its
  // staged waves included: a suppressed wave neither sells nor counts. The 3c3 stub
  // floor is NOT suppressed — it is a price-level exit like the moonbag trail (3c),
  // which protection has never blocked.) The flag holds for the
  // LIFE of the position: no timeout, no auto-expiry; it clears only when the
  // position closes or when POST /unprotect clears it (bot.js owns both, and
  // unprotect also resets the kill-zone record so the zone re-arms fresh). The
  // stop's armed state and any ratchet/kill-zone pending are dropped from the
  // returned state below so none can execute while the flag is set; bleed/leash
  // pendings pass through untouched. Each suppression is reported on the decision
  // as protectedBlock (the first suppressed kind, once per check) for bot.js to
  // count in stats.protect.
  const prot = !!pos.protected;
  let protectedBlock = null;
  const noteBlock = (kind) => { if (prot && !protectedBlock) protectedBlock = kind; };
  if (prot) {
    stopArmedTs = null; floorChecks = 0; floorSince = null;
    if (exitPending != null) { delete exitPending.ratchet; delete exitPending.killzone; }
  }
  // TAKEOVER switch (user 2026-10-15, the XZON race: his manual sell collided with
  // the bot's own ratchet sell and the bot's sell found no balance): POST /takeover
  // hands the position to the user ENTIRELY. While pos.takenOver is set, NO exit
  // section below runs — not the TP ladder, not the trails, not the stop family,
  // not bleed/leash/ratchet, not the time stops, not even liquidity death: the bot
  // must never sell any fraction of a coin the user is driving himself. Tracking
  // still runs (ratio/peak/moveHist above are computed and returned, so marks and
  // the true peak stay current for the dashboard and for release), but all ARMING
  // state is dropped from the returned state: pendings cleared silently (no fake
  // cancel events — exitConfirmEvents stays empty), the stop un-armed, probation
  // and the adaptive-TP1 arm cleared. On release (bot.js), judging resumes fresh:
  // the stall/probation clock re-anchors to the release moment (stallBaseTs,
  // section 4b), so no clock that matured during the takeover can fire. Takeover
  // supersedes protect: with both flags set, this return wins and nothing judges.
  const taken = !!pos.takenOver;
  const out = (fraction, reason) => ({ fraction, reason, newPeak: peakRatio, newPeakMove: peakMove, ratio, stallSince: null, stopArmedTs, floorChecks, floorSince, probationSince, tp1Arm, moveHist, exitPending, exitConfirmEvents, protectedBlock, killZone, postTp1PeakMove, killzoneEvents, deadflowArmed, deadflowEvents, stallPending, stallEvents, clipPending, deadLossEvents, bagDeadWaves, bagDeadHot, bagTrailSince, bagFloorSince, bagTp2Ratio, bagTrimDone });
  if (taken) {
    stopArmedTs = null; floorChecks = 0; floorSince = null; probationSince = null; tp1Arm = null; stallPending = null; clipPending = null; bagDeadHot = false; bagTrailSince = null; bagFloorSince = null;
    if (exitPending != null) exitPending = {};
    return { ...out(0, null), takenOver: true };
  }
  // failSafe(kind, reason): a fail-safe exit whose FULL condition is true on this check calls
  // this instead of returning its sell directly. EXIT_CONFIRM_SEC = 0 (or a legacy position)
  // → the sell decision, exactly as before the layer. Otherwise the first trigger only ARMS
  // the pending ({kind: now}) and returns null — evaluation continues, so every other exit
  // still judges this check and any sell it produces executes normally; the pending sells on
  // the first check at/after the window with the condition still true (counted 'confirmed').
  const failSafe = (kind, reason) => {
    if (!((cfg.exitConfirmSec || 0) > 0) || exitPending == null) return out(1, reason);
    const since = exitPending[kind];
    if (since == null) { exitPending[kind] = now; return null; }
    if (now - since >= cfg.exitConfirmSec * 1000) {
      delete exitPending[kind];
      exitConfirmEvents.push({ type: 'confirmed', kind });
      return out(1, reason);
    }
    return null;
  };
  // cancelPending(kind): the exit's condition read FALSE on a check inside its window — the
  // breakdown did not hold, so the pending sell is disarmed (counted 'cancelled') and the
  // exit can re-trigger later with a fresh window.
  const cancelPending = (kind) => {
    if (exitPending != null && exitPending[kind] != null) {
      delete exitPending[kind];
      exitConfirmEvents.push({ type: 'cancelled', kind });
    }
  };

  // 1. liquidity death: the pool can no longer absorb what we hold
  const valueUsd = mark.valueSol * (mark.solUsd || 150);
  if (mark.liqUsd != null && (mark.liqUsd < 2000 || mark.liqUsd < valueUsd * 2)) return out(1, `liquidity death ($${Math.round(mark.liqUsd)} liq vs $${Math.round(valueUsd)} position)`);

  // 2a. dip stop: price fell dipStopPct below entry — sell, no exceptions
  //     (PROTECT: skipped while the position is protected — part of the stop-loss family)
  //     STRIP (stopFamily): disabled in code — the section below can never fire.
  if (!STRIP.stopFamily && cfg.dipStopPct > 0 && move <= 1 - cfg.dipStopPct) {
    if (prot) noteBlock('dip stop');
    else return out(1, `dip stop (price ${((move - 1) * 100).toFixed(1)}% from entry)`);
  }

  // 2a2. hard floor on realizable value — but confirmed (user 2026-10-13): one tick under the
  //      floor is a wick until the next check proves the price is still there. Both of today's
  //      floor fires (Udderstep, SAMM) were sub-4s wicks that bounced instantly and then ripped;
  //      the floor sold the bottom of both. Requiring stopHardConfirmChecks consecutive checks
  //      at/below the floor (default 2) lets the snap-back disarm it (floorChecks resets above),
  //      while a real collapse is still there ~4s later and sells. No flow veto once confirmed.
  //      An unconfirmed breach falls through: the grace stop (2b) arms on this same tick and
  //      governs the -10..-20 zone unless the floor confirms on the next check.
  if (!STRIP.stopFamily && hardBreached) { // STRIP (stopFamily): the hard floor can never fire
    if (prot) noteBlock('stop-loss'); // PROTECT: the hard floor is stop-loss family — skipped, and its counters stay cleared (see the protect block above)
    else {
      floorChecks += 1;
      const checksOk = floorChecks >= (cfg.stopHardConfirmChecks ?? 2);
      const timeOk = now - floorSince >= (cfg.stopHardConfirmSec || 0) * 1000;
      if (checksOk && timeOk) return out(1, `stop-loss (${((ratio - 1) * 100).toFixed(0)}%, hard floor${(cfg.stopHardConfirmSec || 0) > 0 ? `, confirmed ${((now - floorSince) / 1000).toFixed(0)}s under` : ((cfg.stopHardConfirmChecks ?? 2) > 1 ? `, confirmed ${floorChecks} checks` : '')})`);
    }
  }

  // 2b. grace stop (user 2026-10-13): breaching the arm line (cfg.stopLoss) starts a grace window
  //     instead of selling on the tick. When the window ends, the flow decides with an exact test:
  //     sells outweighing buys (sellsM5 > buysM5) or almost no buys left (buysM5 <= 2) — or no flow
  //     data at all — confirms the death and sells. Buyers at least matching sells vetoes the sell
  //     (they're absorbing the dip) and disarms, so a later breach re-arms fresh.
  if (!STRIP.stopFamily && cfg.stopLoss > 0 && ratio <= 1 - cfg.stopLoss) { // STRIP (stopFamily): the grace stop can never arm or fire
    if (prot) noteBlock('stop-loss'); // PROTECT: the grace stop is stop-loss family — skipped, never arms while the flag is set
    else {
      if (stopArmedTs == null) stopArmedTs = now;
      if (now - stopArmedTs >= (cfg.stopGraceSec || 0) * 1000) {
        const flowAlive = cfg.stopFlowVeto > 0 && mark.buysM5 != null && mark.buysM5 > 2 && mark.sellsM5 <= mark.buysM5;
        if (!flowAlive) return out(1, `stop-loss (${((ratio - 1) * 100).toFixed(0)}%, confirmed after ${cfg.stopGraceSec}s grace, flow ${mark.buysM5 ?? '?'}b/${mark.sellsM5 ?? '?'}s)`);
        stopArmedTs = null;
      }
    }
  }

  // 3. TP ladder (user 2026-10-13): sell INTO strength at fixed levels — up-firing exits fill near
  //    their level, while down-firing trails gap 25-55 points through their lines on one-candle
  //    dumps (the recorded exits of all nine recent 2.4-3.1x runners). TP1 is ADAPTIVE (the user's
  //    twist): it arms at tp1Pct and, while the run still looks strong (see `strong` above), the
  //    bank target slides up toward tp1AdaptMax; it fires at the ceiling, on a tp1Giveback rollover
  //    from the peak, or the moment strength fades. Gains are net of fees, as always here.
  if (!pos.tp1Done && !pos.noTp && cfg.tp1Frac > 0) {
    // TP1 OVERRIDE (user 2026-10-16 19:12 EDT, "arm tp1 to hit at 50% / not
    // 20%-60% / just for this coin"): pos.tp1AtPct (set via POST /tp1at,
    // bot.js owns the field) pins THIS position's TP1 to one flat line.
    // While set, the adaptive machinery below is fully bypassed for the
    // position — any arm it carried is dropped, and no ceiling / rollover /
    // strength-fade fire can sell before the line. At the line, TP1 banks
    // cfg.tp1Frac flat and advances stages exactly as an adaptive fire does
    // (the same pathClass / killZoneOverlay derivation off the realized
    // gain rides the decision). The fire spends the override: bot.js clears
    // the field when it books any TP1, and this section's !tp1Done gate
    // already makes a stale value on a middle-stage position inert. TPs
    // judge under protect, so the override does too; takeover returned
    // long before this section, so a taken-over position's override simply
    // never fires. Nothing else reads the field — the stall exit and
    // every other position are untouched.
    if (pos.tp1AtPct > 0) {
      tp1Arm = null; // the adaptive arm does not survive into the override window
      if (gain >= pos.tp1AtPct) {
        const pathClass = gain > cfg.modestMaxPct ? 'ladder' : (gain >= cfg.modestMinPct ? 'modest' : 'ladder');
        const killZoneOverlay = gain < cfg.modestMinPct;
        return { ...out(cfg.tp1Frac, `TP1 +${Math.round(pos.tp1AtPct * 100)}% (override)`), tp1: true, tp1Arm: null, pathClass, killZoneOverlay };
      }
      // below the override line: nothing TP1-related arms or fires this check
    } else {
      if (tp1Arm == null && gain >= cfg.tp1Pct) tp1Arm = { ts: now, share: shareNow };
      if (tp1Arm != null) {
        let fire = null;
        if (gain >= cfg.tp1AdaptMax) fire = `ceiling +${Math.round(cfg.tp1AdaptMax * 100)}%`;
        else if (peakGain - gain >= cfg.tp1Giveback) fire = 'rollover';
        else if (!strong) fire = 'strength faded';
        if (fire) {
          // Two-path classification (user 2026-10-15, variant c): the fire's realized
          // gain — the same `gain` this sell record prints — picks the remainder's
          // path: inside [modestMinPct, modestMaxPct] → MODEST; above → LADDER;
          // below → LADDER plus the kill-zone overlay (4e). Stamped on the decision
          // for bot.js to persist on the position and journal on this sell + the close.
          const pathClass = gain > cfg.modestMaxPct ? 'ladder' : (gain >= cfg.modestMinPct ? 'modest' : 'ladder');
          const killZoneOverlay = gain < cfg.modestMinPct;
          return { ...out(cfg.tp1Frac, `TP1 +${(gain * 100).toFixed(0)}% (adaptive: ${fire})`), tp1: true, tp1Arm: null, pathClass, killZoneOverlay };
        }
      }
    }
  }

  // 3a. MODEST TARGET + SPLIT (two-path redesign, user 2026-10-15): a modest
  //     STRIP (modestBranch): modestActive is forced false above, so this section
  //     can never fire — the remainder judges through the plain ladder instead.
  //     remainder is NOT trailed (3b / 3d-pre / 3d / 4 all skip it below) — it rides
  //     to this target on `move`. At the target the remainder SPLITS: bank
  //     modestSplitBankFrac of it on this sell, and the surviving slice converts
  //     to the ladder path (bot.js flips pos.pathClass on the modestSplit flag),
  //     where TP2, the trails and the moonbag judge it under the ladder's existing
  //     semantics and fraction conventions. A profit event: protect does NOT
  //     suppress it; takeover returned long before this section.
  if (modestActive && cfg.modestTargetPct > 0 && move >= 1 + cfg.modestTargetPct) {
    return { ...out(cfg.modestSplitBankFrac, `modest target +${(cfg.modestTargetPct * 100).toFixed(0)}% — banked ${(cfg.modestSplitBankFrac * 100).toFixed(0)}% of remainder, rest to ladder`), modestSplit: true };
  }

  // 3b. TP2: the second bank, at tp2Pct — sells tp2Frac of the ORIGINAL position (converted to a
  //     fraction of what remains). Fires on the way up, near the level, before the dump candle.
  //     An un-split MODEST remainder never reaches this section's rule (3a owns it until the split).
  if (!modestActive && pos.tp1Done && !pos.tp2Done && !pos.noTp && cfg.tp2Frac > 0 && gain >= cfg.tp2Pct) {
    const frac = Math.min(1, cfg.tp2Frac / Math.max(pos.remainingFrac, 1e-9));
    // Moonbag trim baseline (owner order 2026-10-17 ~00:27 EDT): stamp the
    // realizable ratio THIS check prints — the bag's value at the TP2
    // moment — so section 3c1 can judge +200% from here. Stamped once:
    // a position that somehow re-judges TP2 keeps its original stamp.
    if (bagTp2Ratio == null) bagTp2Ratio = ratio;
    return { ...out(frac, `TP2 +${(gain * 100).toFixed(0)}%`), tp2: true };
  }

  // 3c. moonbag: the post-TP2 remainder trails bagTrailPct below its peak — no at-entry floor, and
  //     the generic trailing stop / profit lock below skip tp2Done positions: the bag's job is to ride.
  //     SMALL-BAG MODE (owner order 2026-10-17 ~04:38 EDT): this section NEVER judges —
  //     trailBreached is mode-gated false in state prep, so a small-bag position falls
  //     straight through to the trim (3c1) and the floor (3c3), its only full exit. The
  //     trail lives on in the closet: BAG_SMALL_HOLD=0 restores every line below
  //     byte-for-byte, confirm timer included.
  //     CONFIRMATION (owner order 2026-10-16 23:12 EDT, "Give it a 1 min timer"): while
  //     BAG_TRAIL_CONFIRM_SEC > 0, a breach only sells once it has HELD — state prep
  //     stamped bagTrailSince on the first sub-line check and clears it on any check back
  //     above the line. Inside the window this section returns a no-sale that still OWNS
  //     the check, exactly as the instant fire did (3c2/3c3 below never judge a breach
  //     check), and the first check at/after the window with the line still breached
  //     sells the bag in full, its reason carrying the hold. Window 0 restores the
  //     pre-timer behavior byte-for-byte: the first sub-line print sells, same string.
  if (trailBreached) {
    if (bagTrailConfirmSec > 0) {
      const heldMs = bagTrailSince != null ? now - bagTrailSince : 0;
      if (heldMs < bagTrailConfirmSec * 1000) return out(0, null);
      return out(1, `moonbag trail (${Math.round(cfg.bagTrailPct * 100)}% off peak ${peakRatio.toFixed(2)}x, now ${((ratio - 1) * 100).toFixed(1)}%, held ${Math.round(bagTrailConfirmSec)}s)`);
    }
    return out(1, `moonbag trail (${Math.round(cfg.bagTrailPct * 100)}% off peak ${peakRatio.toFixed(2)}x, now ${((ratio - 1) * 100).toFixed(1)}%)`);
  }

  // 3c1. MOONBAG TRIM (owner order 2026-10-17 ~00:27 EDT, "200% from TP2 —
  //      trim 50%"): a TP-ladder-family profit take on the bag, judged in
  //      BOTH bag modes (a moonbag-stage rule, not a mode rule). Once per
  //      position: when the realizable ratio reaches BAG_TRIM_MULT (3) ×
  //      the ratio stamped at the TP2 print — +200% measured from the TP2
  //      moment, ≈5.4x entry — sell half the CURRENT remainder; the
  //      surviving half stays under the moonbag rules (the 3c trail judged
  //      above, dead flow / floor below). Judged on ratio — the remainder's
  //      value per its share of entry cost — never on remainingFrac, so
  //      wave/partial sells (and the trim's own booking) cannot move the
  //      line or re-arm it: the persisted bagTrimDone flag is the
  //      once-only guarantee. A position that crossed TP2 before the stamp
  //      existed judges against 1 + tp2Pct, the TP2 trigger level — the
  //      same ≈5.4x-entry figure the order names. PROTECT does not
  //      suppress it (a profit take like TP1/TP2, which protection has
  //      never blocked); TAKEOVER returned long before here. PLACEMENT:
  //      after the trail, like every moonbag-stage rule — a trail breach
  //      on the same check keeps the trail's label.
  if (pos.tp2Done && !bagTrimDone && (cfg.bagTrimMult ?? 3) > 0) {
    const trimBase = bagTp2Ratio != null ? bagTp2Ratio : 1 + cfg.tp2Pct;
    if (trimBase > 0 && ratio >= (cfg.bagTrimMult ?? 3) * trimBase) {
      bagTrimDone = true;
      return { ...out(0.5, `moonbag trim (+200% from TP2 — sold 50%, now +${((ratio - 1) * 100).toFixed(1)}%)`), bagTrim: true };
    }
  }

  // 3c2. DEAD FLOW AFTER TP2 (exit-stack v2, user 2026-10-15 ~20:26 EDT): the
  //      dead-flow rule, repositioned. Its first incarnation judged PRE-TP1
  //      positions at altitude (founding case Scout/AAD) and was stripped the
  //      same day it shipped; in the v2 spec the user gives dead flow exactly
  //      one stage — the MOONBAG. Once TP1 and TP2 have banked, a remainder
  //      nobody is buying anymore is finished: if its own flow flatlines for
  //      a full rolling window, the whole bag sells instead of waiting for
  //      the wide trail to be reached. Machinery and parameters are the
  //      original rule's, unchanged:
  //        ARM: the position's peak `move` reached 1 + deadflowArmPct (state
  //          prep above, persisted as pos.deadflowArmed — a post-TP2 position
  //          crossed that line long ago, so arming is effectively immediate).
  //        TRIGGER — all three over a rolling deadflowWindowSec window
  //          (DEADFLOW_WINDOW_SEC; 120s in the live store), judged on the ~4s
  //          checks from the position's OWN recorded series:
  //          1. the buy count barely moves: flowHist's per-check `buys` (the
  //             trailing-5m buy count bot.js records every check) rises by at
  //             most deadflowMaxBuyDelta (1) across the window.
  //          2. no new peak inside the window: the best `move` printed since
  //             the window opened does not exceed the peak as of its start
  //             (both off moveHist, the position's own per-check move prints).
  //          3. the price actually stopped pushing: the current `move` sits
  //             at least deadflowPeakGapPct below that window-start peak —
  //             and the window-start peak itself is at/above the arm line, so
  //             the stall being judged is a stall at altitude, not a sag.
  //      The window IS the confirmation — a full window of accumulated dead
  //      flow, not one bad tick — so the fire is instant: no exitPending.
  //      FAIL-CLOSED: the window must be fully covered (flow + move samples
  //      at or just before its start, a fresh current sample, buy counts
  //      present at both ends) — missing data never fires.
  //      SCOPE is exactly tp2Done: pre-TP1 and post-TP1/pre-TP2 positions can
  //      never fire it. PLACEMENT: after the moonbag trail — a trail breach
  //      on the same check keeps the trail's label; both sell the full bag.
  //      PROTECT suppresses the fire like the original rule's (noteBlock —
  //      it is a profit-side auto exit); TAKEOVER returned long before here.
  //      STAGED (user order 2026-10-16 ~20:15 EDT; BAG_DEAD_STAGED, default
  //      on): the trigger above is unchanged, but the fire no longer sells
  //      the whole bag. The trigger is judged as a LEVEL (deadTrig) and the
  //      sells hang off its EDGES: a check where deadTrig holds while the
  //      previous judged check's did not is a WAVE — wave 1 and wave 2 each
  //      sell 50% of the current remainder (the TP-style partial machinery
  //      books them; the position survives). A wave suppressed by protect
  //      neither sells nor counts, but the level still reads hot, so the
  //      edge is spent either way — an unprotect into the same dead tape
  //      must wait for a clear and a fresh edge, like any other check.
  //      After wave 2 the level is inert: dead flow never sells again on
  //      this position, and the stub's only price exit is the 3c3 floor
  //      (plus the untouched 3c trail, which outranks everything here).
  //      BAG_DEAD_STAGED=0 keeps the legacy branch below: the first dead
  //      check sells the whole bag, exactly as this section read before.
  //      SMALL-BAG MODE (owner order 2026-10-17 ~00:22 EDT; BAG_SMALL_HOLD,
  //      default on): this whole section is INERT — dead flow sells NOTHING
  //      on the bag, staged or legacy: no waves, no wave counting, the bag
  //      simply holds, and the 3c3 floor (with its confirmation) is the
  //      downside exit. The waves machinery stays in the code intact behind
  //      the mode switch — closeted for the bigger-bag regime per the
  //      owner's amendment ("once we start leaving bigger moon bags we
  //      utilize it") — and with the mode off every line below judges
  //      exactly as it did before the small-bag build.
  if (!bagSmallHold && pos.tp2Done && cfg.deadflowWindowSec > 0 && deadflowArmed) {
    const winMs = cfg.deadflowWindowSec * 1000;
    const winStart = now - winMs;
    let fStart = null, fNow = null;
    for (const s of pos.flowHist || []) {
      if (!s || s.ts == null) continue;
      if (s.ts <= winStart && (fStart == null || s.ts > fStart.ts)) fStart = s;
      if (fNow == null || s.ts > fNow.ts) fNow = s;
    }
    let peakAtStart = null, peakInWindow = null;
    for (const h of moveHist) {
      if (h.ts <= winStart) peakAtStart = peakAtStart == null ? h.move : Math.max(peakAtStart, h.move);
      else peakInWindow = peakInWindow == null ? h.move : Math.max(peakInWindow, h.move);
    }
    const covered = fStart != null && fNow != null && winStart - fStart.ts <= 12000 && now - fNow.ts <= 12000
      && fStart.buys != null && fNow.buys != null && peakAtStart != null && peakInWindow != null;
    const buyDelta = covered ? fNow.buys - fStart.buys : null;
    const deadTrig = covered && peakAtStart >= 1 + cfg.deadflowArmPct
      && buyDelta <= cfg.deadflowMaxBuyDelta && peakInWindow <= peakAtStart + 1e-9 && move <= peakAtStart - cfg.deadflowPeakGapPct;
    if (deadTrig) {
      if (prot) {
        // a suppressed legacy fire, or a suppressed wave while waves remain;
        // after wave 2 there is no fire left to suppress, so nothing reports
        if (!(cfg.bagDeadStaged > 0) || bagDeadWaves < 2) noteBlock('dead flow');
      } else if (!(cfg.bagDeadStaged > 0)) {
        // LEGACY (BAG_DEAD_STAGED=0): the pre-staging rule entire — the
        // first dead check sells the whole bag, exactly as before.
        deadflowEvents.push({ type: 'fired' });
        bagDeadHot = true;
        return out(1, `dead flow after TP2 (${move >= 1 ? '+' : ''}${((move - 1) * 100).toFixed(1)}%, ${Math.max(0, buyDelta)} new buys in ${cfg.deadflowWindowSec}s, peak stalled)`);
      } else if (bagDeadWaves < 2 && !bagDeadHot) {
        // STAGED WAVE: a rising edge of dead flow sells half of what
        // remains; the position survives and the wave count persists.
        bagDeadWaves += 1;
        bagDeadHot = true;
        deadflowEvents.push({ type: 'wave', wave: bagDeadWaves });
        return { ...out(0.5, `moonbag dead flow (wave ${bagDeadWaves} — sold 50%, ${move >= 1 ? '+' : ''}${((move - 1) * 100).toFixed(1)}%, ${Math.max(0, buyDelta)} new buys in ${cfg.deadflowWindowSec}s, peak stalled)`), bagWave: bagDeadWaves };
      }
      // staged and already hot (or both waves spent): the tape is still
      // dead but nothing sells — the edge must clear before another wave
      // can count, and after wave 2 no wave ever counts again.
    }
    bagDeadHot = deadTrig;
  }

  // 3c3. MOONBAG FLOOR (user order 2026-10-16 ~20:15 EDT, "let the rest
  //      ride until 10+% above avg entry"): once both dead-flow waves have
  //      sold, the surviving stub has exactly one price exit of its own —
  //      when the realizable quote (ratio: current value vs the remainder's
  //      share of the average entry cost) falls to 1 + BAG_FLOOR_PCT, the
  //      stub sells in full. The floor governs the FINAL stub only: before
  //      wave 2 a dip to the line sells nothing (dead-flow staging still
  //      governs, test-pinned), and with BAG_DEAD_STAGED=0 the floor does
  //      not exist. PLACEMENT: after dead flow, before everything below —
  //      the moonbag trail (3c) still outranks it, so a deep retrace off a
  //      high peak keeps the trail's label and its 100% sell; liquidity
  //      death (1) outranks both. PROTECT does not suppress it (a price-
  //      level exit like the trail, which protection has never blocked);
  //      TAKEOVER returned long before here.
  //      SMALL-BAG MODE (owner order 2026-10-17 ~00:22 EDT): the floor is
  //      the bag's downside exit outright — armed from TP2, no wave
  //      precondition, no BAG_DEAD_STAGED gate — and it confirms: state
  //      prep stamped bagFloorSince on the first at/below check, and the
  //      bag sells only once the breach has HELD BAG_FLOOR_CONFIRM_SEC
  //      (default 60) continuous seconds; inside the window this section
  //      returns a no-sale that owns the check, exactly like the trail's
  //      pending (3c), and the first check at/after the window with the
  //      line still breached sells in full, its reason carrying the hold.
  //      Window 0 = the instant fire on the line, same string as the
  //      closeted floor's. The branch below is the closeted mode's floor,
  //      untouched.
  if (bagSmallHold && pos.tp2Done && ratio <= 1 + cfg.bagFloorPct) {
    if (bagFloorConfirmSec > 0) {
      const heldMs = bagFloorSince != null ? now - bagFloorSince : 0;
      if (heldMs < bagFloorConfirmSec * 1000) return out(0, null);
      deadflowEvents.push({ type: 'floor' });
      return out(1, `moonbag floor (+${Math.round(cfg.bagFloorPct * 100)}% over entry, held ${Math.round(bagFloorConfirmSec)}s)`);
    }
    deadflowEvents.push({ type: 'floor' });
    return out(1, `moonbag floor (+${Math.round(cfg.bagFloorPct * 100)}% over entry)`);
  }
  if (cfg.bagDeadStaged > 0 && pos.tp2Done && bagDeadWaves >= 2 && ratio <= 1 + cfg.bagFloorPct) {
    deadflowEvents.push({ type: 'floor' });
    return out(1, `moonbag floor (+${Math.round(cfg.bagFloorPct * 100)}% over entry)`);
  }

  // 3d-pre. TP2 rejection (user 2026-10-13): the middle stage climbed to within reach of the TP2
  //     mark (peak net gain >= tp2RejectZone) but never converted; a fade of tp2RejectDrop off
  //     that peak is a rejection, not a pullback — sell the remainder instead of riding the wide
  //     trail down (wizardcat: peaked +80% net, rode the 25% trail out at +34%).
  if (!modestActive && pos.tp1Done && !pos.tp2Done && cfg.tp2RejectZone > 0 && peakGain >= cfg.tp2RejectZone && ratio <= peakRatio * (1 - cfg.tp2RejectDrop)) return out(1, `TP2 rejection (peak +${(peakGain * 100).toFixed(0)}%, now ${((ratio - 1) * 100).toFixed(1)}%)`);

  // 3d. post-TP1 trail — STRIP (postTp1Trail): disabled in code, can never fire
  //     (removed by user order 2026-10-16 — see the header note). The section is
  //     kept for reversibility only: with the gate on, a middle-stage remainder
  //     is never sold for retracing its peak or fading back to cost.
  if (!STRIP.postTp1Trail && !modestActive && pos.tp1Done && !pos.tp2Done && (ratio <= peakRatio * (1 - cfg.tpTrailPct) || ratio <= 1)) return out(1, `post-TP1 trail (peak ${(peakRatio).toFixed(2)}x, now ${((ratio - 1) * 100).toFixed(1)}%)`);

  // 4. trailing stop once armed (never on the moonbag — it has its own wider trail, 3c;
  //    never on an un-split modest remainder either — see 3d)
  //    STRIP (genericTrail): disabled in code — can never fire.
  if (!STRIP.genericTrail && !modestActive && !pos.tp2Done && peakRatio >= 1 + cfg.trailArm && ratio <= peakRatio * (1 - cfg.trailPct)) return out(1, `trailing stop (${(cfg.trailPct * 100).toFixed(0)}% off peak ${(peakRatio).toFixed(2)}x)`);

  // 4a. profit lock: once up lockArm+ after costs, don't let it round-trip — sell if it gives back (1 - lockKeep) of its
  //     best real gain. Scales with the move: best +40% → sells at +20%; best +200% → sells at +100% (lockKeep 0.5).
  //     Skips the moonbag (post-TP2): the ladder, not the lock, governs the bag.
  //     STRIP (profitLock): disabled in code — can never fire.
  if (!STRIP.profitLock && !pos.tp2Done && cfg.lockKeep > 0 && peakGain >= cfg.lockArm && gain <= peakGain * cfg.lockKeep) return out(1, `profit lock (best +${(peakGain * 100).toFixed(0)}%, now +${(gain * 100).toFixed(0)}% after fees)`);

  // 4b. entry stall (user 2026-10-13, endpoint version): at stallSec from entry, judge where the
  //     price IS, not where it has been — inside the entry range = stalling = sell, however it
  //     got there. The range is asymmetric (user 2026-10-14): −stallBandPct below entry but only
  //     +stallBandUpPct above it — up more than +3% at the deadline is working, not stalled
  //     (UNTXED sold at +2.2% then ripped). A spike that faded back into the range sells; a coin
  //     still outside the range (either direction) is some other rule's problem. Post-TP1
  //     runners are exempt.
  //     PROBATION LEASH (user 2026-10-14, Musclecat): while probation is on
  //     (stallProbationSec > 0), reaching the deadline inside the range no longer sells —
  //     Musclecat sat flat past the 180s deadline, then dove to the −17% hard floor in ~20s
  //     (−0.0169) because nothing owned the space between "stalled" and "floored" (the dip
  //     stop is off). Instead the position goes on probation: a tight leash (stallLeashPct,
  //     on `move` like the stall itself) sells a dive instantly; breaking above the range top
  //     clears probation — the coin is working, the normal stack resumes; and the outer
  //     deadline stallProbationSec, anchored to ENTRY (not to when probation began), sells
  //     whatever is still in the range there. Probation off (stallProbationSec = 0) restores
  //     the original sell-at-the-deadline line, unchanged.
  const stallBandUp = cfg.stallBandUpPct ?? cfg.stallBandPct;
  const heldSec = heldMin * 60;
  // TAKEOVER: after a release, the stall/probation clock re-anchors to the release
  // moment (pos.stallBaseTs, set by bot.js releasePosition) — the takeover window
  // never counts toward the prove-itself deadlines. Positions never released (the
  // field absent) judge from entry exactly as before; the bleed below keeps the
  // true age (heldSec) — only the stall/probation deadlines re-anchor.
  const stallHeldSec = (now - (pos.stallBaseTs || pos.entryTs)) / 1000;
  // STRIP (stallProbation): the whole stall/probation block — deadline sell, the
  // probation leash and the probation expiry — is disabled in code and can never fire.
  if (!STRIP.stallProbation && cfg.stallSec > 0 && !pos.tp1Done && stallHeldSec >= cfg.stallSec) {
    if ((cfg.stallProbationSec || 0) > 0) {
      if (probationSince == null) {
        // deadline reached inside the range: probation starts, no sell
        if (move >= 1 - cfg.stallBandPct && move <= 1 + stallBandUp) { probationSince = now; return out(0, null); }
      } else if (cfg.stallLeashPct > 0 && move <= 1 - cfg.stallLeashPct) {
        // the leash is a fail-safe: confirmed, not instant (EXIT_CONFIRM_SEC). While its
        // pending runs, the position is NOT sold from here — but probation EXPIRY below is
        // a time expiry, not a breakdown trigger, and stays unconfirmed: it still sells on
        // this very check if the deadline has passed, as any other exit would.
        const d = failSafe('leash', `probation leash (${((move - 1) * 100).toFixed(1)}% after stall deadline)`);
        if (d) return d;
        if (stallHeldSec >= cfg.stallProbationSec) return out(1, `probation expired (still in entry range at ${cfg.stallProbationSec}s, ${((move - 1) * 100).toFixed(1)}%)`);
      } else if (move > 1 + stallBandUp) {
        probationSince = null; // breakout: probation over — the sections below judge normally
        cancelPending('leash');
      } else if (stallHeldSec >= cfg.stallProbationSec) {
        return out(1, `probation expired (still in entry range at ${cfg.stallProbationSec}s, ${((move - 1) * 100).toFixed(1)}%)`);
      } else {
        cancelPending('leash'); // on probation, back above the leash line: a pending leash sell is disarmed
      }
      // else: on probation, in range, leash/expiry not met — no exit from this section.
    } else if (move >= 1 - cfg.stallBandPct && move <= 1 + stallBandUp) {
      return out(1, `stall (in entry range at ${cfg.stallSec}s, ${((move - 1) * 100).toFixed(1)}%)`);
    }
  }

  // 4c. break-even ratchet (user 2026-10-14, "Build it — arm at +5%", guarding UNDER the TP
  //     ladder): mined from the user's own pre-TP1 closes — of 22 measurable positions
  //     reconstructed candle-by-candle, EVERY one that peaked >= +5% on the realizable move
  //     and then returned to break-even closed red (9 of 9, ~0.142 SOL of losses at a +5%
  //     arm; DOG peaked +22% and died at the old hard floor, LURK peaked +28% and closed
  //     -0.018). So once the tracked peak move (peakMove, judged on `move` like the stall,
  //     never the raw chart) reaches beArmPct, the trade can no longer become a loser: a
  //     fall back to beTriggerPct sells the FULL position at ~scratch — the +2% cushion over
  //     break-even exists so the executed fill lands at true scratch after the sell's own
  //     slippage (user approved +1-2%). Pre-TP1 ONLY: once TP1 fires, the TP ladder
  //     (TP2 / TP2 rejection / moonbag stage) owns the remainder and this never
  //     fires. Judged on the position's own peak path, independent of the stall/probation
  //     timeline — it can fire inside the first minute. It sits AFTER the stall block so a
  //     probationed position keeps the leash's own label on a deep dive (the leash's -7%
  //     condition is met first inside 4b), while an armed position on probation still
  //     scratches here when it fades to the trigger line. Arming needs no extra persisted
  //     state: it derives from peakMove, which bot.js already persists every check.
  //     Arming requires the position's OWN recorded peakMove: a position carrying none
  //     (legacy) never arms — the peakRatio-derived seed used elsewhere would fake a
  //     breakout off the round-trip (peakRatio floored at 1 / base < 1), so the ratchet
  //     fails open on untracked peaks like every other sampled-data check in this bot.
  //     beArmPct = 0 disables the ratchet. (The mining undercounts the shakeout cost —
  //     winners that dipped to break-even and then ran usually TP1'd out of the measured
  //     set — the user took the +5% arm with that caveat on the table.)
  //     Confirmation (user 2026-10-14): as a fail-safe, the ratchet sells through failSafe —
  //     with EXIT_CONFIRM_SEC > 0 the trigger must hold continuously across the window (a
  //     recovery back above the trigger line cancels via the else-branch below); the reason
  //     string is built fresh on the selling check, exactly as before.
  //     STRIP (tratchet, exit-stack v2): disabled in code — the section below
  //     can never arm a pending or fire, at any BE_ARM/BE_TRIGGER value. A
  //     stale pre-v2 ratchet pending on a carried-over position passes
  //     through untouched and inert (the cancel is gated off with the fire).
  if (!STRIP.tratchet && !pos.tp1Done && cfg.beArmPct > 0 && pos.peakMove != null && peakMove >= 1 + cfg.beArmPct && move <= 1 + cfg.beTriggerPct) {
    if (prot) noteBlock('ratchet'); // PROTECT: "no ratchet" — skipped; its pending was already dropped from the returned state above
    else {
      const pctFmt = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
      const d = failSafe('ratchet', `break-even ratchet (peaked ${pctFmt(peakMove - 1)}, back to ${pctFmt(move - 1)})`);
      if (d) return d;
      // pending: fall through — the bleed section and everything below still judge this check
    }
  } else if (!STRIP.tratchet) {
    cancelPending('ratchet');
  }

  // 4d. bleed exit (user 2026-10-14, "Still-falling test — down 7%+ and not recovering"):
  //     the probation leash (4b) only exists for a coin that sat inside the entry band at the
  //     stall deadline — TAILOOR never did, and bled to -52% over ~6 minutes with no exit
  //     owning it (the user cut it by hand). This frees the leash from the band: past the
  //     prove-itself window (bleedMinAgeSec — before it, the older exits judge alone), ANY
  //     position down bleedPct or more on `move` sells in full IF it is still falling — the
  //     current move at/below the move bleedLookbackSec ago, on the position's own per-check
  //     move history. A coin that dipped and is recovering (current move back above the
  //     lookback print) is left alone — that is the whole test. No reference reading at
  //     least ~45s old (e.g. just after a restart) = no fire yet. No tp1Done exclusion:
  //     post-TP1 the trails judge first and these prints are rarely reachable there.
  //     It sits after 4b/4c, so a probationed dive keeps the leash's own label and an
  //     armed ratchet fade keeps the ratchet's. bleedPct = 0 disables the exit.
  //     Confirmation (user 2026-10-14): as a fail-safe, the bleed sells through failSafe —
  //     the FULL condition, still-falling leg included, is re-tested fresh on every check of
  //     the window; a print that is merely still ≤ −bleedPct but recovering (current move
  //     back above the lookback reference) fails the leg and cancels the pending sell.
  // STRIP (bleed): disabled in code — bleedFires can never become true and the
  // whole fire/cancel block below is gated off with it, so a stale pre-strip
  // bleed pending on a carried-over position passes through untouched and inert.
  let bleedFires = false;
  if (!STRIP.bleed && cfg.bleedPct > 0 && heldSec >= (cfg.bleedMinAgeSec || 0) && move <= 1 - cfg.bleedPct) {
    const target = now - (cfg.bleedLookbackSec || 60) * 1000;
    let ref = null;
    for (const h of pos.moveHist || []) {
      if (!h || now - h.ts < 45000) continue; // the reference must be a real lookback, not the last few checks
      if (ref == null || Math.abs(h.ts - target) < Math.abs(ref.ts - target)) ref = h;
    }
    bleedFires = !!(ref && move <= ref.move);
  }
  if (!STRIP.bleed) {
    if (bleedFires) {
      const d = failSafe('bleed', `bleed exit (${((move - 1) * 100).toFixed(1)}% and still falling)`);
      if (d) return d;
      // pending: fall through — the sections below still judge this check
    } else {
      cancelPending('bleed');
    }
  }

  // 4e. KILL ZONE (two-path redesign, user 2026-10-15): the modest remainder's
  //     STRIP (modestBranch): zoneEligible is forced false above — this section
  //     can never arm, count an entry, or fire.
  //     downside floor, overlaid on sub-band ladder remainders (zoneEligible,
  //     computed in the state prep). Judged on `move`, never the chart:
  //     - ARMING: the zone is inert until the post-TP1 peak (postTp1PeakMove)
  //       reaches killZoneArmMult. A dip before that accrues NO zone state at
  //       all — the bleed/leash window owns it, exactly as before this section
  //       existed (FEEMAIL's class can never start inside an armed zone).
  //     - FIRST ENTRY (armed, move at/below 1 + killZoneFloorPct): the same 10s
  //       confirmation window the fail-safes use, on the same exitPending slot
  //       under kind 'killzone'. Recovery above the floor inside the window
  //       cancels it and COUNTS the entry; still at/below at lapse, the FULL
  //       remainder sells at market.
  //     - SECOND ENTRY after a cancelled window: instant sell, no window — the
  //       window already forgave one wick ("kill it on the way down").
  //     - SLOT PRECEDENCE: the zone never arms a window while a fail-safe
  //       pending (leash/ratchet/bleed) owns the slot — it waits, counts no
  //       entry, and re-judges next check; a zone window already running still
  //       completes on its own clock. One pending, one owner, one sell.
  //     - PROTECT: triggers are suppressed like the stop family (noteBlock; the
  //       pending itself was already dropped in the protect block above).
  //       Arming keeps tracking underneath, so an unprotect finds live state —
  //       bot.js additionally resets the record so entries start fresh.
  //     EXIT_CONFIRM_SEC = 0 (or a legacy position with no exitPending) restores
  //     the pre-layer behavior for the zone too: the first entry sells at once.
  if (zoneEligible) {
    const kz = killZone || { armed: false, entries: 0 };
    const kzFloor = 1 + cfg.killZoneFloorPct;
    if (!kz.armed && postTp1PeakMove != null && postTp1PeakMove >= cfg.killZoneArmMult) {
      kz.armed = true;
      killzoneEvents.push({ type: 'armed' });
    }
    if (kz.armed) {
      if (move <= kzFloor) {
        if (prot) noteBlock('kill zone');
        else if (kz.entries >= 1) {
          killzoneEvents.push({ type: 'reentry' });
          return out(1, `kill zone (re-entry at ${((move - 1) * 100).toFixed(1)}% — second dip into the zone, no window)`);
        } else if (exitPending != null && exitPending.killzone != null) {
          if (!((cfg.exitConfirmSec || 0) > 0) || now - exitPending.killzone >= cfg.exitConfirmSec * 1000) {
            delete exitPending.killzone;
            exitConfirmEvents.push({ type: 'confirmed', kind: 'killzone' });
            killzoneEvents.push({ type: 'fired' });
            return out(1, `kill zone (move ${((move - 1) * 100).toFixed(1)}% held at/below the +${(cfg.killZoneFloorPct * 100).toFixed(0)}% floor through the ${cfg.exitConfirmSec}s window)`);
          }
          // window running, condition holds: fall through — later sections still judge this check
        } else if (!((cfg.exitConfirmSec || 0) > 0) || exitPending == null) {
          killzoneEvents.push({ type: 'fired' });
          return out(1, `kill zone (move ${((move - 1) * 100).toFixed(1)}% at/below the +${(cfg.killZoneFloorPct * 100).toFixed(0)}% floor)`);
        } else if (Object.keys(exitPending).length === 0) {
          exitPending.killzone = now; // first entry: arm the window; later sections still judge this check
        }
        // else: a fail-safe pending owns the slot — the zone waits, no entry counted
      } else if (exitPending != null && exitPending.killzone != null) {
        // recovery above the floor inside the window: cancel it and count the entry
        delete exitPending.killzone;
        exitConfirmEvents.push({ type: 'cancelled', kind: 'killzone' });
        killzoneEvents.push({ type: 'cancelled' });
        kz.entries = 1;
      }
    }
    // the record only exists once the zone has armed or counted an entry —
    // before that, no zone state accrues at all (the returned killZone stays null)
    if (killZone != null || kz.armed || kz.entries > 0) killZone = kz;
  }

  // 5. STALL EXIT (user order 2026-10-16 19:24 EDT — the simplification; see
  //     the header note): the ONE general downside exit, successor to both
  //     the SL ladder (removed) and the momentum-failure undertaker that
  //     stood here (10-minute age gate + this same conjunction, instant,
  //     and it also demanded the position be underwater — a price input
  //     the new rule drops entirely). The rule, entire:
  //       AGE — the position must be at least STALL_EXIT_MIN_AGE_SEC old
  //         (his "3M"): younger than that the rule does not exist for it
  //         and no pending can stamp.
  //       TRIGGER — the undertaker's dead-flow conjunction on the live
  //         check: buysM5 ≤ 1 AND sellsM5 > 3 × buysM5 — the same mark
  //         fields and the same numbers the undertaker judged, carried
  //         over rather than re-invented.
  //       CONFIRM — the first dead check stamps the pending (persisted on
  //         the position, visible on /state); the sell executes at the
  //         first check at/after pending + STALL_EXIT_CONFIRM_SEC (his
  //         "60 sec confirm") where the conjunction STILL holds. Any
  //         intervening check where it fails cancels the pending
  //         outright; it can re-trigger later with a fresh window.
  //     NO price input anywhere: no gain line arms, fires or cancels —
  //     a coin down 50% with buyers alive rides, and a green coin on a
  //     dead tape sells. Sells in full (fraction 1). Scope is pre-TP1 +
  //     middle: state prep already dropped any pending on a tp2Done
  //     position, and the moonbag's own dead flow (3c2) owns the bag.
  //     PROTECT does not block it — it succeeds the undertaker, which
  //     judged under protect; TAKEOVER returned long before this section.
  if (cfg.stallExit > 0 && !pos.tp2Done) {
    const ageOk = heldMin * 60 >= (cfg.stallExitMinAgeSec || 0);
    const deadFlow = mark.buysM5 != null && mark.buysM5 <= 1 && mark.sellsM5 > mark.buysM5 * 3;
    if (ageOk && deadFlow) {
      if (stallPending == null) { stallPending = now; stallEvents.push({ type: 'pending' }); }
      if (now - stallPending >= (cfg.stallExitConfirmSec || 0) * 1000) {
        stallEvents.push({ type: 'fired' });
        return out(1, `stall exit (dead flow, ${cfg.stallExitConfirmSec}s confirm)`);
      }
    } else if (stallPending != null) {
      stallPending = null; // the tape showed life inside the window (or the position left the rule's scope): the pending dies
      stallEvents.push({ type: 'cancelled' });
    }
  }

  // 5a. ENTRY CLIP (owner order 2026-10-18 17:56 EDT — "adding the 3m timer
  //     at the entry stall point like we had before — −7% we clip out";
  //     AMENDED by the owner 2026-10-18 20:28 EDT — "don't sell right away
  //     at the −7% — give it a 1m confirmation there"): the price
  //     counterpart the stall exit (5) deliberately lacks. From
  //     ENTRY_CLIP_SEC of age, a pre-TP1 position whose round-trip move
  //     reaches −ENTRY_CLIP_PCT does NOT sell on the spot: the first
  //     breached check stamps the pending, and the sell executes at the
  //     first check at/after pending + ENTRY_CLIP_CONFIRM_SEC where the
  //     move is STILL at/below the line — the same confirm shape as the
  //     stall exit beside it. Any intervening check back above the line
  //     cancels the pending outright; a later breach starts a fresh
  //     window. ENTRY_CLIP_CONFIRM_SEC=0 restores the original instant
  //     form. No flow conjunction: price alone arms and fires it. Judged
  //     on `move` like the dip stop, so it fires on what the price did,
  //     not on sunk fees. Scope is pre-TP1 only: TP1 banking proves the
  //     entry worked and hands the position to the middle/moonbag judges;
  //     TP2 is further out of scope still. PROTECT does not block it (same
  //     posture as the stall exit beside it); TAKEOVER returned long
  //     before this section.
  if (cfg.entryClip > 0 && !pos.tp1Done && !pos.tp2Done) {
    const ageOk = heldMin * 60 >= (cfg.entryClipSec || 0);
    const breached = ageOk && move <= 1 - (cfg.entryClipPct || 0);
    if (breached) {
      if (clipPending == null) clipPending = now;
      if (now - clipPending >= (cfg.entryClipConfirmSec || 0) * 1000) {
        return out(1, `entry clip (${((move - 1) * 100).toFixed(1)}% at ${Math.floor(heldMin * 60)}s — held under the −${((cfg.entryClipPct || 0) * 100).toFixed(0)}% line through the ${cfg.entryClipConfirmSec}s confirm)`);
      }
    } else if (clipPending != null) {
      clipPending = null; // back above the line inside the window: the pending dies
    }
  }

  // 5c. DEAD-FLOW EXIT (owner order 2026-10-20 00:32 EDT — "no SL at
  //     all, only a dead flow once it's under -10%"): the stack's ONLY
  //     loss-side exit, and price alone still cannot fire it. The rule:
  //       ARM — the position is PRE-TP1 and its round-trip move sits
  //         at/below −DEAD_FLOW_PCT (judged on `move`, like the clip
  //         beside it: what the price did, not sunk fees). Above the
  //         line the rule does not exist for the position.
  //       FIRE — while armed, the tape over the trailing
  //         DEAD_FLOW_WINDOW_SEC reads DEAD under the moonbag dead-flow
  //         test's own terms (3c2), judged on the position's OWN
  //         recorded series: (1) the trailing-5m buy count flowHist
  //         records every check rises by at most deadflowMaxBuyDelta
  //         across the window; (2) no new peak inside the window — the
  //         best `move` printed since it opened does not exceed the
  //         peak as of its start (moveHist). Both terms met sells in
  //         full. The window IS the confirmation — a full window of
  //         dead tape, not one bad tick — so the fire is instant, no
  //         pending, exactly like 3c2.
  //       FAIL-TOWARD-HOLDING (the owner's no-SL intent): the window
  //         must be fully covered — a flow sample at/just before its
  //         start, a fresh current sample, buy counts present at both
  //         ends, move samples on both sides of its start. Missing
  //         tape NEVER fires: a position with no recorded window (just
  //         opened, fresh restart, feed gap) simply holds.
  //     Scope is pre-TP1 only: TP1 banking proves the entry worked and
  //     hands the position to the middle/moonbag judges — the moonbag
  //     stage's own dead flow (3c2) is untouched and owns the bag.
  //     PROTECT does not block it (same posture as the stall exit and
  //     the clip beside it); TAKEOVER returned long before this
  //     section. DEAD_FLOW_EXIT=0 (or a 0 window) disables it entire.
  if (cfg.deadFlowExit > 0 && (cfg.deadFlowWindowSec || 0) > 0 && !pos.tp1Done && !pos.tp2Done && move <= 1 - (cfg.deadFlowPct ?? 0.10)) {
    const winMs = cfg.deadFlowWindowSec * 1000;
    const winStart = now - winMs;
    let fStart = null, fNow = null;
    for (const s of pos.flowHist || []) {
      if (!s || s.ts == null) continue;
      if (s.ts <= winStart && (fStart == null || s.ts > fStart.ts)) fStart = s;
      if (fNow == null || s.ts > fNow.ts) fNow = s;
    }
    let peakAtStart = null, peakInWindow = null;
    for (const h of moveHist) {
      if (h.ts <= winStart) peakAtStart = peakAtStart == null ? h.move : Math.max(peakAtStart, h.move);
      else peakInWindow = peakInWindow == null ? h.move : Math.max(peakInWindow, h.move);
    }
    const covered = fStart != null && fNow != null && winStart - fStart.ts <= 12000 && now - fNow.ts <= 12000
      && fStart.buys != null && fNow.buys != null && peakAtStart != null && peakInWindow != null;
    const buyDelta = covered ? fNow.buys - fStart.buys : null;
    if (covered && buyDelta <= cfg.deadflowMaxBuyDelta && peakInWindow <= peakAtStart + 1e-9) {
      deadLossEvents.push({ type: 'fired', buyDelta });
      return out(1, `dead-flow exit (${((move - 1) * 100).toFixed(1)}% — under the −${((cfg.deadFlowPct ?? 0.10) * 100).toFixed(0)}% line, ${Math.max(0, buyDelta)} new buys in ${cfg.deadFlowWindowSec}s, no new peak)`);
    }
  }

  // 5b. volume decay: volume dried up 70%+ from entry and price isn't pushing up — no fuel left
  //     STRIP (volumeDecay, exit-stack v2): disabled in code — can never fire.
  if (!STRIP.volumeDecay && pos.entryVolH1 > 0 && mark.volH1 != null && heldMin >= 5) {
    const volRatio = mark.volH1 / pos.entryVolH1;
    if (volRatio < 0.3 && ratio < 1.05) return out(1, `volume decay (vol ${(volRatio * 100).toFixed(0)}% of entry, price ${((ratio - 1) * 100).toFixed(1)}%)`);
  }

  // 6. time stop: didn't work fast enough
  //     STRIP (timeStop, exit-stack v2): disabled in code — can never fire.
  if (!STRIP.timeStop && heldMin >= cfg.timeStopMin && ratio < 1 + cfg.timeStopMinGain) return out(1, `time stop (${Math.round(heldMin)}m, ${((ratio - 1) * 100).toFixed(0)}%)`);

  // 7. absolute max hold
  //     STRIP (maxHold, exit-stack v2): disabled in code — can never fire.
  if (!STRIP.maxHold && heldMin >= cfg.maxHoldMin) return out(1, `max hold ${cfg.maxHoldMin}m`);

  return out(0, null);
}
