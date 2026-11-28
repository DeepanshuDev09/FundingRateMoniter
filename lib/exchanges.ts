import type { Ev } from "./calc";

const BIN = "https://fapi.binance.com";
// Bybit has several equivalent API hosts; some regions block one but not the other, so we try them in order.
const BYBIT_HOSTS = [process.env.BYBIT_BASE, "https://api.bybit.com", "https://api.bytick.com"].filter(Boolean) as string[];
const DELTA = "https://api.india.delta.exchange";
// Funding schedule used until the data proves a shorter one (see deltaPayments). Delta only ever shortens intervals.
const DELTA_INTERVAL = Number(process.env.DELTA_FUNDING_INTERVAL_HOURS ?? 8);
// Delta reports funding in PERCENT (0.01 means 0.01%: the documented base interest rate), while Binance and Bybit report decimals
// (0.0001 means 0.01%). Everything stored in the database is a decimal, so Delta values are divided by 100 here.
const DELTA_IN_PERCENT = process.env.DELTA_RATE_IN_PERCENT !== "false";
const dRate = (v: number) => (DELTA_IN_PERCENT ? v / 100 : v);

async function get(url: string): Promise<any> {
  const r = await fetch(url, { cache: "no-store", headers: { "User-Agent": "funding-monitor/0.1", Accept: "application/json" } });
  if (!r.ok) throw new Error(`${url} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

/** "1000PEPE" -> { base: "PEPE", mult: 1000 } so Binance and Delta names line up. */
export function normBase(raw: string) {
  const m = /^(1000000|10000|1000)(.+)$/.exec(raw);
  return m ? { base: m[2], mult: Number(m[1]) } : { base: raw, mult: 1 };
}

// ---------- Binance USDT-M ----------
export async function binanceSymbols() {
  const d = await get(`${BIN}/fapi/v1/exchangeInfo`);
  return d.symbols
    .filter((s: any) => s.contractType === "PERPETUAL" && s.quoteAsset === "USDT" && s.status === "TRADING")
    .map((s: any) => ({ symbol: s.symbol as string, base: s.baseAsset as string }));
}

export async function binanceLive() {
  const [pi, tk, fi] = await Promise.all([
    get(`${BIN}/fapi/v1/premiumIndex`),
    get(`${BIN}/fapi/v1/ticker/24hr`),
    get(`${BIN}/fapi/v1/fundingInfo`).catch(() => []),
  ]);
  const vol = new Map<string, number>(tk.map((t: any) => [t.symbol, Number(t.quoteVolume)]));
  const iv = new Map<string, number>(fi.map((f: any) => [f.symbol, Number(f.fundingIntervalHours)]));
  const caps = new Map<string, { cap: number; floor: number }>(fi.map((f: any) => [f.symbol, { cap: Number(f.adjustedFundingRateCap), floor: Number(f.adjustedFundingRateFloor) }]));
  const out = new Map<string, { rate: number; mark: number; index: number; cap?: number; floor?: number; vol: number; interval: number }>();
  for (const p of pi) {
    out.set(p.symbol, {
      index: Number(p.indexPrice), cap: caps.get(p.symbol)?.cap, floor: caps.get(p.symbol)?.floor,
      rate: Number(p.lastFundingRate), mark: Number(p.markPrice),
      vol: vol.get(p.symbol) ?? 0, interval: iv.get(p.symbol) ?? 8,
    });
  }
  return out;
}

export async function binanceHistory(symbol: string, startMs: number, interval: number): Promise<(Ev & { interval: number })[]> {
  const out: (Ev & { interval: number })[] = [];
  let cur = startMs;
  for (let page = 0; page < 12; page++) { // 1000 records per page; 1h-interval symbols need about 9 pages for 365 days
    const d = await get(`${BIN}/fapi/v1/fundingRate?symbol=${symbol}&startTime=${cur}&limit=1000`);
    for (const r of d) out.push({ ts: Number(r.fundingTime), rate: Number(r.fundingRate), interval });
    if (d.length < 1000) break;
    cur = Number(d[d.length - 1].fundingTime) + 1;
  }
  return out;
}

// ---------- Bybit V5 linear (USDT) ----------
/** GET a Bybit V5 path, trying each host until one answers. Also checks Bybit's own retCode (HTTP 200 can still be an error). */
async function bybitGet(path: string): Promise<any> {
  let lastErr: any;
  for (const host of BYBIT_HOSTS) {
    try {
      const d = await get(`${host}${path}`);
      if (d?.retCode !== undefined && d.retCode !== 0) throw new Error(`Bybit retCode ${d.retCode}: ${d.retMsg}`);
      return d;
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error("No Bybit host configured");
}

const num = (v: any) => (v === "" || v == null ? NaN : Number(v));

export async function bybitSymbols() {
  const out: { symbol: string; base: string; interval: number; capUp: number; capLow: number }[] = [];
  let cursor = "";
  do {
    const d = await bybitGet(`/v5/market/instruments-info?category=linear&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    out.push(...(d.result?.list ?? [])
      .filter((s: any) => s.contractType === "LinearPerpetual" && s.quoteCoin === "USDT" && s.status === "Trading")
      .map((s: any) => ({ symbol: s.symbol as string, base: s.baseCoin as string, interval: Number(s.fundingInterval) / 60 || 8, capUp: num(s.upperFundingRate), capLow: num(s.lowerFundingRate) })));
    cursor = d.result?.nextPageCursor ?? "";
  } while (cursor);
  return out;
}

