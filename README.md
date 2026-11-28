# Funding Spread Monitor (Vercel edition)

Next.js 15 + Neon Postgres + Vercel Functions. Monitors funding rates of the same perpetual on
**Binance USDT-M** and **Delta Exchange India**, plus separate **Binance USDT-M ↔ Bybit linear USDT** and **Bybit linear USDT ↔ Delta Exchange India** monitors, and computes the hedged return
(short the exchange that pays less, long the other).

## How it works

- Visitors see data saved in Postgres only. They never trigger any exchange calls.
- You open `/admin`, enter `ADMIN_PASSWORD`, and choose **Sync Binance - Delta**, **Sync Binance - Bybit**, or **Sync Bybit - Delta**. Each scan:
  1. creates tables if needed, rebuilds the common-pair list (also downloadable at `/api/common-pairs`) and saves live rates;
  2. downloads funding history for 10 pairs per batch (a full year on the first scan for that market, then only new records) and saves it;
  3. waits (default 60 s) and repeats until every pair is done.
- Keep the admin tab open while it runs. If you close it, the pairs already saved stay saved; click again to continue.
- No cron jobs, so it works on the free Vercel Hobby plan.

## Deploy

1. Push this folder to GitHub and import it in Vercel.
2. Add **Neon Postgres** and choose an India/Mumbai region if Neon offers one for your project. Confirm the database's region in Neon; adding it through Vercel does not automatically place it in India.
3. Add `ADMIN_PASSWORD` (and the other variables in `.env.example`), then deploy.
4. Open `/admin`, sign in, and run the sync button for each market you want to update. Bybit - Delta has its own history sync and progress cursor.
5. Verify Delta units (see below):
   `curl -H "x-admin-password: YOUR_PASSWORD" "https://YOUR-APP.vercel.app/api/debug/delta?symbol=BTCUSD"`

## Region

`vercel.json` pins all Vercel Functions, including API routes, to `bom1` (Mumbai), so their outbound exchange API requests originate from that region. This does not move the Neon database or the exchange providers' own servers; those locations are controlled separately by their providers. Binance or Bybit may block requests from some regions (US IPs commonly get HTTP 451); changing the Vercel region to troubleshoot a block also changes where the functions run.

## Check these before trusting the numbers

- **Delta funding history** is read from the candle endpoint (`FUNDING:<symbol>`, 1h candles) and sampled at settlement hours.
  Confirm with `/api/debug/delta` that (a) `funding_rate` / candle `close` is a decimal rate (code stores it unchanged, not divided by 100) and
  (b) the funding interval and settlement hour match `DELTA_FUNDING_INTERVAL_HOURS` / `DELTA_FUNDING_HOUR_OFFSET`.
  If either assumption is wrong, 30d returns will be off by a constant factor.
- **Contract mismatch:** Binance is USDT-margined, Delta India perps are USD-quoted. Check contract sizes for any pair you actually trade.
- **Bybit mapping:** only actively trading linear USDT perpetuals are included. Its instrument endpoint supplies each contract's funding interval; the history endpoint is paged backward in 200-record batches.
- **Fees:** set `TAKER_FEE_*` to your real tier (Delta India may add GST).
- Returns are quoted on one leg's notional, before slippage, basis moves and borrowing/margin costs.

## Included

Common-pair mapping, one-year history then incremental sync, table with both hedge directions, 1d/7d/30d/90d and one-year returns, 3d trend,
consistency, std, sign flips, basis, volume, freshness dots, per-pair chart and month-selectable daily funding table, backtest and liquidation calculators,
browser-side watchlist, CSV export, dark mode. Not included: user accounts, per-user alerts, paper trading, execution.

## Bybit troubleshooting

- Open `/api/debug/bybit` (header `x-admin-password`) to see which Bybit host answers from your Vercel region. The app tries `api.bybit.com`, then `api.bytick.com`; set `BYBIT_BASE` to force another host.
- If both fail with 403, change the region in `vercel.json` (try `sin1`) and redeploy. A Bybit failure no longer stops the sync: Binance/Delta data is still saved and the Admin log shows a `warning` line.
- Older databases are upgraded automatically on first read, so a stale schema no longer breaks `/api/pairs` or `/api/recommend`.


