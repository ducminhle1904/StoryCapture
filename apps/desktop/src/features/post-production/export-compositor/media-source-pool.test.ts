import { describe, expect, it, vi } from "vitest";

import { canonicalGraph, canonicalSource, canonicalTransition } from "./canonical-test-fixture";
import {
  type CanonicalMediaHandle,
  type CanonicalMediaLoader,
  CanonicalMediaSourcePool,
} from "./media-source-pool";
import { evaluateScene } from "./scene-evaluator";

describe("canonical media source pool", () => {
  it("selects the master-decoder loader mode only for canonical export", async () => {
    const loader: CanonicalMediaLoader = vi.fn(async () => ({
      source: {} as CanvasImageSource,
      duration_us: null,
      seek: async () => undefined,
      dispose: vi.fn(),
    }));
    const graph = canonicalGraph([canonicalSource("source-a", 0, 1_000)]);
    const pool = new CanonicalMediaSourcePool(loader);
    await pool.configure(graph, "export");
    expect(loader).toHaveBeenCalledWith(expect.objectContaining({ id: "source-a" }), "export");
    pool.dispose();
  });

  it("loads and seeks multiple sources in stable order, deduplicates seeks, and holds last frame", async () => {
    const events: string[] = [];
    const handles = new Map<string, CanonicalMediaHandle>();
    const loader: CanonicalMediaLoader = vi.fn(async (node) => {
      events.push(`load:${node.id}`);
      const handle: CanonicalMediaHandle = {
        source: { width: 1_280, height: 720 } as unknown as CanvasImageSource,
        duration_us: 1_000_000,
        async seek(sourcePtsUs, options) {
          events.push(`seek:${node.id}:${sourcePtsUs}:${options.last_frame}`);
        },
        dispose() {
          events.push(`dispose:${node.id}`);
        },
      };
      handles.set(node.id, handle);
      return handle;
    });
    const sourceA = canonicalSource("source-a", 0, 1_000);
    const sourceB = canonicalSource("source-b", 1_000, 1_000);
    const graph = canonicalGraph([sourceB, canonicalTransition("fade"), sourceA]);
    graph.output_fps = 10;
    graph.duration_ms = 2_400;
    const pool = new CanonicalMediaSourcePool(loader);

    await pool.configure(graph);
    expect(events).toEqual(["load:source-a", "load:source-b"]);
    expect(pool.loadedSourceIds()).toEqual(["source-a", "source-b"]);

    const transitionFrame = evaluateScene(graph, 850);
    await pool.prepare(transitionFrame);
    expect(events.slice(2)).toEqual(["seek:source-a:850000:false", "seek:source-b:50000:false"]);

    await pool.prepare(transitionFrame);
    expect(events).toHaveLength(4);

    await pool.prepare(evaluateScene(graph, 2_300));
    expect(events.at(-1)).toBe("seek:source-b:900000:true");
    expect(pool.source("source-a")).toBe(handles.get("source-a")?.source);

    pool.dispose();
    expect(events.slice(-2)).toEqual(["dispose:source-a", "dispose:source-b"]);
  });

  it("disposes partial state when a deterministic load fails", async () => {
    const disposed = vi.fn();
    const loader: CanonicalMediaLoader = async (node) => {
      if (node.id === "source-b") throw new Error("boom");
      return {
        source: {} as CanvasImageSource,
        duration_us: null,
        seek: async () => undefined,
        dispose: disposed,
      };
    };
    const pool = new CanonicalMediaSourcePool(loader);
    const graph = canonicalGraph([
      canonicalSource("source-a", 0, 1_000),
      canonicalSource("source-b", 1_000, 1_000),
    ]);

    await expect(pool.configure(graph)).rejects.toThrow("boom");
    expect(disposed).toHaveBeenCalledOnce();
    expect(pool.loadedSourceIds()).toEqual([]);
  });

  it("clamps an active source with overstated graph duration to its final decodable frame", async () => {
    const seek = vi.fn(async () => undefined);
    const loader: CanonicalMediaLoader = async () => ({
      source: {} as CanvasImageSource,
      duration_us: 1_000_000,
      seek,
      dispose: vi.fn(),
    });
    const graph = canonicalGraph([canonicalSource("source-a", 0, 2_000)]);
    graph.output_fps = 10;
    graph.duration_ms = 2_000;
    const pool = new CanonicalMediaSourcePool(loader);

    await pool.configure(graph);
    await pool.prepare(evaluateScene(graph, 1_500));

    expect(seek).toHaveBeenCalledWith(900_000, {
      last_frame: false,
      frame_duration_us: 100_000,
    });
    pool.dispose();
  });
});