export async function bybitLive() {
  const d = await bybitGet(`/v5/market/tickers?category=linear`);
  const out = new Map<string, { rate: number; mark: number; index: number; vol: number; oi: number; interval: number }>();
  for (const t of d.result?.list ?? []) {
    // Number("") is 0, which would look like a real 0% funding rate, so empty strings are treated as missing.
    const rate = num(t.fundingRate), mark = num(t.markPrice);
    if (!Number.isFinite(rate) || !Number.isFinite(mark)) continue;
    out.set(t.symbol, { rate, mark, index: num(t.indexPrice), vol: num(t.turnover24h) || 0, oi: num(t.openInterestValue) || 0, interval: Number(t.fundingIntervalHour) || 8 });
  }
  return out;
}

export async function bybitRaw(symbol = "BTCUSDT") {
  const out: any = { hosts_tried: BYBIT_HOSTS };
  for (const host of BYBIT_HOSTS) {
    try {
      const [t, h] = await Promise.all([
        get(`${host}/v5/market/tickers?category=linear&symbol=${symbol}`),
        get(`${host}/v5/market/funding/history?category=linear&symbol=${symbol}&limit=5`),
      ]);
      return { ...out, host_ok: host, ticker: t.result?.list?.[0], history_sample: h.result?.list };
    } catch (e: any) { (out.errors ??= []).push(`${host}: ${String(e.message).slice(0, 200)}`); }
  }
  return out;
}

export async function bybitHistory(symbol: string, startMs: number, interval: number): Promise<(Ev & { interval: number })[]> {
  const out: (Ev & { interval: number })[] = [];
  let end = Date.now();
  // Bybit returns at most 200 records ordered newest-first. Work backward to the requested start.
  for (let page = 0; page < 50 && end >= startMs; page++) { // 50 pages x 200 = 10,000 records; a 1h-interval symbol needs ~44 for a year
    const d = await bybitGet(`/v5/market/funding/history?category=linear&symbol=${symbol}&endTime=${end}&limit=200`);
    const list = d.result?.list ?? [];
    if (!list.length) break;
    for (const r of list) {
      const ts = Number(r.fundingRateTimestamp);
      if (ts >= startMs) out.push({ ts, rate: Number(r.fundingRate), interval });
    }
    const oldest = Number(list[list.length - 1].fundingRateTimestamp);
    if (!Number.isFinite(oldest) || oldest <= startMs || list.length < 200) break;
    end = oldest - 1;
  }
  return out;
}

