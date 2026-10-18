// config.js — every number the bot uses lives here. loadConfig(env) is pure so tests can call it.
// All trading thresholds are STARTING GUESSES. The outcome journal exists so you can tune them from data.

const num = (env, k, d) => {
  const v = env[k];
  if (v === undefined || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export function loadConfig(env = process.env) {
  const hasKey = !!(env.WALLET_PRIVATE_KEY || '').trim();
  const realMode = env.REAL_MODE === '1' && hasKey;
  const cfg = {
    realMode,
    modeWarning: env.REAL_MODE === '1' && !hasKey ? 'REAL_MODE=1 but WALLET_PRIVATE_KEY missing → running in SHADOW mode' : null,

    // ---- hard limits (enforced in risk.js, not advisory) ----
    tradeSol: num(env, 'TRADE_SOL', 0.05),
    maxPositions: num(env, 'MAX_POSITIONS', 5),
    slot2Sol: num(env, 'SLOT2_SOL', 0.025),             // size for an entry opened while a position is already open (owner order 2026-10-17: "open up one more trading slot but .025" — slot 1 keeps tradeSol, the second concurrent slot trades this); 0 = off (uniform sizing, the pre-slot stack)
    dailyLossSol: num(env, 'DAILY_LOSS_SOL', 0),        // realized loss in a UTC day that halts new entries; 0 = disabled
    haltAfterCloses: num(env, 'HALT_AFTER_CLOSES', 0),  // one-shot: halt new entries after this many more closes; 0 = off
    // Risk brake (user 2026-10-15, his rule: "after the next 3 L trade half... if 1 trade
    // wipes out the whole .05 then halt after that"): LOSS_HALVE_N red closes counted from
    // arming halve the trade size until /risk/reset lifts it (a win does NOT reset the
    // count); a single close losing >= WIPE_HALT_FRAC of its stake writes the HALT latch
    // after the close completes. 0 = that leg off.
    lossHalveN: num(env, 'LOSS_HALVE_N', 3),            // red closes that halve the trade size
    lossHalveFactor: num(env, 'LOSS_HALVE_FACTOR', 0.5), // size multiplier once the brake trips
    wipeHaltFrac: num(env, 'WIPE_HALT_FRAC', 0.90),     // one close losing this fraction of its stake → HALT
    haltDownSol: num(env, 'HALT_DOWN_SOL', 0),          // balance halt: once armed (baseline = wallet equity at first check), halt if equity falls this much below the baseline; 0 = off. Set 0.09 by user 2026-10-13 for overnight — user corrected: BALANCE, not day P&L.
    // Reconcile drop guard (user order 2026-10-16, the WORLD orphan): a position is
    // only booked as sold-outside-the-bot when its token balance reads zero SUSTAINED —
    // never inside the post-entry grace window (a fresh fill's token account can read
    // as zero across RPC nodes for seconds), and only after the zero has persisted
    // across separate checks spanning the confirm window. One racing 0n read dropped
    // WORLD 5s after its fill while the tokens never left the wallet.
    reconcileGraceSec: num(env, 'RECONCILE_GRACE_SEC', 120),     // no reconcile drop younger than this
    reconcileConfirmSec: num(env, 'RECONCILE_CONFIRM_SEC', 60),  // zero must persist at least this long
    // Orphan adoption (user order 2026-10-16, the second half of the WORLD fix):
    // reconcile also picks bags back UP — a mint the bot itself bought (journal
    // open) whose position was closed off the books while tokens remain in the
    // wallet at real value is re-adopted as a position and managed by the exit
    // stack again. Journal-driven on purpose: every bag the bot owns arrived
    // through a journaled buy, and the mint-filter balance read is the reliable
    // one (programId enumeration proved broken on public/Helius RPCs).
    adoptOrphans: num(env, 'ADOPT_ORPHANS', 1),          // 1 = adoption on
    adoptMinSol: num(env, 'ADOPT_MIN_SOL', 0.005),      // bag must be worth at least this (realizable) — below is dust
    adoptLookbackH: num(env, 'ADOPT_LOOKBACK_H', 168),  // only closes inside this window are candidates
    // Scan Ledger (user order 2026-10-16, RECORD-ONLY): every coin the bot scans
    // leaves a permanent session record (first/peak/last price + mc, biggest
    // run while watched, whether it ever signaled) so coins that ran without
    // ever signaling can be found and studied. The signal journal only ever
    // held the ~10 that fired; the other ~750 evaporated with the in-memory
    // history. Nothing in trading reads the ledger. 0 disables it entirely.
    scanLedger: num(env, 'SCAN_LEDGER', 1),                 // 1 = scan ledger on
    scanSessionIdleSec: num(env, 'SCAN_SESSION_IDLE_SEC', 600), // a watch session finalizes after this long with no fresh view (or at 3h old)
    scanStamps: num(env, 'SCAN_STAMPS', 1),                 // 1 = per-setup evaluation verdicts (judgeScan) stamped on scan-ledger sessions — record-only instrumentation; 0 = session records exactly as before stamps shipped
    // Shadow Seller (user order 2026-10-16, RECORD-ONLY): a LEARNED exit judge
    // with no ladder rules and no borrowed thresholds — it buckets each open
    // position's state (peak band × drawdown band × buy-share-trend sign),
    // looks the bucket up in an evidence table built from the bot's own
    // completed history (journal closes + tick paths: did HOLDING from that
    // state beat the mark on the table?), and journals the first would-sell
    // per position when the evidence says holding paid worse. Fires are
    // paired against the ladder's actual outcome on the same remainder at
    // close (/shadowseller). It can never sell, gate, or touch live logic.
    shadowSeller: num(env, 'SHADOW_SELLER', 1),              // 1 = shadow seller on (0 = fully off: no observing, no records)
    shadowSellerMinN: num(env, 'SHADOW_SELLER_MIN_N', 8),     // bucket samples required before the bucket may fire (below = no opinion = hold)
    shadowSellerPriorK: num(env, 'SHADOW_SELLER_PRIOR_K', 10), // smoothing prior: phantom flat samples pulling every bucket's EV toward 0
    shadowSellerRefitMin: num(env, 'SHADOW_SELLER_REFIT_MIN', 15), // evidence table refit cadence (boot + this often, lazily on the observe path)
    // Staircase-3 Shadow Signal (user order 2026-10-16, RECORD-ONLY): every
    // Structure Watch mark at ordinal >= 3 is ALSO journaled as a named
    // shadow signal (the study's finding: median +208% forward peak over 154
    // finalized marks) and scored by the watch's own forward scores, joined
    // at read time (/staircase). No path reads it back into a decision.
    staircaseSignal: num(env, 'STAIRCASE_SIGNAL', 1),        // 1 = staircase-3 shadow signal on (0 = no records, card off)
    // Never-Green Cut SHADOW (owner order 2026-10-17, RECORD-ONLY): a
    // position that has NEVER peaked above +2% (running peakRatio <=
    // NG_CUT_PEAK_MAX for its whole life), is at least NG_CUT_ARM_SEC old,
    // and prints a realizable ratio <= NG_CUT_RATIO for NG_CUT_CONFIRM_CHECKS
    // consecutive position checks would have been cut in full at that
    // check's quote. Journals would-fires + pairs them against the actual
    // close in nevergreen.jsonl (/nevergreen, LAB card) so the rule is
    // judged on ~30 paired samples before any promotion. Priced from the
    // 2026-10-17 tick replay: SEXCOIN (never green, bled 36 min to -59%)
    // would have exited at 7.9 min / -18%; the 300s arm is load-bearing —
    // MAKERS dipped to 0.719 at 1.3 min before running 16x, and an arm
    // under 5 min fires on it. NEVER sells, blocks, or feeds any decision.
    neverGreenShadow: num(env, 'NEVERGREEN_SHADOW', 1),      // 1 = never-green cut shadow on (0 = module fully inert, no records, card off)
    ngCutArmSec: num(env, 'NG_CUT_ARM_SEC', 300),            // seconds a position must be held before the cut may arm (see above — do not lower casually)
    ngCutPeakMax: num(env, 'NG_CUT_PEAK_MAX', 1.02),         // running peakRatio ceiling: above this the position once went green and the cut is permanently disarmed
    ngCutRatio: num(env, 'NG_CUT_RATIO', 0.90),              // realizable ratio at/below which a never-green position counts a confirm check
    ngCutConfirmChecks: num(env, 'NG_CUT_CONFIRM_CHECKS', 2), // consecutive sub-line checks required to would-fire (a check back above the line resets the count)
    // Bottom Tracker (user order 2026-10-16, RECORD-ONLY): watched coins that
    // dump >= BOTTOM_DROP_PCT off their sampled peak open an episode; once the
    // low has held quiet for BOTTOM_QUIET_MIN minutes, the first move >=
    // BOTTOM_MOVE_PCT off the low (with buy flow back, when flow is known)
    // journals a 'first move' mark to bottom_marks.jsonl, forward-scored with
    // the structure watch's tailer (/bottomwatch). The twitchy cousin of
    // churn's patient basing — measured, never traded. 0 = fully off.
    bottomWatch: num(env, 'BOTTOM_WATCH', 1),                 // 1 = bottom tracker on (0 = no observing, no records, card off)
    bottomLive: num(env, 'BOTTOM_LIVE', 1),                   // 1 = QUALIFIED bottom marks route live entries (Bot._evalBottom, the base strategy's third shape; 0 = tracker stays record-only)
    bottomDropPct: num(env, 'BOTTOM_DROP_PCT', 50),           // drawdown off the watched peak that opens an episode (PERCENT)
    bottomQuietMin: num(env, 'BOTTOM_QUIET_MIN', 3),          // minutes with no new low before the bottom counts as established
    bottomMovePct: num(env, 'BOTTOM_MOVE_PCT', 18),           // first move off the low that fires the mark (PERCENT)
    bottomExpireMin: num(env, 'BOTTOM_EXPIRE_MIN', 60),       // minutes out of the sampling orbit before tracking a mint ends
    bottomMinPeakMc: num(env, 'BOTTOM_MIN_PEAK_MC', 25000),    // peak mc (USD) a run must have reached for its mark to qualify as a RETRACE SETUP (owner refinement 2026-10-16: he means coins that RAN first — dev/null/Gato class; below the floor the mark is dust: still journaled + scored in its own bucket, never alerted)
    // Range Study (owner order 2026-10-16; study record-only, marks ALSO
    // route live entries by default — RANGE_LIVE below): a coin that bases
    // in a tight sideways range for a sustained stretch — the shape he
    // circled on 'Market Maker' (~20 min of base before the vertical pop
    // the bot chased at its tip). When the trailing RANGE_WINDOW_MIN of
    // sampled history is tight (hi/lo mc within RANGE_MAX_BAND_PCT),
    // quiet (no 1-minute step beyond RANGE_MAX_MIN_MOVE_PCT) and covered,
    // and the coin is real (mc >= RANGE_MIN_MC, first sampled at least a
    // window ago), one mark per range episode journals to
    // range_marks.jsonl, forward-scored with the structure watch's tailer
    // (/rangewatch): expanded / broke down / ranged. 0 = fully off.
    rangeWatch: num(env, 'RANGE_WATCH', 1),                  // 1 = range study on (0 = no observing, no records, card off)
    rangeWindowMin: num(env, 'RANGE_WINDOW_MIN', 15),        // trailing minutes of sampled history judged as the range window
    rangeMaxBandPct: num(env, 'RANGE_MAX_BAND_PCT', 35),     // hi/lo mc band over the window that still counts as tight (PERCENT)
    rangeMaxMinMovePct: num(env, 'RANGE_MAX_MIN_MOVE_PCT', 18), // largest allowed 1-minute step inside the window (PERCENT)
    rangeMinMc: num(env, 'RANGE_MIN_MC', 15000),             // mc (USD) at mark a coin must carry to count as real
    // Range LIVE (owner correction 2026-10-16, minutes after the study
    // shipped: "None of this is shadow btw — Real"): when 1 (the
    // default — his order), a range mark ALSO routes a live entry
    // attempt through the exact standard onSignal pipeline
    // (Bot._evalRange) — same gates, risk, sizing, exits as every
    // setup; the study keeps journaling + scoring untouched. 0 =
    // revert to the pure record-only study (marks, scores, card;
    // zero signal records).
    rangeLive: num(env, 'RANGE_LIVE', 1),                    // 1 = range marks route live entries (0 = study only)
    // BASE MODE (owner order 2026-10-16 23:00 EDT, "Build the base
    // strategy" — his diagnosis: the signals are fine, the ENTRIES are
    // the disease; good and bad coins run and die the same, so the rule
    // stack around direct entries is noise). "Buy the base, not the
    // blast": when 1 (the default — a live strategy order), every live
    // signal whose setup is not a formed-base shape {range, staircase,
    // bottom} is DEMOTED at the onSignal seam to a watch enrollment
    // (journaled 'skipped', fields.enrolledBy) and never buys; base
    // entries carry TP1 pinned at +50% from birth, range entries judge
    // in the band's lower two-thirds (top-third marks open a deferred
    // dip watch instead), and range/bottom entries carry a structural
    // stop at the base's own low. 0 = tonight's direct-buy behavior,
    // byte-identical.
    baseMode: num(env, 'BASE_MODE', 1),                      // 1 = base strategy on (0 = direct entries as before)
    // Base-strategy entry gates (owner decision 2026-10-16 23:16 EDT,
    // off tonight's range burst — the range path bought DEAD coins:
    // entry volM5 stamps of $0 / $17 / $137 / $186 / $524 / $958 against
    // a $22.1K loser-median in his last-50 study). PULSE FLOOR: every
    // base-shape entry eval (range incl. the deferred dip, bottom,
    // staircase) needs a live tape on the fresh view — volM5 at or
    // above the floor, unknown counting as dead. ENROLLMENT: a range
    // entry additionally requires the mint to be NOMINATED — a live
    // signal demoted into an enrollment for it within the TTL (the
    // enrollment map restores at boot from the signals journal). A
    // base alone is not a nomination.
    baseMinVolM5: num(env, 'BASE_MIN_VOL_M5', 5000),         // pulse floor for base-shape entries, USD 5m volume (0 = floor off)
    enrollTtlH: num(env, 'ENROLL_TTL_H', 24),                // hours a demotion enrollment nominates a mint for range entries
    // Confluence Shadow Signal (user order 2026-10-16, RECORD-ONLY): every
    // walletWatch confluence fire ALSO opens two virtual positions stamped
    // at DETECTION time (the classification study's decisive unknowns are
    // all forward questions — true touch rates at tradable refs, lag cost,
    // post-friction EV per exit profile). SCALP exits whole at the first
    // check whose net gain (exits.js's ruler) reaches confluenceScalpPct;
    // LADDER runs the live exit stack via evaluateExit. Both mirror the
    // live downside (liquidity death, stall exit) and a
    // 4h max-hold terminal. Journal: confluence_signal.jsonl (/confluencesignal).
    // No path reads it back into a decision.
    confluenceSignal: num(env, 'CONFLUENCE_SIGNAL', 1),      // 1 = confluence shadow signal on (0 = no new fires, card off)
    confluenceScalpPct: num(env, 'CONFLUENCE_SCALP_PCT', 0.20), // scalp profile: 100% exit at the first check with net gain >= this
    // Staircase-3 LIVE (user order 2026-10-16, "flip it live" — shadow study
    // continues untouched): when 1, an ordinal>=3 mark ALSO routes a live
    // entry attempt through the exact standard onSignal pipeline
    // (Bot._evalStaircase) — same gates, risk, sizing, exits as every setup.
    // 0 = marks stay shadow-only (the pre-flip world). Default 0 in code;
    // the live env carries the user's flip.
    staircaseLive: num(env, 'STAIRCASE_LIVE', 0),            // 0 = staircase live entries off (1 = on)
    // D4 cold-market streak pause (user 2026-10-13, his design over his agent's timer version):
    // N straight red closes pause new entries; the bot keeps scanning and resumes ITSELF only
    // when market breadth (share of sampled coins green on the hour) recovers and stays
    // recovered — never on a timer alone, never on one coin's signal. Bot-managed layer only:
    // the balance halt above it still releases exclusively by the user's hand.
    streakPauseN: num(env, 'STREAK_PAUSE_N', 4),              // straight losses that trigger the pause (0 = off)
    streakPauseMinMin: num(env, 'STREAK_PAUSE_MIN_MIN', 15),  // minimum minutes a pause lasts, however hot it gets
    streakHeatPct: num(env, 'STREAK_HEAT_PCT', 0.5),           // breadth share (chgH1 > 0) that counts as a hot market
    streakHeatSustainMin: num(env, 'STREAK_HEAT_SUSTAIN_MIN', 10), // breadth must hold at/above the line this long to resume
    streakHeatMinCoins: num(env, 'STREAK_HEAT_MIN_COINS', 50),     // breadth only counts with at least this many coins reporting
    killEquityFrac: num(env, 'KILL_EQUITY_FRAC', 0.5),  // wallet SOL below this fraction of starting → permanent halt
    minReserveSol: num(env, 'MIN_RESERVE_SOL', 0.02),   // never spend the last of the fees
    maxTradesPerHour: num(env, 'MAX_TRADES_PER_HOUR', 120),
    mandatoryApesPerHour: num(env, 'MANDATORY_APES_PER_HOUR', 0), // user 2026-10-13 (entry-fixes A1): default OFF — forcing gate-failed signals through to hit an hourly quota made the bot lower its standards exactly when nobody was watching. Was 5 in code / 10 in live env.
    paceRelax: num(env, 'PACE_RELAX', 0),               // user 2026-10-13 (entry-fixes A2): 1 = paceCfg loosens gate thresholds (liq/mc floors cut, maxMc ×1.5). Default 0 = gates run at face value, always.
    mintCooldownMin: num(env, 'MINT_COOLDOWN_MIN', 20),
    loserCooldownH: num(env, 'LOSER_COOLDOWN_H', 6),    // don't re-buy a coin that closed at a loss within this many hours (0 = off)
    winnerCooldownH: num(env, 'WINNER_COOLDOWN_H', num(env, 'LOSER_COOLDOWN_H', 6)), // don't re-buy a coin that closed at a WIN within this many hours either (user 2026-10-15: 'let it apply for the wins as well' — HIMA closed +0.0063, re-bought 21m later 31% under its top, cut by hand). Defaults to the loser window; WINNER_COOLDOWN_H overrides (0 = off)
    closedCooldownH: num(env, 'CLOSED_COOLDOWN_MIN', 0) > 0 ? num(env, 'CLOSED_COOLDOWN_MIN', 0) / 60 : num(env, 'CLOSED_COOLDOWN_H', 3),  // don't re-buy a coin that closed AT ALL (win or loss) within the cooldown (0 = off). Added 2026-10-12 at 3h (the journal's only 2 re-entries both lost); user cooled it to 5 minutes on 2026-10-13 (it blocked an OSPREY re-entry) — CLOSED_COOLDOWN_MIN overrides in minutes when set.
    maxPoolFraction: num(env, 'MAX_POOL_FRACTION', 0.05), // position ≤ 5% of pool liquidity
    allowLarge: env.ALLOW_LARGE === '1',                // typo guard: TRADE_SOL > 0.25 refused unless set
    shadowStartSol: num(env, 'SHADOW_START_SOL', 1),

    // ---- execution ----
    buyBps: num(env, 'BUY_SLIPPAGE_BPS', 1500),
    sellBps: num(env, 'SELL_SLIPPAGE_BPS', 2500),
    priorityFeeLamports: num(env, 'PRIORITY_FEE_LAMPORTS', 100000),
    closeEmptyAccounts: num(env, 'CLOSE_EMPTY_ACCOUNTS', 1) === 1, // after a full sell, close the token account → ~0.002 SOL rent back
    minRoundTrip: num(env, 'MIN_ROUND_TRIP', 0.80),     // sell-back value / spend must be ≥ this, else unexitable/too thin
    jupBase: env.JUP_BASE || 'https://api.jup.ag/swap/v1',
    jupTokensBase: env.JUP_TOKENS_BASE || 'https://lite-api.jup.ag/tokens/v2',
    jupApiKey: env.JUP_API_KEY || '',
    rpcUrls: (env.RPC_URLS || 'https://api.mainnet-beta.solana.com').split(',').map(s => s.trim()).filter(Boolean),
    holderDas: env.HOLDER_DAS !== '0',                  // record-only holder sampling via Helius DAS getTokenAccounts (rides RPC_URLS): every gate/shadow/snapshot eval also leaves a token-account-count sample in gate.js's holder series, so holderGrowth fills on coins RugCheck has no report for. 0 = off (RugCheck-only sampling, the pre-DAS behavior). Fail-silent either way; nothing trades on it.

    // ---- eligibility ----
    minMc: num(env, 'MIN_MC', 10000),
    maxMc: num(env, 'MAX_MC', 2_000_000),
    minLiqUsd: num(env, 'MIN_LIQ_USD', 15000),
    minLiqToMc: num(env, 'MIN_LIQ_TO_MC', 0.03),
    minPairAgeMin: num(env, 'MIN_PAIR_AGE_MIN', 0),   // skip pools younger than N min (0 = off). Off: winners W/GTRADE/Playground/19 were all bought 1–5m after pool open
    // LIQ RE-CHECK (owner order 2026-10-17, "Ship the liquidity fix" — "The
    // liquidity re-check, for every lane, not just confluence. A $0 reading
    // on a coin that's seconds old is a broken read, not a decision."): when
    // a YOUNG coin's (pair age <= LIQ_RECHECK_MAX_AGE_MIN) entry evaluation
    // is about to terminal-skip SOLELY because liquidity read $0/missing
    // (the eligible() liq + liqToMc legs), the skip is deferred instead: the
    // view is re-fetched every LIQ_RECHECK_INTERVAL_SEC for up to
    // LIQ_RECHECK_WINDOW_SEC and the SAME evaluation resumes the moment
    // liquidity reads real — through every remaining gate, all still
    // binding; the re-check bypasses nothing but the broken read. A broken
    // read never stamps the per-mint signal cooldown and never journals a
    // skip; only the final verdict (taken, or the terminal skip after the
    // window) does. Step-6 audit (2026-10-17): this read was the FIRST
    // blocker on 46% of never-taken confluence mints. LIQ_RECHECK=0
    // restores the one-and-done skips byte-identically.
    liqRecheck: env.LIQ_RECHECK !== '0',
    liqRecheckIntervalSec: num(env, 'LIQ_RECHECK_INTERVAL_SEC', 10),
    liqRecheckWindowSec: num(env, 'LIQ_RECHECK_WINDOW_SEC', 90),
    liqRecheckMaxAgeMin: num(env, 'LIQ_RECHECK_MAX_AGE_MIN', 10),

    // ---- 'pop' detector (needs live history: flat → vertical) ----
    popWindowSec: num(env, 'POP_WINDOW_SEC', 300),
    popGainPct: num(env, 'POP_GAIN_PCT', 35),
    popMaxGainPct: num(env, 'POP_MAX_GAIN_PCT', 200),   // already >3x in the window = chasing
    popMinVolH1: num(env, 'POP_MIN_VOL_H1', 20000),   // legacy: pop volume is judged on the 5m window now (below)
    popMinVolM5: num(env, 'POP_MIN_VOL_M5', 25000),   // user 2026-10-12: the 25k belongs on 5m volume, not the hour
    popMinBuysM5: num(env, 'POP_MIN_BUYS_M5', 20),    // was 5: real momentum = many buyers, not a handful
    popMinChgH1: num(env, 'POP_MIN_CHG_H1', 0),       // coin must be UP on the hour: a bounce off a crash is not a pop
    popMaxBelowHigh: num(env, 'POP_MAX_BELOW_HIGH', 0.30), // skip if price is >30% under its 1h high (dead-cat bounce)
    popMaxDropH6: num(env, 'POP_MAX_DROP_H6', 40),    // skip pops on coins down 40%+ over 6h (for young pools: since launch) — a crash
                                                      // that already left the 1h window still counts (0 = off)
    minBuyRatioM5: num(env, 'MIN_BUY_RATIO_M5', 0.60), // user 2026-10-13 (entry-fixes A5): 0.55 → 0.60 — ARCADES (0.56) and MEMEOS (0.57) barely cleared the old bar and died
    maxBuyRatioM5: num(env, 'MAX_BUY_RATIO_M5', 0.85), // D1 band top (user 2026-10-13, Muse's call on 'fix it as you see fit'): the ratio fails at BOTH ends — at 0.85+ the 'demand' is usually one bundled buyer, not a crowd (PEPECAT 0.90 and MIRAGE 0.88 both lost; no winner today printed that high). Applies to pop + trend. 0 = off.
    maxDrawFromPeak: num(env, 'MAX_DRAW_FROM_PEAK', 0.15), // enter on strength, not on the way down

    // ---- 'fast pop' detector (live trade stream, user 2026-10-13) ----
    // The classic pop reads trailing DexScreener aggregates and fires at the echo of a
    // move (SCI: first signal ~90s after the spike peaked; OSPREY: no signal at all
    // during a +230% recovery). Fast pop computes the move from PumpPortal's live
    // trade stream over a short window, so the signal exists seconds after the move
    // does. Same 'pop' pipeline after detection — every gate still applies.
    fastPop: num(env, 'FAST_POP', 1),                        // 1 = on (stream detection active)
    fastPopWindowSec: num(env, 'FAST_POP_WINDOW_SEC', 90),   // rolling window judged on stream trades
    fastPopGainPct: num(env, 'FAST_POP_GAIN_PCT', 30),       // price gain from the window low, %
    fastPopMaxGainPct: num(env, 'FAST_POP_MAX_GAIN_PCT', 0), // entry-fixes A4 knob, shipped OFF: a ceiling here kills the OSPREY shape fast pop was built for — a V-recovery reads +91% off the 90s window low and is a catch, not a chase (the window low is 90 seconds old, not a 5m base). Set FAST_POP_MAX_GAIN_PCT=75 to apply the classic cap here too.
    fastPopMinVolSol: num(env, 'FAST_POP_MIN_VOL_SOL', 2.5), // total SOL traded inside the window
    fastPopMinVolM5: num(env, 'FAST_POP_MIN_VOL_M5', 5000),  // qualification floor (user 2026-10-15): the fire's USD volume figure (metrics.volM5) must clear this too — the 90s burst alone fired on dust (NEXA journaled $511 on a 5 SOL burst); 0 = off
    fastPopMinStreamVolSol: num(env, 'FAST_POP_MIN_STREAM_VOL_SOL', 20), // qualification floor (user 2026-10-15): the burst itself must carry real size — total SOL traded inside the window; 0 = off
    fastPopMinBuys: num(env, 'FAST_POP_MIN_BUYS', 8),        // distinct buy trades inside the window
    fastPopMinBuyShare: num(env, 'FAST_POP_MIN_BUY_SHARE', 0.60), // buys / (buys + sells), live flow (0.55 → 0.60, entry-fixes A5)
    fastPopMaxBuyShare: num(env, 'FAST_POP_MAX_BUY_SHARE', 0.85), // D1 band top for the stream share — same bundle-bait logic as MAX_BUY_RATIO_M5; 0 = off
    fastPopMaxDrop: num(env, 'FAST_POP_MAX_DROP', 0.08),     // last price may be at most this below the window peak
    fastPopMinTrades: num(env, 'FAST_POP_MIN_TRADES', 12),   // total trades inside the window
    fastPopRecentSec: num(env, 'FAST_POP_RECENT_SEC', 15),   // the move must still be printing…
    fastPopMinRecent: num(env, 'FAST_POP_MIN_RECENT', 3),    // …with at least this many trades in the recent slice
    fastPopMaxSubs: num(env, 'FAST_POP_MAX_SUBS', 150),      // stream subscriptions track the freshest watch mints
    fastPopEvalMs: num(env, 'FAST_POP_EVAL_MS', 1000),       // per-mint evaluation throttle

    // ---- 'trend' detector (runner already ranked hot; uses DexScreener priceChange, no history needed) ----
    trendMinH1: num(env, 'TREND_MIN_H1', 25),
    trendMaxH1: num(env, 'TREND_MAX_H1', 400),
    trendMinM5: num(env, 'TREND_MIN_M5', 2),
    trendMinVolH1: num(env, 'TREND_MIN_VOL_H1', 100000),
    trendMinBuyRatio: num(env, 'TREND_MIN_BUY_RATIO', 0.60), // 0.52 → 0.60 (entry-fixes A5) — MageTrail got in at 0.52 and stopped out
    // Trend pause + quality guards (user 2026-10-13, entry-fixes B1–B5; tonight's trend went 0-for-9):
    trendEnabled: num(env, 'TREND_ENABLED', 0),          // B1: 0 = trend detector paused; pop keeps running. Re-enable only with B2–B5 in and a backtest showing trend net positive.
    trendShadow: num(env, 'TREND_SHADOW', 0),            // shadow-only (user 2026-10-14, forward plan step 1b): 1 = trend signals are journaled + outcome-tracked but never bought; detector keeps running. 0 = live (today's behavior).
    trendLive: num(env, 'TREND_LIVE', 1) === 1,          // LIVE flip (owner order 2026-10-16, "make them all go live"): true (default) = trend signals route through the live pipeline like pop. TREND_LIVE=0 is the kill switch — it restores shadow routing (Bot.shadowedSetup consults trendShadow only when this knob is absent from a hand-built cfg).
    trendMinMc: num(env, 'TREND_MIN_MC', 30000),         // B4: trend needs a real market cap (BORING $15k, Urara $15.6k); 0 = off
    trendMinBuyRatioH1: num(env, 'TREND_MIN_BUY_RATIO_H1', 0.55), // B2: the whole HOUR must be buy-dominated, not just a 14-trade 5m blip (Urara: 411 buys vs 445 sells on the hour); 0 = off
    trendMinTxnsM5: num(env, 'TREND_MIN_TXNS_M5', 30),   // B2: at least this many 5m trades before a ratio counts as demand; 0 = off
    trendMaxVolToMc: num(env, 'TREND_MAX_VOL_TO_MC', 3), // B3: wash reject — small cap (below FRESH_SMALL_MC) with hourly volume > this × its cap is churn, not demand (Urara: $71k on $15.6k = 4.5×); applies to pop too; 0 = off
    revivalMinAgeD: num(env, 'REVIVAL_MIN_AGE_D', 7),    // B5: pool at least this many days old…
    revivalMaxChgH6: num(env, 'REVIVAL_MAX_CHG_H6', 300), // …and up this much in 6h = dead-coin revival, skip (Urara's pool was ~67 days old, +550% h6); 0 = off
    trendMinBuysM5: num(env, 'TREND_MIN_BUYS_M5', 5),
    // Freshness is VOLUME, not price (user 2026-10-14, UNTXED): a grind can run +121% on the
    // hour in small price steps, so the old rule (last-5m price gain ≥ a share of the hourly
    // move) made grinds structurally invisible. What must be fresh is the trading itself: 5m
    // volume at/above this floor proves the coin is alive NOW. The coin must still be at least
    // slightly green on the 5m (trendMinM5). 0 = off (no freshness check).
    trendFreshMinVolM5: num(env, 'TREND_FRESH_MIN_VOL_M5', 25000),
    // ---- 'churn' detector (user 2026-10-14): a dumped coin BASING at its lows with a trade
    // count that refuses to die — accumulation BEFORE any pop (the Vwhale shape: −53% peak→low,
    // then ~180 tx/5m of two-way flow at support while its buy ratio sat ~0.50, so pop never
    // fired). Needs the dump, the base, the sustained count, two-way flow, and a real average
    // trade size — the avg floor is what separates accumulation from wash churn by construction:
    // it sits above the botflow ($6) and dust ($1.5) HARD gate floors, and the B3 wash reject /
    // hard gates still judge every churn candidate downstream.
    churnEnabled: num(env, 'CHURN_ENABLED', 1) === 1,
    churnMinDropPct: num(env, 'CHURN_MIN_DROP_PCT', 40),   // sampled peak → window low drop that counts as "dumped"
    churnLowBandPct: num(env, 'CHURN_LOW_BAND_PCT', 10),  // current price must sit within this % of the window low
    churnStableMin: num(env, 'CHURN_STABLE_MIN', 10),     // no new low for this long = the dump is over, it's basing
    churnMinTxM5: num(env, 'CHURN_MIN_TX_M5', 120),       // trailing-5m trade count (buys+sells), sustained over the last 3 samples
    churnMinBuyShare: num(env, 'CHURN_MIN_BUY_SHARE', 0.40), // two-way interest, not an exit stampede (deliberately below the pop 0.60)
    churnMinAvgUsd: num(env, 'CHURN_MIN_AVG_USD', 10),    // volM5 / tx — above BOTFLOW_MAX_AVG_USD ($6) and DUST_MAX_AVG_USD ($1.5) so wash/dust flow can't qualify
    churnWatchH: num(env, 'CHURN_WATCH_H', 3),            // basing watch: a coin that dumped stays watchlist-pinned this many hours past WATCH_TTL
    churnWatchMax: num(env, 'CHURN_WATCH_MAX', 40),       // max pinned coins (oldest pin evicted first)

    // ---- 'liftoff' detector (user 2026-10-14): the BEGINNING of an uptrend — a coin
    // lifting off a tight flat BASE in steps, with rising lows, building buy pressure
    // and picking-up trade activity, fired while still early (≤ liftoffMaxGainPct off
    // the base low). The grind shape (UNTXED +121%/h, CODE +73%/h in ~+1.5% steps) is
    // structurally invisible to pop (needs a vertical burst) and was invisible to
    // trend's old price-freshness rule for the same reason. Churn catches the base
    // BEFORE any move; liftoff catches the first confirmed leg up off it.
    liftoffEnabled: num(env, 'LIFTOFF_ENABLED', 1) === 1,
    liftoffShadow: num(env, 'LIFTOFF_SHADOW', 0) === 1,   // shadow-only (user 2026-10-14, forward plan step 1b): true = liftoff signals are journaled + outcome-tracked but never bought; detector keeps running. false = live (today's behavior).
    liftoffMinHistoryMin: num(env, 'LIFTOFF_MIN_HISTORY_MIN', 20), // minutes of sampled history before a base can be judged at all
    liftoffLookbackMin: num(env, 'LIFTOFF_LOOKBACK_MIN', 45),      // base + climb are judged inside this trailing window
    liftoffBaseRangePct: num(env, 'LIFTOFF_BASE_RANGE_PCT', 15),   // (baseHigh − baseLow) / baseLow ceiling for the base to count as "flat"
    liftoffMinGainPct: num(env, 'LIFTOFF_MIN_GAIN_PCT', 10),       // current price must be at least this far above baseLow…
    liftoffMaxGainPct: num(env, 'LIFTOFF_MAX_GAIN_PCT', 35),       // …and no further — beyond this it's extended (pop/trend territory)
    liftoffClimbMin: num(env, 'LIFTOFF_CLIMB_MIN', 10),            // the recent window judged for rising lows / activity pickup; the base is everything older in the lookback
    liftoffMinBuyShare: num(env, 'LIFTOFF_MIN_BUY_SHARE', 0.55),   // latest view's trailing-5m buy share floor
    liftoffTxnBoost: num(env, 'LIFTOFF_TXN_BOOST', 1.5),           // climb-window avg trade count must be at least this × the base window's
    liftoffMinVolM5: num(env, 'LIFTOFF_MIN_VOL_M5', 5000),         // 5m DOLLAR volume floor (user 2026-10-14: liftoff counted trades, not dollars — STUDIO fired on ~$543 of 5m volume; the floor demands a crowd stands behind the twitch; 0 = off)

    // ---- 'flow' detector (user 2026-10-14): tracked smart wallets' BUYS are the trigger,
    // not price momentum. Polls each wallet's recent transactions over the existing Helius
    // RPC (RPC_URLS) — NOT the PumpPortal stream (dark while its wallet sits under the 0.02
    // SOL streaming threshold). A wallet nominates; the full gate stack still judges.
    // FLOW_WALLETS empty = module inert. FLOW_SOLO_WALLETS: a solo wallet's buy fires on its
    // own — no size bar, no confluence — above only the 0.1 SOL anti-dust floor. The user's
    // solo wallets: Be24Gbf5KisDk1LcWWZsBn8dvB816By7YzYF5zWZnRR6 ("chairman") and
    // 5B52w1ZW9tuwUduueP5J7HXz5AcGfruGoX6YoAudvyxG ("yenni"). FLOW_WALLET_NAMES maps any
    // tracked address to a display name (address:name pairs) used in signal labels —
    // "flow: yenni bought 0.85 SOL"; unnamed wallets label by shortened address.
    flowEnabled: num(env, 'FLOW_ENABLED', 1) === 1,
    flowWallets: (env.FLOW_WALLETS || '').split(',').map(s => s.trim()).filter(Boolean),
    flowSoloWallets: (env.FLOW_SOLO_WALLETS || '').split(',').map(s => s.trim()).filter(Boolean),
    flowNames: Object.fromEntries((env.FLOW_WALLET_NAMES || '').split(',').map(s => s.trim()).filter(Boolean)
      .map(pair => { const i = pair.lastIndexOf(':'); return i > 0 ? [pair.slice(0, i).trim(), pair.slice(i + 1).trim()] : [pair, '']; })
      .filter(([addr, name]) => addr && name)),
    flowPollSec: num(env, 'FLOW_POLL_SEC', 30),           // per-wallet signature poll cadence
    flowMinSol: num(env, 'FLOW_MIN_SOL', 1.0),            // a single tracked wallet buying >= this fires alone
    flowWalletsConfl: num(env, 'FLOW_WALLETS_CONFL', 2),  // …or this many distinct wallets buying the same mint…
    flowWindowMin: num(env, 'FLOW_WINDOW_MIN', 15),       // …inside this window (any size above the 0.1 SOL dust floor)
    // FLOW_LIVE_WALLETS (user 2026-10-15, freeze carve-out): when SET, flow goes
    // shadow-only except these wallets — only a solo trigger fired by a listed
    // wallet may reach the live pipeline; every other flow trigger (the other
    // solos, size triggers, confluence) is journaled as a shadow signal instead
    // (record-only, outcome-tracked, no buy, no SOL). The live store sets it to
    // yenni + poorgoat (poorgoat also sits in FLOW_SOLO_WALLETS so its triggers
    // carry the solo kind, exactly yenni's status). UNSET (null) = legacy: all
    // triggers live.
    flowLiveWallets: env.FLOW_LIVE_WALLETS === undefined ? null
      : (env.FLOW_LIVE_WALLETS || '').split(',').map(s => s.trim()).filter(Boolean),
    // FLOW_ALL_LIVE (owner order 2026-10-16, "make them all go live"): true
    // (default) = EVERY tracked-wallet flow trigger routes live through
    // _evalFlow — the FLOW_LIVE_WALLETS roster above no longer gates routing.
    // FLOW_ALL_LIVE=0 is the kill switch: roster behavior returns exactly
    // (only listed solo wallets live, everything else journals as shadow).
    flowAllLive: num(env, 'FLOW_ALL_LIVE', 1) === 1,

    // FLOW CONFIRMATION LANE (owner order 2026-10-17, "Go ahead and.
    // Build." — off this morning's audits: first catches lose; a coin that
    // already fired, stayed liquid, and fires AGAIN is the proven shape).
    // While BASE_MODE is on, a flow fire on a mint with a PRIOR distinct
    // flow event inside FLOW_CONFIRM_WINDOW_H, at mc >= FLOW_CONFIRM_MIN_MC
    // with the standard liq floors passing on a real view, routes DIRECT
    // through the standard pipeline (every gate binding, top guard
    // included) at exactly FLOW_CONFIRM_SOL instead of being enrolled for
    // base watch. Lane-local re-entry: the lane ignores the winner/loser/
    // closed mint cooldowns for its own entries; after a lane close the
    // mint can re-enter on a new qualifying fire once
    // FLOW_CONFIRM_REENTRY_MIN has passed, max FLOW_CONFIRM_MAX_ENTRIES
    // lane entries per mint inside the window anchored at the first fire.
    // Pre-registered kill rule: at FLOW_CONFIRM_KILL_N lane closes with a
    // negative mean PnL the lane disables itself (persisted + journaled).
    // FLOW_CONFIRM_LIVE=0 is the kill switch — base-mode enrollment for
    // every flow fire, exactly as before the lane existed.
    flowConfirmLive: num(env, 'FLOW_CONFIRM_LIVE', 1) === 1,
    flowConfirmWindowH: num(env, 'FLOW_CONFIRM_WINDOW_H', 3),        // a prior flow event inside this window arms the lane
    flowConfirmMinMc: num(env, 'FLOW_CONFIRM_MIN_MC', 50000),        // the qualifying fire's own mc floor
    flowConfirmSol: num(env, 'FLOW_CONFIRM_SOL', 0.025),             // exact lane entry size (brake does not factor it)
    flowConfirmReentryMin: num(env, 'FLOW_CONFIRM_REENTRY_MIN', 10), // minutes after a lane close before the lane may re-enter the mint
    flowConfirmMaxEntries: num(env, 'FLOW_CONFIRM_MAX_ENTRIES', 2),  // lane entries per mint per window
    flowConfirmKillN: num(env, 'FLOW_CONFIRM_KILL_N', 15),           // lane closes that arm the one-time kill-rule check

    // ---- wallet task shadow detectors (user brief 2026-10-14, Phases 4–6; go given 2026-10-15) ----
    // LOG-ONLY observers over the Phase 1–3 wallet sets (src/walletSets.json): the 23
    // hand-tagged devs (dev-launch detector) and the 225 surviving trader entities /
    // 297 wallets (confluence detector: >= CONFL_MIN_CLUSTERS distinct entities buy the
    // same mint within CONFL_WINDOW_MIN). Events are gate-judged in shadow and
    // outcome-tracked against the taken-pop baseline; promotion is a FLAG the user
    // acts on — nothing here trades, gates live entries, or self-promotes.
    walletWatchEnabled: num(env, 'WALLET_WATCH', 1) === 1,
    // LIVE flips for the walletWatch detectors (owner order 2026-10-16, "make
    // them all go live"): the detectors themselves still only journal events
    // + outcome-track them; the BOT taps each event (WalletWatch liveEval dep)
    // and routes a live entry attempt through the standard pipeline — fresh
    // view, held/cooldown guards, eligible() floor, gates, risk, sizing —
    // under setup labels 'devlaunch' / 'confluence'. A failed guard journals
    // as skipped with its reason; nothing bypasses. Kill switches restore
    // record-only exactly: DEVLAUNCH_LIVE=0 / CONFLUENCE_LIVE=0. (The
    // CONFLUENCE_SIGNAL shadow study above is a different thing and stays
    // record-only untouched.)
    devlaunchLive: num(env, 'DEVLAUNCH_LIVE', 1) === 1,
    confluenceLive: num(env, 'CONFLUENCE_LIVE', 1) === 1,
    devPollSec: num(env, 'DEV_POLL_SEC', 60),             // dev wallet signature poll cadence
    conflPollSec: num(env, 'CONFL_POLL_SEC', 300),        // survivor wallet signature poll cadence
    conflWindowMin: num(env, 'CONFL_WINDOW_MIN', 5),      // confluence window (on-chain buy times)
    conflMinClusters: num(env, 'CONFL_MIN_CLUSTERS', 2),  // distinct entities required for a confluence event
    devEarlyMin: num(env, 'DEV_EARLY_MIN', 60),           // a dev buy within this many minutes of coin creation counts as a launch (early-buy)
    devQualN: num(env, 'DEV_QUAL_N', 10),                 // finalized launches per dev before qualification is judged (rolling window)
    conflQualN: num(env, 'CONFL_QUAL_N', 30),             // finalized confluence events before qualification is judged

    // ---- 'graduation watch' (user 2026-10-14: "do that every 2 minutes then not 3hrs") ----
    // Post-graduation runners were structurally invisible: Plois graduated and ran +41%
    // in 5m while the bot had never seen the mint — the /reallists graduated list arrives
    // EMPTY (mirror gap) and the movers/trending scrape is 3-hourly. This poller asks
    // pump.fun's v3 API for recently COMPLETED coins every GRAD_POLL_SEC and feeds fresh
    // graduations into the watchlist through noteMint's reserved slice (source
    // 'graduated'). GRAD_FRESH_MIN is the activity window: a first-observed completion
    // only counts while the coin's last trade is inside it. There is no graduation
    // timestamp in the v3 payload and created_timestamp cannot judge freshness (Plois
    // sat on the curve 49 minutes before graduating) — the first-observed-completion
    // transition is the freshness signal. The first poll after boot primes it, and
    // since the boot backfill (user 2026-10-14) it also ADDS still-fresh completions
    // found at prime time, capped by GRAD_BACKFILL_MAX — a coin that graduated while
    // the bot was down (UNTXED: graduated 01:28 EDT, watcher booted 01:39) is caught
    // at startup instead of being primed away as history.
    gradWatchEnabled: num(env, 'GRAD_WATCH_ENABLED', 1) === 1,
    gradPollSec: num(env, 'GRAD_POLL_SEC', 120),          // how often to ask pump.fun for fresh completions
    gradFreshMin: num(env, 'GRAD_FRESH_MIN', 30),         // a first-seen completion counts while its last trade is within this window
    gradBackfillMax: num(env, 'GRAD_BACKFILL_MAX', 50),   // boot backfill: max adds from the priming poll, freshest first (0 = off, pure priming)

    // Pre-buy freshness guard: abort if the price moved hard between signal and execution (stale quote).
    prebuyMaxDumpPct: num(env, 'PREBUY_MAX_DUMP_PCT', 30), // fresh < signal*(1-30%) → dumped, abort
    prebuyMaxPumpPct: num(env, 'PREBUY_MAX_PUMP_PCT', 100), // fresh > signal*2 → chasing, abort
    // Quote-level freshness guard: price implied by the live round-trip buy quote vs the
    // decision price. The DexScreener re-pull above can lag the pool by minutes (NEVER,
    // 2026-10-12: decided at $49k, filled at $2.3k); the Jupiter quote cannot. 0 = off.
    freshGuardPct: num(env, 'FRESH_GUARD_PCT', 10), // abort if |live − decision| > 10%
    reportEveryTrades: num(env, 'REPORT_EVERY_TRADES', 10), // full report on the dashboard after every N closes

    // ---- gates ----
    requireReportBelowAgeH: num(env, 'REQUIRE_REPORT_BELOW_AGE_H', 6), // young coins with no RugCheck report are blocked
    minHolders: num(env, 'MIN_HOLDERS', 100),
    linkedDumpMaxDrain: num(env, 'LINKED_DUMP_MAX_DRAIN', 0.35),
    creatorMaxDrain: num(env, 'CREATOR_MAX_DRAIN', 0.25), // creator-dump gate cap (was hardcoded 0.25 in gate.js)
    creatorVolBypassUsd: num(env, 'CREATOR_VOL_BYPASS_USD', 25000), // creator veto becomes a warning when 5m volume >= this — real flow can absorb the stack (user 2026-10-14, Eikon: skipped at $53K on this gate with $39.1K/5m volume, then bought at $307K and lost). 0 = off (veto always fires).
    insiderCountMax: num(env, 'INSIDER_COUNT_MAX', 50),
    insiderMaxPct: num(env, 'INSIDER_MAX_PCT', 10), // linked-wallet supply cap in the insiders gate (loosened to 15 by env 2026-10-12: skipped coins averaged +16%)
    // Insider-COUNT entry block (owner order 2026-10-16, off the last-50 separation study): the gates' insiders check above caps the SUPPLY SHARE in linked networks; this blocks on the raw COUNT of graph-detected insider wallets (rug.graphInsidersDetected — the same field the entry snapshot records as insiderWallets). Study: winner median 0 vs loser median 4; a >=3 block would have blocked 17/31 losers vs 6/18 winners (net +0.26 SOL on the sample). Judged in Bot.onSignal AFTER the gate stack resolves to proceed, so it binds on clean passes, mandatory-ape forces and contested overrides alike. INSIDER_BLOCK=0 is the kill switch (no verdict stamped, no tally — records exactly as before).
    insiderBlock: num(env, 'INSIDER_BLOCK', 1) === 1,
    insiderBlockN: num(env, 'INSIDER_BLOCK_N', 3), // block when graphInsidersDetected >= this count
    // Fast-bonder entry block (owner order 2026-10-16, "live gate now: block sub-2-minute bonders"): a KNOWN graduated coin whose bonding curve lived less than FAST_BOND_MAX_SEC seconds never buys. The camouflaged-bundle species splits its graduation slam across 100+ wallets and pads the tape with micro-buys so every count-based read looks organic (TRUMARS: 201 curve buys, 78-second curve) — but elapsed curve time cannot be faked. Measured from DexScreener pairCreatedAt, curve pair vs first AMM pair (sources.js curveLifeFromPairs). FAIL OPEN BY CONSTRUCTION: a non-graduated coin has no lifespan, a failed fetch measures nothing, and neither ever blocks. Judged in Bot.onSignal immediately after the insider block, so it binds on clean passes, mandatory-ape forces and contested overrides alike. Distinct from instantGrad below, which counts curve buy txs. FAST_BOND_BLOCK=0 is the kill switch (no fetch, no verdict stamped, no tally — records exactly as before).
    // BIRTH-VERDICT MEMORY (owner order 2026-10-16, the FMR hole): both birth gates fail open on missing data, so a verdict one evaluation ESTABLISHED must be REMEMBERED, not re-fetched into oblivion by the next one (FMR: instantGrad fired on a trend eval; 18 min later a pop eval's curve read 429'd to 'unknown' AND DexScreener's pair stamps came back degenerate — the bot bought a bought-out launch). Whenever any evaluation establishes a disqualifying birth verdict — an instantGrad bought-out fire or a measured lifespan under FAST_BOND_MAX_SEC — Bot persists it per mint (birth-verdicts.json) and the memory block at the onSignal seam (just before the fresh fastBond fetch) blocks every later evaluation of that mint. NO separate knob: ENFORCEMENT follows FAST_BOND_BLOCK (the kill switch disables the memory block too — no stamp, no tally, no block; records exactly as before), while verdict WRITING is always-on bookkeeping wherever a verdict is established (it accrues even with enforcement off). A passing measurement never writes a verdict. Boot backfills the memory from the journal's own gate stamps, so pre-fix fires are remembered on the first boot.
    fastBondBlock: num(env, 'FAST_BOND_BLOCK', 1) === 1,
    fastBondMaxSec: num(env, 'FAST_BOND_MAX_SEC', 120), // block when curve lifespan < this many seconds
    // Top guard (owner order 2026-10-16, "Do not buy a coin if it's at the literal fucking top" + "minimize those numbers so it signals as it's building up" — the values below are his approved set): a candidate within TOP_GUARD_DIST_PCT of its trailing TOP_GUARD_LOOKBACK_MIN-minute sampled high never buys when that high was MADE by a >= TOP_GUARD_SURGE_PCT rise inside the TOP_GUARD_SURGE_WINDOW_SEC before it printed and is still <= TOP_GUARD_HIGH_MAX_AGE_SEC old. The live triggers peak when the vertical peaks (blocus taken at the exact top tick of one candle, MM taken already -13.6% off a seconds-old high, 'long' taken at $50,158 and $33.9K three minutes later), so fills land on the tip; this blocks the fresh vertical tip while passing ground-out highs (no 2m surge — staircase runners) and held highs (surge aged out). Judged in Bot.onSignal on the same post-gates seam as the insider/fastBond/birth-memory blocks, from the bot's OWN sampled mc history ONLY — no external fetch, so it can never fail open on a 429 or a stamp collapse. UNKNOWN (thin history, unmeasured surge base, no current mc) never blocks. TOP_GUARD_BLOCK=0 is the kill switch (no verdict stamped, no tally — records exactly as before).
    topGuardBlock: num(env, 'TOP_GUARD_BLOCK', 1) === 1,
    topGuardDistPct: num(env, 'TOP_GUARD_DIST_PCT', 10), // block when the candidate sits within this % of the sampled high
    topGuardSurgePct: num(env, 'TOP_GUARD_SURGE_PCT', 20), // ...and the high was made by at least this % of a rise inside the surge window
    topGuardSurgeWindowSec: num(env, 'TOP_GUARD_SURGE_WINDOW_SEC', 120), // the window before the high print the surge is measured over
    topGuardHighMaxAgeSec: num(env, 'TOP_GUARD_HIGH_MAX_AGE_SEC', 300), // ...and the high is no older than this (a held high ages out)
    topGuardLookbackMin: num(env, 'TOP_GUARD_LOOKBACK_MIN', 30), // trailing minutes of samples the high is read from
    minQuoteLiqUsd: num(env, 'MIN_QUOTE_LIQ_USD', 1200),
    ladderMinN: num(env, 'LADDER_MIN_N', 15), ladderMaxRatio: num(env, 'LADDER_MAX_RATIO', 1.6),
    revivalDeadDrop: num(env, 'REVIVAL_DEAD_DROP', 50), revivalBounce: num(env, 'REVIVAL_BOUNCE', 50),
    revivalStrong: num(env, 'REVIVAL_STRONG', 80), revivalSellRatio: num(env, 'REVIVAL_SELL_RATIO', 1.25),
    bundleWatch: num(env, 'BUNDLE_WATCH', 1) === 1,
    bundleCheckSec: num(env, 'BUNDLE_CHECK_SEC', 8),
    bundleWindowSec: num(env, 'BUNDLE_WINDOW_SEC', 120),
    bundleDumpFrac: num(env, 'BUNDLE_DUMP_FRAC', 0.25),
    // farm-wallet tiers: balances within FARM_TOL_PCT of each other, in groups of >= FARM_MIN_CLUSTER
    farmTolPct: num(env, 'FARM_TOL_PCT', 0.005),
    farmMinCluster: num(env, 'FARM_MIN_CLUSTER', 3),
    farmMaxWallets: num(env, 'FARM_MAX_WALLETS', 8),
    farmMaxSupplyPct: num(env, 'FARM_MAX_SUPPLY_PCT', 10),
    // dust volume: >= DUST_MIN_TX trades in 1h averaging < DUST_MAX_AVG_USD. Set DUST_MAX_AVG_USD=0 to disable.
    dustMinTx: num(env, 'DUST_MIN_TX', 300),
    dustMaxAvgUsd: num(env, 'DUST_MAX_AVG_USD', 1.5),
    // instant graduation: bonding curve filled in <= N buys = bought out at launch (0 = off)
    instantGradMaxBuys: num(env, 'INSTANT_GRAD_MAX_BUYS', 3),
    // bot flow: coin younger than BOTFLOW_MAX_AGE_H with >= BOTFLOW_MIN_TX trades in 1h averaging < BOTFLOW_MAX_AVG_USD (0 = off)
    botflowMaxAgeH: num(env, 'BOTFLOW_MAX_AGE_H', 2),
    botflowMinTx: num(env, 'BOTFLOW_MIN_TX', 1000),
    botflowMaxAvgUsd: num(env, 'BOTFLOW_MAX_AVG_USD', 6),
    // setup blacklist: 0 = off (per-token blocking only). Set to N to block setups with N+ bad marks.
    setupBlacklistMin: num(env, 'SETUP_BLACKLIST_MIN', 0),
    // name block: any coin whose NAME contains one of these words (whole-word, case-insensitive) is
    // hard-skipped before gates — user 2026-10-13 after CI ("Crypto Inu", -39%) and SCI ("Super
    // Crypto Inu", -23%) died back-to-back inside two minutes. Empty NAME_BLOCK_WORDS = off.
    nameBlockWords: (env.NAME_BLOCK_WORDS ?? 'inu').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    // extension cap: skip classic entries priced more than this fraction above the trailing-1h
    // sampled low (the breakout base) — user 2026-10-13 (OTTO). 0 = off.
    extMaxFromBase: num(env, 'EXT_MAX_FROM_BASE', 1.5),
    // fresh-history fail-closed (user 2026-10-13, entry-fixes A3): when a coin arrives from the
    // trending/movers lists with too little sampled history to judge, the anti-chase guards used
    // to wave it through. Now DexScreener's own aggregates decide: a >FRESH_MAX_CHG_M5 5-minute
    // move already printed = skip; and a small cap whose whole hourly move is one 5m candle
    // (chgM5 ≥ FRESH_M5_SHARE_H1 × chgH1) = skip. BORING: +41.6% m5 vs +13.8% h1 at $14.5k, no samples.
    freshMaxChgM5: num(env, 'FRESH_MAX_CHG_M5', 25),     // 0 = off
    freshSmallMc: num(env, 'FRESH_SMALL_MC', 30000),     // "small cap" line for the fresh check and the B3 wash reject
    freshM5ShareH1: num(env, 'FRESH_M5_SHARE_H1', 0.7),  // 0 = off
    // fresh-coin FLOW bypass (user 2026-10-14, "Flow — heavy 5m volume, buyers dominating"):
    // the move-cap leg of the fresh check lifts when the coin's own 5m flow is heavy AND
    // buyer-dominated — the flow is the evidence the missing sampled history would have
    // given. The small-cap blip leg is NEVER bypassed (a small cap's flow is the wash
    // itself), and at/above the D1 bundle-bait ceiling there is no bypass either.
    freshBypassMinVolM5: num(env, 'FRESH_BYPASS_MIN_VOL_M5', 50000), // 0 = bypass off
    freshBypassMinBuyRatio: num(env, 'FRESH_BYPASS_MIN_BUY_RATIO', 0.65), // buy share the bypass demands (the ceiling is MAX_BUY_RATIO_M5, wired in bot.js)
    // flow-entry snapshot collapse floor (user 2026-10-15, from the DACITY forensic): the
    // classic detectors carry their own price-shape protection (pop's positive gain band +
    // draw-from-peak cap, trend's chgM5 floor + near-high rule), but a flow entry fires on a
    // tracked wallet's buy and reaches the shared stack with NO shape requirement — and the
    // one shared check that reads chgM5 (the fresh check above) caps only the UPSIDE and
    // only while sampled history is thin. DACITY was taken at chgM5 -41.8% in its own entry
    // snapshot, ~62% under its peak, and bled out. A flow entry whose OWN snapshot prints
    // chgM5 at/below this floor is skipped. The floor is a negative percent; 0 = off. The
    // -20 default sits in the empty band of the recorded flow-entry distribution (every
    // taken flow entry 2026-10-12..15 printed chgM5 in [-11.9, +35.2] except DACITY's
    // -41.8 collapse) — dip-follows still pass, only collapses are blocked. Flow only:
    // every other setup keeps its detector shape and is untouched by this knob.
    flowSnapshotMinChgM5: num(env, 'FLOW_SNAPSHOT_MIN_CHG_M5', -20), // <= this chgM5 (%) in a flow entry's own snapshot = skip (0 = off)
    // peak-distance stamps + shadow veto (RECORD-ONLY, user 2026-10-15): every signal
    // record's fields block carries distFromPeakPct / peakAgeSec (distance under the
    // trailing-60m sampled peak, and the peak's age) plus a peakVeto verdict computed
    // with these lines. NOTHING reads the verdict — no gate, detector or sizing path
    // branches on it; it exists so the veto can be scored against outcomes before
    // anyone proposes making it real. Defaults are the design-note starting lines.
    peakVetoDistPct: num(env, 'PEAK_VETO_DIST_PCT', 0.15),  // shadow line: at/above this distance under the sampled peak…
    peakVetoAgeSec: num(env, 'PEAK_VETO_AGE_SEC', 1800),    // …with the peak at most this old (sec), the shadow would block
    // shallow-dip veto (user 2026-10-14): a classic entry (pop/trend/liftoff) may be taken at
    // the trailing SHALLOW_DIP_WINDOW_MIN sampled top, breaking above it, or on a real dip
    // (SHALLOW_DIP_MAX_PCT or more under the top — deep dips included) — but not in the
    // shallow zone just under the top (his example: -5%), which is the rollover spot. Deep
    // dips stay buyable on every classic setup because each setup's own volume / buy-inflow
    // legs still judge them. This REPLACES the stale-pop veto (removed earlier today for
    // CODE): the stale veto is gone either way — 0 here turns THIS rule off, it does not
    // bring the stale veto back.
    shallowDipMaxPct: num(env, 'SHALLOW_DIP_MAX_PCT', 0.10), // 0 = off
    shallowDipWindowMin: num(env, 'SHALLOW_DIP_WINDOW_MIN', 60),
    // ran-rebuy block (user 2026-10-15, "for tonight" — RAN_REBUY=0 lifts it with no
    // code change): a mint the bot already traded whose coin has printed >=
    // RAN_REBUY_MULT x that trade's entry price at ANY point since the entry
    // (including after the exit — measured on GeckoTerminal minute candles over
    // the mint's top pool, peak high vs the journaled entry fill in USD) cannot
    // be re-bought until RAN_REBUY_HOURS after that trade's close. Mint-exact,
    // anchored on the most recent prior close; the wait's expiry re-allows the
    // rebuy regardless of the run, and a coin that never printed the multiple
    // is never blocked. Fail-open on any unmeasurable peak (counted in stats).
    ranRebuy: num(env, 'RAN_REBUY', 1),                    // 1 = on, 0 = off
    ranRebuyMult: num(env, 'RAN_REBUY_MULT', 5),          // "already ran" = printed >= this x the prior entry
    ranRebuyHours: num(env, 'RAN_REBUY_HOURS', 3),        // rebuy wait after the prior close, hours

    // ---- exits (judged on REALIZABLE value = Jupiter sell quote, not screen price) ----
    stopLoss: num(env, 'STOP_LOSS', 0.15),                // grace-stop ARM line on realizable value (user 2026-10-13: 0.10 live via env)
    stopHardPct: num(env, 'STOP_HARD_PCT', 0.20),         // hard floor: sells at this drawdown, no grace/veto once confirmed
    stopHardConfirmChecks: num(env, 'STOP_HARD_CONFIRM_CHECKS', 2), // consecutive checks at/below the floor before it fires (1 = instant, pre-2026-10-13 behavior)
    stopHardConfirmSec: num(env, 'STOP_HARD_CONFIRM_SEC', 0), // seconds a hard-floor breach must PERSIST before it fires (user 2026-10-13: 3s — "be sure it's still there"); 0 = no time requirement, the check count alone decides
    stopGraceSec: num(env, 'STOP_GRACE_SEC', 5),          // seconds between arming and the flow-confirmed sell
    stopFlowVeto: num(env, 'STOP_FLOW_VETO', 1),          // 1 = buyers absorbing the dip vetoes a confirmed stop (0 = off)
    stopXcheck: num(env, 'STOP_XCHECK', 1),               // 1 = a full exit needs a corroborating instant re-quote (bad-print guard)
    stopXcheckPct: num(env, 'STOP_XCHECK_PCT', 0.20),     // re-quote may differ from the triggering mark by at most this fraction
    // STALL EXIT (user order 2026-10-16 19:24 EDT, "remove the mess... simplify
    // it" / "No SL rule aside from the 3M stall 60 sec confirm"): the ONE general
    // downside exit (exits.js section 5). It replaced BOTH the SL ladder — a
    // price-rung probation machine built and removed the same evening at his
    // order — and the 10-minute momentum-failure undertaker it succeeds: the
    // same dead-flow conjunction the undertaker judged (buysM5 ≤ 1 AND sellsM5 >
    // 3 × buysM5), but from 3 minutes of age instead of 10, and the first dead
    // check only stamps a pending — the sell needs the flow to STILL be dead
    // 60s later. No price input anywhere: price alone can never trigger, arm
    // or cancel it. Pre-TP1 + middle stages; the moonbag keeps its own dead
    // flow (3c2) and trail. Protect does NOT block it (the undertaker never
    // was protect-blocked either); takeover silences it like everything else.
    stallExit: num(env, 'STALL_EXIT', 1),                 // kill switch: 0 = no general downside exit pre-TP2 besides liquidity death (the owner's chosen shape if flipped)
    stallExitMinAgeSec: num(env, 'STALL_EXIT_MIN_AGE_SEC', 180), // the "3M": the rule does not exist for a younger position — no pending can stamp
    stallExitConfirmSec: num(env, 'STALL_EXIT_CONFIRM_SEC', 60), // the "60 sec confirm": dead flow must still hold this long after the pending stamps, judged on the first check at/after the lapse
    // DEATH DETECTOR (owner design 2026-10-17 ~18:37 EDT, "put it to a test
    // with a .02 buy with our last funds"; combination rule delegated to the
    // agent): NOT a stop-loss — no price floor, no arming on targets, PnL is
    // never an input. Every position check re-asks "is this coin alive right
    // now?" from three moment vitals: (1) the realizable sell quote vs the
    // screen value of the bag (execRatio — the exit door closing), (2) the
    // liquidity SLOPE over the trailing window (real reads only; a $0 or
    // missing read is UNKNOWN, never a drain), (3) sized sell pressure
    // (sells dominating buys in dollars over the 5m window). A sell needs
    // 2 of 3 vitals bad, still bad on the first check after the confirm
    // window — EXCEPT a hard quote collapse, which fires solo and instantly:
    // if the exit door is actually closing there is no second opinion to
    // wait for. Pre-TP1 positions only (the bleed zone); once TP1 banks,
    // the ladder owns the position. Protect/takeover silence it like the
    // rest of the downside family. DEATH_DETECTOR=1 turns it live.
    deathDetector: env.DEATH_DETECTOR === '1',
    ddQuoteBad: num(env, 'DD_QUOTE_BAD', 0.70),           // execRatio at/below this = quote vital bad (bag fetches <= 70% of screen value)
    ddQuoteCollapse: num(env, 'DD_QUOTE_COLLAPSE', 0.50), // execRatio at/below this = collapse: solo instant fire
    ddLiqDropPct: num(env, 'DD_LIQ_DROP_PCT', 0.40),      // liquidity down >= this fraction across the window = liq vital bad
    ddLiqWindowSec: num(env, 'DD_LIQ_WINDOW_SEC', 180),   // trailing window for the liquidity slope read
    ddFlowSellMult: num(env, 'DD_FLOW_SELL_MULT', 2),     // sells >= this x buys (count, 5m) toward the flow vital
    ddFlowMinUsd: num(env, 'DD_FLOW_MIN_USD', 400),       // ...AND >= this much estimated sell-side $ in the 5m window (sized, not dust)
    ddConfirmSec: num(env, 'DD_CONFIRM_SEC', 10),         // 2-of-3 must still read bad on the first check at/after this lapse
    // FAKE-ALIVE STAMP (owner insight + build order 2026-10-18): record-only
    // per-position score of how much of its life the tape looked balanced
    // (buys >= 70% of sells) while the price fell under its peak — the
    // volume-bot grind signature. NOTHING trades on it; it rides ticks,
    // /state and close records for a later verdict. FAKE_ALIVE_STAMP=0 off.
    fakeAliveStamp: env.FAKE_ALIVE_STAMP !== '0',
    dipStopPct: num(env, 'DIP_STOP_PCT', 0.05),           // sell if PRICE drops this far below entry (0 = off)
    stallSec: num(env, 'STALL_SEC', 60),                  // entry stall: sell if price never breaks out within this many seconds of entry (0 = off)
    stallBandPct: num(env, 'STALL_BAND_PCT', 0.05),       // entry range half-width: at stallSec the price must be OUTSIDE entry ± this or the position sells (user 2026-10-13 endpoint version)
    stallBandUpPct: num(env, 'STALL_BAND_UP_PCT', 0.03),  // stall dead-zone UPPER edge only — tighter than the downside: at stallSec, up more than +3% is working, not stalled; the lower edge stays stallBandPct (user 2026-10-14: UNTXED stalled out at +2.2% and then ripped)
    stallProbationSec: num(env, 'STALL_PROBATION_SEC', 300), // probation leash (user 2026-10-14, Musclecat): with this > 0, a position inside the band at the stall deadline is NOT sold — it goes on probation until this many seconds FROM ENTRY (then sells if still in the range); 0 = probation OFF (sell at the deadline, pre-leash behavior)
    stallLeashPct: num(env, 'STALL_LEASH_PCT', 0.07),     // while on probation, a price move to/below −this from entry sells instantly — the tight leash stands in for the distant −17% hard floor, which was the only other owner of a band-sitter (Musclecat: flat past the 180s deadline, dove to the floor in ~20s, −0.0169); 0 = no leash, expiry only
    beArmPct: num(env, 'BE_ARM_PCT', 0.05),               // break-even ratchet ARM (user 2026-10-14, "Build it — arm at +5%"): once a pre-TP1 position's peak realizable move reaches +this, the trade can no longer become a loser; 0 = ratchet off
    beTriggerPct: num(env, 'BE_TRIGGER_PCT', 0.02),       // ...an armed position sells in full when the move falls back to +this — the cushion above break-even exists so the executed fill lands at true scratch after the sell's own slippage (user approved +1-2%)
    ratchetShadow: num(env, 'RATCHET_SHADOW', 1),         // shadow flow judge for the ratchet (user 2026-10-14): RECORD-ONLY — watches held positions' streamed flow and journals where a flow trigger WOULD have fired vs where the price trigger did (ratchet_shadow.jsonl). There is no live mode: this can never sell. 0 = fully off (no held-mint subscriptions for it, no records)
    tickJournal: num(env, 'TICK_JOURNAL', 1),             // position-tick journal (user 2026-10-16): RECORD-ONLY — every position check (~4s) appends ONE compact record of what the bot itself saw when it judged that position (quote ratio, net gain, stage, peak, 5m buy share / buy / sell counts, mc) to position_ticks.jsonl. It is the prerequisite dataset for the bracket-classifier question: until now those marks lived only in memory (pos.flowHist) and died with the process (measurement pass 2026-10-16, workstream D). There is no live mode: NOTHING reads this journal back, no decision path consumes it, and it can never sell. 0 = fully off (no records, no counter)
    ratchetFlowWindowSec: num(env, 'RATCHET_FLOW_WINDOW_SEC', 15), // ...the rolling stream window the shadow judge reads
    ratchetFlowSellShare: num(env, 'RATCHET_FLOW_SELL_SHARE', 0.70), // ...would-fire needs sells to be at least this share of the window's traded SOL
    ratchetFlowMinSellSol: num(env, 'RATCHET_FLOW_MIN_SELL_SOL', 1.0), // ...AND at least this much SOL of sells in the window (one whale taking profit is not an exit wave)
    ratchetStreamEvalMs: num(env, 'RATCHET_STREAM_EVAL_MS', 300), // stream judge v2 (user 2026-10-15): per-mint throttle for evaluating the SAME shadow judge on streamed prints as they land, instead of only when the 4s quote tick asks — RECORD-ONLY like the rest of the layer (ratchet_shadow.jsonl, kind 'would-fire-stream'); the live ratchet and the tick judge are untouched
    ratchetStreamVwapSec: num(env, 'RATCHET_STREAM_VWAP_SEC', 2), // ...the stream judge's price basis: SOL/token VWAP (Σsol/Σtokens) over this many seconds of prints, measured from the position's actual entry fill — a window holding fewer than 2 prints is NO opinion, so one dust print can neither set the peak nor fake a fade
    calloutsEnabled: num(env, 'CALLOUTS_ENABLED', 0),     // live pump.fun callouts (user 2026-10-15: OFF — under the new Callout Rewards rules, follower PnL drives rewards and the current book's tailer numbers are negative; the entry + progress posts stay dark until this is flipped to 1). 0 = postCallout returns immediately (no auth, no LLM, no network) and both bot call sites skip it entirely. The Callout Shadow Lab (calloutLab.js) is separate: record-only, always on, unaffected by this knob.
    bleedPct: num(env, 'BLEED_PCT', 0.07),                 // bleed exit (user 2026-10-14, "Still-falling test — down 7%+ and not recovering"): past the prove-itself window, a position down at least this much on `move` AND still falling sells in full — the probation leash freed from the band (TAILOOR bled to -52% in ~6 min because nothing owned a falling coin that never sat inside the band at the stall deadline); 0 = off
    bleedMinAgeSec: num(env, 'BLEED_MIN_AGE_SEC', 180),    // ...the prove-itself window: before this age the older exits judge alone
    bleedLookbackSec: num(env, 'BLEED_LOOKBACK_SEC', 60),  // ..."still falling" = the current move at/below the move this long ago, judged on the position's own per-check move history; no reading at least ~45s old = no fire yet
    exitConfirmSec: num(env, 'EXIT_CONFIRM_SEC', 10),     // confirmation window for the FAIL-SAFE exits only (user 2026-10-14, "a fail safe to the fail safe"): the break-even ratchet, the bleed exit and the probation leash no longer sell on the first triggering check — their full condition must hold CONTINUOUSLY until a check at/after this many seconds from the trigger, judged inside the existing position-check loop (no extra delay beyond the window); a recovery inside the window cancels the pending sell and the exit can re-trigger later. Probation EXPIRY, the TP ladder and every other exit stay instant. 0 = off, the fail-safes sell on the trigger check exactly as before the layer existed
    tp1Pct: num(env, 'TP1_PCT', 0.25),                    // bank part on the jump: +25% in your pocket after slippage + SOL fees
    tp1Frac: num(env, 'TP1_FRAC', 0.65),                  // ...sell 65% of it
    // TP ladder (user 2026-10-13): TP1 is adaptive — it ARMS at tp1Pct and the bank target slides up
    // to tp1AdaptMax while the run still looks strong (price near its high + flow supportive, judged
    // on the position's own recorded marks). Fires early on a tp1Giveback rollover from the peak or
    // when strength fades. TP2 banks tp2Frac OF THE ORIGINAL position at tp2Pct; the post-TP2
    // moonbag trails bagTrailPct below peak with no floor/lock.
    tp1AdaptMax: num(env, 'TP1_ADAPT_MAX_PCT', 0.60),     // adaptive TP1 ceiling (net gain)
    tp1Giveback: num(env, 'TP1_GIVEBACK_PCT', 0.08),      // give-back from peak (gain points) that banks TP1 once armed
    tp1FlowMin: num(env, 'TP1_FLOW_MIN_SHARE', 0.50),     // min buy share of 5m flow for the run to count as supported
    tp2Pct: num(env, 'TP2_PCT', 1.00),                    // second bank at +100% net
    tp2Frac: num(env, 'TP2_FRAC', 0.35),                  // ...sells this fraction of the ORIGINAL position (0 = off)
    bagTrailPct: num(env, 'BAG_TRAIL_PCT', 0.15),         // moonbag trail below peak (was 0.35 from the MFE study; user tightened 35→20→15% on 2026-10-13 — exit at -15% under the last recorded peak)
    bagTrailConfirmSec: num(env, 'BAG_TRAIL_CONFIRM_SEC', 60), // moonbag trail confirmation (owner order 2026-10-16 23:12 EDT, "Give it a 1 min timer"): the 3c breach must HOLD this many seconds before the bag sells — a check back above the line disarms it, so a V-dip that recovers inside the window sells nothing (Chameleon's bag trailed out at a bottom that recovered above the peak in ~3 min); 0 = instant fire on the first sub-line print, exactly as before the timer
    tpTrailPct: num(env, 'TP_TRAIL_PCT', 0.25),           // DEAD KNOB: the post-TP1 middle trail (3d) is stripped in code (user order 2026-10-16) — read only by the disabled section
    tp2RejectZone: num(env, 'TP2_REJECT_ZONE', 0.80),     // middle stage: peak net gain at/above this = it reached for the TP2 mark (user 2026-10-13)
    tp2RejectDrop: num(env, 'TP2_REJECT_DROP', 0.10),     // ...and this far off that peak without converting = rejected → sell the remainder (zone 0 = off)
    // Two-path exit redesign (user 2026-10-15, variant c): at TP1 the position is classified by the
    // TP1 sell's realized gain — [modestMinPct, modestMaxPct] → MODEST: the remainder skips the middle
    // trail / generic trail and rides to the modestTargetPct split under the kill zone; above the band
    // → LADDER (today's stack, unchanged); below the band → LADDER plus the kill-zone overlay (4e).
    modestMinPct: num(env, 'MODEST_MIN_PCT', 0.20),       // TP1 fire at/above this net gain can classify modest
    modestMaxPct: num(env, 'MODEST_MAX_PCT', 0.40),       // ...and at/below this (a fire above it = ladder)
    modestTargetPct: num(env, 'MODEST_TARGET_PCT', 0.50), // modest remainder's split target on `move` (0 = target off: the remainder rides the kill zone / downside stack only)
    modestSplitBankFrac: num(env, 'MODEST_SPLIT_BANK_FRAC', 0.6667), // at the target, bank this fraction OF THE REMAINDER; the surviving slice converts to the ladder path
    killZoneFloorPct: num(env, 'KILL_ZONE_FLOOR_PCT', 0.10), // kill zone floor: the remainder's `move` at/below 1 + this (once armed) enters the zone (0 = zone off)
    killZoneArmMult: num(env, 'KILL_ZONE_ARM_MULT', 1.25),   // ...the zone arms only once the post-TP1 peak `move` reaches this multiple of entry — before that the bleed/leash own the downside
    // Dead-flow exit at altitude (user 2026-10-15, the Scout/AAD round-trip: peaked ~+12% realizable,
    // buys flatlined, chopped, gave it all back to probation expiry at −0.4%): a PRE-TP1 position whose
    // peak `move` reached the arm line sells in full when its own flow flatlines for a full window —
    // the window IS the confirmation, no extra grace (exits.js 4d-pre).
    deadflowArmPct: num(env, 'DEADFLOW_ARM_PCT', 0.08),      // arm: the position's peak `move` reaches 1 + this (pre-TP1)
    deadflowWindowSec: num(env, 'DEADFLOW_WINDOW_SEC', 45), // rolling window of dead flow that must hold in full (0 = rule off)
    deadflowMaxBuyDelta: num(env, 'DEADFLOW_MAX_BUY_DELTA', 1), // max rise in the 5m buy count across the window — one stray buy tolerated
    deadflowPeakGapPct: num(env, 'DEADFLOW_PEAK_GAP_PCT', 0.01), // current `move` must sit at least this far below the window-start peak (price stopped pushing)
    // Staged moonbag dead flow (user order 2026-10-16 ~20:15 EDT, exits.js 3c2/3c3): the bag's
    // dead-flow exit sells in waves — 50% of the current remainder per dead-flow wave (edge-based:
    // the condition must clear between waves) — and after wave 2 the stub rides to a floor at
    // 1 + bagFloorPct of entry instead of ever selling to dead flow again. 0 = legacy: dead flow
    // sells the whole bag at once, exactly as before, and the floor does not exist.
    bagDeadStaged: num(env, 'BAG_DEAD_STAGED', 1),        // staged waves on (1) / legacy whole-bag dead-flow sell (0)
    bagFloorPct: num(env, 'BAG_FLOOR_PCT', 0.10),         // post-wave-2 stub floor: sell in full when ratio <= 1 + this ("10% above avg entry")
    // SMALL-BAG MOONBAG METHOD (owner order 2026-10-17 ~00:22 EDT, "no dead flow no 50% cut just
    // hold"; amendment ~00:24 EDT, "definitely closet this method… once we start leaving bigger
    // moon bags we utilize it"): while BAG_SMALL_HOLD is on (the live default), the post-TP2 bag's
    // dead-flow section (exits.js 3c2) sells NOTHING — no waves, no legacy whole-bag fire — and the
    // 3c3 floor becomes the bag's downside exit, armed from TP2 (no wave precondition) with a
    // BAG_FLOOR_CONFIRM_SEC confirmation (default 60; 0 = instant fire on the line). Mode OFF
    // restores the staged waves + instant post-wave-2 floor byte-for-byte: the waves method is
    // closeted in the code, not deleted, and returns when bags get bigger (a TP2_FRAC trim that
    // leaves ~20% riding instead of ~5%). Confirm window raised 30 -> 60 by owner order
    // 2026-10-17 ~05:49 EDT ("give the moonbag any chance it can to just rise"): a bounce back
    // above the line inside the minute disarms the pending floor exit with no credit, exactly
    // like the trail's 60s confirm discipline.
    bagSmallHold: num(env, 'BAG_SMALL_HOLD', 1),          // small-bag moonbag mode on (1) / closeted waves method (0)
    bagFloorConfirmSec: num(env, 'BAG_FLOOR_CONFIRM_SEC', 60), // small-bag floor confirmation: the floor breach must HOLD this many seconds before the bag sells (0 = instant fire)
    // MOONBAG TRIM (owner order 2026-10-17 ~00:27 EDT, "200% from TP2 — trim 50%"): once per
    // position, when the bag's realizable ratio reaches BAG_TRIM_MULT × the ratio stamped at the
    // TP2 print (3x ≈ +200% from TP2 ≈ 5.4x entry), sell half the current remainder; the surviving
    // half rides the trail/floor as before (exits.js 3c1). Applies in both bag modes; protect does
    // not suppress it (a TP-ladder-family profit take, like TP1/TP2). 0 = trim off.
    bagTrimMult: num(env, 'BAG_TRIM_MULT', 3),            // moonbag trim level: this multiple of the TP2-stamp ratio (0 = off)
    lockArm: num(env, 'PROFIT_LOCK_ARM', 0.15),           // once up +15% or more after fees...
    lockKeep: num(env, 'PROFIT_LOCK_KEEP', 0.5),          // ...sell the rest if it falls below half of its best gain (0 = off)
    trailArm: num(env, 'TRAIL_ARM', 1.00),
    trailPct: num(env, 'TRAIL_PCT', 0.25),
    timeStopMin: num(env, 'TIME_STOP_MIN', 25),
    timeStopMinGain: num(env, 'TIME_STOP_MIN_GAIN', 0.10),
    maxHoldMin: num(env, 'MAX_HOLD_MIN', 120),
    momentumFailSellRatio: num(env, 'MOMENTUM_FAIL_SELL_RATIO', 1.8),

    // ---- loops ----
    discoverEverySec: num(env, 'DISCOVER_EVERY_SEC', 20),
    pollEverySec: num(env, 'POLL_EVERY_SEC', 10),
    positionEverySec: num(env, 'POSITION_EVERY_SEC', 4),
    watchMax: num(env, 'WATCH_MAX', 400),
    watchTtlMin: num(env, 'WATCH_TTL_MIN', 20),
    signalCooldownMin: num(env, 'SIGNAL_COOLDOWN_MIN', 10),
    maxSignalsPerTick: num(env, 'MAX_SIGNALS_PER_TICK', 3),

    // ---- live feed (PumpPortal websocket: new launches in seconds) ----
    liveFeed: env.LIVE_FEED !== '0',
    liveFeedUrl: env.PUMPPORTAL_WS_URL || 'wss://pumpportal.fun/api/data',
    pumpportalApiKey: env.PUMPPORTAL_API_KEY || '',   // unlocks PumpPortal trade streaming (subscribeTokenTrade is key-gated: the linked wallet must hold >= 0.02 SOL). Appended as ?api-key= at connect; never logged.

    dataDir: env.DATA_DIR || './data',
    port: num(env, 'PORT', 3000),
  };
  // Burned cost of ONE swap transaction: the 5,000-lamport base fee (protocol
  // constant) + the configured priority fee. Chain-calibrated (D2 + rent
  // analysis, 2026-10-14): meta.fee on parsed buy txs was exactly 105,000
  // lamports at the default priority fee. The ~0.001514 token-account deposit
  // a buy also pays is NOT included — it is a refundable deposit the
  // closeEmptyAccounts sweep recovers, not a burned fee.
  cfg.txFeeSol = (5000 + cfg.priorityFeeLamports) / 1e9;
  return cfg;
}

export function validateConfig(cfg) {
  const errs = [];
  if (cfg.tradeSol <= 0) errs.push('TRADE_SOL must be > 0');
  if (cfg.tradeSol > 0.25 && !cfg.allowLarge) errs.push(`TRADE_SOL=${cfg.tradeSol} looks like a typo (>0.25). Set ALLOW_LARGE=1 if intentional.`);
  if (cfg.maxPositions < 1 || cfg.maxPositions > 10) errs.push('MAX_POSITIONS must be 1..10');
  if (cfg.slot2Sol < 0) errs.push('SLOT2_SOL must be >= 0 (0 = off)');
  if (cfg.dailyLossSol < 0) errs.push('DAILY_LOSS_SOL must be >= 0 (0 = disabled)');
  if (cfg.haltAfterCloses < 0) errs.push('HALT_AFTER_CLOSES must be >= 0');
  if (cfg.lossHalveN < 0) errs.push('LOSS_HALVE_N must be >= 0');
  if (cfg.lossHalveFactor <= 0 || cfg.lossHalveFactor > 1) errs.push('LOSS_HALVE_FACTOR must be between 0 and 1');
  if (cfg.wipeHaltFrac < 0 || cfg.wipeHaltFrac > 1) errs.push('WIPE_HALT_FRAC must be between 0 and 1');
  if (cfg.haltDownSol < 0) errs.push('HALT_DOWN_SOL must be >= 0');
  if (cfg.killEquityFrac <= 0 || cfg.killEquityFrac >= 1) errs.push('KILL_EQUITY_FRAC must be between 0 and 1');
  if (cfg.fastPopWindowSec < 10 || cfg.fastPopWindowSec > 600) errs.push('FAST_POP_WINDOW_SEC must be 10..600');
  if (cfg.fastPopGainPct < 1 || cfg.fastPopGainPct > 1000) errs.push('FAST_POP_GAIN_PCT must be 1..1000');
  if (cfg.fastPopMinBuyShare < 0 || cfg.fastPopMinBuyShare > 1) errs.push('FAST_POP_MIN_BUY_SHARE must be between 0 and 1');
  if (cfg.fastPopMaxDrop < 0 || cfg.fastPopMaxDrop > 0.9) errs.push('FAST_POP_MAX_DROP must be 0..0.9');
  if (cfg.fastPopMaxSubs < 1 || cfg.fastPopMaxSubs > 1000) errs.push('FAST_POP_MAX_SUBS must be 1..1000');
  if (cfg.stopLoss <= 0 || cfg.stopLoss >= 1) errs.push('STOP_LOSS must be between 0 and 1');
  if (cfg.stopHardPct < 0 || cfg.stopHardPct >= 1) errs.push('STOP_HARD_PCT must be 0 (off) or between 0 and 1');
  if (cfg.stopHardConfirmChecks < 1 || cfg.stopHardConfirmChecks > 10) errs.push('STOP_HARD_CONFIRM_CHECKS must be between 1 and 10');
  if (cfg.stopHardConfirmSec < 0 || cfg.stopHardConfirmSec > 60) errs.push('STOP_HARD_CONFIRM_SEC must be between 0 and 60');
  if (cfg.stopGraceSec < 0 || cfg.stopGraceSec > 120) errs.push('STOP_GRACE_SEC must be between 0 and 120');
  if (cfg.stallExit < 0 || cfg.stallExit > 1) errs.push('STALL_EXIT must be 0 or 1');
  if (cfg.stallExitMinAgeSec < 0 || cfg.stallExitMinAgeSec > 3600) errs.push('STALL_EXIT_MIN_AGE_SEC must be between 0 and 3600');
  if (cfg.stallExitConfirmSec < 0 || cfg.stallExitConfirmSec > 600) errs.push('STALL_EXIT_CONFIRM_SEC must be between 0 and 600');
  if (cfg.stopXcheckPct < 0.05 || cfg.stopXcheckPct > 0.9) errs.push('STOP_XCHECK_PCT must be between 0.05 and 0.9');
  if (cfg.extMaxFromBase < 0 || cfg.extMaxFromBase > 20) errs.push('EXT_MAX_FROM_BASE must be between 0 and 20 (0 = off)');
  if (cfg.paceRelax < 0 || cfg.paceRelax > 1) errs.push('PACE_RELAX must be 0 or 1');
  if (cfg.scanStamps < 0 || cfg.scanStamps > 1) errs.push('SCAN_STAMPS must be 0 or 1');
  if (cfg.fastPopMaxGainPct < 0 || cfg.fastPopMaxGainPct > 5000) errs.push('FAST_POP_MAX_GAIN_PCT must be between 0 and 5000 (0 = off)');
  if (cfg.trendEnabled < 0 || cfg.trendEnabled > 1) errs.push('TREND_ENABLED must be 0 or 1');
  if (cfg.trendShadow < 0 || cfg.trendShadow > 1) errs.push('TREND_SHADOW must be 0 or 1');
  if (cfg.trendMinMc < 0) errs.push('TREND_MIN_MC must be >= 0 (0 = off)');
  if (cfg.trendMinBuyRatioH1 < 0 || cfg.trendMinBuyRatioH1 > 1) errs.push('TREND_MIN_BUY_RATIO_H1 must be between 0 and 1 (0 = off)');
  if (cfg.trendMinTxnsM5 < 0) errs.push('TREND_MIN_TXNS_M5 must be >= 0 (0 = off)');
  if (cfg.trendMaxVolToMc < 0) errs.push('TREND_MAX_VOL_TO_MC must be >= 0 (0 = off)');
  if (cfg.trendFreshMinVolM5 < 0) errs.push('TREND_FRESH_MIN_VOL_M5 must be >= 0 (0 = off)');
  if (cfg.revivalMinAgeD < 0) errs.push('REVIVAL_MIN_AGE_D must be >= 0 (0 = off)');
  if (cfg.revivalMaxChgH6 < 0) errs.push('REVIVAL_MAX_CHG_H6 must be >= 0');
  if (cfg.freshMaxChgM5 < 0) errs.push('FRESH_MAX_CHG_M5 must be >= 0 (0 = off)');
  if (cfg.freshSmallMc < 0) errs.push('FRESH_SMALL_MC must be >= 0');
  if (cfg.freshM5ShareH1 < 0 || cfg.freshM5ShareH1 > 1) errs.push('FRESH_M5_SHARE_H1 must be between 0 and 1 (0 = off)');
  if (cfg.freshBypassMinVolM5 < 0) errs.push('FRESH_BYPASS_MIN_VOL_M5 must be >= 0 (0 = bypass off)');
  if (cfg.freshBypassMinBuyRatio < 0 || cfg.freshBypassMinBuyRatio > 1) errs.push('FRESH_BYPASS_MIN_BUY_RATIO must be between 0 and 1');
  if (cfg.flowSnapshotMinChgM5 > 0 || cfg.flowSnapshotMinChgM5 < -100) errs.push('FLOW_SNAPSHOT_MIN_CHG_M5 must be between -100 and 0 (0 = off)');
  if (cfg.peakVetoDistPct < 0 || cfg.peakVetoDistPct > 1) errs.push('PEAK_VETO_DIST_PCT must be between 0 and 1');
  if (cfg.peakVetoAgeSec < 0 || cfg.peakVetoAgeSec > 86400) errs.push('PEAK_VETO_AGE_SEC must be between 0 and 86400');
  if (cfg.shallowDipMaxPct < 0 || cfg.shallowDipMaxPct > 0.9) errs.push('SHALLOW_DIP_MAX_PCT must be between 0 and 0.9 (0 = off)');
  if (cfg.shallowDipWindowMin < 1 || cfg.shallowDipWindowMin > 720) errs.push('SHALLOW_DIP_WINDOW_MIN must be between 1 and 720');
  if (cfg.insiderBlockN < 1 || cfg.insiderBlockN > 10000) errs.push('INSIDER_BLOCK_N must be between 1 and 10000');
  if (cfg.fastBondMaxSec < 1 || cfg.fastBondMaxSec > 86400) errs.push('FAST_BOND_MAX_SEC must be between 1 and 86400');
  if (cfg.topGuardDistPct < 0 || cfg.topGuardDistPct > 100) errs.push('TOP_GUARD_DIST_PCT must be between 0 and 100');
  if (cfg.topGuardSurgePct < 0 || cfg.topGuardSurgePct > 100000) errs.push('TOP_GUARD_SURGE_PCT must be between 0 and 100000');
  if (cfg.topGuardSurgeWindowSec < 1 || cfg.topGuardSurgeWindowSec > 3600) errs.push('TOP_GUARD_SURGE_WINDOW_SEC must be between 1 and 3600');
  if (cfg.topGuardHighMaxAgeSec < 0 || cfg.topGuardHighMaxAgeSec > 86400) errs.push('TOP_GUARD_HIGH_MAX_AGE_SEC must be between 0 and 86400');
  if (cfg.topGuardLookbackMin < 1 || cfg.topGuardLookbackMin > 90) errs.push('TOP_GUARD_LOOKBACK_MIN must be between 1 and 90 (the sample history keeps 90m)');
  if (cfg.ranRebuy < 0 || cfg.ranRebuy > 1) errs.push('RAN_REBUY must be 0 or 1');
  if (cfg.ranRebuyMult < 1 || cfg.ranRebuyMult > 1000) errs.push('RAN_REBUY_MULT must be between 1 and 1000');
  if (cfg.ranRebuyHours <= 0 || cfg.ranRebuyHours > 168) errs.push('RAN_REBUY_HOURS must be > 0 and <= 168');
  if (cfg.maxBuyRatioM5 < 0 || cfg.maxBuyRatioM5 > 1) errs.push('MAX_BUY_RATIO_M5 must be between 0 and 1 (0 = off)');
  if (cfg.churnMinDropPct < 0 || cfg.churnMinDropPct > 100) errs.push('CHURN_MIN_DROP_PCT must be between 0 and 100');
  if (cfg.churnLowBandPct < 0 || cfg.churnLowBandPct > 100) errs.push('CHURN_LOW_BAND_PCT must be between 0 and 100');
  if (cfg.churnStableMin < 0 || cfg.churnStableMin > 240) errs.push('CHURN_STABLE_MIN must be between 0 and 240');
  if (cfg.churnMinTxM5 < 0) errs.push('CHURN_MIN_TX_M5 must be >= 0');
  if (cfg.churnMinBuyShare < 0 || cfg.churnMinBuyShare > 1) errs.push('CHURN_MIN_BUY_SHARE must be between 0 and 1');
  if (cfg.churnMinAvgUsd < 0) errs.push('CHURN_MIN_AVG_USD must be >= 0');
  if (cfg.churnWatchH < 0 || cfg.churnWatchH > 72) errs.push('CHURN_WATCH_H must be between 0 and 72');
  if (cfg.churnWatchMax < 0 || cfg.churnWatchMax > 500) errs.push('CHURN_WATCH_MAX must be between 0 and 500');
  if (cfg.liftoffMinHistoryMin < 0 || cfg.liftoffMinHistoryMin > 90) errs.push('LIFTOFF_MIN_HISTORY_MIN must be between 0 and 90');
  if (cfg.liftoffLookbackMin < 0 || cfg.liftoffLookbackMin > 90) errs.push('LIFTOFF_LOOKBACK_MIN must be between 0 and 90');
  if (cfg.liftoffBaseRangePct < 0 || cfg.liftoffBaseRangePct > 100) errs.push('LIFTOFF_BASE_RANGE_PCT must be between 0 and 100');
  if (cfg.liftoffMinGainPct < 0 || cfg.liftoffMinGainPct > 1000) errs.push('LIFTOFF_MIN_GAIN_PCT must be between 0 and 1000');
  if (cfg.liftoffMaxGainPct < cfg.liftoffMinGainPct || cfg.liftoffMaxGainPct > 5000) errs.push('LIFTOFF_MAX_GAIN_PCT must be >= LIFTOFF_MIN_GAIN_PCT and <= 5000');
  if (cfg.liftoffClimbMin < 0 || cfg.liftoffClimbMin > 120) errs.push('LIFTOFF_CLIMB_MIN must be between 0 and 120');
  if (cfg.liftoffMinBuyShare < 0 || cfg.liftoffMinBuyShare > 1) errs.push('LIFTOFF_MIN_BUY_SHARE must be between 0 and 1');
  if (cfg.liftoffTxnBoost < 0) errs.push('LIFTOFF_TXN_BOOST must be >= 0');
  if (cfg.liftoffMinVolM5 < 0) errs.push('LIFTOFF_MIN_VOL_M5 must be >= 0');
  if (cfg.flowPollSec < 5 || cfg.flowPollSec > 600) errs.push('FLOW_POLL_SEC must be between 5 and 600');
  if (cfg.flowMinSol < 0) errs.push('FLOW_MIN_SOL must be >= 0');
  if (cfg.flowWalletsConfl < 1 || cfg.flowWalletsConfl > 20) errs.push('FLOW_WALLETS_CONFL must be between 1 and 20');
  if (cfg.flowWindowMin < 1 || cfg.flowWindowMin > 240) errs.push('FLOW_WINDOW_MIN must be between 1 and 240');
  if (cfg.devPollSec < 10 || cfg.devPollSec > 3600) errs.push('DEV_POLL_SEC must be between 10 and 3600');
  if (cfg.conflPollSec < 30 || cfg.conflPollSec > 3600) errs.push('CONFL_POLL_SEC must be between 30 and 3600');
  if (cfg.conflWindowMin < 1 || cfg.conflWindowMin > 60) errs.push('CONFL_WINDOW_MIN must be between 1 and 60');
  if (cfg.conflMinClusters < 2 || cfg.conflMinClusters > 10) errs.push('CONFL_MIN_CLUSTERS must be between 2 and 10');
  if (cfg.devQualN < 3 || cfg.devQualN > 100) errs.push('DEV_QUAL_N must be between 3 and 100');
  if (cfg.conflQualN < 5 || cfg.conflQualN > 500) errs.push('CONFL_QUAL_N must be between 5 and 500');
  if (cfg.gradPollSec < 30 || cfg.gradPollSec > 3600) errs.push('GRAD_POLL_SEC must be between 30 and 3600');
  if (cfg.gradFreshMin < 1 || cfg.gradFreshMin > 1440) errs.push('GRAD_FRESH_MIN must be between 1 and 1440');
  if (cfg.gradBackfillMax < 0) errs.push('GRAD_BACKFILL_MAX must be >= 0 (0 = backfill off)');
  if (cfg.creatorVolBypassUsd < 0) errs.push('CREATOR_VOL_BYPASS_USD must be >= 0 (0 = off)');
  if (cfg.streakPauseN < 0 || cfg.streakPauseN > 50) errs.push('STREAK_PAUSE_N must be between 0 and 50 (0 = off)');
  if (cfg.streakPauseMinMin < 0 || cfg.streakPauseMinMin > 1440) errs.push('STREAK_PAUSE_MIN_MIN must be between 0 and 1440');
  if (cfg.streakHeatPct <= 0 || cfg.streakHeatPct > 1) errs.push('STREAK_HEAT_PCT must be between 0 and 1');
  if (cfg.streakHeatSustainMin < 0 || cfg.streakHeatSustainMin > 240) errs.push('STREAK_HEAT_SUSTAIN_MIN must be between 0 and 240');
  if (cfg.streakHeatMinCoins < 0 || cfg.streakHeatMinCoins > 10000) errs.push('STREAK_HEAT_MIN_COINS must be between 0 and 10000');
  if (cfg.fastPopMaxBuyShare < 0 || cfg.fastPopMaxBuyShare > 1) errs.push('FAST_POP_MAX_BUY_SHARE must be between 0 and 1 (0 = off)');
  if (cfg.fastPopMinVolM5 < 0) errs.push('FAST_POP_MIN_VOL_M5 must be >= 0 (0 = off)');
  if (cfg.fastPopMinStreamVolSol < 0) errs.push('FAST_POP_MIN_STREAM_VOL_SOL must be >= 0 (0 = off)');
  if (cfg.dipStopPct < 0 || cfg.dipStopPct >= 1) errs.push('DIP_STOP_PCT must be between 0 and 1 (0 = off)');
  if (cfg.stallSec < 0) errs.push('STALL_SEC must be >= 0 (0 = off)');
  if (cfg.lockKeep < 0 || cfg.lockKeep >= 1) errs.push('PROFIT_LOCK_KEEP must be between 0 and 1 (0 = off)');
  if (cfg.tp1Frac < 0 || cfg.tp1Frac > 1) errs.push('TP1_FRAC must be between 0 and 1');
  if (cfg.tp1AdaptMax < cfg.tp1Pct || cfg.tp1AdaptMax > 3) errs.push('TP1_ADAPT_MAX_PCT must be >= TP1_PCT and <= 3');
  if (cfg.tp1Giveback < 0 || cfg.tp1Giveback > 0.5) errs.push('TP1_GIVEBACK_PCT must be between 0 and 0.5');
  if (cfg.tp1FlowMin < 0 || cfg.tp1FlowMin > 1) errs.push('TP1_FLOW_MIN_SHARE must be between 0 and 1');
  if (cfg.tp2Pct < 0 || cfg.tp2Pct > 5) errs.push('TP2_PCT must be between 0 and 5');
  if (cfg.tp2Frac < 0 || cfg.tp2Frac > 1) errs.push('TP2_FRAC must be between 0 and 1 (0 = off)');
  if (cfg.bagTrailPct < 0 || cfg.bagTrailPct >= 0.9) errs.push('BAG_TRAIL_PCT must be between 0 and 0.9');
  if (cfg.bagTrailConfirmSec < 0 || cfg.bagTrailConfirmSec > 3600) errs.push('BAG_TRAIL_CONFIRM_SEC must be between 0 and 3600');
  if (cfg.tpTrailPct < 0 || cfg.tpTrailPct >= 1) errs.push('TP_TRAIL_PCT must be between 0 and 1');
  if (cfg.tp2RejectZone < 0 || cfg.tp2RejectZone > 5) errs.push('TP2_REJECT_ZONE must be between 0 and 5');
  if (cfg.tp2RejectDrop < 0 || cfg.tp2RejectDrop >= 0.9) errs.push('TP2_REJECT_DROP must be between 0 and 0.9');
  if (cfg.modestMinPct < 0 || cfg.modestMinPct >= 1) errs.push('MODEST_MIN_PCT must be between 0 and 1');
  if (cfg.modestMaxPct < cfg.modestMinPct || cfg.modestMaxPct >= 2) errs.push('MODEST_MAX_PCT must be >= MODEST_MIN_PCT and below 2');
  if (cfg.modestTargetPct < 0 || cfg.modestTargetPct > 5) errs.push('MODEST_TARGET_PCT must be between 0 and 5 (0 = off)');
  if (cfg.modestSplitBankFrac <= 0 || cfg.modestSplitBankFrac >= 1) errs.push('MODEST_SPLIT_BANK_FRAC must be between 0 and 1 (exclusive)');
  if (cfg.killZoneFloorPct < 0 || cfg.killZoneFloorPct >= 1) errs.push('KILL_ZONE_FLOOR_PCT must be 0 (off) or between 0 and 1');
  if (cfg.killZoneArmMult < 1 || cfg.killZoneArmMult > 10) errs.push('KILL_ZONE_ARM_MULT must be between 1 and 10');
  if (cfg.deadflowArmPct < 0 || cfg.deadflowArmPct >= 1) errs.push('DEADFLOW_ARM_PCT must be between 0 and 1');
  if (cfg.deadflowWindowSec < 0 || cfg.deadflowWindowSec > 600) errs.push('DEADFLOW_WINDOW_SEC must be between 0 (off) and 600');
  if (cfg.deadflowMaxBuyDelta < 0 || cfg.deadflowMaxBuyDelta > 1000) errs.push('DEADFLOW_MAX_BUY_DELTA must be between 0 and 1000');
  if (cfg.deadflowPeakGapPct < 0 || cfg.deadflowPeakGapPct > 0.5) errs.push('DEADFLOW_PEAK_GAP_PCT must be between 0 and 0.5');
  if (cfg.bagDeadStaged < 0 || cfg.bagDeadStaged > 1) errs.push('BAG_DEAD_STAGED must be 0 or 1');
  if (cfg.bagFloorPct < 0 || cfg.bagFloorPct >= 1) errs.push('BAG_FLOOR_PCT must be between 0 and 1');
  if (cfg.bagSmallHold < 0 || cfg.bagSmallHold > 1) errs.push('BAG_SMALL_HOLD must be 0 or 1');
  if (cfg.bagFloorConfirmSec < 0 || cfg.bagFloorConfirmSec > 3600) errs.push('BAG_FLOOR_CONFIRM_SEC must be between 0 and 3600');
  if (cfg.bagTrimMult < 0 || cfg.bagTrimMult > 100) errs.push('BAG_TRIM_MULT must be between 0 (off) and 100');
  if (cfg.stallBandPct < -0.5 || cfg.stallBandPct > 1) errs.push('STALL_BAND_PCT must be between -0.5 and 1 (breakout bar above entry for the entry stall)');
  if (cfg.stallBandUpPct < 0 || cfg.stallBandUpPct > 1) errs.push('STALL_BAND_UP_PCT must be between 0 and 1 (upside edge of the entry-stall dead zone)');
  if (cfg.stallProbationSec < 0) errs.push('STALL_PROBATION_SEC must be >= 0 (0 = probation off, sell at the stall deadline)');
  if (cfg.stallLeashPct < 0 || cfg.stallLeashPct > 0.9) errs.push('STALL_LEASH_PCT must be between 0 and 0.9 (0 = no leash, probation expiry only)');
  if (cfg.beArmPct < 0 || cfg.beArmPct >= 1) errs.push('BE_ARM_PCT must be 0 (off) or between 0 and 1');
  if (cfg.beTriggerPct < 0 || cfg.beTriggerPct >= 1) errs.push('BE_TRIGGER_PCT must be between 0 and 1');
  if (cfg.beArmPct > 0 && cfg.beTriggerPct >= cfg.beArmPct) errs.push('BE_TRIGGER_PCT must be below BE_ARM_PCT when the break-even ratchet is on');
  if (cfg.ratchetShadow < 0 || cfg.ratchetShadow > 1) errs.push('RATCHET_SHADOW must be 0 or 1');
  if (cfg.tickJournal < 0 || cfg.tickJournal > 1) errs.push('TICK_JOURNAL must be 0 or 1');
  if (cfg.shadowSeller < 0 || cfg.shadowSeller > 1) errs.push('SHADOW_SELLER must be 0 or 1');
  if (cfg.shadowSellerMinN < 1) errs.push('SHADOW_SELLER_MIN_N must be >= 1');
  if (cfg.shadowSellerPriorK < 0) errs.push('SHADOW_SELLER_PRIOR_K must be >= 0');
  if (cfg.shadowSellerRefitMin < 1) errs.push('SHADOW_SELLER_REFIT_MIN must be >= 1');
  if (cfg.staircaseSignal < 0 || cfg.staircaseSignal > 1) errs.push('STAIRCASE_SIGNAL must be 0 or 1');
  if (cfg.neverGreenShadow < 0 || cfg.neverGreenShadow > 1) errs.push('NEVERGREEN_SHADOW must be 0 or 1');
  if (cfg.ngCutArmSec < 0 || cfg.ngCutArmSec > 3600) errs.push('NG_CUT_ARM_SEC must be between 0 and 3600');
  if (cfg.ngCutPeakMax < 1 || cfg.ngCutPeakMax > 3) errs.push('NG_CUT_PEAK_MAX must be between 1 and 3');
  if (cfg.ngCutRatio <= 0 || cfg.ngCutRatio >= 1) errs.push('NG_CUT_RATIO must be between 0 and 1 (exclusive)');
  if (cfg.ngCutConfirmChecks < 1 || cfg.ngCutConfirmChecks > 20) errs.push('NG_CUT_CONFIRM_CHECKS must be between 1 and 20');
  if (cfg.bottomWatch < 0 || cfg.bottomWatch > 1) errs.push('BOTTOM_WATCH must be 0 or 1');
  if (cfg.bottomDropPct <= 0 || cfg.bottomDropPct >= 100) errs.push('BOTTOM_DROP_PCT must be between 0 and 100 (percent)');
  if (cfg.bottomQuietMin < 0 || cfg.bottomQuietMin > 120) errs.push('BOTTOM_QUIET_MIN must be 0..120');
  if (cfg.bottomMovePct <= 0 || cfg.bottomMovePct > 500) errs.push('BOTTOM_MOVE_PCT must be between 0 and 500 (percent)');
  if (cfg.bottomExpireMin < 10) errs.push('BOTTOM_EXPIRE_MIN must be >= 10');
  if (!(cfg.bottomMinPeakMc > 0)) errs.push('BOTTOM_MIN_PEAK_MC must be > 0 (USD)');
  if (cfg.rangeWatch < 0 || cfg.rangeWatch > 1) errs.push('RANGE_WATCH must be 0 or 1');
  if (cfg.rangeWindowMin < 3 || cfg.rangeWindowMin > 240) errs.push('RANGE_WINDOW_MIN must be 3..240');
  if (cfg.rangeMaxBandPct <= 0 || cfg.rangeMaxBandPct > 200) errs.push('RANGE_MAX_BAND_PCT must be between 0 and 200 (percent)');
  if (cfg.rangeMaxMinMovePct <= 0 || cfg.rangeMaxMinMovePct > 100) errs.push('RANGE_MAX_MIN_MOVE_PCT must be between 0 and 100 (percent)');
  if (!(cfg.rangeMinMc > 0)) errs.push('RANGE_MIN_MC must be > 0 (USD)');
  if (cfg.rangeLive < 0 || cfg.rangeLive > 1) errs.push('RANGE_LIVE must be 0 or 1');
  if (cfg.bottomLive < 0 || cfg.bottomLive > 1) errs.push('BOTTOM_LIVE must be 0 or 1');
  if (cfg.baseMode < 0 || cfg.baseMode > 1) errs.push('BASE_MODE must be 0 or 1');
  if (!(cfg.flowConfirmWindowH > 0) || cfg.flowConfirmWindowH > 72) errs.push('FLOW_CONFIRM_WINDOW_H must be > 0 and <= 72');
  if (!(cfg.flowConfirmMinMc >= 0)) errs.push('FLOW_CONFIRM_MIN_MC must be >= 0');
  if (!(cfg.flowConfirmSol > 0) || cfg.flowConfirmSol > 1) errs.push('FLOW_CONFIRM_SOL must be > 0 and <= 1');
  if (!(cfg.flowConfirmReentryMin >= 0)) errs.push('FLOW_CONFIRM_REENTRY_MIN must be >= 0');
  if (!(cfg.flowConfirmMaxEntries >= 1)) errs.push('FLOW_CONFIRM_MAX_ENTRIES must be >= 1');
  if (!(cfg.flowConfirmKillN >= 1)) errs.push('FLOW_CONFIRM_KILL_N must be >= 1');
  if (!(cfg.baseMinVolM5 >= 0)) errs.push('BASE_MIN_VOL_M5 must be >= 0 (USD)');
  if (!(cfg.enrollTtlH > 0) || cfg.enrollTtlH > 720) errs.push('ENROLL_TTL_H must be between 0 and 720 (hours)');
  if (cfg.confluenceSignal < 0 || cfg.confluenceSignal > 1) errs.push('CONFLUENCE_SIGNAL must be 0 or 1');
  if (cfg.confluenceScalpPct <= 0 || cfg.confluenceScalpPct > 2) errs.push('CONFLUENCE_SCALP_PCT must be between 0 and 2');
  if (cfg.staircaseLive < 0 || cfg.staircaseLive > 1) errs.push('STAIRCASE_LIVE must be 0 or 1');
  if (cfg.ratchetFlowWindowSec < 1 || cfg.ratchetFlowWindowSec > 120) errs.push('RATCHET_FLOW_WINDOW_SEC must be 1..120');
  if (cfg.ratchetFlowSellShare < 0 || cfg.ratchetFlowSellShare > 1) errs.push('RATCHET_FLOW_SELL_SHARE must be between 0 and 1');
  if (cfg.ratchetFlowMinSellSol < 0) errs.push('RATCHET_FLOW_MIN_SELL_SOL must be >= 0');
  if (cfg.ratchetStreamEvalMs < 50 || cfg.ratchetStreamEvalMs > 5000) errs.push('RATCHET_STREAM_EVAL_MS must be 50..5000');
  if (cfg.ratchetStreamVwapSec < 1 || cfg.ratchetStreamVwapSec > 30) errs.push('RATCHET_STREAM_VWAP_SEC must be 1..30');
  if (cfg.calloutsEnabled < 0 || cfg.calloutsEnabled > 1) errs.push('CALLOUTS_ENABLED must be 0 or 1');
  if (cfg.bleedPct < 0 || cfg.bleedPct >= 1) errs.push('BLEED_PCT must be 0 (off) or between 0 and 1');
  if (cfg.bleedMinAgeSec < 0) errs.push('BLEED_MIN_AGE_SEC must be >= 0');
  if (cfg.bleedLookbackSec < 0) errs.push('BLEED_LOOKBACK_SEC must be >= 0');
  if (cfg.exitConfirmSec < 0) errs.push('EXIT_CONFIRM_SEC must be >= 0 (0 = fail-safe exits sell instantly, as before the layer)');
  if (cfg.realMode && cfg.rpcUrls.length === 0) errs.push('RPC_URLS required in real mode');
  return errs;
}
