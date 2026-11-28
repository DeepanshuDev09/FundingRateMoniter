"use client";
import Link from "next/link";
import { use, useEffect, useState } from "react";
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { cls, dirLabel, freshness, pct, signedPct, usd } from "@/lib/format";
import { BYBIT_FORMULA_NOTE, CHECK_LABEL, type Check } from "@/lib/diagnose";

export default function PairPage({ params, searchParams }: { params: Promise<{ base: string }>; searchParams: Promise<{ market?: string }> }) {
  const { base } = use(params);
  const market = use(searchParams).market;
  const by = market === "bybit";
  const bybitDelta = market === "bybit-delta";
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`/api/pair/${base}${market ? `?market=${market}` : ""}`).then(async (r) => {
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      setData(j);
    }).catch((e) => setError(e.message));
  }, [base, market]);

  if (error) return <div className="wrap"><Link className="back" href="/">Back to all pairs</Link><div className="err"><b>Couldn&apos;t load {base}.</b> {error}</div></div>;
  if (!data) return <div className="wrap"><Link className="back" href="/">Back to all pairs</Link><p className="muted">Loading...</p></div>;

  const p = data.pair, series: any[] = data.series;
  const f = freshness(bybitDelta ? p.bybit_delta_last_synced_at : p.last_synced_at);
  const left = bybitDelta ? "Bybit" : "Binance", peer = by ? "Bybit" : "Delta";
  const leftKey = bybitDelta ? "bybit" : "binance", peerKey = by ? "bybit" : "delta";
  const pk = (k: string) => (by ? p[`y_${k}`] : bybitDelta ? p[`yd_${k}`] : p[k]);
  const leftRate = bybitDelta ? p.y_rate : p.b_rate;
  const peerRate = by ? p.y_rate : p.d_rate;
  const leftInterval = bybitDelta ? (p.y_interval ?? p.mapped_y_interval) : p.b_interval;
  const peerInterval = by ? (p.y_interval ?? p.mapped_y_interval) : p.d_interval;
  const leftMark = bybitDelta ? (p.y_mark ? p.y_mark / (p.y_mult ?? 1) : null) : (p.b_mark ? p.b_mark / p.b_mult : null);
  const peerMark = by ? (p.y_mark ? p.y_mark / (p.y_mult ?? 1) : null) : (p.d_mark ? p.d_mark / p.d_mult : null);
  const liveApr = by ? p.y_live_apr : bybitDelta ? p.yd_live_apr : p.live_apr;
  const liveDir = by ? p.y_live_direction : bybitDelta ? p.yd_live_direction : p.live_direction;
  const leftVol = bybitDelta ? p.y_vol : p.b_vol;
  const peerVol = by ? p.y_vol : p.d_vol;
  const basis = by ? p.y_basis : bybitDelta ? p.yd_basis : p.basis;

  return (
    <div className="wrap">
      <Link className="back" href="/">Back to all pairs</Link>
      <h1>{p.base}</h1>
      <p className="sub">{bybitDelta ? `${p.bybit_symbol} on Bybit, ${p.delta_symbol} on Delta India` : `${p.binance_symbol} on Binance, ${by ? p.bybit_symbol : p.delta_symbol} on ${by ? "Bybit" : "Delta India"}`}. Best direction over 30 days: <b>{dirLabel(pk("direction"))}</b>.</p>

      <div className="facts">
        <div className="fact"><b className={cls(pk("net30"))}>{signedPct(pk("net30"))}</b><span>30d net of fees</span></div>
        <div className="fact"><b className={cls(pk("net90"))}>{signedPct(pk("net90"))}</b><span>3-month net of fees{pk("days90") && pk("days90") < 85 ? ` (${pk("days90")} days of data)` : ""}</span></div>
        <div className="fact"><b className={cls(pk("ret365"))}>{signedPct(pk("ret365"))}</b><span>1y gross return{pk("days365") && pk("days365") < 350 ? ` (${pk("days365")} days of data)` : ""}</span></div>
        <div className="fact"><b className={cls(pk("ret30"))}>{signedPct(pk("ret30"))}</b><span>30d gross</span></div>
        {data.dyn && <>
          <div className="fact"><b className={cls(data.dyn.net30)}>{signedPct(data.dyn.net30)}</b><span>30d net, flipping sides ({data.dyn.flips30} flips)</span></div>
          <div className="fact"><b className={cls(data.dyn.net90)}>{signedPct(data.dyn.net90)}</b><span>3-month net, flipping sides</span></div>
          <div className="fact"><b className={cls(data.dyn.net365)}>{signedPct(data.dyn.net365)}</b><span>1y net, flipping sides ({data.dyn.flips} flips)</span></div>
          <div className="fact"><b>{dirLabel(data.dyn.direction)}</b><span>Side the flip rule holds now</span></div>
        </>}
        <div className="fact"><b>{pct(pk("apr"), 0)}</b><span>30d APR (on notional)</span></div>
        <div className="fact"><b>{pct(pk("trend3_apr"), 0)}</b><span>Last 3 days APR</span></div>
        <div className="fact"><b>{pct(pk("consistency"), 0)}</b><span>Positive days</span></div>
        <div className="fact"><b>{pk("breakeven_days") ? `${pk("breakeven_days").toFixed(1)} days` : "-"}</b><span>To cover entry and exit fees</span></div>
      </div>

      <div className="box">
        <h2>Past year: daily funding and cumulative earnings (% of notional)</h2>
        <div style={{ width: "100%", height: 320 }}>
          <ResponsiveContainer>
            <ComposedChart data={series}>
              <CartesianGrid stroke="var(--line)" vertical={false} />
              <XAxis dataKey="date" stroke="var(--muted)" fontSize={12} />
              <YAxis stroke="var(--muted)" fontSize={12} tickFormatter={(v) => `${v.toFixed(2)}%`} width={56} />
              <Tooltip formatter={(v: any) => `${Number(v).toFixed(4)}%`} contentStyle={{ background: "var(--panel)", border: "1px solid var(--line)", color: "var(--ink)" }} />
              <Legend />
              <Bar dataKey={leftKey} name={`${left} funding/day`} fill="#d99a2b" />
              <Bar dataKey={peerKey} name={`${peer} funding/day`} fill="#4b8fd6" />
              <Line type="monotone" dataKey="cumulative" name="Cumulative, fixed best side" stroke="var(--gain)" strokeWidth={2.5} dot={false} />
              <Line type="monotone" dataKey="dyn_cumulative" name="Cumulative, flipping sides (gross)" stroke="#a66bd6" strokeWidth={2.5} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        {!series.length && <p className="muted">History for this pair hasn&apos;t synced yet. It joins the rotation automatically.</p>}
      </div>

      <WhyDiffer p={p} bybit={by} bybitDelta={bybitDelta} basis={basis} gapHistory={data.gapHistory ?? []} />

      {data.dyn && <FlipLog dyn={data.dyn} />}

      <DailyFundingTable key={`${base}-${peer}`} funding={data.funding ?? []} left={left} peer={peer} />

      <div className="grid">
        <div className="box">
          <h2>Right now</h2>
          <div className="row"><span>{left} funding / interval</span><span className="num">{leftRate == null ? "-" : `${(leftRate * 100).toFixed(4)}% / ${leftInterval}h`}</span></div>
          <div className="row"><span>{peer} funding / interval</span><span className="num">{peerRate == null ? "-" : `${(peerRate * 100).toFixed(4)}% / ${peerInterval}h`}</span></div>
          {!by && !bybitDelta && <div className="row"><span>CoinDCX funding / interval</span><span className="num">{p.c_rate == null ? "not listed" : `${(p.c_rate * 100).toFixed(4)}% / ${p.c_interval ?? 8}h`}</span></div>}
          {!by && !bybitDelta && <div className="row"><span>CoinDCX vs Delta, live (APR)</span><span className="num gain">{p.dcx_apr == null ? "-" : `${pct(p.dcx_apr, 0)}: ${dirLabel(p.dcx_direction)}`}</span></div>}
          <div className="row"><span>Current spread, {left} vs {peer} (APR)</span><span className="num gain">{pct(liveApr, 0)}</span></div>
          <div className="row"><span>Current best direction</span><span>{dirLabel(liveDir)}</span></div>
          <div className="row"><span>{left} mark price</span><span className="num">{leftMark ? leftMark.toPrecision(6) : "-"}</span></div>
          <div className="row"><span>{peer} mark price</span><span className="num">{peerMark ? peerMark.toPrecision(6) : "-"}</span></div>
          <div className="row"><span>Basis ({peer} vs {left})</span><span className="num">{signedPct(basis)}</span></div>
          <div className="row"><span>24h volume ({left} / {peer})</span><span className="num">{usd(leftVol)} / {usd(peerVol)}</span></div>
          <div className="row"><span>{peer} open interest</span><span className="num">{usd(by ? p.y_oi : p.d_oi)}</span></div>
          <div className="row"><span>Stability: daily std / sign flips</span><span className="num">{pct(pk("spread_std"), 3)} / {pk("sign_flips") ?? "-"}</span></div>
          <div className="row"><span>History synced</span><span><span className={`dot ${f.c}`} />{f.t}</span></div>
        </div>
        <Backtest series={series} defaultFee={by ? 0.055 : bybitDelta ? 0.0525 : 0.05} />
        <Liquidation entry={leftMark ?? 0} />
      </div>
      <p className="note" style={{ marginTop: 14 }}>
        The projection assumes the same funding repeats. It won&apos;t, so treat it as a rough guide.
      </p>
    </div>
  );
}

