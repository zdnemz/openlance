/**
 * Dev-only stack control: status + (re)spawn of the anvil chain stack.
 *
 * The API now runs inside this Next.js process (route handlers under /api),
 * so this route no longer supervises a separate API process — it only reports
 * API/chain health and can (re)spawn the anvil + contracts stack that
 * lives in scripts/anvil/dev-real.sh.
 */
export const dynamic = "force-dynamic";

import { spawn } from "node:child_process";
import { openSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const ANVIL_DIR = resolve(ROOT, "scripts/anvil");

async function status() {
  // API health is this very process — resolve the origin from the request.
  const chain = await fetch("http://127.0.0.1:8545", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 }),
    signal: AbortSignal.timeout(1500),
  })
    .then((r) => r.ok)
    .catch(() => false);
  return { api: true, chain };
}

export async function GET() {
  return Response.json(await status());
}

export async function POST(req: Request) {
  const force = new URL(req.url).searchParams.get("force") === "1";
  const current = await status();
  if (!force && current.chain) {
    return Response.json({ ...current, spawned: false, reason: "chain healthy" });
  }
  if (force) {
    // Authoritative teardown first: concurrent orchestrators crossfire pkills.
    await new Promise<void>((resolve) => {
      const killer = spawn("bash", ["-c", "pkill -f 'dev-real.sh' 2>/dev/null; sleep 2; true"], { stdio: "ignore" });
      killer.on("exit", () => resolve());
    });
  }
  const logPath = resolve(ANVIL_DIR, ".state", "stack.log");
  mkdirSync(resolve(ANVIL_DIR, ".state"), { recursive: true });
  const out = openSync(logPath, "a");
  const child = spawn("bash", [resolve(ANVIL_DIR, "dev-real.sh")], {
    cwd: ANVIL_DIR,
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, PATH: `${resolve(ROOT, ".foundry/bin")}:${process.env.PATH ?? ""}` },
  });
  child.unref();
  return Response.json({ spawned: true, pid: child.pid, note: "anvil chain stack only — API is in-process" });
}
