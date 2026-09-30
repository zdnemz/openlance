/** Formatting: wei/ETH, addresses, dates — mono-numeric presentation rules. */

/**
 * Safe wei parser. API payloads are typed as strings but can arrive as
 * `undefined`/`null`/garbage (partial responses, older records). `BigInt()`
 * throws on those, and several call sites run during render — so everything
 * that turns a wei-ish value into a bigint goes through here. Invalid input
 * collapses to 0n; presentation helpers (`formatEth`) render it as "—".
 */
export function toWei(value: string | bigint | number | null | undefined): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return Number.isFinite(value) ? BigInt(Math.trunc(value)) : 0n;
  if (typeof value !== "string" || value.length === 0) return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

export function formatEth(wei: string | bigint | null | undefined, maxDecimals = 3): string {
  if (wei === null || wei === undefined || wei === "") return "—";
  try {
    const big = typeof wei === "bigint" ? wei : BigInt(wei);
    const neg = big < 0n;
    const abs = neg ? -big : big;
    const whole = abs / 10n ** 18n;
    const tail = (abs % 10n ** 18n).toString().padStart(18, "0");
    // Truncation used to report a real non-zero amount as a flat "0" — a bid of
    // 0.0004 ETH read "0 ETH" next to a wallet prompt for 4e14 wei. Anything
    // that survives only past the displayed precision says so instead.
    if (tail.slice(maxDecimals).replace(/0+$/, "") !== "") return "<0.001";
    const frac = tail.slice(0, maxDecimals).replace(/0+$/, "");
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
  // `slice(-0)` returns the WHOLE string, and a short value would print its own
  // head twice ("0x12…0x12"). Only elide when both ends actually fit.
  if (size <= 0 || addr.length <= 2 + size * 2) return addr;
  return `${addr.slice(0, 2 + size)}…${addr.slice(-size)}`;
}

export function shortHash(hash: string | null | undefined, size = 6): string {
  if (!hash) return "—";
  if (size <= 0 || hash.length <= 2 + size + 4) return hash;
  return `${hash.slice(0, 2 + size)}…${hash.slice(-4)}`;
}

export function timeAgo(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  const then = typeof iso === "string" ? new Date(iso).getTime() : iso.getTime();
  const diff = Date.now() - then;
  if (!Number.isFinite(diff)) return "—";
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

/** Wall-clock time for a chat bubble: 14:07 today, "Mar 3" once it is not. */
export function clockTime(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "";
  const sameDay = d.toDateString() === new Date().toDateString();
  return d.toLocaleTimeString("en-GB", sameDay
    ? { hour: "2-digit", minute: "2-digit" }
    : { month: "short", day: "numeric" });
}

export function dateLabel(iso: string | null | undefined): string {
  if (!iso) return "—";
  // A bad timestamp rendered the literal "Invalid Date" into the page.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function timeUntil(iso: string | null | undefined): string {
  if (!iso) return "—";
  // NaN made every comparison false, so a bad timestamp fell through to
  // `${NaN}m` — "NaNm" on a countdown the user is meant to trust.
  const diff = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(diff)) return "—";
  if (diff <= 0) return "elapsed";
  const hours = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours >= 1) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export const MILESTONE_LABELS: Record<string, string> = {
  draft: "Draft — unpublished",
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
  draft: "var(--color-state-pending)",
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
  return (toWei(amountWei) * BigInt(feeBps)) / 10000n;
}

/**
 * Ledger-event dot colour — money state semantics, never the rose accent.
 *
 * `STATE_COLORS` is keyed by MILESTONE status, not event type; indexing it with
 * an event name was always `undefined`, so every row fell through to the accent
 * and the whole on-chain log rendered in the one colour the system reserves for
 * emphasis. The project room and the dashboard read the same map from here.
 */
export function ledgerDotColor(eventType: string): string {
  if (/Released|Split/i.test(eventType)) return "var(--color-state-released)";
  if (/Refund/i.test(eventType)) return "var(--color-state-refund)";
  if (/Dispute|Finalized|Appeal|Tally/i.test(eventType)) return "var(--color-state-disputed)";
  if (/Fund/i.test(eventType)) return "var(--color-state-funded)";
  if (/Submitted|Commit/i.test(eventType)) return "var(--color-state-submitted)";
  if (/Fee/i.test(eventType)) return "var(--color-state-split)";
  return "var(--color-state-pending)";
}
