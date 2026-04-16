"use client";

import type { QueryClient } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createTRPCClient,
  httpBatchLink,
  splitLink,
  httpSubscriptionLink,
} from "@trpc/client";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import { useState } from "react";
import superjson from "superjson";
import { makeQueryClient } from "./query-client";
import type { AppRouter } from "./routers/_app";

export const { TRPCProvider, useTRPC } = createTRPCContext<AppRouter>();

let browserQueryClient: QueryClient | undefined;

function getQueryClient() {
  if (typeof window === "undefined") {
    // Server: always make a new query client
    return makeQueryClient();
  }
  // Browser: reuse singleton
  if (!browserQueryClient) {
    browserQueryClient = makeQueryClient();
  }
  return browserQueryClient;
}

function getBaseUrl() {
  if (typeof window !== "undefined") return "";
  // SSR: use localhost
  return `http://localhost:${process.env.PORT ?? 3000}`;
}

export function TRPCReactProvider(props: { children: React.ReactNode }) {
  const queryClient = getQueryClient();

  const [trpcClient] = useState(() =>
    createTRPCClient<AppRouter>({
      links: [
        splitLink({
          condition: (op) => op.type === "subscription",
          true: httpSubscriptionLink({
            url: `${getBaseUrl()}/api/trpc`,
            transformer: superjson,
          }),
          false: httpBatchLink({
            url: `${getBaseUrl()}/api/trpc`,
            transformer: superjson,
            headers() {
              const headers = new Headers();
              headers.set("x-trpc-source", "nextjs-react");
              return headers;
            },
          }),
        }),
      ],
    }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {props.children}
      </TRPCProvider>
    </QueryClientProvider>
  );
}
