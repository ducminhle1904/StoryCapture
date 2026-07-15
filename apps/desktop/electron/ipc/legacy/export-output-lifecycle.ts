import fs from "node:fs/promises";
import path from "node:path";

const RESERVATION_SUFFIX = ".storycapture-reservation.json";
const REGISTRY_FILENAME = "export-output-folders.json";

export interface ExportOutputReservation {
  finalPath: string;
  tempPath: string;
  reservationPath: string;
}

interface ReservationRecord {
  version: 1;
  pid: number;
  createdAt: number;
  finalPath: string;
  tempPath: string;
}

let outputFolderRegistryPath: string | null = null;
let outputFolderRegistryWrite: Promise<void> = Promise.resolve();

function numberedPath(desiredPath: string, attempt: number): string {
  if (attempt === 1) return desiredPath;
  const extension = path.extname(desiredPath);
  return path.join(
    path.dirname(desiredPath),
    `${path.basename(desiredPath, extension)}-${attempt}${extension}`,
  );
}

function tempPathFor(finalPath: string, jobId: string): string {
  const extension = path.extname(finalPath);
  const stem = path.basename(finalPath, extension);
  return path.join(path.dirname(finalPath), `.${stem}.storycapture-${jobId}.part${extension}`);
}

function pathIsInside(folder: string, candidate: string): boolean {
  const relative = path.relative(folder, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export async function reserveExportOutputPath(
  desiredPath: string,
  jobId: string,
): Promise<ExportOutputReservation> {
  await fs.mkdir(path.dirname(desiredPath), { recursive: true });
  for (let attempt = 1; attempt < 10_000; attempt += 1) {
    const finalPath = numberedPath(desiredPath, attempt);
    const tempPath = tempPathFor(finalPath, jobId);
    const reservationPath = `${finalPath}${RESERVATION_SUFFIX}`;
    if (await fs.stat(finalPath).catch(() => null)) continue;
    const record: ReservationRecord = {
      version: 1,
      pid: process.pid,
      createdAt: Date.now(),
      finalPath,
      tempPath,
    };
    try {
      await fs.writeFile(reservationPath, `${JSON.stringify(record)}\n`, { flag: "wx" });
      if (await fs.stat(finalPath).catch(() => null)) {
        await fs.rm(reservationPath, { force: true });
        continue;
      }
      return { finalPath, tempPath, reservationPath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error(`could not reserve an output path for ${desiredPath}`);
}

export async function commitExportOutput(reservation: ExportOutputReservation): Promise<void> {
  try {
    // The temp and final names share a folder, so a hard link publishes the
    // verified inode atomically without rename's POSIX overwrite behavior.
    await fs.link(reservation.tempPath, reservation.finalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`reserved output path already exists at commit: ${reservation.finalPath}`, {
        cause: error,
      });
    }
    throw error;
  }
  const tempRemoved = await fs
    .rm(reservation.tempPath, { force: true })
    .then(() => true)
    .catch(() => false);
  if (tempRemoved) {
    await fs.rm(reservation.reservationPath, { force: true }).catch(() => undefined);
  }
}

export async function releaseExportOutput(reservation: ExportOutputReservation): Promise<void> {
  await fs.rm(reservation.tempPath, { force: true });
  await fs.rm(reservation.reservationPath, { force: true });
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function cleanupOrphanedExportArtifacts(folder: string): Promise<number> {
  const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(RESERVATION_SUFFIX)) continue;
    const reservationPath = path.join(folder, entry.name);
    let record: ReservationRecord | null = null;
    try {
      record = JSON.parse(await fs.readFile(reservationPath, "utf8")) as ReservationRecord;
    } catch {
      await fs.rm(reservationPath, { force: true });
      removed += 1;
      continue;
    }
    if (
      record.version !== 1 ||
      !pathIsInside(folder, record.finalPath) ||
      !pathIsInside(folder, record.tempPath) ||
      processIsAlive(record.pid)
    ) {
      continue;
    }
    await fs.rm(record.tempPath, { force: true });
    await fs.rm(reservationPath, { force: true });
    removed += 1;
  }
  return removed;
}

async function readRegisteredFolders(registryPath: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(registryPath, "utf8")) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (value): value is string => typeof value === "string" && path.isAbsolute(value),
        )
      : [];
  } catch {
    return [];
  }
}

export async function initializeExportOutputLifecycle(userDataPath: string): Promise<void> {
  outputFolderRegistryPath = path.join(userDataPath, REGISTRY_FILENAME);
  const folders = await readRegisteredFolders(outputFolderRegistryPath);
  await Promise.all(folders.map((folder) => cleanupOrphanedExportArtifacts(folder)));
}

export async function prepareExportOutputFolder(folder: string): Promise<void> {
  await fs.mkdir(folder, { recursive: true });
  await cleanupOrphanedExportArtifacts(folder);
  if (!outputFolderRegistryPath) return;
  const registryPath = outputFolderRegistryPath;
  const update = outputFolderRegistryWrite
    .catch(() => undefined)
    .then(async () => {
      const folders = new Set(await readRegisteredFolders(registryPath));
      folders.add(path.resolve(folder));
      await fs.mkdir(path.dirname(registryPath), { recursive: true });
      const tempRegistry = `${registryPath}.${process.pid}.tmp`;
      await fs.writeFile(tempRegistry, `${JSON.stringify([...folders].sort(), null, 2)}\n`);
      await fs.rename(tempRegistry, registryPath);
    });
  outputFolderRegistryWrite = update;
  await update;
}