function DailyFundingTable({ funding, left, peer }: { funding: { date: string; binance: number | null; peer: number | null; net: number | null }[]; left: string; peer: string }) {
  const currentMonth = new Date().toISOString().slice(0, 7);
  const [month, setMonth] = useState(funding[funding.length - 1]?.date.slice(0, 7) ?? currentMonth);
  const daysInMonth = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const byDate = new Map(funding.map((row) => [row.date, row]));
  const rows = Array.from({ length: daysInMonth }, (_, i) => {
    const date = `${month}-${String(i + 1).padStart(2, "0")}`;
    return { date, ...byDate.get(date) };
  });
  const dailyReturns = rows.map((row) => row.net).filter((value): value is number => value != null);
  const monthlyTotal = dailyReturns.reduce((total, value) => total + value, 0);
  const averagePerDay = dailyReturns.length ? monthlyTotal / dailyReturns.length : null;
  const firstMonth = funding[0]?.date.slice(0, 7);
  const formatRate = (rate: number | null | undefined) => rate == null ? "-" : `${rate.toFixed(4)}%`;
  const monthLabel = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1))
    .toLocaleDateString("en", { month: "long", year: "numeric", timeZone: "UTC" });

  return (
    <div className="box" style={{ marginTop: 14 }}>
      <div className="bar" style={{ justifyContent: "space-between" }}>
        <h2>Daily funding by date (%)</h2>
        <label>Month<input type="month" value={month} min={firstMonth} max={currentMonth} onChange={(e) => setMonth(e.target.value || currentMonth)} /></label>
      </div>
      <div className="monthly-summary" aria-label={`${monthLabel} return summary`}>
        <div className="monthly-summary-item">
          <span>Average daily return ({dailyReturns.length} data days)</span>
          <b className={averagePerDay == null ? "" : averagePerDay >= 0 ? "gain" : "loss"}>{formatRate(averagePerDay)}</b>
        </div>
        <div className="monthly-summary-item">
          <span>Total return in {monthLabel}</span>
          <b className={monthlyTotal >= 0 ? "gain" : "loss"}>{dailyReturns.length ? formatRate(monthlyTotal) : "-"}</b>
        </div>
      </div>
      <div className="tablebox">
        <table className="daily-funding-table">
          <thead><tr><th>Date (UTC)</th><th className="num">{left}</th><th className="num">{peer}</th><th className="num">Net return</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.date}>
                <td>{row.date}</td>
                <td className="num">{formatRate(row.binance)}</td>
                <td className="num">{formatRate(row.peer)}</td>
                <td className={`num ${row.net == null ? "" : row.net >= 0 ? "gain" : "loss"}`}>{formatRate(row.net)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note" style={{ margin: "10px 2px 0" }}>Returns follow the selected hedge direction. Monthly averages include only days with funding data from both exchanges; trading fees are not deducted.</p>
    </div>
  );
}

