"use client";

/** Runtime config: contract addresses + fee, fetched from /overview (truth). */
import { create } from "zustand";
import { get } from "@/lib/api";
import type { Overview, StorageRuntimeConfig } from "@/lib/types";

interface RuntimeState {
  loaded: boolean;
  chainId: number;
  feeBps: number;
  disputeFeeWei: string;
  minStakeWei: string;
  tierSilverWei: string;
  tierGoldWei: string;
  minScoreToWithdraw: number;
  minStakeDurationSeconds: number;
  unstakeCooldownSeconds: number;
  commitWindowSeconds: number;
  revealWindowSeconds: number;
  appealWindowSeconds: number;
  escrow: string | null;
  registry: string | null;
  timelock: string | null;
  chainMode: string;
  /** Resolved storage system config (bucket, driver, limits). */
  storage: StorageRuntimeConfig | null;
  load: () => Promise<void>;
}

export const useRuntime = create<RuntimeState>((set) => ({
  loaded: false,
  chainId: 31337,
  feeBps: 250,
  disputeFeeWei: "50000000000000000",
  minStakeWei: "100000000000000000",
  tierSilverWei: "1000000000000000000",
  tierGoldWei: "10000000000000000000",
  minScoreToWithdraw: 50,
  minStakeDurationSeconds: 7 * 24 * 60 * 60,
  unstakeCooldownSeconds: 3 * 24 * 60 * 60,
  commitWindowSeconds: 86400,
  revealWindowSeconds: 86400,
  appealWindowSeconds: 172800,
  escrow: null,
  registry: null,
  timelock: null,
  chainMode: "…",
  storage: null,
  load: async () => {
    try {
      const overview = await get<Overview>("/overview");
      const cfg = overview.config;
      // Never let a missing field overwrite a good default with `undefined` —
      // a partial/cached response would otherwise poison consumers (BigInt()).
      set({
        loaded: true,
        chainId: cfg.chainId ?? 31337,
        feeBps: cfg.feeBps ?? 250,
        disputeFeeWei: cfg.disputeFeeWei ?? "50000000000000000",
        minStakeWei: cfg.minStakeWei ?? "100000000000000000",
        tierSilverWei: (cfg as { tierSilverWei?: string }).tierSilverWei ?? "1000000000000000000",
        tierGoldWei: (cfg as { tierGoldWei?: string }).tierGoldWei ?? "10000000000000000000",
        minScoreToWithdraw: cfg.minScoreToWithdraw ?? 50,
        minStakeDurationSeconds: cfg.minStakeDurationSeconds ?? 7 * 24 * 60 * 60,
        unstakeCooldownSeconds: cfg.unstakeCooldownSeconds ?? 3 * 24 * 60 * 60,
        commitWindowSeconds: (cfg as { commitWindowSeconds?: number }).commitWindowSeconds ?? 86400,
        revealWindowSeconds: (cfg as { revealWindowSeconds?: number }).revealWindowSeconds ?? 86400,
        appealWindowSeconds: (cfg as { appealWindowSeconds?: number }).appealWindowSeconds ?? 172800,
        escrow: cfg.contracts?.escrow ?? null,
        registry: cfg.contracts?.arbiterRegistry ?? null,
        timelock: cfg.contracts?.timelock ?? null,
        chainMode: cfg.chainMode ?? "…",
        storage: cfg.storage ?? null,
      });
    } catch {
      /* API still booting — consumers show the offline state */
    }
  },
}));
