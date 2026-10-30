import type { Ev } from "./calc";

const BIN = "https://fapi.binance.com";
const BYBIT = "https://api.bybit.com";
const DELTA = "https://api.india.delta.exchange";
const DELTA_INTERVAL = Number(process.env.DELTA_FUNDING_INTERVAL_HOURS ?? 8);
const DELTA_OFFSET = Number(process.env.DELTA_FUNDING_HOUR_OFFSET ?? 0);

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
  const out = new Map<string, { rate: number; mark: number; vol: number; interval: number }>();
  for (const p of pi) {
    out.set(p.symbol, {
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
export async function bybitSymbols() {
  const out: { symbol: string; base: string; interval: number }[] = [];
  let cursor = "";
  do {
    const d = await get(`${BYBIT}/v5/market/instruments-info?category=linear&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    out.push(...(d.result?.list ?? [])
      .filter((s: any) => s.contractType === "LinearPerpetual" && s.quoteCoin === "USDT" && s.status === "Trading")
      .map((s: any) => ({ symbol: s.symbol as string, base: s.baseCoin as string, interval: Number(s.fundingInterval) / 60 })));
    cursor = d.result?.nextPageCursor ?? "";
  } while (cursor);
  return out;
}

export async function bybitLive() {
  const d = await get(`${BYBIT}/v5/market/tickers?category=linear`);
  const out = new Map<string, { rate: number; mark: number; vol: number; oi: number; interval: number }>();
  for (const t of d.result?.list ?? []) {
    const rate = Number(t.fundingRate), mark = Number(t.markPrice);
    if (!Number.isFinite(rate) || !Number.isFinite(mark)) continue;
    out.set(t.symbol, { rate, mark, vol: Number(t.turnover24h ?? 0), oi: Number(t.openInterestValue ?? 0), interval: Number(t.fundingIntervalHour) || 8 });
  }
  return out;
}

export async function bybitHistory(symbol: string, startMs: number, interval: number): Promise<(Ev & { interval: number })[]> {
  const out: (Ev & { interval: number })[] = [];
  let end = Date.now();
  // Bybit returns at most 200 records ordered newest-first. Work backward to the requested start.
  for (let page = 0; page < 24 && end >= startMs; page++) {
    const d = await get(`${BYBIT}/v5/market/funding/history?category=linear&symbol=${symbol}&endTime=${end}&limit=200`);
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
  const out = new Map<string, { rate: number; mark: number; vol: number; oi: number }>();
  for (const t of d.result as any[]) {
    out.set(t.symbol, {
      rate: Number(t.funding_rate) / 100, // Delta reports percent. Confirm via /api/debug/delta.
      mark: Number(t.mark_price),
      vol: Number(t.turnover_usd ?? 0),
      oi: Number(t.oi_value_usd ?? 0),
    });
  }
  return out;
}

/** Funding history from Delta's candle endpoint (FUNDING:<symbol>), 1h candles sampled at settlement hours. */
export async function deltaHistory(symbol: string, startMs: number): Promise<(Ev & { interval: number })[]> {
  const end = Math.floor(Date.now() / 1000);
  const start = Math.floor(startMs / 1000);
  const CHUNK = 60 * 86400; // candle endpoint caps results per request, so fetch in 60-day chunks
  const candles: any[] = [];
  for (let t = start; t < end; t += CHUNK) {
    const d = await get(`${DELTA}/v2/history/candles?resolution=1h&symbol=FUNDING:${symbol}&start=${t}&end=${Math.min(t + CHUNK, end)}`);
    candles.push(...(d.result as any[]));
  }
  return candles
    .filter((c) => (Math.floor(c.time / 3600) % DELTA_INTERVAL) === DELTA_OFFSET)
    .map((c) => ({ ts: c.time * 1000, rate: Number(c.close) / 100, interval: DELTA_INTERVAL }));
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