function Backtest({ series, defaultFee }: { series: any[]; defaultFee: number }) {
  const [capital, setCapital] = useState(1000);
  const [lev, setLev] = useState(3);
  const [days, setDays] = useState(30);
  const [fee, setFee] = useState(defaultFee);
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
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={7}>7 days</option><option value={14}>14 days</option><option value={30}>30 days</option><option value={90}>90 days</option><option value={365}>1 year</option></select>
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

function FlipLog({ dyn }: { dyn: any }) {
  const log: { date: string; direction: string; streak: number }[] = [...dyn.flipLog].reverse();
  return (
    <div className="box" style={{ marginTop: 14 }}>
      <h2>Flip rule: side changes</h2>
      <p className="muted" style={{ margin: "0 0 8px" }}>
        Starts as {dirLabel(dyn.start)}. Swaps sides when funding paid in a row (blocks of {" "}8h netting negative) reaches the threshold, then starts counting again.
        {" "}Flips last year: {dyn.flips}. Every flip is charged one round-trip fee in the net figures above. History used: {dyn.days} days.
      </p>
      {log.length ? (
        <div className="tablebox">
          <table>
            <thead><tr><th>Time (UTC)</th><th>New side</th><th className="num">Losing streak that triggered it</th></tr></thead>
            <tbody>{log.slice(0, 30).map((f) => <tr key={f.date}><td>{f.date}</td><td>{dirLabel(f.direction)}</td><td className="num loss">{signedPct(f.streak, 3)}</td></tr>)}</tbody>
          </table>
        </div>
      ) : <p className="muted">No flips in the available history.</p>}
    </div>
  );
}

const p3 = (v: number | null | undefined) => (v == null ? "-" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(3)}%`);

/** Explains WHY the two exchanges pay different funding: price premium vs own index, what funding implies, caps, and the gap between exchanges. */
function WhyDiffer({ p, bybit, bybitDelta, basis, gapHistory }: { p: any; bybit: boolean; bybitDelta: boolean; basis: number | null; gapHistory: any[] }) {
  const yInt = p.y_interval ?? p.mapped_y_interval ?? 8;
  const legs = (bybitDelta
    ? [{ name: "Bybit", rate: p.y_rate, interval: yInt, d: p.y_diag }, { name: "Delta", rate: p.d_rate, interval: p.d_interval, d: p.d_diag }]
    : bybit
      ? [{ name: "Binance", rate: p.b_rate, interval: p.b_interval, d: p.b_diag }, { name: "Bybit", rate: p.y_rate, interval: yInt, d: p.y_diag }]
      : [{ name: "Binance", rate: p.b_rate, interval: p.b_interval, d: p.b_diag }, { name: "Delta", rate: p.d_rate, interval: p.d_interval, d: p.d_diag }]
  ).filter((l) => l.d);
  if (!legs.length) return null;
  const say = (l: any) => {
    const d = l.d, k: Check = d.status;
    if (k === "consistent") return `${l.name}: the funding is explained by a real price gap on that exchange (${p3(d.premium)} against its own index).`;
    if (k === "mismatch") {
      const smaller = d.expected != null && l.rate != null && Math.abs(l.rate) < Math.abs(d.expected);
      return `${l.name}: at its current premium of ${p3(d.premium)} the formula would give about ${p3(d.expected)} per payment, but funding is ${p3(l.rate)}. ` + (smaller
        ? "Funding is smaller than the price gap suggests. The gap may be recent (funding averages the whole interval), or this exchange measures premium differently (for example from order-book impact prices rather than the mark price). Check again after its next settlement."
        : "Funding is larger than the price gap suggests. Check that exchange's index price, its formula, and whether the history is settled or predicted rates.");
    }
    if (k === "capped") return `${l.name}: the rate is sitting at its funding cap, so the real pressure may be larger than the rate shows.`;
    return `${l.name}: not enough data yet. It needs the mark and index price from the latest live refresh.`;
  };
  const shortInterval = (bybit || bybitDelta) && Number(yInt) < 8;
  return (
    <div className="box" style={{ marginTop: 14 }}>
      <h2>Why the two exchanges pay different funding</h2>
      <p className="muted" style={{ margin: "0 0 8px" }}>
        Funding is not a market price. Each exchange builds it from its own premium (perpetual price against its own index price) and its own formula. Delta&apos;s documented formula is
        {" "}average premium plus a clamp of (interest rate minus premium) at ±0.05%, with interest 0.01% per 8 hours. Inverting it shows which premium a funding rate implies.
        {" "}This is a rough check: the premium shown is one instant, funding is an average over the interval, and shorter-interval formulas may scale differently.
      </p>
      <div className="tablebox">
        <table>
          <thead><tr><th>Exchange</th><th className="num">Funding per payment</th><th className="num">Interval</th><th className="num">Premium now (vs own index)</th><th className="num">Premium implied by funding</th><th className="num">Funding cap</th><th>Check</th></tr></thead>
          <tbody>
            {legs.map((l) => (
              <tr key={l.name}>
                <td>{l.name}</td>
                <td className={`num ${cls(l.rate)}`}>{p3(l.rate)}</td>
                <td className="num">{l.interval ? `${l.interval}h` : "-"}</td>
                <td className="num">{p3(l.d.premium)}</td>
                <td className="num">{l.d.implied ? (l.d.implied.kind === "band" ? `${p3(l.d.implied.lo)} to ${p3(l.d.implied.hi)}` : p3(l.d.implied.mid)) : "-"}</td>
                <td className="num">{l.d.cap != null || l.d.floor != null ? `${p3(l.d.floor)} / ${p3(l.d.cap)}` : "-"}</td>
                <td className={l.d.status === "consistent" ? "gain" : l.d.status === "unknown" ? "muted" : "warn"}>{CHECK_LABEL[l.d.status as Check]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {legs.map((l) => <p key={l.name} className="note" style={{ margin: "8px 0 0" }}>{say(l)}</p>)}
      <p className="note" style={{ margin: "8px 0 0" }}>
        Price gap between the two exchanges now: <b>{p3(basis)}</b> ({legs[1].name} against {legs[0].name}). When you hold the hedge you also carry this gap: if it narrows you gain on top of funding, if it widens you lose even while collecting funding.
      </p>
      {shortInterval && <p className="note" style={{ margin: "8px 0 0" }}>{BYBIT_FORMULA_NOTE}</p>}
      {gapHistory.length >= 3 ? (
        <div style={{ width: "100%", height: 240, marginTop: 10 }}>
          <ResponsiveContainer>
            <ComposedChart data={gapHistory}>
              <CartesianGrid stroke="var(--line)" vertical={false} />
              <XAxis dataKey="t" stroke="var(--muted)" fontSize={11} minTickGap={40} />
              <YAxis stroke="var(--muted)" fontSize={12} tickFormatter={(v) => `${Number(v).toFixed(2)}%`} width={56} />
              <Tooltip formatter={(v: any) => `${Number(v).toFixed(3)}%`} contentStyle={{ background: "var(--panel)", border: "1px solid var(--line)", color: "var(--ink)" }} />
              <Legend />
              <Line type="monotone" dataKey="gap" name={`${legs[1].name} price vs ${legs[0].name} price`} stroke="var(--gain)" strokeWidth={2} dot={false} connectNulls />
              <Line type="monotone" dataKey="left_prem" name={`${legs[0].name} premium vs its index`} stroke="#6b8afd" strokeWidth={1.5} dot={false} connectNulls />
              <Line type="monotone" dataKey="peer_prem" name={`${legs[1].name} premium vs its index`} stroke="#a66bd6" strokeWidth={1.5} dot={false} connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      ) : <p className="muted" style={{ margin: "10px 0 0" }}>Price-gap history builds up from each live refresh (one point per hour). Run the live refresh a few times to see the chart.</p>}
    </div>
  );
}