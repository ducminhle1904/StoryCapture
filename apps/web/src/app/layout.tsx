import { StoryCaptureThemeProvider } from "@storycapture/ui/theme";
import { Analytics } from "@vercel/analytics/next";
import type { Metadata } from "next";
import { AstryxBrowserSupport } from "@/components/astryx-browser-support";
import { TRPCReactProvider } from "@/trpc/client";
import "@/styles/layers.css";
import "@/styles/globals.css";

const siteUrl = "https://story-capture-web.vercel.app";
const siteDescription =
  "StoryCapture is a script-first product demo video maker for SaaS teams. Automate browser flows, capture native pixels, polish edits, and share demos.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "Product Demo Video Maker for SaaS Teams - StoryCapture",
    template: "%s - StoryCapture",
  },
  description: siteDescription,
  keywords: [
    "product demo video maker",
    "product demo video generator",
    "demo automation software",
    "SaaS product demo video",
    "screen recording to demo video",
    "software walkthrough video",
    "browser automation video",
  ],
  alternates: {
    canonical: "/",
  },
  authors: [{ name: "StoryCapture" }],
  creator: "StoryCapture",
  publisher: "StoryCapture",
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
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
    title: "Product Demo Video Maker for SaaS Teams - StoryCapture",
    description: siteDescription,
    url: "/",
    siteName: "StoryCapture",
    type: "website",
    locale: "en_US",
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
    title: "Product Demo Video Maker for SaaS Teams - StoryCapture",
    description: siteDescription,
    images: ["/assets/storycapture-hero-product.png"],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <StoryCaptureThemeProvider>
          <TRPCReactProvider>{children}</TRPCReactProvider>
          <AstryxBrowserSupport />
        </StoryCaptureThemeProvider>
        <Analytics />
      </body>
    </html>
  );
}
