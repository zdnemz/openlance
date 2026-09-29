/**
 * Self-check for the EIP-712 payload the wallet is actually handed
 * (run: pnpm check:eip712).
 *
 * `signTypedData()` used to send `types: { EIP712Domain: [], ... }`. An empty
 * domain-type list makes the signer hash a domain with ZERO fields, so the
 * signature recovers to some other address instead of the signer. The server
 * then rejects every voucher with "Login voucher signature does not match" —
 * and every sponsored ForwardRequest the same way. The contract test did not
 * catch it because it hashes with viem directly and never went through the
 * client's payload construction.
 *
 * The rule: the payload's `EIP712Domain` must describe the domain's own
 * fields, so the digest a wallet computes from the payload equals the digest
 * the server computes from `domain` alone.
 */
import { getAddress, hashTypedData, recoverAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { useWallet } from "../lib/wallet.ts";

let failures = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) console.log(`  ok    ${name}`);
  else {
    console.error(`  FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
    failures++;
  }
}

const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const ADDRESS = account.address;

const FORWARDER = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512" as const;
const SESSION_TYPES = {
  SponsorshipSession: [
    { name: "owner", type: "address" },
    { name: "issuedAt", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "sessionId", type: "bytes32" },
  ],
} as const;

/** Mirrors FORWARD_REQUEST_TYPES in apps/api/src/modules/sponsorship.ts. */
const FORWARD_REQUEST_TYPES = {
  ForwardRequest: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "gas", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint48" },
    { name: "data", type: "bytes" },
    { name: "sessionId", type: "bytes32" },
  ],
} as const;

/**
 * Provider that signs the payload the client sends, exactly as a wallet would,
 * and hands back the signature. Returns the parsed payload so the test can
 * assert on what actually left the client.
 */
async function signThroughClient(domain: Record<string, unknown>, types: Record<string, unknown>, primaryType: string, message: Record<string, unknown>) {
  let payload!: { domain: Record<string, unknown>; types: Record<string, { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> };
  let signature!: `0x${string}`;

  useWallet.setState({ kind: "injected", address: ADDRESS });
  (globalThis as Record<string, unknown>).window = {
    location: { origin: "https://openlance.test" },
    ethereum: {
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method !== "eth_signTypedData_v4") return null;
        payload = JSON.parse((params as [string, string])[1]!);
        // A real wallet signs the payload it is given — including its
        // EIP712Domain list. That is the whole point of the check.
        signature = await account.signTypedData({
          domain: payload.domain as Parameters<typeof account.signTypedData>[0]["domain"],
          types: payload.types as Parameters<typeof account.signTypedData>[0]["types"],
          primaryType: payload.primaryType,
          message: payload.message as Parameters<typeof account.signTypedData>[0]["message"],
        });
        return signature;
      },
    },
  };

  const { signTypedData } = await import("../lib/wallet.ts");
  const returned = await signTypedData({ domain, types, primaryType, message });
  if (returned !== signature) throw new Error("provider signature was not returned verbatim");
  return { payload, signature };
}

async function main() {
  console.log("EIP-712 payload agrees with the server digest");

  const domain = { name: "OpenLance SponsorshipForwarder", version: "1", chainId: 31337, verifyingContract: FORWARDER };
  const message = { owner: getAddress(ADDRESS), issuedAt: 1757000000, expiry: 1757086400, sessionId: `0x${"c".repeat(64)}` as const };

  // 1. The payload must not carry an empty EIP712Domain list.
  const { payload, signature } = await signThroughClient(domain, SESSION_TYPES, "SponsorshipSession", message);
  const domainTypes = payload.types.EIP712Domain ?? [];
  check("payload EIP712Domain is not empty", Array.isArray(domainTypes) && domainTypes.length > 0, JSON.stringify(domainTypes));
  check(
    "payload EIP712Domain describes the domain fields",
    JSON.stringify(domainTypes) === JSON.stringify([
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ]),
    JSON.stringify(domainTypes),
  );

  // 2. The digest a wallet computes FROM THE PAYLOAD must equal the one the
  //    server computes from `domain` + the primary type. This is the property
  //    that was broken: with EIP712Domain: [] the two digests diverge and the
  //    signature recovers to the wrong address.
  const digestFromPayload = hashTypedData({
    domain: payload.domain as Parameters<typeof hashTypedData>[0]["domain"],
    types: payload.types as Parameters<typeof hashTypedData>[0]["types"],
    primaryType: payload.primaryType,
    message: payload.message as Parameters<typeof hashTypedData>[0]["message"],
  });
  const digestFromServer = hashTypedData({
    domain: domain as never,
    types: SESSION_TYPES,
    primaryType: "SponsorshipSession",
    // The server sends the same numbers; viem coerces to uint256 on encode.
    message: message as never,
  });
  check("payload digest == server digest", digestFromPayload === digestFromServer, `${digestFromPayload} vs ${digestFromServer}`);

  //    …and the resulting signature must recover to the signer under the
  //    server's digest, which is exactly what the login voucher verify does.
  const recovered = await recoverAddress({ hash: digestFromServer, signature });
  check("signature recovers to the signer", recovered?.toLowerCase() === ADDRESS.toLowerCase(), String(recovered));

  // 3. The domain is derived, not hardcoded: a domain with no verifyingContract
  //    must not claim one, and a domain with a salt must include it.
  {
    const minimal = { name: "X", version: "1", chainId: 1 };
    const { payload: p } = await signThroughClient(minimal, SESSION_TYPES, "SponsorshipSession", message);
    check(
      "no verifyingContract → none in EIP712Domain",
      !JSON.stringify(p.types.EIP712Domain).includes("verifyingContract"),
      JSON.stringify(p.types.EIP712Domain),
    );
  }
  {
    const salted = { ...domain, salt: `0x${"d".repeat(64)}` };
    const { payload: p } = await signThroughClient(salted, SESSION_TYPES, "SponsorshipSession", message);
    check(
      "salt is included in EIP712Domain",
      JSON.stringify(p.types.EIP712Domain).includes("salt"),
      JSON.stringify(p.types.EIP712Domain),
    );
  }
  // 4. A caller-supplied EIP712Domain must not reintroduce the empty-list bug.
  {
    const { payload: p } = await signThroughClient(domain, { ...SESSION_TYPES, EIP712Domain: [] } as never, "SponsorshipSession", message);
    check("caller-supplied EIP712Domain is overridden", (p.types.EIP712Domain ?? []).length > 0, JSON.stringify(p.types.EIP712Domain));
  }

  // 5. A ForwardRequest carries bigint uint fields (the 0.05 ETH dispute fee is
  //    `value`). JSON.stringify throws "Do not know how to serialize a BigInt"
  //    on those, which killed every sponsored money action at signing time.
  {
    const forward = {
      from: getAddress(ADDRESS),
      to: "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512",
      value: 50_000_000_000_000_000n, // 0.05 ETH
      gas: 1_000_000n,
      nonce: 3n,
      deadline: 1_757_086_400,
      data: "0xdeadbeef",
      sessionId: `0x${"c".repeat(64)}` as const,
    };
    let signed = false;
    try {
      const { payload: p, signature: sig } = await signThroughClient(domain, FORWARD_REQUEST_TYPES, "ForwardRequest", forward);
      signed = true;
      check(
        "bigint uint fields reach the payload as strings",
        p.message.value === "50000000000000000" && p.message.gas === "1000000" && p.message.nonce === "3",
        JSON.stringify(p.message),
      );
      // The wallet hashes what it was given; the server hashes numbers. Same
      // uint256s must produce the same digest, or the relay rejects the sig.
      const fromPayload = hashTypedData({
        domain: p.domain as Parameters<typeof hashTypedData>[0]["domain"],
        types: p.types as Parameters<typeof hashTypedData>[0]["types"],
        primaryType: p.primaryType,
        message: p.message as Parameters<typeof hashTypedData>[0]["message"],
      });
      const fromServer = hashTypedData({ domain: domain as never, types: FORWARD_REQUEST_TYPES, primaryType: "ForwardRequest", message: forward as never });
      check("ForwardRequest payload digest == server digest", fromPayload === fromServer, `${fromPayload} vs ${fromServer}`);
      const who = await recoverAddress({ hash: fromServer, signature: sig });
      check("ForwardRequest signature recovers to the signer", who?.toLowerCase() === ADDRESS.toLowerCase(), String(who));
    } catch (err) {
      check("ForwardRequest with bigint value signs", false, err instanceof Error ? err.message : String(err));
    }
    check("ForwardRequest signing did not throw", signed);
  }

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nEIP-712 payload ok");
}

void main();
