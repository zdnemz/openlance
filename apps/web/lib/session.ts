"use client";

/**
 * Session store — SIWE-derived JWT + user, persisted for UX convenience,
 * always bound to the signing wallet address (a wallet switch invalidates it).
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useSyncExternalStore } from "react";
import type { PublicUser } from "@/lib/types";

interface SessionState {
  token: string | null;
  user: PublicUser | null;
  /** the wallet address that produced this token */
  boundAddress: string | null;
  setSession: (token: string, user: PublicUser, address: string) => void;
  setUser: (user: PublicUser) => void;
  clear: () => void;
}

export const useSession = create<SessionState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      boundAddress: null,
      setSession: (token, user, address) => set({ token, user, boundAddress: address }),
      setUser: (user) => set({ user }),
      clear: () => set({ token: null, user: null, boundAddress: null }),
    }),
    { name: "el:session" },
  ),
);

/**
 * True once the persisted session has rehydrated from localStorage.
 *
 * The session is null during SSR and the first client render, then flips in —
 * so any component that branches on `user`/`token` must gate on this to avoid
 * React hydration mismatches. Starts at `false`; the `persist` API is absent on
 * the server, so it is only accessed inside the effect.
 */
export function useSessionHydrated(): boolean {
  return useSyncExternalStore(
    (onChange) => useSession.persist?.onFinishHydration(onChange) ?? (() => {}),
    () => useSession.persist?.hasHydrated() ?? true,
    () => false,
  );
}
