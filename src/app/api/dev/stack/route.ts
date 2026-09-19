/**
 * Dev-only stack control: status + (re)spawn. Keeps the anvil stack alive
 * through the sandbox's process reaper by spawning it as a child of this
 * Next.js server (the one process tree the environment keeps alive).
 *
 * Self-contained on purpose: route files hot-reload in dev, so the spawn
 * logic lives inline instead of behind an imported module that might be
 * cached in the server's module registry.
 */
export const dynamic = "force-dynamic";

import { spawn } from "node:child_process";
import { openSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const API_DIR = resolve(ROOT, "mini-services/api");

async function status() {
  const api = await fetch("http://localhost:3030/health", { signal: AbortSignal.timeout(1500) })
    .then((r) => r.ok)
    .catch(() => false);
  const chain = await fetch("http://127.0.0.1:8545", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 }),
    signal: AbortSignal.timeout(1500),
  })
    .then((r) => r.ok)
    .catch(() => false);
  return { api, chain };
}

function lockAlive() {
  try {
    const lockPath = resolve(API_DIR, "data", "stack.lock");
    if (!existsSync(lockPath)) return false;
    const pid = Number(readFileSync(lockPath, "utf8").trim());
    if (!Number.isFinite(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function GET() {
  return Response.json({ ...(await status()), lock: lockAlive() });
}

export async function POST(req: Request) {
  const force = new URL(req.url).searchParams.get("force") === "1";
  const current = await status();
  if (!force && (current.api || lockAlive())) {
    return Response.json({ ...current, spawned: false, reason: current.api ? "healthy" : "locked" });
  }
  if (force) {
    // Authoritative teardown first: concurrent orchestrators crossfire pkills.
    await new Promise<void>((resolve) => {
      const killer = spawn("bash", ["-c", "pkill -f 'dev-real.sh' 2>/dev/null; pkill -f 'src/server.ts' 2>/dev/null; sleep 2; true"], { stdio: "ignore" });
      killer.on("exit", () => resolve());
    });
  }
  const logPath = resolve(API_DIR, "data", "stack.log");
  mkdirSync(resolve(API_DIR, "data"), { recursive: true });
  const out = openSync(logPath, "a");
  const child = spawn("bash", [resolve(API_DIR, "scripts/dev-real.sh")], {
    cwd: API_DIR,
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, PORT: "3030", PATH: `${resolve(ROOT, ".foundry/bin")}:${process.env.PATH ?? ""}` },
  });
  child.unref();
  return Response.json({ spawned: true, pid: child.pid });
}
