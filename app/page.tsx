"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { cls, dirLabel, freshness, pct, signedPct, usd } from "@/lib/format";

type Row = any;
const CACHE_KEY = "pairs-cache-v1";

const COLS: { key: string; label: string; num?: boolean; get: (r: Row) => any; render: (r: Row) => React.ReactNode }[] = [
  { key: "live_apr", label: "Now (APR)", num: true, get: (r) => r.live_apr, render: (r) => <span className="gain">{pct(r.live_apr, 0)}</span> },
  { key: "ret7", label: "7d", num: true, get: (r) => r.ret7, render: (r) => <span className={cls(r.ret7)}>{signedPct(r.ret7)}</span> },
  { key: "ret30", label: "30d gross", num: true, get: (r) => r.ret30, render: (r) => <span className={cls(r.ret30)}>{signedPct(r.ret30)}</span> },
  { key: "net30", label: "30d net", num: true, get: (r) => r.net30, render: (r) => <span className={cls(r.net30)}>{signedPct(r.net30)}</span> },
  { key: "net90", label: "3-mo net", num: true, get: (r) => r.net90, render: (r) => <span className={cls(r.net90)}>{signedPct(r.net90)}</span> },
  { key: "apr", label: "30d APR", num: true, get: (r) => r.apr, render: (r) => pct(r.apr, 0) },
  { key: "trend3_apr", label: "3d APR", num: true, get: (r) => r.trend3_apr,
    render: (r) => <span className={r.trend3_apr != null && r.apr != null && r.trend3_apr < r.apr * 0.5 ? "warn" : ""}>{pct(r.trend3_apr, 0)}</span> },
  { key: "consistency", label: "Positive days", num: true, get: (r) => r.consistency, render: (r) => pct(r.consistency, 0) },
  { key: "sign_flips", label: "Flips", num: true, get: (r) => r.sign_flips, render: (r) => r.sign_flips ?? "-" },
  { key: "basis", label: "Basis", num: true, get: (r) => r.basis, render: (r) => signedPct(r.basis) },
  { key: "volume", label: "Min 24h vol", num: true, get: (r) => r.volume, render: (r) => usd(r.volume) },
];

