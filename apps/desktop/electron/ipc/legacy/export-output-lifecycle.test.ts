import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupOrphanedExportArtifacts,
  commitExportOutput,
  initializeExportOutputLifecycle,
  prepareExportOutputFolder,
  releaseExportOutput,
  reserveExportOutputPath,
} from "./export-output-lifecycle";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-export-output-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("export output lifecycle", () => {
  it("reserves collision-free names atomically and commits without overwriting", async () => {
    const root = await tempRoot();
    const desired = path.join(root, "demo.mp4");
    const first = await reserveExportOutputPath(desired, "job-a");
    const second = await reserveExportOutputPath(desired, "job-b");
    expect(first.finalPath).toBe(desired);
    expect(second.finalPath).toBe(path.join(root, "demo-2.mp4"));
    await expect(fs.stat(first.finalPath)).rejects.toMatchObject({ code: "ENOENT" });

    await fs.writeFile(first.tempPath, "encoded-a");
    await commitExportOutput(first);
    expect(await fs.readFile(desired, "utf8")).toBe("encoded-a");
    await expect(fs.stat(first.tempPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(first.reservationPath)).rejects.toMatchObject({ code: "ENOENT" });

    await releaseExportOutput(second);
    await expect(fs.stat(second.finalPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes orphan temp files and reservations", async () => {
    const root = await tempRoot();
    const reservation = await reserveExportOutputPath(path.join(root, "orphan.webm"), "job-c");
    await fs.writeFile(reservation.tempPath, "partial");
    const record = JSON.parse(await fs.readFile(reservation.reservationPath, "utf8"));
    record.pid = 999_999_999;
    await fs.writeFile(reservation.reservationPath, JSON.stringify(record));

    await expect(cleanupOrphanedExportArtifacts(root)).resolves.toBe(1);
    await expect(fs.stat(reservation.tempPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(reservation.finalPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to replace a file created after reservation", async () => {
    const root = await tempRoot();
    const reservation = await reserveExportOutputPath(path.join(root, "race.mp4"), "job-d");
    await fs.writeFile(reservation.tempPath, "encoded");
    await fs.writeFile(reservation.finalPath, "external");

    await expect(commitExportOutput(reservation)).rejects.toThrow(/already exists at commit/);
    expect(await fs.readFile(reservation.finalPath, "utf8")).toBe("external");
    await releaseExportOutput(reservation);
    expect(await fs.readFile(reservation.finalPath, "utf8")).toBe("external");
  });

  it("keeps every output folder when registry updates overlap", async () => {
    const root = await tempRoot();
    const userData = path.join(root, "user-data");
    const first = path.join(root, "exports-a");
    const second = path.join(root, "exports-b");
    await initializeExportOutputLifecycle(userData);

    await Promise.all([prepareExportOutputFolder(first), prepareExportOutputFolder(second)]);

    const registered = JSON.parse(
      await fs.readFile(path.join(userData, "export-output-folders.json"), "utf8"),
    );
    expect(registered).toEqual([first, second].sort());
  });
});
