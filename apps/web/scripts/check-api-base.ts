/**
 * Self-check for WHERE THE API LIVES (run: pnpm check:api-base).
 *
 * The web app reaches the API one of two ways, decided in `lib/api-base.ts`:
 *
 *   - a SEPARATE origin (`NEXT_PUBLIC_API_BASE=http://…`): `pnpm dev`, Caddy,
 *     CI. Every call is cross-origin and absolute.
 *   - the SAME origin (`NEXT_PUBLIC_API_BASE=` — empty): the Vercel services
 *     deployment, where the root vercel.json rewrites `/api/(.*)` to the api
 *     service on the page's own domain. Calls are the relative `/api/...`.
 *
 * Everything written for the first mode has to survive the second, and the two
 * places that cannot use a relative URL are the ones that break quietly:
 *
 *   - `wallet_addEthereumChain` wants an ABSOLUTE rpc URL; a relative `/api/rpc`
 *     would be stored by the wallet as a dead endpoint.
 *   - the proxy's server-side `fetch` of `/api/jobs/<id>` needs an ABSOLUTE URL;
 *     Node's fetch throws on a relative one, the proxy fails open, and the
 *     awarded-job redirect silently stops working with no error anywhere.
 *     (check-job-redirect.ts alone cannot catch that — its stub ignores the URL.)
 *
 * `lib/api-base.ts` reads the variable once, at module load, so each mode runs
 * in its own child process (same loader, same script). A last group loads the
 * REAL `next.config.ts` under different environments to pin the build-time
 * default: empty on Vercel when the variable is missing, untouched everywhere
 * else, and an explicit value (even an empty one) always wins.
 *
 * No network, no browser: `fetch`, `window` and the wallet are stubbed, and the
 * fetch stub parses the URL the way Node does (a relative URL throws).
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) console.log(`  ok    ${name}`);
  else {
    console.error(`  FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
    failures++;
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/** The page / request origin the tests pretend to be served from. */
const ORIGIN = "https://app.example.com";
const EXPLICIT = "http://api.invalid:12322";
const LOCAL_DEFAULT = "http://localhost:4000";

const JOB_ID = "11111111-2222-3333-4444-555555555555";
const PROJECT_ID = "99999999-8888-7777-6666-555555555555";
const WALLET = "0x3333333333333333333333333333333333333333";

/* ═════════════════════════ child: one mode, real modules ═════════════════════ */

