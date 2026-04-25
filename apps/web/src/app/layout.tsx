import { Analytics } from "@vercel/analytics/next";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { TRPCReactProvider } from "@/trpc/client";
import "@/styles/globals.css";

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
  display: "swap",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://storycapture.app"),
  title: "StoryCapture",
  description: "Turn structured user stories into polished demo videos automatically.",
  icons: {
    icon: [
      {
        url: "/icon.png",
        type: "image/png",
        sizes: "512x512",
      },
    ],
    apple: [
      {
        url: "/apple-icon.png",
        type: "image/png",
        sizes: "180x180",
      },
    ],
  },
  openGraph: {
    title: "StoryCapture",
    description: "Turn structured user stories into polished demo videos automatically.",
    type: "website",
    images: [
      {
        url: "/assets/storycapture-hero-product.png",
        width: 1672,
        height: 941,
        alt: "StoryCapture product workflow preview",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "StoryCapture",
    description: "Turn structured user stories into polished demo videos automatically.",
    images: ["/assets/storycapture-hero-product.png"],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`dark ${geist.variable} ${geistMono.variable}`}>
      <body>
        <TRPCReactProvider>{children}</TRPCReactProvider>
        <Analytics />
      </body>
    </html>
  );
}
