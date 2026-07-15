import type { ExportCompositionGraphV4, ExportCursorSkin } from "@storycapture/shared-types";

import type { CanonicalRenderAssets } from "./canvas-scene-renderer";
import { canonicalAssetUrl } from "./media-source-pool";
import { type EvaluatedScene, nodesOf } from "./scene-evaluator";

const cursorSkinAssetUrls = import.meta.glob("../../../../../../assets/cursor-skins/*.png", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

export type CanonicalImageLoader = (path: string) => Promise<CanvasImageSource>;

export const loadCanonicalImage: CanonicalImageLoader = (path) =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "sync";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`failed to load canonical image: ${path}`));
    image.src = canonicalAssetUrl(path);
  });

function cursorSkinUrl(skin: ExportCursorSkin): string | null {
  return cursorSkinAssetUrls[`../../../../../../assets/cursor-skins/${skin}.png`] ?? null;
}

export function canonicalCursorPngFramePath(path: string, frameIndex: number): string {
  const index = Math.max(0, Math.floor(frameIndex));
  const padded = String(index).padStart(6, "0");
  const printf = path.match(/%0?(\d*)d/);
  if (printf) {
    const width = printf[1] ? Number(printf[1]) : 0;
    return path.replace(printf[0], width > 0 ? String(index).padStart(width, "0") : String(index));
  }
  if (path.includes("{frame}")) return path.replaceAll("{frame}", padded);
  if (/\.png$/i.test(path)) return path;
  return `${path.replace(/\/$/, "")}/frame-${padded}.png`;
}

export class CanonicalImageAssetPool implements Omit<CanonicalRenderAssets, "source"> {
  private images = new Map<string, CanvasImageSource>();
  private skins = new Map<ExportCursorSkin, CanvasImageSource>();
  private cursorFrames = new Map<string, CanvasImageSource>();
  private generation = 0;

  constructor(private readonly loader: CanonicalImageLoader = loadCanonicalImage) {}

  async configure(graph: ExportCompositionGraphV4): Promise<void> {
    const generation = this.generation + 1;
    this.generation = generation;
    this.images.clear();
    this.skins.clear();
    this.cursorFrames.clear();

    const paths = new Set<string>();
    for (const background of nodesOf(graph, "background")) {
      if (background.kind.kind === "image") {
        if (!background.kind.path) {
          throw new Error(
            `canonical background asset is unresolved: ${background.kind.asset_id ?? "unknown"}`,
          );
        }
        paths.add(background.kind.path);
      }
    }
    for (const node of nodesOf(graph, "highlight-overlay")) {
      for (const highlight of node.highlights) {
        if (highlight.png_path) paths.add(highlight.png_path);
      }
    }
    for (const path of Array.from(paths).sort()) {
      const image = await this.loader(path);
      if (generation !== this.generation) {
        throw new Error("canonical image asset configuration was superseded");
      }
      this.images.set(path, image);
    }

    const skins = Array.from(
      new Set(nodesOf(graph, "cursor-overlay").map((node) => node.skin)),
    ).sort();
    for (const skin of skins) {
      const path = cursorSkinUrl(skin);
      if (!path) throw new Error(`canonical cursor skin asset is unresolved: ${skin}`);
      const image = await this.loader(path);
      if (generation !== this.generation) {
        throw new Error("canonical cursor skin configuration was superseded");
      }
      this.skins.set(skin, image);
    }
  }

  async prepare(scene: EvaluatedScene): Promise<void> {
    for (const cursor of scene.cursors) {
      if (cursor.png_frame_index == null) continue;
      const key = `${cursor.node.id}:${cursor.png_frame_index}`;
      if (this.cursorFrames.has(key)) continue;
      const path = canonicalCursorPngFramePath(cursor.node.trajectory.path, cursor.png_frame_index);
      this.cursorFrames.set(key, await this.loader(path));
    }
  }

  image(path: string): CanvasImageSource | null {
    return this.images.get(path) ?? null;
  }

  cursorSkin(skin: ExportCursorSkin): CanvasImageSource | null {
    return this.skins.get(skin) ?? null;
  }

  cursorPngFrame(cursorNodeId: string, frameIndex: number): CanvasImageSource | null {
    return this.cursorFrames.get(`${cursorNodeId}:${frameIndex}`) ?? null;
  }

  dispose(): void {
    this.generation += 1;
    this.images.clear();
    this.skins.clear();
    this.cursorFrames.clear();
  }
}
