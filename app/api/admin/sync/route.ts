import { isAdmin } from "@/lib/auth";
import { q, SCHEMA } from "@/lib/db";
import { refreshLive, refreshPairs, syncHistory } from "@/lib/sync";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** POST {step:"check"} | {step:"init"} | {step:"batch", since} - admin password required. */
export async function POST(req: Request) {
  if (!isAdmin(req)) return Response.json({ error: "Wrong password" }, { status: 401 });
  try {
    const body = await req.json();
    if (body.step === "check") return Response.json({ ok: true });
    if (body.step === "init") {
      const since = new Date().toISOString();
      for (const s of SCHEMA) await q(s);
      const pairs = await refreshPairs();
      await refreshLive();
      return Response.json({ ok: true, pairs, since });
    }
    if (body.step === "batch") return Response.json({ ok: true, ...(await syncHistory(10, body.since)) });
    return Response.json({ error: "Unknown step" }, { status: 400 });
  } catch (e: any) {
    return Response.json({ error: String(e.message) }, { status: 500 });
  }
}
