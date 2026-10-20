// PRE-ENTRY CENSUS (owner order 2026-10-18, "it should work both ways"):
// before a QUALIFIED bottom mark routes a live buy, the mint gets a short
// wallet-census watch (PREENTRY_WINDOW_SEC). The census that used to only
// witness positions now also guards the door it was built beside — but only
// against CLEAR puppet tapes. Three signatures veto, any suffices:
//
//   absorption   — buy COUNTS dominate the window (buys >= sells) while the
//                  price falls >= PREENTRY_ABSORB_DROP_PCT from the watch
//                  start. Real demand lifts price; absorbed demand is a
//                  volume bot holding a bid it dumps into (OPEQ, 2026-10-18:
//                  45 buys vs 16 sells while price fell -18% in 90 seconds).
//   manufactured — heavy trade count from almost no wallets
//                  (uniqBuyers <= PREENTRY_MAX_UNIQ over >=
//                  PREENTRY_NARROW_MIN_TRADES trades) with a high wash
//                  share (the same wallets on both sides).
//   one-sided    — the mirror image the first two cannot see (owner order
//                  2026-10-19, the Rockstar tape): a one-way exit stampede —
//                  sells >= PREENTRY_ONESIDED_RATIO x buys — or a tape
//                  whose entire buy side is a single wallet
//                  (uniqBuyers <= PREENTRY_ONESIDED_MAX_UNIQ). Rockstar's
//                  census read 1 buy / 899 sells / 1 unique buyer and came
//                  back "clean" because both older signatures only cover
//                  buyer-side fakery; a bottom entry into a one-sided
//                  tape is buying the exit liquidity.
//
// Everything else passes, and thin data passes by design (fail-open): the
// veto exists for unmistakable cases only. The pure evaluator lives here;
// the Bot owns the watch lifecycle (feed subscription, price sampling,
// finalize -> skip-journal on veto / onSignal on pass).

/**
 * Judge one completed pre-entry watch.
 *   win: censusWindow() summary over the watch window
 *        ({ buys, sells, uniqBuyers, uniqSellers, newBuyers, wash, tradesTotal })
 *   startPrice / minPrice / endPrice: view prices sampled across the watch
 *   cfg: the preEntry* knobs
 * Returns { veto, why, read } — `read` is the compact stamp that rides the
 * signal either way; `why` names the outcome ('absorption' /
 * 'manufactured' / 'one-sided' / 'thin' / 'clean').
 */
export function evaluatePreEntry({ win, startPrice, minPrice, endPrice, cfg }) {
  const trades = win ? (win.tradesTotal ?? (win.buys + win.sells)) : 0;
  const buys = win ? win.buys : 0;
  const sells = win ? win.sells : 0;
  const uniqBuyers = win ? win.uniqBuyers : 0;
  const newBuyers = win ? win.newBuyers : 0;
  const wash = win ? win.wash : 0;
  const washShare = uniqBuyers > 0 ? wash / uniqBuyers : 0;
  const dropPct = startPrice > 0 && minPrice != null ? (1 - minPrice / startPrice) * 100 : 0;
  const endDropPct = startPrice > 0 && endPrice != null ? (1 - endPrice / startPrice) * 100 : 0;
  const read = {
    trades, buys, sells, uniqBuyers, newBuyers, wash,
    washShare: +washShare.toFixed(2),
    sellBuyRatio: buys > 0 ? +(sells / buys).toFixed(2) : null,
    dropPct: +dropPct.toFixed(1), endDropPct: +endDropPct.toFixed(1),
  };
  if (!win || trades < cfg.preEntryMinTrades) return { veto: false, why: 'thin', read };
  if (dropPct >= cfg.preEntryAbsorbDropPct && buys >= sells) return { veto: true, why: 'absorption', read };
  if (uniqBuyers <= cfg.preEntryMaxUniqBuyers && trades >= cfg.preEntryNarrowMinTrades && washShare >= cfg.preEntryWashShare) {
    return { veto: true, why: 'manufactured', read };
  }
  if (sells >= (cfg.preEntryOneSidedRatio ?? 10) * buys || uniqBuyers <= (cfg.preEntryOneSidedMaxUniq ?? 1)) {
    return { veto: true, why: 'one-sided', read };
  }
  return { veto: false, why: 'clean', read };
}

/** The reason string a pre-entry veto carries on its skipped signal. */
export function preEntryReason({ why, read }) {
  if (why === 'absorption') {
    return `preentry-veto: absorption — ${read.buys} buys vs ${read.sells} sells while price fell ${read.dropPct}% in the pre-entry watch (bot-driven tape)`;
  }
  if (why === 'one-sided') {
    return `preentry-veto: one-sided — ${read.sells} sells vs ${read.buys} buys, ${read.uniqBuyers} unique buyers in the pre-entry watch (one-sided tape)`;
  }
  return `preentry-veto: manufactured — ${read.trades} trades from ${read.uniqBuyers} unique buyers, wash share ${read.washShare} (bot-driven tape)`;
}
