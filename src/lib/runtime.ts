"use client";

/** Runtime config: contract addresses + fee, fetched from /overview (truth). */
import { create } from "zustand";
import { get } from "@/lib/api";
import type { Overview } from "@/lib/types";

interface RuntimeState {
  loaded: boolean;
  chainId: number;
  feeBps: number;
  escrow: string | null;
  registry: string | null;
  chainMode: string;
  load: () => Promise<void>;
}

export const useRuntime = create<RuntimeState>((set) => ({
  loaded: false,
  chainId: 31337,
  feeBps: 250,
  escrow: null,
  registry: null,
  chainMode: "…",
  load: async () => {
    try {
      const overview = await get<Overview>("/overview");
      set({
        loaded: true,
        chainId: overview.config.chainId,
        feeBps: overview.config.feeBps,
        escrow: overview.config.contracts.escrow,
        registry: overview.config.contracts.arbiterRegistry,
        chainMode: overview.config.chainMode,
      });
    } catch {
      /* API still booting — consumers show the offline state */
    }
  },
}));