/** Largest price move seen inside any 120-day window over the last year, from Bybit daily candles. */
export async function bybitWorstMove(symbol: string, window = 120): Promise<number> {
  const d = await bybitGet(`/v5/market/kline?category=linear&symbol=${encodeURIComponent(symbol)}&interval=D&limit=365`);
  const candles = (d.result?.list ?? []).slice().reverse();
  const hi = candles.map((k: any) => Number(k[2]));
  const lo = candles.map((k: any) => Number(k[3]));
  const cl = candles.map((k: any) => Number(k[4]));
  let worst = 0;
  for (let i = 0; i < candles.length; i++) {
    let mx = 0, mn = Infinity;
    for (let j = i + 1; j < Math.min(candles.length, i + 1 + window); j++) {
      mx = Math.max(mx, hi[j]); mn = Math.min(mn, lo[j]);
    }
    if (mn === Infinity || !cl[i]) continue;
    worst = Math.max(worst, mx / cl[i] - 1, 1 - mn / cl[i]);
  }
  return worst;
}

// ---------- Delta Exchange India ----------
export async function deltaProducts() {
  const d = await get(`${DELTA}/v2/products?contract_types=perpetual_futures`);
  return (d.result as any[])
    .filter((p) => p.state === "live" && p.contract_type === "perpetual_futures")
    .map((p) => ({
      symbol: p.symbol as string,
      base: (p.underlying_asset?.symbol ?? "") as string,
      quote: (p.quoting_asset?.symbol ?? "") as string,
    }));
}

export async function deltaTickers() {
  const d = await get(`${DELTA}/v2/tickers?contract_types=perpetual_futures`);
  const out = new Map<string, { rate: number; mark: number; index: number; vol: number; oi: number }>();
  for (const t of d.result as any[]) {
    const rate = dRate(Number(t.funding_rate));
    if (!Number.isFinite(rate)) continue;
    out.set(t.symbol, {
      rate,
      mark: Number(t.mark_price),
      index: Number(t.spot_price),   // Delta's index price
      vol: Number(t.turnover_usd ?? 0),
      oi: Number(t.oi_value_usd ?? 0),
    });
  }
  return out;
}

/**
 * Turns Delta's hourly FUNDING candles into one record per funding payment.
 * The rate is constant inside a funding interval, so every hourly candle of a block repeats the same value. We must keep exactly one
 * candle per block. The block length is not fixed: it was 8h and some contracts (NOT, NEIRO, ...) moved to 4h in late 2025.
 * It is read from the data itself: a rate can only change on a block boundary, so changes at 04/12/20 UTC prove a 4h schedule.
 * Intervals only ever get shorter, and a switch is accepted only when it is confirmed by several later changes, so a single
 * off-schedule correction does not trigger it. Values are returned as decimals (percent / 100).
 */
export function deltaPayments(candles: { time: number | string; close: number | string }[], fallbackHours = DELTA_INTERVAL, inPercent = DELTA_IN_PERCENT) {
  const byTime = new Map<number, number>();
  for (const c of candles) { const t = Number(c.time), v = Number(c.close); if (Number.isFinite(t) && Number.isFinite(v) && c.close !== null && c.close !== "") byTime.set(t, v); }
  const cs = [...byTime.entries()].sort((a, b) => a[0] - b[0]);
  const changes: number[] = [];                                  // hour index of every change between two adjacent hourly candles
  for (let i = 1; i < cs.length; i++) if (cs[i][0] - cs[i - 1][0] === 3600 && cs[i][1] !== cs[i - 1][1]) changes.push(Math.floor(cs[i][0] / 3600));

  let cur = fallbackHours;
  const eras: { from: number; hours: number }[] = [{ from: -Infinity, hours: cur }];   // from = hour index
  for (let i = 0; i < changes.length; i++) {
    if (changes[i] % cur === 0) continue;
    const next = changes.slice(i, i + 5);
    if (next.length < 3) break;
    for (const x of [4, 2, 1]) {
      if (x >= cur) continue;
      const onGrid = next.filter((h) => h % x === 0).length;
      // changes that only a grid of x hours can explain (not the next coarser grid of 2x hours): they are the real evidence
      const needsX = next.filter((h) => h % x === 0 && h % (2 * x) !== 0);
      if (onGrid >= Math.ceil(next.length * 0.8) && needsX.length >= 2) {
        cur = x; eras.push({ from: needsX[0], hours: x });
        break;
      }
    }
  }
  const eraAt = (h: number) => { let e = eras[0]; for (const x of eras) if (x.from <= h) e = x; return e.hours; };
  const out: { ts: number; rate: number; interval: number }[] = [];
  for (const [t, v] of cs) {
    const h = Math.floor(t / 3600), hours = eraAt(h);
    if (h % hours === 0) out.push({ ts: t * 1000, rate: inPercent ? v / 100 : v, interval: hours });
  }
  return out;
}

