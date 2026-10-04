/**
 * Self-check for the awarded-job redirect in the edge proxy
 * (run: pnpm check:job-redirect).
 *
 * `/jobs/:id` is a stale address the moment a proposal is accepted — the work
 * lives in the project room. The proxy answers that as a 307 so the posting
 * never paints. This drives the real `proxy()` against a stubbed API and
 * asserts the decision on both sides of the rule.
 *
 * The rule: a `/jobs/<uuid>` request whose job has a project redirects to that
 * room (carrying `fromJob` so the room's "not yours to see" wall can link
 * back), and EVERYTHING else passes through — `?stay=1`, an unawarded job, a
 * draft the API refuses, an API that is down, and any path that is not a job.
 *
 * It must also stay behind the two gates above it: an un-onboarded visitor and
 * a wrong-seat hit are still answered by those, never by this redirect.
 *
 * No network: `fetch` is stubbed and the API base points at a dead host.
 */

export {}; // module scope — the sibling check scripts declare the same helpers

let failures = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) console.log(`  ok    ${name}`);
  else {
    console.error(`  FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
    failures++;
  }
}

process.env.NEXT_PUBLIC_API_BASE = "http://api.invalid";

// Must be set before the proxy module is imported — it reads the base at load.
const JOB_ID = "11111111-2222-3333-4444-555555555555";
const PROJECT_ID = "99999999-8888-7777-6666-555555555555";

type JobRead = { ok?: boolean; projectId?: string | null; throw?: boolean; forwardedFor?: string | null; url?: string; redirectMode?: string };

let api: JobRead = { ok: true, projectId: null };
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  // Parse it the way Node does: a relative URL throws, which the proxy would
  // swallow (it fails open) — so the stub must be the one to say so.
  new URL(String(url));
  api.url = String(url);
  api.forwardedFor = new Headers(init?.headers).get("x-forwarded-for");
  api.redirectMode = init?.redirect;
  if (api.throw) throw new Error("API unreachable");
  const ok = api.ok ?? true;
  return Response.json(
    ok ? { data: { projectId: api.projectId ?? null } } : { error: { code: "forbidden", message: "nope" } },
    { status: ok ? 200 : 403 },
  );
}) as typeof fetch;

async function main() {
  const { NextRequest } = await import("next/server");
  const { proxy, config } = await import("../proxy.ts");

  /** Cookies the API stamps for a verified, seated user. */
  const GATE = { el_onboarded: "1", el_role: "client" };

  function request(path: string, headers: Record<string, string> = {}) {
    return new NextRequest(`http://localhost:12321${path}`, { headers: { cookie: Object.entries(GATE).map(([k, v]) => `${k}=${v}`).join("; "), ...headers } });
  }

  /** `null` = pass through; otherwise the redirect target. */
  async function redirectFor(path: string, headers?: Record<string, string>): Promise<string | null> {
    const res = await proxy(request(path, headers));
    if (res.status < 300 || res.status >= 400) return null;
    const location = new URL(res.headers.get("location")!);
    return location.pathname + location.search;
  }

  console.log("awarded job redirects to the room");
  api = { ok: true, projectId: PROJECT_ID };
  check("carries the room + fromJob breadcrumb", (await redirectFor(`/jobs/${JOB_ID}`)) === `/projects/${PROJECT_ID}?fromJob=${JOB_ID}`);
  await redirectFor(`/jobs/${JOB_ID}`, { "x-forwarded-for": "203.0.113.7" });
  check("keeps the visitor's IP for the read limiter", api.forwardedFor === "203.0.113.7", `saw ${api.forwardedFor}`);
  // The same-origin (empty base) case is pinned in check-api-base.ts.
  check("reads the job from the configured API base", api.url === `http://api.invalid/api/jobs/${JOB_ID}`, `saw ${api.url}`);

  check("never follows a redirect from the API", api.redirectMode === "manual", `saw ${api.redirectMode}`);

  console.log("everything else passes through");
  check("?stay=1 stays on the posting", (await redirectFor(`/jobs/${JOB_ID}?stay=1`)) === null);
  api = { ok: true, projectId: null };
  check("an unawarded job renders", (await redirectFor(`/jobs/${JOB_ID}`)) === null);
  api = { ok: false };
  check("a refused read (draft) renders", (await redirectFor(`/jobs/${JOB_ID}`)) === null);
  api = { throw: true };
  check("an unreachable API renders", (await redirectFor(`/jobs/${JOB_ID}`)) === null);
  api = { ok: true, projectId: PROJECT_ID };
  check("/jobs (the list) is untouched", (await redirectFor("/jobs")) === null);
  check("/jobs/new is untouched", (await redirectFor("/jobs/new")) === null);

  console.log("the proxy never sees the API");
  // Next compiles the matcher as a path-to-regexp pattern; the lookahead is plain
  // regex, so the negative-lookahead part can be exercised directly.
  const matcher = new RegExp(`^${config.matcher[0]}$`);
  check("/api/* is outside the matcher", !matcher.test("/api/auth/nonce") && !matcher.test("/api/health"));
  check("pages are still inside it", matcher.test("/dashboard") && matcher.test("/jobs/x") && matcher.test("/"));
  check("a page that merely starts with 'api' is still guarded", matcher.test("/apiary"));

  console.log("the gates above still win");
  const anon = new NextRequest(`http://localhost:12321/jobs/${JOB_ID}`);
  check("un-onboarded → /onboarding", new URL((await proxy(anon)).headers.get("location")!).pathname === "/onboarding");
  const arbiter = new NextRequest(`http://localhost:12321/jobs/${JOB_ID}`, {
    headers: { cookie: "el_onboarded=1; el_role=arbiter" },
  });
  check("wrong seat → /dashboard", new URL((await proxy(arbiter)).headers.get("location")!).pathname === "/dashboard");
  const room = await proxy(request(`/projects/${PROJECT_ID}`));
  check("the room itself is never redirected", room.status < 300 || room.status >= 400);

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall checks passed");
}

main();
