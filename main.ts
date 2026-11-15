// crisp-owl-96 — dip ladder bot for CBBTC/USDC, 1-minute bars.
//
// Idea in plain words: keep a short simple moving average as a fair-value
// anchor. When price slips meaningfully under that anchor we do not go
// all-in at once; we buy a first slice, and only add another slice if the
// dip deepens by a further step from the previous slice's price.
// The position is closed as a whole once price recovers back above the
// anchor (or a small profit over average cost is reached), and a hard
// emergency stop cuts the whole position if it sinks too far under cost.
//
// Tuning note (v2, after the first local grade lost money): the original
// 30-bar anchor with a -0.6% first dip bought far too often into a tape
// that kept sliding, and the -3.5% stop let those losers run. The anchor
// is now faster (15 bars), the first dip must be a full -1.0% before any
// money moves, and the emergency stop is tighter at -1.5% under cost.
// The ladder shape itself (25% slices, max 3, +0.6% add-on steps,
// recovery / take-profit exits) is unchanged.

import { runBars } from './vendor/makefun-bars.ts';

const TICKER = 'CBBTC';

// --- ladder tuning -------------------------------------------------------
const ANCHOR_LEN = 15; // bars in the simple moving average
const FIRST_DIP = 0.01; // first entry: close <= anchor * (1 - 1.0%)
const NEXT_DIP = 0.006; // each extra slice needs another -0.6% step
const MAX_SLICES = 3; // never stack more than three slices
const SLICE_PCT = 25n; // one slice = 25% of the remaining weight room
const RECOVER = 0.004; // exit when close >= anchor * (1 + 0.4%)
// Profit / stop thresholds are kept as integer ratios so the comparison
// on raw quote units stays exact (no float rounding on money).
const PROFIT_NUM = 1012n; // value >= 101.2% of cost  -> take profit
const PROFIT_DEN = 1000n;
const STOP_NUM = 985n; // value <= 98.5% of cost     -> emergency stop
const STOP_DEN = 1000n;
const SLIP_BPS = 100;
const MIN_BUY = 1_000_000n; // harness minimum notional: 1 USDC

// --- rolling state -------------------------------------------------------
// Ring buffer would do, but 1,440 bars is tiny: a plain array plus a
// running sum gives an exact, deterministic SMA with O(1) updates.
const pastCloses: number[] = [];
let rollingSum = 0;

let slicesOpen = 0; // how many ladder slices we believe are filled/open
let lastSlicePrice = 0; // decision close of the most recent slice

function anchorAverage(): number | null {
  if (pastCloses.length < ANCHOR_LEN) return null;
  return rollingSum / ANCHOR_LEN;
}

function noteClose(px: number): void {
  pastCloses.push(px);
  rollingSum += px;
  if (pastCloses.length > ANCHOR_LEN) {
    rollingSum -= pastCloses[pastCloses.length - ANCHOR_LEN - 1]!;
  }
}

await runBars({
  onBatch(state, batch) {
    // Locate this bar's CBBTC close and turn the scaled integer into a
    // plain float price for the indicator maths.
    const bar = batch.bars.find((b) => b.symbol === TICKER);
    const rawClose = state.close(TICKER);
    if (bar === undefined || rawClose === null) return [];
    const info = state.symbols.get(TICKER);
    if (info === undefined) return [];
    const px = Number(rawClose) / 10 ** info.price_scale;
    if (!(px > 0)) return [];
    noteClose(px);

    // Warm-up bars only feed the history; trading on them is rejected.
    if (state.warmingUp) return [];

    const held = state.positions.get(TICKER);
    const heldQty = held?.qty ?? 0n;
    const heldCost = held?.cost ?? 0n;

    // Flat bookkeeping: a flat account at decision time means any earlier
    // slice was either sold or rejected, so the ladder starts over.
    if (heldQty === 0n) {
      slicesOpen = 0;
      lastSlicePrice = 0;
    } else if (slicesOpen === 0) {
      // Defensive resync: a position exists but our counter was reset.
      slicesOpen = 1;
      lastSlicePrice = px;
    }

    const anchor = anchorAverage();
    if (anchor === null) return [];

    // ---- exit side: checked first, every bar, whole position only ----
    if (heldQty > 0n && heldCost > 0n) {
      const worth = state.value(TICKER, heldQty);
      const recovered = px >= anchor * (1 + RECOVER);
      const inProfit = worth * PROFIT_DEN >= heldCost * PROFIT_NUM;
      const inDanger = worth * STOP_DEN <= heldCost * STOP_NUM;
      if (recovered || inProfit || inDanger) {
        return [
          {
            side: 'sell' as const,
            symbol: TICKER,
            qty: heldQty,
            max_slippage_bps: SLIP_BPS,
          },
        ];
      }
    }

    // ---- entry side: the ladder ---------------------------------------
    if (heldQty === 0n) {
      // First rung: price must sit at least FIRST_DIP under the anchor.
      if (px > anchor * (1 - FIRST_DIP)) return [];
    } else {
      // Later rungs: need room in the ladder and a fresh dip step taken
      // from the price where the previous slice was decided.
      if (slicesOpen >= MAX_SLICES) return [];
      if (lastSlicePrice <= 0) return [];
      if (px > lastSlicePrice * (1 - NEXT_DIP)) return [];
    }

    const room = state.weightRoom(TICKER);
    let spend = (room * SLICE_PCT) / 100n;
    if (spend > state.cash) spend = state.cash;
    if (spend < MIN_BUY) return [];

    slicesOpen += 1;
    lastSlicePrice = px;
    return [
      {
        side: 'buy' as const,
        symbol: TICKER,
        notional_quote_units: spend,
        max_slippage_bps: SLIP_BPS,
      },
    ];
  },
});