/** Funding history from Delta's candle endpoint (FUNDING:<symbol>): one decimal rate per funding payment. */
export async function deltaHistory(symbol: string, startMs: number): Promise<(Ev & { interval: number })[]> {
  const end = Math.floor(Date.now() / 1000);
  const start = Math.floor(startMs / 1000);
  const CHUNK = 60 * 86400; // candle endpoint caps results per request, so fetch in 60-day chunks
  const candles: any[] = [];
  for (let t = start; t < end; t += CHUNK) {
    const d = await get(`${DELTA}/v2/history/candles?resolution=1h&symbol=FUNDING:${symbol}&start=${t}&end=${Math.min(t + CHUNK, end)}`);
    candles.push(...(d.result as any[]));
  }
  return deltaPayments(candles);
}

export async function deltaRaw(symbol: string) {
  const end = Math.floor(Date.now() / 1000);
  const start = end - 3 * 86400;
  const [ticker, candles] = await Promise.all([
    get(`${DELTA}/v2/tickers/${symbol}`),
    get(`${DELTA}/v2/history/candles?resolution=1h&symbol=FUNDING:${symbol}&start=${start}&end=${end}`),
  ]);
  return { ticker: ticker.result, candles_sample: (candles.result as any[]).slice(-30) };
}

/** Largest price move (up or down) seen inside any 120-day window over the last year, from daily candles. */
export async function binanceWorstMove(symbol: string, window = 120): Promise<number> {
  const d = await get(`${BIN}/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=365`);
  const hi = d.map((k: any) => Number(k[2])), lo = d.map((k: any) => Number(k[3])), cl = d.map((k: any) => Number(k[4]));
  let worst = 0;
  for (let i = 0; i < d.length; i++) {
    let mx = 0, mn = Infinity;
    for (let j = i + 1; j < Math.min(d.length, i + 1 + window); j++) { mx = Math.max(mx, hi[j]); mn = Math.min(mn, lo[j]); }
    if (mn === Infinity) continue;
    worst = Math.max(worst, mx / cl[i] - 1, 1 - mn / cl[i]);
  }
  return worst;
}

// ---------- CoinDCX futures (live funding only: no public funding-history endpoint is documented) ----------
const DCX_API = "https://api.coindcx.com";
const DCX_PUB = "https://public.coindcx.com";
const DCX_DEFAULT_HOURS = Number(process.env.COINDCX_FUNDING_INTERVAL_HOURS ?? 8);

/** Current funding ("fr") and mark price for every CoinDCX USDT futures pair, keyed by pair e.g. "B-BTC_USDT". */
export async function coindcxPrices() {
  const j = await get(`${DCX_PUB}/market_data/v3/current_prices/futures/rt`);
  const src = j?.prices ?? j;
  const out = new Map<string, { rate: number; mark: number }>();
  for (const [pair, v] of Object.entries<any>(src ?? {})) {
    if (!v || typeof v !== "object" || !/^B-.+_USDT$/.test(pair)) continue;
    const rate = Number(v.fr);
    if (!Number.isFinite(rate)) continue;
    out.set(pair, { rate, mark: Number(v.mp ?? v.ls ?? 0) });
  }
  return out;
}

export async function coindcxFundingHours(pair: string): Promise<number> {
  try {
    const d = await get(`${DCX_API}/exchange/v1/derivatives/futures/data/instrument?pair=${pair}&margin_currency_short_name=USDT`);
    const f = Number(d?.instrument?.funding_frequency);
    return f > 0 ? f : DCX_DEFAULT_HOURS;
  } catch { return DCX_DEFAULT_HOURS; }
}

export async function coindcxRaw(pair = "B-BTC_USDT") {
  const j = await get(`${DCX_PUB}/market_data/v3/current_prices/futures/rt`);
  const src = j?.prices ?? j;
  const keys = Object.keys(src ?? {});
  const hours = await coindcxFundingHours(pair);
  return { top_level_keys: Object.keys(j ?? {}).slice(0, 10), pair_count: keys.length, sample_pair: pair, sample: src?.[pair], funding_hours_used: hours };
}