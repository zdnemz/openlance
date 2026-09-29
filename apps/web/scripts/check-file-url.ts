/**
 * Self-check for `fileUrl` (run: pnpm check:file-url).
 *
 * `fileUrl` re-points an API-built absolute URL at the public API origin so
 * uploads and local-driver downloads land on the origin that checks the
 * signature. It must NOT touch a URL on a foreign origin.
 *
 * The rule: `/api/*` is re-pointed at API_BASE; everything else — notably the
 * supabase driver's signed URL, whose token IS the credential and whose host
 * is the only server that serves it — is returned untouched.
 *
 * No network: API_BASE points at a dead host.
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

const API_BASE = "http://api.invalid";

async function main() {
  // Must be set before the module is imported — it reads the base at load.
  process.env.NEXT_PUBLIC_API_BASE = API_BASE;
  const { fileUrl } = await import("../lib/api.ts");

  console.log("API URLs are re-pointed at the public API origin");
  check(
    "upload target keeps path + query",
    fileUrl("http://api.internal:4000/api/files/abc/raw") === `${API_BASE}/api/files/abc/raw`,
    fileUrl("http://api.internal:4000/api/files/abc/raw"),
  );
  check(
    "local signed download keeps exp + sig",
    fileUrl("http://api.internal:4000/api/files/abc/raw?exp=1&sig=x") === `${API_BASE}/api/files/abc/raw?exp=1&sig=x`,
    fileUrl("http://api.internal:4000/api/files/abc/raw?exp=1&sig=x"),
  );

  console.log("foreign origins pass through untouched");
  const signed =
    "https://vyljqnvdstccodwqcstk.supabase.co/storage/v1/object/sign/openlance/p/a/CV.pdf?token=abc.def.ghi";
  check("supabase signed URL is returned verbatim", fileUrl(signed) === signed, fileUrl(signed));
  check("a /storage path is never re-pointed at the API", !fileUrl(signed).startsWith(API_BASE));

  console.log("non-URLs are left alone");
  check("empty string", fileUrl("") === "");
  check("relative path", fileUrl("/api/files/abc/raw") === "/api/files/abc/raw");

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall checks passed");
}

main();
