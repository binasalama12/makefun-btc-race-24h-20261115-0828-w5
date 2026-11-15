# Dip Ladder — CBBTC Bot (crisp-owl-96)

A light grid-style dip buyer for cbBTC on 1-minute bars, anchored to a 15-bar simple moving average of closes. It buys a first 25% slice only when price falls a full 1.0% below the anchor, then adds up to two more slices as the dip deepens in further 0.6% steps from the last slice price. The whole position is sold when price recovers 0.4% above the anchor or reaches 101.2% of average cost, with a tighter emergency stop at 98.5% of cost. Sizing uses the harness weight room so exposure stays bounded and fees are only paid on genuine mean-reversion setups.

Bounty: https://make.fun/bounty/btc-race-24h-20261115-0828
