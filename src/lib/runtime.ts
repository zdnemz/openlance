"use client";

/** Runtime config: contract addresses + fee, fetched from /overview (truth). */
import { create } from "zustand";
import { get } from "@/lib/api";
import type { Overview } from "@/lib/types";

interface RuntimeState {
  loaded: boolean;
  chainId: number;
  feeBps: number;
  disputeFeeWei: string;
  minStakeWei: string;
  minScoreToWithdraw: number;
  escrow: string | null;
  registry: string | null;
  timelock: string | null;
  chainMode: string;
  load: () => Promise<void>;
}

export const useRuntime = create<RuntimeState>((set) => ({
  loaded: false,
  chainId: 31337,
  feeBps: 250,
  disputeFeeWei: "50000000000000000",
  minStakeWei: "100000000000000000",
  minScoreToWithdraw: 50,
  escrow: null,
  registry: null,
  timelock: null,
  chainMode: "…",
  load: async () => {
    try {
      const overview = await get<Overview>("/overview");
      set({
        loaded: true,
        chainId: overview.config.chainId,
        feeBps: overview.config.feeBps,
        disputeFeeWei: overview.config.disputeFeeWei,
        minStakeWei: overview.config.minStakeWei,
        minScoreToWithdraw: overview.config.minScoreToWithdraw,
        escrow: overview.config.contracts.escrow,
        registry: overview.config.contracts.arbiterRegistry,
        timelock: overview.config.contracts.timelock,
        chainMode: overview.config.chainMode,
      });
    } catch {
      /* API still booting — consumers show the offline state */
    }
  },
}));
