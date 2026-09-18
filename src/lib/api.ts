/**
 * EscrowLance API client — gateway-aware dual path.
 *
 * · Through the preview gateway (any non-localhost origin): every request is
 *   a RELATIVE path plus `?XTransformPort=3030`; Caddy forwards to the API.
 * · Direct dev (localhost:3000): talk to the API origin itself (CORS allow-
 *   listed server-side).
 */
import { useSession } from "@/lib/session";

const API_PORT = process.env.NEXT_PUBLIC_API_PORT ?? "3030";

/** true when the page itself is the dev server (localhost:3000, no gateway) */
function isDirect(): boolean {
  if (typeof window === "undefined") return false;
  return window.location.hostname === "localhost" && window.location.port === "3000";
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
  if (isDirect()) return `http://localhost:${API_PORT}${path}`;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}XTransformPort=${API_PORT}`;
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

/** Rewrite API-served absolute upload URLs into gateway-safe relative ones. */
export function fileUrl(u: string): string {
  if (!u || isDirect()) return u;
  try {
    const parsed = new URL(u);
    const target = parsed.port || "3030";
    return `${parsed.pathname}${parsed.search ? parsed.search + "&" : "?"}XTransformPort=${target}`;
  } catch {
    return u;
  }
}
