/**
 * OpenLance API client.
 *
 * The API is a separate service (apps/api, default :4000), so calls are
 * cross-origin in development and need CORS. `NEXT_PUBLIC_API_BASE` is the
 * public origin of that service; leave it empty only when something proxies
 * `/api` back to the API service on the same origin.
 *
 * `credentials: "include"` is load-bearing: the gate cookies
 * (`el_onboarded`, `el_role`) are stamped by the API and read by this app's
 * edge proxy, and a cross-origin response drops Set-Cookie without it.
 * Auth itself is a Bearer token, not a cookie.
 */
import { useSession } from "@/lib/session";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:4000";

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
    credentials: "include",
  });
  const json = (await res.json().catch(() => ({}))) as { data?: T; error?: { code: string; message: string; details?: unknown } };
  if (!res.ok || json.error) {
    throw new ApiError(res.status, json.error?.code ?? "unknown", json.error?.message ?? `Request failed (${res.status})`, json.error?.details);
  }
  return json.data as T;
}

export const get = <T = unknown>(path: string) => api<T>("GET", path);
export const post = <T = unknown>(path: string, body?: unknown) => api<T>("POST", path, body);
export const patch = <T = unknown>(path: string, body?: unknown) => api<T>("PATCH", path, body);
export const del = <T = unknown>(path: string) => api<T>("DELETE", path);

/**
 * Resolve a file URL to something the browser can fetch.
 *
 * The API builds absolute URLs from API_URI (e.g. http://localhost:4000/api/
 * files/…). Rewriting them to API_BASE + path keeps the request on the API
 * origin — which is where the signed-URL signature is checked — and avoids a
 * cross-origin redirect through the web app.
 */
export function fileUrl(u: string): string {
  if (!u) return u;
  try {
    const parsed = new URL(u);
    return `${API_BASE}${parsed.pathname}${parsed.search}`;
  } catch {
    return u;
  }
}
