"use client";

/** One-off admin action: register an arbiter on-chain (registry.register). */
import { useWallet } from "@/lib/wallet";
import { useChainAction, registerArbiterAction } from "@/lib/chain-actions";
import { useRuntime } from "@/lib/runtime";
import { toast } from "sonner";

export function useRegisterArbiter() {
  const chain = useChainAction();
  const { address } = useWallet();
  const registry = useRuntime((s) => s.registry);
  const isAdmin = address?.toLowerCase() === "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

  return async () => {
    if (!isAdmin) {
      toast.error("Admin only", { description: "Connect as the admin wallet (anvil persona Mara) to register arbiters." });
      return;
    }
    if (!registry) {
      toast.error("Registry address unknown");
      return;
    }
    const result = await registerArbiterAction(chain.run)(address!);
    if (result.ok) toast.success("Arbiter registered");
  };
}
