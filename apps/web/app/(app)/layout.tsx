import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";

/**
 * The signed-in app has no landing copy to index, and every route under it is
 * gated behind a wallet — so say what the product is, once, and let each page
 * override the title through the root `template`. Without this the whole
 * interior shared the root title on every tab and every link preview.
 */
export const metadata: Metadata = {
  title: "App",
  robots: { index: false, follow: false },
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
