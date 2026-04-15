import { QueryClient } from "@tanstack/react-query";

/**
 * Desktop-tuned defaults:
 * - `staleTime: 30s` — IPC results are cheap to refetch but we don't need
 *   sub-second freshness for project metadata / app info.
 * - `refetchOnWindowFocus: false` — desktop apps don't have the same
 *   tab-switching pattern as web; refetching on focus thrashes IPC.
 * - `retry: 1` — Tauri commands either succeed or fail deterministically;
 *   one retry covers transient lock contention but no more.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});
