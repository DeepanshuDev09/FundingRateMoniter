"use client";
import Link from "next/link";
import { use, useEffect, useState } from "react";
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { cls, dirLabel, freshness, pct, signedPct, usd } from "@/lib/format";

export default function PairPage({ params }: { params: Promise<{ base: string }> }) {
  const { base } = use(params);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`/api/pair/${base}`).then(async (r) => {
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      setData(j);
    }).catch((e) => setError(e.message));
  }, [base]);

  if (error) return <div className="wrap"><Link className="back" href="/">Back to all pairs</Link><div className="err"><b>Couldn&apos;t load {base}.</b> {error}</div></div>;
  if (!data) return <div className="wrap"><Link className="back" href="/">Back to all pairs</Link><p className="muted">Loading...</p></div>;

  const p = data.pair, series: any[] = data.series;
  const f = freshness(p.last_synced_at);
  const bFund = p.b_rate != null ? p.b_rate * 100 : null, dFund = p.d_rate != null ? p.d_rate * 100 : null;

  return (
    <div className="wrap">
      <Link className="back" href="/">Back to all pairs</Link>
      <h1>{p.base}</h1>
      <p className="sub">{p.binance_symbol} on Binance, {p.delta_symbol} on Delta India. Best direction over 30 days: <b>{dirLabel(p.direction)}</b>.</p>

      <div className="facts">
        <div className="fact"><b className={cls(p.net30)}>{signedPct(p.net30)}</b><span>30d net of fees</span></div>
        <div className="fact"><b className={cls(p.net90)}>{signedPct(p.net90)}</b><span>3-month net of fees{p.days90 && p.days90 < 85 ? ` (${p.days90} days of data)` : ""}</span></div>
        <div className="fact"><b className={cls(p.ret30)}>{signedPct(p.ret30)}</b><span>30d gross</span></div>
        <div className="fact"><b>{pct(p.apr, 0)}</b><span>30d APR (on notional)</span></div>
        <div className="fact"><b>{pct(p.trend3_apr, 0)}</b><span>Last 3 days APR</span></div>
        <div className="fact"><b>{pct(p.consistency, 0)}</b><span>Positive days</span></div>
        <div className="fact"><b>{p.breakeven_days ? `${p.breakeven_days.toFixed(1)} days` : "-"}</b><span>To cover entry and exit fees</span></div>
      </div>

      <div className="box">
        <h2>Daily funding and cumulative earnings (% of notional)</h2>
        <div style={{ width: "100%", height: 320 }}>
          <ResponsiveContainer>
            <ComposedChart data={series}>
              <CartesianGrid stroke="var(--line)" vertical={false} />
              <XAxis dataKey="date" stroke="var(--muted)" fontSize={12} />
              <YAxis stroke="var(--muted)" fontSize={12} tickFormatter={(v) => `${v.toFixed(2)}%`} width={56} />
              <Tooltip formatter={(v: any) => `${Number(v).toFixed(4)}%`} contentStyle={{ background: "var(--panel)", border: "1px solid var(--line)", color: "var(--ink)" }} />
              <Legend />
              <Bar dataKey="binance" name="Binance funding/day" fill="#d99a2b" />
              <Bar dataKey="delta" name="Delta funding/day" fill="#4b8fd6" />
              <Line type="monotone" dataKey="cumulative" name="Cumulative hedge earnings" stroke="var(--gain)" strokeWidth={2.5} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        {!series.length && <p className="muted">History for this pair hasn&apos;t synced yet. It joins the rotation automatically.</p>}
      </div>

      <div className="grid">
        <div className="box">
          <h2>Right now</h2>
          <div className="row"><span>Binance funding / interval</span><span className="num">{bFund == null ? "-" : `${bFund.toFixed(4)}% / ${p.b_interval}h`}</span></div>
          <div className="row"><span>Delta funding / interval</span><span className="num">{dFund == null ? "-" : `${dFund.toFixed(4)}% / ${p.d_interval}h`}</span></div>
          <div className="row"><span>CoinDCX funding / interval</span><span className="num">{p.c_rate == null ? "not listed" : `${(p.c_rate * 100).toFixed(4)}% / ${p.c_interval ?? 8}h`}</span></div>
          <div className="row"><span>CoinDCX vs Delta, live (APR)</span><span className="num gain">{p.dcx_apr == null ? "-" : `${pct(p.dcx_apr, 0)}: ${dirLabel(p.dcx_direction)}`}</span></div>
          <div className="row"><span>Current spread, Binance vs Delta (APR)</span><span className="num gain">{pct(p.live_apr, 0)}</span></div>
          <div className="row"><span>Current best direction</span><span>{dirLabel(p.live_direction)}</span></div>
          <div className="row"><span>Binance mark price</span><span className="num">{p.b_mark ? (p.b_mark / p.b_mult).toPrecision(6) : "-"}</span></div>
          <div className="row"><span>Delta mark price</span><span className="num">{p.d_mark ? (p.d_mark / p.d_mult).toPrecision(6) : "-"}</span></div>
          <div className="row"><span>Basis (Delta vs Binance)</span><span className="num">{signedPct(p.basis)}</span></div>
          <div className="row"><span>24h volume (Binance / Delta)</span><span className="num">{usd(p.b_vol)} / {usd(p.d_vol)}</span></div>
          <div className="row"><span>Delta open interest</span><span className="num">{usd(p.d_oi)}</span></div>
          <div className="row"><span>Stability: daily std / sign flips</span><span className="num">{pct(p.spread_std, 3)} / {p.sign_flips ?? "-"}</span></div>
          <div className="row"><span>History synced</span><span><span className={`dot ${f.c}`} />{f.t}</span></div>
        </div>
        <Backtest series={series} />
        <Liquidation entry={p.b_mark ? p.b_mark / p.b_mult : 0} />
      </div>
      <p className="note" style={{ marginTop: 14 }}>
        The projection assumes the same funding repeats. It won&apos;t, so treat it as a rough guide.
      </p>
    </div>
  );
}

