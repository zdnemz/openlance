"use client";

/** /profile/:address — read-only public card. Editing lives ONLY at /profile/me. */
import { use } from "react";
import { ProfileView } from "@/components/profile-view";

export default function ProfileByAddressPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = use(params);
  return <ProfileView address={address} allowEdit={false} />;
}
