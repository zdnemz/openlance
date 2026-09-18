/** Formatting: wei/ETH, addresses, dates — mono-numeric presentation rules. */

export function formatEth(wei: string | bigint | null | undefined, maxDecimals = 3): string {
  if (wei === null || wei === undefined) return "—";
  try {
    const big = typeof wei === "bigint" ? wei : BigInt(wei);
    const neg = big < 0n;
    const abs = neg ? -big : big;
    const whole = abs / 10n ** 18n;
    const frac = (abs % 10n ** 18n).toString().padStart(18, "0").slice(0, maxDecimals).replace(/0+$/, "");
    const num = frac ? `${whole}.${frac}` : `${whole}`;
    return neg ? `-${num}` : num;
  } catch {
    return "—";
  }
}

export function formatUsdFromEth(eth: string, ethPrice = 3127.4): string {
  const n = Number(eth);
  if (!Number.isFinite(n)) return "—";
  const usd = n * ethPrice;
  return usd >= 1000 ? `$${(usd / 1000).toFixed(1)}k` : `$${usd.toFixed(0)}`;
}

export function shortAddress(addr: string | null | undefined, size = 4): string {
  if (!addr) return "—";
  return `${addr.slice(0, 2 + size)}…${addr.slice(-size)}`;
}

export function shortHash(hash: string | null | undefined, size = 6): string {
  if (!hash) return "—";
  return `${hash.slice(0, 2 + size)}…${hash.slice(-4)}`;
}

export function timeAgo(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  const then = typeof iso === "string" ? new Date(iso).getTime() : iso.getTime();
  const diff = Date.now() - then;
  if (diff < 0) return "just now";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function dateLabel(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function timeUntil(iso: string | null | undefined): string {
  if (!iso) return "—";
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "elapsed";
  const hours = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours >= 1) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export const MILESTONE_LABELS: Record<string, string> = {
  pending_funding: "Awaiting funding",
  funded: "In escrow",
  submitted: "Under review",
  released: "Released",
  disputed: "Disputed",
  resolved_release: "Released (arbitrated)",
  resolved_refund: "Refunded",
  resolved_split: "Split",
  cancelled: "Cancelled",
};

export const STATE_COLORS: Record<string, string> = {
  pending_funding: "var(--color-state-pending)",
  funded: "var(--color-state-funded)",
  submitted: "var(--color-state-submitted)",
  released: "var(--color-state-released)",
  resolved_release: "var(--color-state-released)",
  disputed: "var(--color-state-disputed)",
  resolved_split: "var(--color-state-split)",
  resolved_refund: "var(--color-state-refund)",
  cancelled: "var(--color-state-pending)",
};

export function feeOn(amountWei: string, feeBps: number): bigint {
  try {
    return (BigInt(amountWei) * BigInt(feeBps)) / 10000n;
  } catch {
    return 0n;
  }
}