export default function Home() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updated, setUpdated] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [minVol, setMinVol] = useState(0);
  const [minCons, setMinCons] = useState(0);
  const [onlyNet, setOnlyNet] = useState(false);
  const [onlyWatch, setOnlyWatch] = useState(false);
  const [watch, setWatch] = useState<string[]>([]);
  const [sort, setSort] = useState({ key: "net30", dir: -1 });

  // Browser cache: show last data instantly, then refresh from the API every minute.
  useEffect(() => {
    try {
      const w = localStorage.getItem("watchlist"); if (w) setWatch(JSON.parse(w));
      const c = localStorage.getItem(CACHE_KEY);
      if (c) { const o = JSON.parse(c); setRows(o.rows); setUpdated(o.at); setLoading(false); }
    } catch {}
    const load = async () => {
      try {
        const r = await fetch("/api/pairs");
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || r.statusText);
        setRows(j); setUpdated(Date.now()); setError("");
        try { localStorage.setItem(CACHE_KEY, JSON.stringify({ rows: j, at: Date.now() })); } catch {}
      } catch (e: any) { setError(e.message); }
      setLoading(false);
    };
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, []);

  const toggle = (b: string) => {
    const n = watch.includes(b) ? watch.filter((x) => x !== b) : [...watch, b];
    setWatch(n); try { localStorage.setItem("watchlist", JSON.stringify(n)); } catch {}
  };

  const shown = useMemo(() => {
    const col = COLS.find((c) => c.key === sort.key)!;
    return rows
      .filter((r) => r.base.toLowerCase().includes(q.toLowerCase()))
      .filter((r) => (r.volume ?? 0) >= minVol)
      .filter((r) => (r.consistency ?? 0) >= minCons)
      .filter((r) => !onlyNet || (r.net30 ?? -1) > 0)
      .filter((r) => !onlyWatch || watch.includes(r.base))
      .sort((a, b) => {
        const x = col.get(a), y = col.get(b);
        if (x == null) return 1; if (y == null) return -1;
        return (x - y) * sort.dir;
      });
  }, [rows, q, minVol, minCons, onlyNet, onlyWatch, watch, sort]);

  const synced = rows.filter((r) => r.last_synced_at).length;

  return (
    <div className="wrap">
      <h1>Funding spread monitor</h1>
      <p className="sub">
        Funding earned by holding opposite perpetual positions on Delta Exchange India and Binance Futures.
        Returns are on one leg&apos;s notional, before slippage and basis moves; net subtracts four taker fees.
      </p>

      <div className="bar">
        <label>Search<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="BTC, ETH..." /></label>
        <label>Min 24h volume
          <select value={minVol} onChange={(e) => setMinVol(Number(e.target.value))}>
            <option value={0}>Any</option><option value={1e5}>$100K</option><option value={1e6}>$1M</option>
            <option value={1e7}>$10M</option><option value={1e8}>$100M</option>
          </select>
        </label>
        <label>Min positive days
          <select value={minCons} onChange={(e) => setMinCons(Number(e.target.value))}>
            <option value={0}>Any</option><option value={0.5}>50%</option><option value={0.7}>70%</option><option value={0.9}>90%</option>
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={onlyNet} onChange={(e) => setOnlyNet(e.target.checked)} />Net positive only</label>
        <label className="check"><input type="checkbox" checked={onlyWatch} onChange={(e) => setOnlyWatch(e.target.checked)} />Watchlist only</label>
        <a href="/api/export"><button type="button">Download CSV</button></a>
      </div>

      {error && <div className="err"><b>Couldn&apos;t load data.</b> {error}. If this is a fresh deploy, run the setup call from the README.</div>}

      <div className="tablebox">
        <table>
          <thead>
            <tr>
              <th aria-label="Watchlist" />
              <th onClick={() => setSort({ key: "base", dir: 1 })}>Pair</th>
              <th>Best direction</th>
              {COLS.map((c) => (
                <th key={c.key} className={c.num ? "num" : ""}
                    onClick={() => setSort((s) => ({ key: c.key, dir: s.key === c.key ? -s.dir : -1 }))}>
                  {c.label}{sort.key === c.key ? (sort.dir === -1 ? " ▾" : " ▴") : ""}
                </th>
              ))}
              <th>Synced</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const f = freshness(r.last_synced_at);
              return (
                <tr key={r.base}>
                  <td><button className={`star ${watch.includes(r.base) ? "on" : ""}`} onClick={() => toggle(r.base)}
                      aria-label={`Watch ${r.base}`}>{watch.includes(r.base) ? "★" : "☆"}</button></td>
                  <td><Link className="pairname" href={`/pair/${r.base}`}>{r.base}</Link></td>
                  <td className="dir">{dirLabel(r.direction ?? r.live_direction)}</td>
                  {COLS.map((c) => <td key={c.key} className="num">{c.render(r)}</td>)}
                  <td><span className={`dot ${f.c}`} />{f.t}</td>
                </tr>
              );
            })}
            {!shown.length && (
              <tr><td colSpan={COLS.length + 4} className="empty">
                {loading ? "Loading pairs..." : rows.length ? "No pairs match these filters." : "No data yet. History fills in at about 10 pairs per minute after setup."}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="status">
        <span>{rows.length} common pairs</span>
        <span>{synced} with history</span>
        <Link href="/admin" className="muted">Admin</Link>
        {updated && <span>Page refreshed {new Date(updated).toLocaleTimeString()}</span>}
      </div>
      <p className="note">
        Past funding does not predict future funding: compare the 3d APR column to the 30d APR before entering.
        Basis is Delta mark price versus Binance mark price; a wide gap can erase funding gains when you close.
      </p>
    </div>
  );
}