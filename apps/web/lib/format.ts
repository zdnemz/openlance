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

/**
 * Decimal ETH text → wei. The INVERSE of `formatEth`, and the counterpart to the
 * API's `toWei` (which is `parseEther`).
 *
 * `toWei` above parses INTEGER wei and is the wrong function for a typed
 * amount: `toWei("5")` is 5 wei, not 5 ETH. Reading a milestone input with it
 * made a 5 ETH bid sum to `0.000000000000000005` — the total the freelancer
 * reviews, and the total the server is about to charge, were both off by 10^18.
 *
 * String arithmetic, never `Number`: a float loses wei precision and rounds
 * sub-wei input up or down. Unparseable or partial text ("", ".", "abc") is 0n
 * so this is safe to call on every render of a live input.
 */
export function ethToWei(eth: string | null | undefined): bigint {
  const m = /^(\d*)(?:\.(\d*))?$/.exec((eth ?? "").trim());
  if (!m) return 0n;
  // Past 18 decimals is not representable, and the server's ETH_AMOUNT rejects
  // it — truncate to stay in scale rather than inflate the amount 10x.
  const frac = (m[2] ?? "").slice(0, 18).padEnd(18, "0");
  return BigInt(m[1] || "0") * 10n ** 18n + BigInt(frac);
}

/**
 * Wei → ETH, exactly, with trailing zeros trimmed.
 *
 * This formatter has lied three times, all in the same direction — understating
 * a real amount:
 *  1. truncating to a flat "0" (a 0.0004 ETH bid read "0 ETH"),
 *  2. answering a hardcoded "<0.001" that ignored `maxDecimals`, so a 0.0005 ETH
 *     milestone showed "<0.001 ETH" for its value, its fee AND its payout, and
 *  3. scaling the floor to the precision but still losing the value: a
 *     0.0000125 ETH fee on that milestone read "<0.000001" — twelve times
 *     smaller than the truth.
 *
 * A floor marker cannot be made honest by picking a better precision: any
 * value that fails to render is somewhere in a range, and a devnet with
 * sub-0.001 milestones and a 250bps fee puts real money down there.
 *
 * So there is no floor. Wei is an integer, so every amount is EXACTLY
 * representable in at most 18 decimals — print all of them and trim the zeros.
 * The cap only stops a pathological value from producing an unreadable string,
 * and a value that long is a decimal-precision bug upstream, not a UI concern;
 * past 12 decimals the scientific form is both shorter and unambiguous.
 */
export function formatEth(wei: string | bigint | null | undefined, maxDecimals = 18): string {
  if (wei === null || wei === undefined || wei === "") return "—";
  try {
    const big = typeof wei === "bigint" ? wei : BigInt(wei);
    const neg = big < 0n;
    const abs = neg ? -big : big;
    const whole = abs / 10n ** 18n;
    const tail = (abs % 10n ** 18n).toString().padStart(18, "0");
    // 1 wei — nothing can be shorter than this without losing the amount.
    if (tail === "0".repeat(18)) return neg ? `-${whole}` : `${whole}`;
    if (maxDecimals < 18) {
      const kept = tail.slice(0, Math.max(0, maxDecimals)).replace(/0+$/, "");
      const num = kept ? `${whole}.${kept}` : `${whole}`;
      return neg ? `-${num}` : num;
    }
    const frac = tail.replace(/0+$/, "");
    const num = `${whole}.${frac}`;
    return neg ? `-${num}` : num;
  } catch {
    return "—";
  }
}

/**
 * Wei → ETH for a LIFETIME TOTAL, rounded to `decimals` (default 4).
 *
 * `formatEth` prints all 18 decimals because an amount you sign, send or check
 * must be exact. A total is not that: it is the sum of every settled milestone
 * for a user, and each one is `amount - floor(amount * feeBps / 10000)`. The
 * per-milestone integer division leaves sub-wei dust, and the sum of those is
 * what made a real balance read `0.448500000000000009 ETH` — an amount nobody
 * can act on, and a stat tile is the one place a rounded figure is honest.
 *
 * Two rules keep this from reintroducing the lie `formatEth` was rebuilt to
 * stop committing:
 *   - it ROUNDS (half-up, away from zero), never truncates, so a total is
 *     never quietly smaller than what the user earned;
 *   - a non-zero amount never rounds to `0` — a user who earned 0.00004 ETH is
 *     told so exactly, rather than shown a flat `0`.
 *
 * Trailing zeros are still trimmed by `formatEth`, so `0.4485` stays 4dp and
 * `12.7` stays 1dp: the cap is a maximum, not padding.
 */
export function formatEthSummary(wei: string | bigint | null | undefined, decimals = 4): string {
  if (wei === null || wei === undefined || wei === "") return "—";
  // NOT `toWei`, which collapses anything unparseable to 0n — a total that failed
  // to read would then render as a confident "0" earned. "—" means unknown and
  // "0" means nothing; this keeps that distinction, as `formatEth` does.
  let big: bigint;
  try {
    big = typeof wei === "bigint" ? wei : BigInt(wei);
  } catch {
    return "—";
  }
  if (big === 0n) return "0";
  const step = 10n ** BigInt(18 - Math.max(0, Math.min(17, decimals)));
  const neg = big < 0n;
  const abs = neg ? -big : big;
  const rounded = ((abs + step / 2n) / step) * step;
  return formatEth((neg ? -rounded : rounded) || abs);
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
