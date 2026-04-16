import type { Metadata } from "next";
import { TRPCReactProvider } from "@/trpc/client";
import "@/styles/globals.css";

export const metadata: Metadata = {
  title: "StoryCapture",
  description:
    "Turn structured user stories into polished demo videos automatically.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body>
        <TRPCReactProvider>{children}</TRPCReactProvider>
      </body>
    </html>
  );
}
