import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { Providers } from "@/components/providers";
import { Toaster } from "sonner";

// All three faces are self-hosted (OFL, see app/fonts/README.txt): the build
// needs no network, and a pixel font is never swapped for a fallback mid-load.
const pressStart = localFont({
  variable: "--font-press-start-2p",
  src: "./fonts/PressStart2P-Regular.woff2",
  weight: "400",
  display: "swap",
});

const pixelifySans = localFont({
  variable: "--font-pixelify-sans",
  src: "./fonts/PixelifySans-Variable.woff2",
  weight: "400 700",
  display: "swap",
});

const plexMono = localFont({
  variable: "--font-plex-mono",
  src: [
    { path: "./fonts/IBMPlexMono-400.woff2", weight: "400" },
    { path: "./fonts/IBMPlexMono-500.woff2", weight: "500" },
    { path: "./fonts/IBMPlexMono-600.woff2", weight: "600" },
  ],
  display: "swap",
});

export const metadata: Metadata = {
  // `template` lets a nested layout set its own title; without it every tab and
  // every shared link showed the root title verbatim.
  title: {
    default: "OpenLance — milestone escrow for freelance work",
    template: "%s · OpenLance",
  },
  description:
    "Freelance marketplace with smart-contract escrow: fund milestones, release on proof, dispute with SBT-staked arbiters. Base-native, on-chain settlement.",
  keywords: ["escrow", "freelance", "web3", "milestones", "solidity", "Base"],
  openGraph: {
    title: "OpenLance",
    description: "Milestone escrow for freelance work — released on proof, not promises.",
    siteName: "OpenLance",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`dark ${pressStart.variable} ${pixelifySans.variable} ${plexMono.variable}`} suppressHydrationWarning>
      {/*
        suppressHydrationWarning on <body>: browser extensions (Bitdefender,
        Web of Trust, etc.) inject attributes like `bis_skin_checked` and
        `__processed_*__` into the body and every descendant before React
        hydrates. That mutation is out of our control and only affects
        attributes here, never our rendered text — so we silence the noise.
      */}
      <body className="font-sans antialiased bg-background text-foreground" suppressHydrationWarning>
        <Providers>{children}</Providers>
        <Toaster
          theme="dark"
          position="bottom-right"
          toastOptions={{
            style: {
              background: "#101015",
              border: "2px solid #43434f",
              borderRadius: 0,
              boxShadow: "4px 4px 0 0 #000",
              color: "#f4f4f5",
              fontFamily: "var(--font-pixelify-sans), sans-serif",
              fontSize: "15px",
            },
          }}
        />
      </body>
    </html>
  );
}
