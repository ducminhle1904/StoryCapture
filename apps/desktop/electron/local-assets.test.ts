import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  app: {
    getAppPath: vi.fn(),
    getPath: vi.fn(),
  },
  protocol: {
    handle: vi.fn(),
    registerSchemesAsPrivileged: vi.fn(),
  },
}));

vi.mock("electron", () => electronMock);

import { convertLocalAssetPath } from "./local-asset-url";
import { registerLocalAssetProtocol } from "./local-assets";

type ProtocolHandler = (request: Request) => Promise<Response>;

let tempDir: string;
let assetsDir: string;
let handler: ProtocolHandler;

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-local-assets-test-"));
  assetsDir = path.join(tempDir, "assets");
  await fs.mkdir(assetsDir);
  Object.defineProperty(process, "resourcesPath", { configurable: true, value: tempDir });
  electronMock.app.getPath.mockReturnValue(tempDir);
  electronMock.app.getAppPath.mockReturnValue(tempDir);
  registerLocalAssetProtocol();
  handler = electronMock.protocol.handle.mock.calls[0]?.[1] as ProtocolHandler;
});

afterAll(async () => {
  await fs.rm(tempDir, { force: true, recursive: true });
});

async function requestAsset(fileName: string, range?: string): Promise<Response> {
  const headers = range ? { range } : undefined;
  return handler(new Request(convertLocalAssetPath(path.join(assetsDir, fileName)), { headers }));
}

describe("local asset protocol", () => {
  it("streams a complete non-video asset whose path contains spaces and Unicode", async () => {
    const fileName = "ảnh preview 01.png";
    const bytes = Buffer.from("png payload");
    await fs.writeFile(path.join(assetsDir, fileName), bytes);

    const response = await requestAsset(fileName);

    expect(response.status).toBe(200);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-length")).toBe(String(bytes.length));
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });

  it("serves a bounded video byte range", async () => {
    await fs.writeFile(path.join(assetsDir, "clip.mp4"), "0123456789");

    const response = await requestAsset("clip.mp4", "bytes=2-5");

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(response.headers.get("content-length")).toBe("4");
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(await response.text()).toBe("2345");
  });

  it("returns 416 with the complete size for an unsatisfiable range", async () => {
    await fs.writeFile(path.join(assetsDir, "short.webm"), "1234");

    const response = await requestAsset("short.webm", "bytes=9-");

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */4");
    expect(await response.text()).toBe("");
  });

  it("keeps files outside authorized roots inaccessible", async () => {
    const outsidePath = path.join(os.tmpdir(), `storycapture-outside-${Date.now()}.txt`);
    await fs.writeFile(outsidePath, "private");
    try {
      const response = await handler(new Request(convertLocalAssetPath(outsidePath)));
      expect(response.status).toBe(404);
    } finally {
      await fs.rm(outsidePath, { force: true });
    }
  });

  it("closes the file descriptor when the response stream is cancelled", async () => {
    await fs.writeFile(path.join(assetsDir, "cancel.wav"), "audio bytes");
    const close = vi.fn(async () => undefined);
    const read = vi.fn(async () => ({ bytesRead: 0, buffer: Buffer.alloc(0) }));
    const open = vi.spyOn(fs, "open").mockResolvedValueOnce({
      stat: async () => ({ isFile: () => true, size: 11 }),
      read,
      close,
    } as never);

    try {
      const response = await requestAsset("cancel.wav");
      await response.body?.cancel();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      open.mockRestore();
    }
  });

  it("closes the file descriptor when a stream read fails", async () => {
    await fs.writeFile(path.join(assetsDir, "broken.ogg"), "audio bytes");
    const close = vi.fn(async () => undefined);
    const open = vi.spyOn(fs, "open").mockResolvedValueOnce({
      stat: async () => ({ isFile: () => true, size: 11 }),
      read: async () => {
        throw new Error("read failed");
      },
      close,
    } as never);

    try {
      const response = await requestAsset("broken.ogg");
      await expect(response.arrayBuffer()).rejects.toThrow("read failed");
      expect(close).toHaveBeenCalledOnce();
    } finally {
      open.mockRestore();
    }
  });

  it("closes the file descriptor when the request is aborted", async () => {
    await fs.writeFile(path.join(assetsDir, "abort.mov"), "video bytes");
    const close = vi.fn(async () => undefined);
    const open = vi.spyOn(fs, "open").mockResolvedValueOnce({
      stat: async () => ({ isFile: () => true, size: 11 }),
      read: vi.fn(),
      close,
    } as never);
    const controller = new AbortController();

    try {
      const request = new Request(convertLocalAssetPath(path.join(assetsDir, "abort.mov")), {
        signal: controller.signal,
      });
      const response = await handler(request);
      controller.abort();
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      await response.body?.cancel().catch(() => undefined);
    } finally {
      open.mockRestore();
    }
  });
});
