/**
 * Plan 06-03 Task 3 — TargetThumbnail unit tests.
 *
 * Stubs the Tauri IPC + URL lifecycle APIs so the component can run
 * under happy-dom without a real recorder process.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";

// Mock the Tauri invoke call BEFORE importing the component.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...(args as [])),
  Channel: class {
    onmessage: ((v: unknown) => void) | null = null;
  },
}));

import { TargetThumbnail } from "./TargetThumbnail";
import type { CaptureTarget } from "@/ipc/capture";

// ─── test-scoped URL shim ──────────────────────────────────────────────
// happy-dom provides URL.createObjectURL in newer builds, but we stub
// both so we can assert exactly how many revocations the component fires.

const createdUrls: string[] = [];
const revokedUrls: string[] = [];
let nextUrlId = 0;

beforeEach(() => {
  createdUrls.length = 0;
  revokedUrls.length = 0;
  nextUrlId = 0;
  invokeMock.mockReset();
  // @ts-ignore — spy override
  globalThis.URL.createObjectURL = vi.fn((blob: Blob) => {
    const url = `blob:test:${++nextUrlId}:${blob.size}`;
    createdUrls.push(url);
    return url;
  });
  // @ts-ignore — spy override
  globalThis.URL.revokeObjectURL = vi.fn((url: string) => {
    revokedUrls.push(url);
  });
});

afterEach(() => {
  cleanup();
});

// ─── helpers ───────────────────────────────────────────────────────────

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
    },
  });
}

function wrap(children: React.ReactNode, client: QueryClient) {
  return (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

const fakePngBytes = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
];

const displayTarget: CaptureTarget = { kind: "display", display_id: 7 };
const altTarget: CaptureTarget = { kind: "display", display_id: 11 };

// ─── tests ─────────────────────────────────────────────────────────────

describe("TargetThumbnail — placeholder when no target", () => {
  it("renders placeholder for null target and never invokes IPC", async () => {
    const client = makeClient();
    render(wrap(<TargetThumbnail target={null} />, client));
    expect(screen.getByTestId("target-thumbnail-placeholder")).toBeInTheDocument();
    expect(screen.queryByTestId("target-thumbnail-image")).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("TargetThumbnail — paused suspends refetch", () => {
  it("shows a 'paused' message and never fires the IPC", async () => {
    const client = makeClient();
    render(
      wrap(<TargetThumbnail target={displayTarget} paused={true} />, client),
    );
    expect(screen.getByText("Paused during recording")).toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("TargetThumbnail — success path", () => {
  it("converts PNG bytes → object URL and renders an <img>", async () => {
    invokeMock.mockResolvedValue(fakePngBytes);
    const client = makeClient();
    render(wrap(<TargetThumbnail target={displayTarget} />, client));

    const img = await screen.findByTestId("target-thumbnail-image");
    expect(img).toBeInTheDocument();
    expect((img as HTMLImageElement).src).toMatch(/^blob:test:/);
    expect(createdUrls).toHaveLength(1);
    expect(invokeMock).toHaveBeenCalledWith(
      "capture_target_thumbnail",
      expect.objectContaining({
        target: displayTarget,
      }),
    );
  });
});

describe("TargetThumbnail — error path shows placeholder (no red state)", () => {
  it("renders the placeholder when the IPC throws", async () => {
    invokeMock.mockRejectedValue(new Error("TCC denied"));
    const client = makeClient();
    render(wrap(<TargetThumbnail target={displayTarget} />, client));
    await waitFor(() =>
      expect(
        screen.getByTestId("target-thumbnail-placeholder"),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("target-thumbnail-image")).toBeNull();
  });
});

describe("TargetThumbnail — objectURL revocation", () => {
  it("revokes the objectURL on unmount (T-06-20)", async () => {
    invokeMock.mockResolvedValue(fakePngBytes);
    const client = makeClient();
    const { unmount } = render(
      wrap(<TargetThumbnail target={displayTarget} />, client),
    );
    await screen.findByTestId("target-thumbnail-image");
    expect(createdUrls).toHaveLength(1);
    unmount();
    // The component revokes in the useEffect cleanup.
    expect(revokedUrls).toContain(createdUrls[0]);
  });

  it("revokes the previous URL when the target changes", async () => {
    invokeMock.mockResolvedValue(fakePngBytes);
    const client = makeClient();
    const { rerender } = render(
      wrap(<TargetThumbnail target={displayTarget} />, client),
    );
    await screen.findByTestId("target-thumbnail-image");
    expect(createdUrls).toHaveLength(1);
    const firstUrl = createdUrls[0];

    // Swap to a different target — query invalidates, new PNG fetched,
    // new objectURL created, old one revoked.
    invokeMock.mockResolvedValue(fakePngBytes);
    rerender(wrap(<TargetThumbnail target={altTarget} />, client));
    await waitFor(() => {
      expect(createdUrls.length).toBeGreaterThanOrEqual(2);
    });
    expect(revokedUrls).toContain(firstUrl);
  });
});
