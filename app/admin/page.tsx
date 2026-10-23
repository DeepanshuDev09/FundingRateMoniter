"use client";
import Link from "next/link";
import { useRef, useState } from "react";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function Admin() {
  const [pw, setPw] = useState("");
  const [authed, setAuthed] = useState(false);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [progress, setProgress] = useState("");
  const [delay, setDelay] = useState(60);
  const stop = useRef(false);

  const add = (m: string) => setLog((l) => [`${new Date().toLocaleTimeString()}  ${m}`, ...l].slice(0, 200));
  const call = async (body: any) => {
    const r = await fetch("/api/admin/sync", { method: "POST", headers: { "Content-Type": "application/json", "x-admin-password": pw }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  };

  const login = async () => {
    try { await call({ step: "check" }); setAuthed(true); setLog([]); }
    catch (e: any) { add(e.message); }
  };

  const run = async () => {
    stop.current = false; setRunning(true); setLog([]);
    try {
      add("Updating pair list and live funding rates...");
      const init = await call({ step: "init" });
      add(`${init.pairs} common pairs found. Syncing history, 10 pairs per batch.`);
      let done = 0;
      while (!stop.current) {
        const b = await call({ step: "batch", since: init.since });
        done += b.results.length;
        const bad = b.results.filter((r: any) => !r.ok);
        add(`Synced ${b.results.map((r: any) => r.base).join(", ")}`);
        bad.forEach((r: any) => add(`  failed ${r.base}: ${r.error}`));
        setProgress(`${done} of ${init.pairs} pairs done, ${b.remaining} left`);
        if (b.remaining === 0 || b.results.length === 0) { add("All pairs synced. Users can see the new data now."); break; }
        for (let s = delay; s > 0 && !stop.current; s--) { setProgress(`${done} of ${init.pairs} pairs done. Next batch in ${s}s`); await sleep(1000); }
      }
      if (stop.current) add("Stopped. Run again to continue; finished pairs are skipped only within one run.");
    } catch (e: any) { add(`Error: ${e.message}`); }
    setRunning(false);
  };

  return (
    <div className="wrap" style={{ maxWidth: 720 }}>
      <Link className="back" href="/">Back to pairs</Link>
      <h1>Admin sync</h1>
      {!authed ? (
        <div className="box">
          <div className="fields" style={{ gridTemplateColumns: "1fr" }}>
            <label>Admin password
              <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && login()} />
            </label>
          </div>
          <button onClick={login}>Sign in</button>
          {log[0] && <p className="loss">{log[0]}</p>}
        </div>
      ) : (
        <div className="box">
          <p className="sub">Updates the pair list and live rates, then downloads funding history for every pair, 10 pairs at a time, and saves it to the database. Keep this tab open while it runs.</p>
          <div className="bar">
            <label>Wait between batches
              <select value={delay} onChange={(e) => setDelay(Number(e.target.value))} disabled={running}>
                <option value={60}>60 seconds</option><option value={30}>30 seconds</option><option value={10}>10 seconds</option>
              </select>
            </label>
            {!running ? <button onClick={run}>Sync all pairs</button> : <button onClick={() => (stop.current = true)}>Stop</button>}
          </div>
          {progress && <p><b>{progress}</b></p>}
          <div className="note" style={{ maxHeight: 300, overflow: "auto", whiteSpace: "pre-wrap" }}>{log.join("\n")}</div>
        </div>
      )}
    </div>
  );
}
