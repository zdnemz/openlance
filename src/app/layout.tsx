import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";
import { Toaster } from "sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "EscrowLance — milestone escrow for freelance work",
  description:
    "Freelance marketplace with smart-contract escrow: fund milestones, release on proof, dispute with SBT-staked arbiters. Base-native, on-chain settlement.",
  keywords: ["escrow", "freelance", "web3", "milestones", "solidity", "Base"],
  openGraph: {
    title: "EscrowLance",
    description: "Milestone escrow for freelance work — released on proof, not promises.",
    siteName: "EscrowLance",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}>
        <Providers>{children}</Providers>
        <Toaster
          theme="dark"
          position="bottom-right"
          toastOptions={{
            style: {
              background: "rgba(19,19,24,0.92)",
              border: "1px solid rgba(255,255,255,0.09)",
              color: "#f4f4f5",
              backdropFilter: "blur(12px)",
            },
          }}
        />
      </body>
    </html>
  );
}