/** The base this child was started with — the module under test must agree. */
async function child(expectBase: string) {
  const urls: { url: string; xff: string | null; signal: boolean }[] = [];
  let apiDown = false;
  // What Node's fetch does with a URL: a relative one throws a TypeError.
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    new URL(String(url));
    urls.push({ url: String(url), xff: new Headers(init?.headers).get("x-forwarded-for"), signal: init?.signal instanceof AbortSignal });
    if (apiDown) throw new Error("API unreachable");
    return Response.json({ data: { projectId: PROJECT_ID } });
  }) as typeof fetch;

  /** The rpcUrls a real wallet would have stored, from the last add call. */
  let added: string[] = [];
  (globalThis as unknown as { window: unknown }).window = {
    location: { origin: ORIGIN },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    ethereum: {
      request: ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method === "eth_chainId") return Promise.resolve("0x1");
        // 4902 = the wallet has never heard of this chain → ends in the add call.
        if (method === "wallet_switchEthereumChain") return Promise.reject({ code: 4902, message: "Unrecognized chain ID" });
        if (method === "wallet_addEthereumChain") {
          added = ((params?.[0] as { rpcUrls?: string[] })?.rpcUrls) ?? [];
          return Promise.resolve(null);
        }
        return Promise.reject(new Error("unstubbed: " + method));
      },
    },
  };

  const { API_BASE } = await import("../lib/api-base.ts");
  const { apiUrl, fileUrl } = await import("../lib/api.ts");
  const { relayRpcUrl, ensureChain } = await import("../lib/wallet.ts");
  const { NextRequest } = await import("next/server");
  const { proxy } = await import("../proxy.ts");

  const same = expectBase === "";
  const apiOrigin = same ? ORIGIN : expectBase;

  console.log("the base is what the build said");
  check(`API_BASE is ${JSON.stringify(expectBase)}`, API_BASE === expectBase, JSON.stringify(API_BASE));

  console.log("the page's own calls");
  check("apiUrl('/overview')", apiUrl("/overview") === `${expectBase}/api/overview`, apiUrl("/overview"));
  check("apiUrl without a leading slash", apiUrl("overview") === `${expectBase}/api/overview`, apiUrl("overview"));
  if (same) check("same-origin means RELATIVE urls", apiUrl("/overview").startsWith("/api/"), apiUrl("/overview"));
  check("relayRpcUrl()", relayRpcUrl() === `${expectBase}/api/rpc`, relayRpcUrl());

  console.log("file URLs");
  const local = "http://api.internal:4000/api/files/abc/raw?exp=1&sig=x";
  check("a local-driver URL keeps path + query on the API base", fileUrl(local) === `${expectBase}/api/files/abc/raw?exp=1&sig=x`, fileUrl(local));
  const signed = "https://x.supabase.co/storage/v1/object/sign/openlance/p/CV.pdf?token=a.b.c";
  check("a supabase signed URL is returned verbatim", fileUrl(signed) === signed, fileUrl(signed));
  check("empty string and relative paths are left alone", fileUrl("") === "" && fileUrl("/api/files/abc/raw") === "/api/files/abc/raw");

  console.log("the wallet is handed an ABSOLUTE url");
  await ensureChain(31337);
  check("the relay fallback is on the API origin", added[0] === `${apiOrigin}/api/rpc`, JSON.stringify(added));
  check("and is a full http(s) URL", /^https?:\/\//.test(added[0] ?? "") && new URL(added[0] ?? "").pathname === "/api/rpc", JSON.stringify(added));
  await ensureChain(31337, "http://127.0.0.1:8545");
  check("a published node URL still wins", added[0] === "http://127.0.0.1:8545", JSON.stringify(added));

  console.log("the proxy's server-side read is ABSOLUTE");
  const GATE = "el_onboarded=1; el_role=client";
  const jobRequest = (headers: Record<string, string> = {}, search = "") =>
    new NextRequest(`${ORIGIN}/jobs/${JOB_ID}${search}`, { headers: { cookie: GATE, ...headers } });
  const res = await proxy(jobRequest({ "x-forwarded-for": "203.0.113.7" }));
  const seen = urls.at(-1);
  check(`it reads ${apiOrigin}/api/jobs/<id>`, seen?.url === `${apiOrigin}/api/jobs/${JOB_ID}`, seen?.url);
  check("and still 307s to the room with the fromJob breadcrumb", res.status === 307 && new URL(res.headers.get("location")!).pathname + new URL(res.headers.get("location")!).search === `/projects/${PROJECT_ID}?fromJob=${JOB_ID}`, res.headers.get("location") ?? String(res.status));
  check("keeps the visitor's IP for the read limiter", seen?.xff === "203.0.113.7", String(seen?.xff));
  check("bounded by a timeout, so a hung API cannot hang the page", seen?.signal === true);

  const before = urls.length;
  await proxy(jobRequest({}, "?stay=1"));
  check("?stay=1 never calls the API", urls.length === before);
  apiDown = true;
  const down = await proxy(jobRequest());
  check("an unreachable API still renders the page", down.status < 300 || down.status >= 400, String(down.status));

  if (failures) process.exit(1);
}

/* ═══════════════════════════ parent: orchestrate + static ═══════════════════ */

function run(args: string[], env: Record<string, string | undefined>) {
  // Same node, same loader flags tsx started this process with.
  return spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), ...args], {
    env: { ...process.env, VERCEL: undefined, NEXT_PUBLIC_API_BASE: undefined, ...env },
    encoding: "utf8",
  });
}

function mode(title: string, base: string, env: Record<string, string | undefined>) {
  console.log(`\n══ ${title} ══`);
  const out = run(["child", base], env);
  process.stdout.write(out.stdout);
  process.stderr.write(out.stderr);
  check(`${title}: every assertion passed`, out.status === 0, `exit ${out.status}`);
}

