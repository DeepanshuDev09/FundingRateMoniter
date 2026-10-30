# Funding Spread Monitor (Vercel edition)

Next.js 15 + Neon Postgres + Vercel Functions. Monitors funding rates of the same perpetual on
**Binance USDT-M** and **Delta Exchange India**, plus a separate **Binance USDT-M ↔ Bybit linear USDT** monitor, and computes the hedged return
(short the exchange that pays less, long the other).

## How it works

- Visitors see data saved in Postgres only. They never trigger any exchange calls.
- You open `/admin`, enter `ADMIN_PASSWORD`, and click **Sync all pairs**. The page then:
  1. creates tables if needed, rebuilds the common-pair list (also downloadable at `/api/common-pairs`) and saves live rates;
  2. downloads funding history for 10 pairs per batch (30 days the first time, only new records afterwards) and saves it;
  3. waits (default 60 s) and repeats until every pair is done.
- Keep the admin tab open while it runs. If you close it, the pairs already saved stay saved; click again to continue.
- No cron jobs, so it works on the free Vercel Hobby plan.

## Deploy

1. Push this folder to GitHub and import it in Vercel.
2. Add **Neon Postgres** from the Vercel Marketplace (sets `DATABASE_URL`).
3. Add `ADMIN_PASSWORD` (and the other variables in `.env.example`), then deploy.
4. Open `/admin`, sign in, click **Sync all pairs**.
5. Verify Delta units (see below):
   `curl -H "x-admin-password: YOUR_PASSWORD" "https://YOUR-APP.vercel.app/api/debug/delta?symbol=BTCUSD"`

## Region

`vercel.json` pins functions to `bom1` (Mumbai). Binance blocks some regions (US IPs commonly get HTTP 451), and Vercel's default region is in the US. If you see 451/403 errors, try `sin1` or another region.

## Check these before trusting the numbers

- **Delta funding history** is read from the candle endpoint (`FUNDING:<symbol>`, 1h candles) and sampled at settlement hours.
  Confirm with `/api/debug/delta` that (a) `funding_rate` / candle `close` is in percent (code divides by 100) and
  (b) the funding interval and settlement hour match `DELTA_FUNDING_INTERVAL_HOURS` / `DELTA_FUNDING_HOUR_OFFSET`.
  If either assumption is wrong, 30d returns will be off by a constant factor.
- **Contract mismatch:** Binance is USDT-margined, Delta India perps are USD-quoted. Check contract sizes for any pair you actually trade.
- **Bybit mapping:** only actively trading linear USDT perpetuals are included. Its instrument endpoint supplies each contract's funding interval; the history endpoint is paged backward in 200-record batches.
- **Fees:** set `TAKER_FEE_*` to your real tier (Delta India may add GST).
- Returns are quoted on one leg's notional, before slippage, basis moves and borrowing/margin costs.

## Included

Common-pair mapping, 30-day history then incremental sync, table with both hedge directions, gross/net, 7d/30d/3d trend,
consistency, std, sign flips, basis, volume, freshness dots, per-pair chart, backtest and liquidation calculators,
browser-side watchlist, CSV export, dark mode. Not included: user accounts, per-user alerts, paper trading, execution.
