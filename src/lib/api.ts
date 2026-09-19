/**
 * OpenLance API client.
 *
 * The backend runs in the SAME Next.js app (App Router route handlers under
 * `/api/**`), so every call is same-origin — no gateway port forwarding, no
 * CORS. `apiBase()` allows an optional absolute override for split deploys.
 */
import { useSession } from "@/lib/session";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";

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

/** Absolute-or-relative upload URLs served by the same app are already same-origin. */
export function fileUrl(u: string): string {
  if (!u || !API_BASE) return u;
  try {
    const parsed = new URL(u);
    return parsed.pathname + parsed.search;
  } catch {
    return u;
  }
}
