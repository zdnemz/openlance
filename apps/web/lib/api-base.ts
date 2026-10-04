/**
 * The ONE place that decides where the API lives — for the browser bundle and
 * for the proxy. Nothing else may read `NEXT_PUBLIC_API_BASE` (scripts/
 * check-api-base.ts enforces it), so the three call sites that used to carry
 * their own copy (lib/api.ts, lib/wallet.ts, proxy.ts) cannot drift apart.
 *
 * Dependency-free on purpose: proxy.ts imports this, and the proxy must not
 * pull in client-only modules (zustand stores, `window`) or node-only ones.
 *
 * `NEXT_PUBLIC_API_BASE` is inlined at BUILD time and means one of:
 *   - an origin (`http://localhost:4000`, `https://api.example.com`) — the API
 *     is its own origin: `pnpm dev`, Caddy / self-hosted, CI. Calls are
 *     cross-origin, so the API needs CORS and the client sends credentials.
 *   - the empty string — SAME origin: `/api/*` is served beside the pages.
 *     That is the Vercel services layout (one domain, the top-level rewrite
 *     `/api/(.*)` routes to the api service). Requests are relative (`/api/...`).
 *   - unset — the local default below. `next.config.ts` flips the default to
 *     the empty string when it builds on Vercel, so a Vercel build never bakes
 *     `localhost:4000` into the browser bundle. An explicit value always wins.
 *
 * `??`, not `||`: the empty string is a real value, not "missing".
 */
export const API_BASE: string = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:4000";

/**
 * An ABSOLUTE URL for an API path (`/api/...`), for the places that cannot use
 * a relative one: `wallet_addEthereumChain` (a wallet needs a full http(s) URL)
 * and the proxy's server-side `fetch` (Node's fetch throws on a relative URL).
 *
 * `origin` is the page's / request's own origin, supplied lazily and read ONLY
 * when the base is empty (same-origin mode) — an explicit base needs neither a
 * `window` nor a request. It is the caller's origin on purpose: a service
 * binding cannot be used here (bindings do not resolve in middleware), and
 * `/api/*` is routed to the API service on that origin anyway.
 */
export function absoluteApiUrl(path: string, origin: () => string): string {
  return `${API_BASE || origin()}${path}`;
}