/** The `env` the real next.config.ts hands Next under this environment. */
function configEnv(env: Record<string, string | undefined>): unknown {
  const out = run(["config"], env);
  if (out.status !== 0) return `error: ${out.stderr}`;
  return JSON.parse(out.stdout.split("\n").filter(Boolean).at(-1) ?? "null");
}

/** Every source file the app ships, minus tooling that legitimately names the variable. */
function appSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (["node_modules", ".next", "scripts", "public"].includes(name) || name.startsWith("next.config")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) appSources(path, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name) && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

function parent() {
  mode("separate API origin (NEXT_PUBLIC_API_BASE=http://…)", EXPLICIT, { NEXT_PUBLIC_API_BASE: EXPLICIT });
  mode("same origin (NEXT_PUBLIC_API_BASE empty)", "", { NEXT_PUBLIC_API_BASE: "" });
  mode("unset (the local default)", LOCAL_DEFAULT, {});

  console.log("\n══ the build-time default (next.config.ts) ══");
  const vercelUnset = configEnv({ VERCEL: "1" });
  check("on Vercel, a missing variable defaults to the EMPTY string (same origin)", JSON.stringify(vercelUnset) === JSON.stringify({ NEXT_PUBLIC_API_BASE: "" }), JSON.stringify(vercelUnset));
  const localUnset = configEnv({});
  check("off Vercel nothing is injected (dev / CI / self-hosted build exactly as before)", localUnset === null, JSON.stringify(localUnset));
  const vercelExplicit = configEnv({ VERCEL: "1", NEXT_PUBLIC_API_BASE: "https://api.example.com" });
  check("on Vercel an explicit base is left to Next's own inlining", vercelExplicit === null, JSON.stringify(vercelExplicit));
  const vercelEmpty = configEnv({ VERCEL: "1", NEXT_PUBLIC_API_BASE: "" });
  check("on Vercel an explicit EMPTY base is not overridden", vercelEmpty === null, JSON.stringify(vercelEmpty));
  const ci = configEnv({ NEXT_PUBLIC_API_BASE: LOCAL_DEFAULT });
  check("CI's explicit http://localhost:4000 is untouched", ci === null, JSON.stringify(ci));

  console.log("\n══ the base is decided in exactly one place ══");
  const readers = appSources(ROOT).filter((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .some((line) => /process\.env\.NEXT_PUBLIC_API_BASE/.test(line) && !/^\s*(\*|\/\/|\/\*)/.test(line)),
  );
  const rel = readers.map((f) => f.slice(ROOT.length + 1));
  check("only lib/api-base.ts reads NEXT_PUBLIC_API_BASE", rel.length === 1 && rel[0] === join("lib", "api-base.ts"), rel.join(", ") || "(none)");
  const base = readFileSync(join(ROOT, "lib", "api-base.ts"), "utf8");
  check("it uses ?? so an empty string is a value, not 'missing'", /process\.env\.NEXT_PUBLIC_API_BASE\s*\?\?/.test(base) && !/process\.env\.NEXT_PUBLIC_API_BASE\s*\|\|/.test(base));
  const proxySrc = readFileSync(join(ROOT, "proxy.ts"), "utf8");
  const imports = [...proxySrc.matchAll(/^import .* from ['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  check("proxy.ts imports stay dependency-free", imports.every((i) => i === "next/server" || i === "@/lib/role-routes" || i === "@/lib/api-base"), imports.join(", "));
  const baseImports = [...base.matchAll(/^import .* from ['"]([^'"]+)['"]/gm)];
  check("and lib/api-base.ts imports nothing", baseImports.length === 0);

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall checks passed");
}

/* ═════════════════════════════════ dispatch ═════════════════════════════════ */

async function main() {
  const [, , role, arg] = process.argv;
  if (role === "child") return child(arg ?? "");
  if (role === "config") {
    const { default: nextConfig } = await import("../next.config.ts");
    console.log(JSON.stringify(nextConfig.env ?? null));
    return;
  }
  parent();
}

main();
