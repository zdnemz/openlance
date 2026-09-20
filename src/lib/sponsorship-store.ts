"use client";

/**
 * Sponsorship session store — whether the current login has an active,
 * unexpired gasless session. Persisted so a refresh keeps the gasless UX until
 * the session (JWT TTL) expires.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface Session {
  sessionId: `0x${string}`;
  expiresAt: string;
  domain: Record<string, unknown>;
  forwardRequestTypes: Record<string, unknown>;
}

interface SponsorshipState {
  sessionId: `0x${string}` | null;
  expiresAt: string | null;
  domain: Record<string, unknown> | null;
  forwardRequestTypes: Record<string, unknown> | null;
  setSession: (s: Session) => void;
  clear: () => void;
  /** True when a session exists and has not expired. */
  isActive: () => boolean;
}

export const useSponsorship = create<SponsorshipState>()(
  persist(
    (set, get) => ({
      sessionId: null,
      expiresAt: null,
      domain: null,
      forwardRequestTypes: null,
      setSession: (s) =>
        set({
          sessionId: s.sessionId,
          expiresAt: s.expiresAt,
          domain: s.domain,
          forwardRequestTypes: s.forwardRequestTypes,
        }),
      clear: () => set({ sessionId: null, expiresAt: null, domain: null, forwardRequestTypes: null }),
      isActive: () => {
        const { sessionId, expiresAt } = get();
        return !!sessionId && !!expiresAt && new Date(expiresAt).getTime() > Date.now();
      },
    }),
    { name: "el:sponsorship" },
  ),
);
