/**
 * OpenLance API client.
 *
 * The API is a separate service (apps/api, default :4000). Where it lives is
 * decided once, in lib/api-base.ts: its own origin (`pnpm dev`, Caddy), which
 * makes every call cross-origin and needs CORS, or the SAME origin as these
 * pages (the Vercel services deployment routes `/api/*` to the API), where the
 * base is empty and every URL here is the relative `/api/...`.
 *
 * `credentials: "include"` is load-bearing cross-origin: the gate cookies
 * (`el_onboarded`, `el_role`) are stamped by the API and read by this app's
 * proxy, and a cross-origin response drops Set-Cookie without it. Same-origin
 * it is a harmless default. Auth itself is a Bearer token, not a cookie.
 */
import { useSession } from "@/lib/session";
import { API_BASE } from "@/lib/api-base";

/**
 * URL of a public API path, for the surfaces that need `fetch` directly (the
 * backend console reads raw endpoints, streams nothing, and wants the Response
 * rather than the parsed envelope). The one `get`/`post` use: absolute against
 * a separate API origin, root-relative (`/api/...`) when the API is same-origin.
 */
export function apiUrl(path: string): string {
  return buildUrl(path);
}

export class ApiError extends Error {
  code: string;
  status: number;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function buildUrl(path: string): string {
  return `${API_BASE}/api${path.startsWith("/") ? path : `/${path}`}`;
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const token = useSession.getState().token;
  const res = await fetch(buildUrl(path), {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: "no-store",
    // Required cross-origin: without it the browser discards the API's
    // Set-Cookie headers and the onboarding/role gate never sees its cookies.
    // Harmless when the API is same-origin.
    credentials: "include",
  });
  const json = (await res.json().catch(() => ({}))) as { data?: T; error?: { code: string; message: string; details?: unknown } };
  if (!res.ok || json.error) {
    // An expired JWT used to leave the whole app rendered as signed-in — rail,
    // profile, role gates all still there — while every read and write failed
    // with "Request failed (401)". Drop the dead session so the header offers
    // Connect again instead of a session that can do nothing.
    if (res.status === 401) useSession.getState().clear();
    throw new ApiError(res.status, json.error?.code ?? "unknown", json.error?.message ?? `Request failed (${res.status})`, json.error?.details);
  }
  return json.data as T;
}

export const get = <T = unknown>(path: string) => api<T>("GET", path);
export const post = <T = unknown>(path: string, body?: unknown) => api<T>("POST", path, body);
export const patch = <T = unknown>(path: string, body?: unknown) => api<T>("PATCH", path, body);
export const del = <T = unknown>(path: string) => api<T>("DELETE", path);

/**
 * Upload raw bytes to an API-originated URL (the local storage driver's
 * `PUT /api/files/:id/raw`). `api` JSON-encodes, which would corrupt the file,
 * so this sends the body verbatim while keeping the Bearer token and the
 * cross-origin credentials the error envelope needs.
 */
export async function putBytes(url: string, body: Blob, contentType: string): Promise<void> {
  const token = useSession.getState().token;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body,
    cache: "no-store",
    credentials: "include",
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string } };
    throw new ApiError(res.status, json.error?.code ?? "unknown", json.error?.message ?? `Upload failed (${res.status})`);
  }
}

/**
 * Resolve a file URL to something the browser can fetch.
 *
 * The API builds absolute URLs from API_URI (e.g. http://localhost:4000/api/
 * files/…). Rewriting those to API_BASE + path keeps the request on the public
 * API origin — which is where the signed-URL signature is checked — and avoids
 * a cross-origin redirect through the web app. Same-origin (empty base) the
 * result is the relative `/api/files/…`, so a wrong API_URI cannot leak a
 * dead host into the browser.
 *
 * Only `/api/*` is rewritten. The supabase driver hands back a signed URL on
 * the Supabase origin (`https://<ref>.supabase.co/storage/v1/object/sign/…`)
 * whose token is the credential; re-pointing it at this API produced a
 * `/storage/…` request the API never mounts, i.e. a bare 404 on a file that
 * exists. Foreign origins pass through untouched.
 */
export function fileUrl(u: string): string {
  if (!u) return u;
  try {
    const parsed = new URL(u);
    if (!parsed.pathname.startsWith("/api/")) return u;
    return `${API_BASE}${parsed.pathname}${parsed.search}`;
  } catch {
    return u;
  }
}