function Backtest({ series }: { series: any[] }) {
  const [capital, setCapital] = useState(1000);
  const [lev, setLev] = useState(3);
  const [days, setDays] = useState(30);
  const [fee, setFee] = useState(0.05);
  const use = series.slice(-days);
  const earnedPct = use.reduce((a, r) => a + r.earn, 0) / 100;
  const notional = (capital * lev) / 2; // capital split across both exchanges, one leg on each
  const gross = notional * earnedPct;
  const fees = notional * 4 * (fee / 100);
  const net = gross - fees;
  const avg = use.length ? gross / use.length : 0;
  return (
    <div className="box">
      <h2>Backtest: what would I have earned?</h2>
      <div className="fields">
        <label>Total capital (USD)<input type="number" min={0} value={capital} onChange={(e) => setCapital(Number(e.target.value))} /></label>
        <label>Leverage<input type="number" min={1} value={lev} onChange={(e) => setLev(Number(e.target.value))} /></label>
        <label>Period
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={7}>7 days</option><option value={14}>14 days</option><option value={30}>30 days</option><option value={90}>90 days</option></select>
        </label>
        <label>Taker fee per leg (%)<input type="number" step="0.01" value={fee} onChange={(e) => setFee(Number(e.target.value))} /></label>
      </div>
      <div className="row"><span>Notional per leg</span><span className="num">${notional.toFixed(0)}</span></div>
      <div className="row"><span>Funding earned ({use.length} days)</span><span className={`num ${net >= 0 ? "gain" : "loss"}`}>${gross.toFixed(2)}</span></div>
      <div className="row"><span>Fees (open + close, both exchanges)</span><span className="num loss">-${fees.toFixed(2)}</span></div>
      <div className="row"><span><b>Net result</b></span><span className={`num ${net >= 0 ? "gain" : "loss"}`}><b>${net.toFixed(2)}</b></span></div>
      <div className="row"><span>Net return on capital</span><span className="num">{capital ? ((net / capital) * 100).toFixed(2) : "-"}%</span></div>
      <div className="row"><span>Average per day (gross)</span><span className="num">${avg.toFixed(2)}</span></div>
      <p className="note">If you enter today at the current spread, the same math applies to the &ldquo;Now (APR)&rdquo; figure, but only while it lasts.</p>
    </div>
  );
}

function Liquidation({ entry }: { entry: number }) {
  const [price, setPrice] = useState(entry || 0);
  const [lev, setLev] = useState(5);
  const [mmr, setMmr] = useState(0.5);
  useEffect(() => { if (entry && !price) setPrice(entry); }, [entry]);
  const m = mmr / 100;
  const longLiq = price * (1 - 1 / lev + m);
  const shortLiq = price * (1 + 1 / lev - m);
  return (
    <div className="box">
      <h2>Liquidation distance</h2>
      <div className="fields">
        <label>Entry price<input type="number" value={price} onChange={(e) => setPrice(Number(e.target.value))} /></label>
        <label>Leverage<input type="number" min={1} value={lev} onChange={(e) => setLev(Number(e.target.value))} /></label>
        <label>Maintenance margin (%)<input type="number" step="0.1" value={mmr} onChange={(e) => setMmr(Number(e.target.value))} /></label>
      </div>
      <div className="row"><span>Long liquidates near</span><span className="num loss">{price ? longLiq.toPrecision(6) : "-"} ({((1 / lev - m) * 100).toFixed(1)}% below)</span></div>
      <div className="row"><span>Short liquidates near</span><span className="num loss">{price ? shortLiq.toPrecision(6) : "-"} ({((1 / lev - m) * 100).toFixed(1)}% above)</span></div>
      <p className="note">Simplified isolated-margin estimate. Real maintenance margin tiers and fees differ per exchange and position size. The hedge is delta-neutral, but the leg that moves against you can still liquidate, so keep spare margin on both exchanges.</p>
    </div>
  );
}