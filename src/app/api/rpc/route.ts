/**
 * Same-origin JSON-RPC relay → anvil (127.0.0.1:8545).
 *
 * The preview browser cannot reach localhost:8545 directly, so wagmi's chain
 * transport points here: every eth_call / eth_sendRawTransaction / estimate
 * passes through the Next.js server to the local chain. Signatures never
 * leave the browser — the relay only carries already-signed payloads.
 */
export const dynamic = "force-dynamic";

const ANVIL_RPC = process.env.ANVIL_RPC_URL ?? "http://127.0.0.1:8545";

export async function POST(req: Request) {
  try {
    const body = await req.text();
    const res = await fetch(ANVIL_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      cache: "no-store",
    });
    return new Response(res.body, {
      status: res.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32603, message: "anvil relay unreachable — is the chain up?" } },
      { status: 502 },
    );
  }
}

export async function GET() {
  return Response.json({ relay: "anvil", target: ANVIL_RPC });
}
