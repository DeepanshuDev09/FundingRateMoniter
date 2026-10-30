"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { dirLabel, pct, signedPct, usd } from "@/lib/format";

const PRED: Record<string, string> = {
  m30: "Average of the last 30 days",
  m90: "Average of the last 90 days",
  md90: "Median of the last 90 days",
  cons: "Lowest of those three (used here)",
};

export default function Recommend() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [alt, setAlt] = useState(7);

  useEffect(() => {
    fetch("/api/recommend").then(async (r) => {
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      setData(j);
    }).catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="wrap"><Link className="back" href="/">Back to all pairs</Link><div className="err"><b>Couldn&apos;t load picks.</b> {error}</div></div>;
  if (!data) return <div className="wrap"><Link className="back" href="/">Back to all pairs</Link><p className="muted">Loading...</p></div>;

  const delta = data.delta ?? data, bybit = data.bybit;
  const v = delta.validation, s = delta.settings;
  const byBase = Object.fromEntries(delta.eligible.map((x: any) => [x.base, x]));
  const basket = delta.basket.map((b: string) => byBase[b]);
  const empty = !delta.eligible.length && !delta.excluded.length;

  const Table = ({ rows }: { rows: any[] }) => (
    <div className="tablebox">
      <table style={{ minWidth: 1040 }}>
        <thead>
          <tr>
            <th>Pair</th><th>Direction</th>
            <th className="num">Poor case</th><th className="num">Typical</th><th className="num">Good case</th>
            <th className="num">Chance of profit</th><th className="num">Yearly return on capital</th>
            <th className="num">Max leverage</th><th className="num">Worst 4-mo price move</th><th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.base}>
              <td><Link className="pairname" href={`/pair/${r.base}`}>{r.base}</Link></td>
              <td className="dir">{dirLabel(r.direction)}</td>
              <td className={`num ${r.p10 >= 0 ? "gain" : "loss"}`}>{signedPct(r.p10)}</td>
              <td className={`num ${r.p50 >= 0 ? "gain" : "loss"}`}>{signedPct(r.p50)}</td>
              <td className="num">{signedPct(r.p90)}</td>
              <td className="num">{pct(r.p_win, 0)}</td>
              <td className={`num ${r.ret_cap * 100 > alt ? "gain" : "warn"}`}>{pct(r.ret_cap, 0)}</td>
              <td className="num">{r.lev}x</td>
              <td className="num">{r.max_move == null ? "-" : pct(r.max_move, 0)}</td>
              <td className="note">{r.flags.length ? r.flags.join("; ") : "-"}</td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={10} className="empty">Nothing passes the filters yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="wrap">
      <Link className="back" href="/">Back to all pairs</Link>
      <h1>Long-term picks (about {s.horizon / 30} months)</h1>
      <p className="sub">
        Pairs ranked by how reliably the Binance/Delta funding spread has paid, after fees and slippage, using about a year of history.
        This is a ranking of past robustness, not a forecast or financial advice.
      </p>

      {empty && <div className="err">No analysis yet. In Admin, run &ldquo;Sync all pairs&rdquo; (first run downloads a year of history), then &ldquo;Run recommendation analysis&rdquo;.</div>}

      {v && (
        <div className="box" style={{ marginBottom: 14 }}>
          <h2>Did this kind of ranking work in the past?</h2>
          <p className="note" style={{ marginTop: 0 }}>
            On {v.folds} past dates, each pair was scored using only the previous {v.lookback} days, then we measured what it earned over the next {v.horizon} days (after fees).
            The top quarter by each rule is compared with the average pair ({signedPct(v.all_avg)}). Test dates overlap, so treat this as a rough check.
          </p>
          <div className="tablebox">
            <table style={{ minWidth: 560 }}>
              <thead><tr><th>Ranking rule</th><th className="num">Top quarter earned</th><th className="num">Top quarter profitable</th><th className="num">Rank correlation</th></tr></thead>
              <tbody>
                {Object.entries(v.predictors).map(([k, p]: any) => (
                  <tr key={k}>
                    <td>{PRED[k]}</td>
                    <td className={`num ${p.top_avg >= 0 ? "gain" : "loss"}`}>{signedPct(p.top_avg)}</td>
                    <td className="num">{pct(p.hit, 0)}</td>
                    <td className="num">{p.ic.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="note">Rank correlation near 0 means the rule had little predictive power; closer to 1 is better. Based on {v.pairs} pairs, last run {new Date(v.as_of).toLocaleDateString()}.</p>
        </div>
      )}

      <div className="bar">
        <label>Compare with another yield (% per year)
          <input type="number" value={alt} onChange={(e) => setAlt(Number(e.target.value))} style={{ width: 120 }} />
        </label>
        <span className="note" style={{ paddingBottom: 8 }}>Green return = beats this figure.</span>
      </div>

      <h2>Core picks: diversified basket</h2>
      <p className="note" style={{ marginTop: 0 }}>Best poor-case results first, skipping pairs whose daily spread moves together with one already chosen. Max 8.</p>
      <Table rows={basket} />

      <h2 style={{ marginTop: 22 }}>All pairs that passed ({delta.eligible.length})</h2>
      <Table rows={delta.eligible} />

      <p className="note" style={{ marginTop: 12 }}>
        <b>How to read it:</b> Poor / Typical / Good are the 10th, 50th and 90th percentile net return over {s.horizon} days on one leg&apos;s notional,
        from 500 resampled histories, after a {pct(1 - s.shrink, 0)} haircut, fees and slippage. Yearly return on capital assumes the suggested leverage,
        with capital split across both exchanges. Max leverage keeps liquidation about 20% further away than the worst 4-month price move of the past year, assuming no margin top-ups.
      </p>

      {!!delta.excluded.length && (
        <details style={{ marginTop: 12 }}>
          <summary className="muted">Excluded pairs ({delta.excluded.length})</summary>
          <div className="tablebox" style={{ marginTop: 8 }}>
            <table style={{ minWidth: 520 }}>
              <thead><tr><th>Pair</th><th>Reason</th><th className="num">Min volume</th></tr></thead>
              <tbody>
                {delta.excluded.map((r: any) => (
                  <tr key={r.base}><td>{r.base}</td><td>{r.reasons.join("; ")}</td><td className="num">{usd(r.volume)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <section style={{ marginTop: 30 }}>
        <h2>Binance ↔ Bybit recommendations</h2>
        <p className="note" style={{ marginTop: 0 }}>A separate ranking using the same four-month walk-forward and bootstrap algorithm, with Binance and Bybit fees, liquidity, basis, and funding history.</p>
        {!bybit || (!bybit.eligible.length && !bybit.excluded.length) ? <div className="err">No Binance–Bybit analysis yet. Run recommendation analysis in Admin after syncing history.</div> : <>
          <h3>Core picks: diversified basket</h3>
          <Table rows={bybit.basket.map((b: string) => bybit.eligible.find((x: any) => x.base === b)).filter(Boolean)} />
          <h3 style={{ marginTop: 22 }}>All pairs that passed ({bybit.eligible.length})</h3>
          <Table rows={bybit.eligible} />
          {!!bybit.excluded.length && <details style={{ marginTop: 12 }}><summary className="muted">Excluded Binance–Bybit pairs ({bybit.excluded.length})</summary><div className="tablebox" style={{ marginTop: 8 }}><table style={{ minWidth: 520 }}><thead><tr><th>Pair</th><th>Reason</th><th className="num">Min volume</th></tr></thead><tbody>{bybit.excluded.map((r: any) => <tr key={r.base}><td>{r.base}</td><td>{r.reasons.join("; ")}</td><td className="num">{usd(r.volume)}</td></tr>)}</tbody></table></div></details>}
        </>}
      </section>
    </div>
  );
}