## Dynamic flip returns

The normal return columns hold one fixed direction (picked from the last 30 days, which is hindsight). The **Flip** columns replay every funding payment and change sides automatically:

- It starts as **Short Binance / Long peer** (`FLIP_START=B` for the opposite).
- The net of the current direction is added up in blocks of `FLIP_BLOCK_HOURS` (default 8). A block that nets negative extends a **losing streak**; a block that nets zero or positive resets it.
- When the streak reaches `-FLIP_THRESHOLD` (default `0.0025` = 0.25% of notional), long and short swap and the streak restarts at 0. Earlier profits do not count.
- Net figures charge one round-trip fee (four fills) for entry and exit plus one per flip.
- Stored during each sync in `pair_stats` / `bybit_pair_stats` (`dyn_*` columns, added automatically). The pair page recomputes it live and shows the flip log and a second cumulative line.

Limits: flips are assumed instant with no slippage; only the period where both exchanges have history is used; it needs enough funding history per pair; Delta history is sampled by `DELTA_FUNDING_INTERVAL_HOURS` (see the note on 4-hour payments below).


## Dynamic-side recommendation

`lib/recommendDynamic.ts` runs inside the matching market analysis button in Admin. Binance - Delta, Binance - Bybit, and Bybit - Delta each have separate recommendation data and results on `/recommend`. For each pair it replays the real flip rule on the real payments and decides **Use dynamic side**, **Use fixed side** (one direction nearly always wins) or **Avoid dynamic**.

- Test windows: 120 days, a new one every 10 days; each starts on the side the previous 30 days favoured (no hindsight). Gross is shrunk by 20% and each entry/exit/flip pays fees plus slippage.
- A pair passes only if it has at least 3 regime changes in 180 days, regimes last about 4 days or more, no more than 60% of the gain over a fixed side comes from 3 months, break-even per flip is at least 3x the real flip cost, at least 75% of 12 threshold/block settings stay profitable, at least 70% of windows are profitable, and it beats a fixed side. There is no volume filter: thin pairs are flagged ("Very thin liquidity") and their higher slippage is included in the cost, but they are not excluded.
- Results are stored in `pair_dyn_features` and `bybit_pair_dyn_features` (created automatically) and shown on the Recommend page. Optional env: `DYN_MAX_LEVERAGE` (default 3).
## Data repair: Delta funding units and 4-hour payments

- Delta reports funding in **percent** (0.01 = 0.01%, its base interest rate). Binance and Bybit report decimals (0.0001 = 0.01%). All stored rates are decimals, so Delta values are now divided by 100 when they are read (`DELTA_RATE_IN_PERCENT=false` turns this off).
- Delta funding history is now one record per real payment. The block length (8h, or 4h on contracts such as NOT and NEIRO since late 2025) is read from the data itself instead of one global `DELTA_FUNDING_INTERVAL_HOURS`; that variable is only the starting assumption. The live "Delta interval" column uses the detected value.
- On the first start of this version a one-time repair deletes the stored Delta history and everything computed from it, then the next Admin sync downloads it again. **After deploying, run the Admin sync for all markets, then the recommendation analysis.**


## Why funding differs between exchanges (price-gap diagnostics)

Each live refresh now also stores each exchange's index price and funding caps (Binance `fundingInfo`, Bybit `instruments-info`), and one **price-gap** point per coin per hour (kept 120 days) in `price_gap_history`.
The pair page has a new box, "Why the two exchanges pay different funding", showing for each exchange: funding per payment, interval, its premium against its own index, the premium that funding *implies* (Delta's documented formula inverted), its funding cap, and a check that says whether the funding is explained by a real price gap, is at a cap, or does not match. The main tables have a one-word version of that check.
Notes: Delta's index price is read from the ticker field `spot_price` (shown as "No data" if absent); set `DELTA_FUNDING_CAP` (a decimal per interval, e.g. 0.01) to get a Delta cap flag. The implied premium assumes the 8-hour formula, so treat it as a rough check. Bybit's new N/8 formula rolls out on Nov 24, Nov 26 and Dec 1, 2026 for contracts under 8h.