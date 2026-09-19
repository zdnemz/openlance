"use client";

/**
 * Client provider tree: TanStack Query → runtime config bootstrap →
 * session-wallet binding. The wallet layer is viem-only (see lib/wallet).
 */
import { useEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRuntime } from "@/lib/runtime";
import { useSession } from "@/lib/session";
import { useWallet } from "@/lib/wallet";
import { loginWithWallet } from "@/lib/siwe";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 4000, retry: 1, refetchOnWindowFocus: false },
        },
      }),
  );

  const loadRuntime = useRuntime((s) => s.load);
  useEffect(() => {
    void loadRuntime();
    const t = setInterval(() => void loadRuntime(), 60_000);
    return () => clearInterval(t);
  }, [loadRuntime]);

  return (
    <QueryClientProvider client={queryClient}>
      <SessionBinding>{children}</SessionBinding>
    </QueryClientProvider>
  );
}

/**
 * A session token belongs to exactly one wallet. When the active wallet
 * changes or disconnects, the session is dropped and the user re-signs —
 * identity follows the key.
 */
function SessionBinding({ children }: { children: ReactNode }) {
  const address = useWallet((s) => s.address);
  const kind = useWallet((s) => s.kind);
  const bound = useSession((s) => s.boundAddress);
  const clear = useSession((s) => s.clear);

  useEffect(() => {
    if (!bound) return;
    if (!address || !kind) {
      clear();
      return;
    }
    if (address.toLowerCase() !== bound) clear();
  }, [address, kind, bound, clear]);

  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    const index = Number(new URLSearchParams(window.location.search).get("persona"));
    if (!Number.isInteger(index) || index < 0 || index > 4) return;
    const s = useSession.getState();
    const w = useWallet.getState();
    if (s.token && w.kind === "persona" && w.personaIndex === index) return;
    void (async () => {
      useWallet.getState().connectPersona(index);
      await loginWithWallet(useWallet.getState().address!);
    })().catch((e) => console.error("[dev autologin]", e));
  }, []);

  return <>{children}</>;
}
