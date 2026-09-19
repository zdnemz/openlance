/**
 * Mint a SIWE session for persona 0 (Mara, admin) and list her projects.
 * Mirrors the seed script's login exactly (viem local signing).
 */
import { privateKeyToAccount } from "viem/accounts";

const BASE = "http://localhost:3030";
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

async function main() {
  const account = privateKeyToAccount(KEY);
  const nonceData = (await (await fetch(`${BASE}/auth/nonce`)).json()).data;
  const message = [
    `${nonceData.siwe.domain} wants you to sign in with your Ethereum account:`,
    account.address,
    "",
    nonceData.siwe.statement,
    "",
    `URI: http://${nonceData.siwe.domain}`,
    "Version: 1",
    `Chain ID: ${nonceData.siwe.chainId}`,
    `Nonce: ${nonceData.nonce}`,
    `Issued At: ${new Date().toISOString()}`,
  ].join("\n");
  const signature = await account.signMessage({ message });
  const verify = (await (
    await fetch(`${BASE}/auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, signature }),
    })
  ).json()) as { data: { token: string } };
  if (!verify?.data?.token) throw new Error("verify failed");
  const projects = (await (
    await fetch(`${BASE}/projects`, { headers: { authorization: `Bearer ${verify.data.token}` } })
  ).json()) as { data: { id: string; status: string }[] };
  for (const p of projects.data ?? []) console.log(`${p.id}  |  ${p.status}`);
}
void main();
