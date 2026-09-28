/**
 * Self-check for the one-signature-per-login rule (run: pnpm check:login).
 *
 * `loginWithWallet()` is the only thing standing between a wallet connect and a
 * stream of signature popups. It has two credential paths (EIP-712 voucher /
 * SIWE personal_sign) and used to be able to show THREE popups for one login:
 * a declined voucher silently fell through to SIWE, which then asked for a
 * second EIP-712 signature to arm gasless. This drives the real module against
 * a stubbed provider and counts the popups.
 *
 * The rule: every path signs AT MOST ONCE, and a successful one signs exactly
 * once. A declined prompt is still a popup — re-prompting with a *different*
 * message after the user said no is the bug.
 *
 * No network and no DOM library: fetch, the injected provider and the two
 * globals zustand's `persist` touches are stubbed.
 */

let failures = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) console.log(`  ok    ${name}`);
  else {
    console.error(`  FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
    failures++;
  }
}

const ADDRESS = "0x1111111111111111111111111111111111111111";
const SESSION_ID = `0x${"c".repeat(64)}` as const;

/** Minimal `window` + `localStorage` — all zustand `persist` and the module need. */
function installGlobals() {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  (globalThis as Record<string, unknown>).localStorage = localStorage;
}

/**
 * Injected provider that records every signing method it is asked for.
 * `rejectFirst: n` declines the first n prompts and approves the rest — the
 * realistic "user said no to the first thing, then went along with it" shape
 * that made the old fall-through bug visible.
 */
function stubWallet(opts: { rejectFirst?: number } = {}) {
  const signs: string[] = [];
  (globalThis as Record<string, unknown>).window = {
    location: { origin: "https://openlance.test" },
    ethereum: {
      request: async ({ method }: { method: string }) => {
        if (method === "personal_sign" || method === "eth_signTypedData_v4") {
          signs.push(method);
          if (signs.length <= (opts.rejectFirst ?? 0)) throw new Error("User rejected the request");
          return `0x${"ab".repeat(65)}`;
        }
        if (method === "eth_chainId") return "0x7a69";
        return null;
      },
    },
  };
  return signs;
}

const OK_VOUCHER = {
  enabled: true,
  domain: { name: "OpenLance SponsorshipForwarder", version: "1", chainId: 31337, verifyingContract: `0x${"b".repeat(40)}` },
  types: { SponsorshipSession: [] },
  primaryType: "SponsorshipSession",
  message: { owner: ADDRESS, issuedAt: 1, expiry: 2, sessionId: SESSION_ID },
  forwardRequestTypes: { ForwardRequest: [] },
  sessionId: SESSION_ID,
};

const SIWE_NONCE = {
  nonce: "n",
  expiresInSeconds: 600,
  siwe: { domain: "openlance.test", chainId: 31337, statement: "Sign in to OpenLance" },
};

/** The sponsorship challenge the old code fetched to arm gasless after SIWE. */
const SPONSORSHIP_CHALLENGE = {
  enabled: true,
  domain: { name: "OpenLance SponsorshipForwarder", version: "1", chainId: 31337, verifyingContract: `0x${"b".repeat(40)}` },
  types: { SponsorshipSession: [] },
  primaryType: "SponsorshipSession",
  message: { owner: ADDRESS, issuedAt: 1, expiry: 2, sessionId: SESSION_ID },
  forwardRequestTypes: { ForwardRequest: [] },
  sessionId: SESSION_ID,
};

/** Stub the API: `routes` maps a path suffix to the `data` payload it returns. */
function stubFetch(routes: Record<string, unknown>) {
  (globalThis as Record<string, unknown>).fetch = async (url: string) => {
    // Drop origin AND query — the challenge endpoint is called with ?address=.
    const path = String(url).replace(/^https?:\/\/[^/]+/, "").split("?")[0]!;
    for (const [suffix, body] of Object.entries(routes)) {
      if (path.endsWith(suffix)) {
        return { ok: true, status: 200, json: async () => ({ data: body }) } as unknown as Response;
      }
    }
    return { ok: true, status: 200, json: async () => ({ data: {} }) } as unknown as Response;
  };
}

async function main() {
  installGlobals();
  const { loginWithWallet } = await import("../lib/siwe.ts");
  const { useWallet } = await import("../lib/wallet.ts");
  // connectInjected() normally does this; the signing helpers read the store.
  useWallet.setState({ kind: "injected", address: ADDRESS });

  console.log("login signature count");

  // 1. Forwarder configured → one EIP-712 voucher, no second prompt.
  {
    const signs = stubWallet();
    stubFetch({
      "/auth/voucher-challenge": OK_VOUCHER,
      "/auth/verify": {
        token: "t",
        user: { walletAddress: ADDRESS },
        sponsorship: { sessionId: SESSION_ID, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
      },
    });
    await loginWithWallet(ADDRESS);
    check("voucher login signs exactly once", signs.length === 1, `saw ${signs.length}: ${signs}`);
    check("voucher login uses EIP-712", signs[0] === "eth_signTypedData_v4", String(signs[0]));
  }

  // 2. No forwarder → one SIWE personal_sign, and no gasless popup after it.
  //    /auth/sponsorship stays reachable here: the old code called it and
  //    signed a second EIP-712 voucher, which is the second popup this asserts
  //    against.
  {
    const signs = stubWallet();
    stubFetch({
      "/auth/voucher-challenge": { enabled: false },
      "/auth/nonce": SIWE_NONCE,
      "/auth/sponsorship": SPONSORSHIP_CHALLENGE,
      "/auth/verify": { token: "t", user: { walletAddress: ADDRESS } },
    });
    await loginWithWallet(ADDRESS);
    check("SIWE login signs exactly once", signs.length === 1, `saw ${signs.length}: ${signs}`);
    check("SIWE login uses personal_sign", signs[0] === "personal_sign", String(signs[0]));
  }

  // 3. Declining the voucher must NOT re-prompt with a different message —
  //    that is how one login used to become three popups. The user declines the
  //    first prompt and approves anything after, so a silent fall-through to
  //    SIWE + a gasless voucher would show up as 3.
  {
    const signs = stubWallet({ rejectFirst: 1 });
    stubFetch({
      "/auth/voucher-challenge": OK_VOUCHER,
      "/auth/nonce": SIWE_NONCE,
      "/auth/sponsorship": SPONSORSHIP_CHALLENGE,
      "/auth/verify": { token: "t", user: { walletAddress: ADDRESS } },
    });
    let threw = false;
    try {
      await loginWithWallet(ADDRESS);
    } catch {
      threw = true;
    }
    check("declined voucher propagates", threw);
    check("declined voucher asks once, not twice", signs.length === 1, `saw ${signs.length}: ${signs}`);
  }

  // 4. A rejected verify after a real signature must not re-prompt either.
  {
    const signs = stubWallet();
    (globalThis as Record<string, unknown>).fetch = async (url: string) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, "").split("?")[0]!;
      if (path.endsWith("/auth/voucher-challenge")) return { ok: true, status: 200, json: async () => ({ data: OK_VOUCHER }) } as unknown as Response;
      if (path.endsWith("/auth/nonce")) return { ok: true, status: 200, json: async () => ({ data: SIWE_NONCE }) } as unknown as Response;
      if (path.endsWith("/auth/sponsorship")) return { ok: true, status: 200, json: async () => ({ data: SPONSORSHIP_CHALLENGE }) } as unknown as Response;
      return { ok: false, status: 400, json: async () => ({ error: { code: "bad_request", message: "Login challenge unknown" } }) } as unknown as Response;
    };
    let threw = false;
    try {
      await loginWithWallet(ADDRESS);
    } catch {
      threw = true;
    }
    check("failed verify propagates", threw);
    check("failed verify does not re-prompt", signs.length === 1, `saw ${signs.length}: ${signs}`);
  }

  // 5. The voucher path must arm gasless; the SIWE path must not inherit a
  //    sponsorship session left in localStorage by an earlier sign-in.
  {
    const { useSponsorship } = await import("../lib/sponsorship-store.ts");
    const signs = stubWallet();
    stubFetch({
      "/auth/voucher-challenge": OK_VOUCHER,
      "/auth/verify": {
        token: "t",
        user: { walletAddress: ADDRESS },
        sponsorship: { sessionId: SESSION_ID, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
      },
    });
    await loginWithWallet(ADDRESS);
    check("voucher login arms gasless", useSponsorship.getState().isActive());

    const siweSigns = stubWallet();
    stubFetch({ "/auth/voucher-challenge": { enabled: false }, "/auth/nonce": SIWE_NONCE, "/auth/verify": { token: "t", user: { walletAddress: ADDRESS } } });
    await loginWithWallet(ADDRESS);
    check("SIWE login clears a stale gasless session", !useSponsorship.getState().isActive());
    check("SIWE login still signs exactly once", siweSigns.length === 1, `saw ${siweSigns.length}: ${siweSigns}`);
  }

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nlogin signature count ok");
}

void main();
