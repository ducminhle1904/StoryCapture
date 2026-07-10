import { app } from "electron";
import electronUpdater, {
  type UpdateInfo as ElectronUpdateInfo,
  type UpdateCheckResult,
} from "electron-updater";

const { autoUpdater } = electronUpdater;

let pendingUpdateCheck: UpdateCheckResult | null = null;

export function releaseNotesText(notes: ElectronUpdateInfo["releaseNotes"]): string | null {
  if (typeof notes === "string") return notes;
  if (Array.isArray(notes)) {
    const text = notes
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (entry && typeof entry === "object" && "note" in entry) {
          return String(entry.note ?? "");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n\n");
    return text || null;
  }
  return null;
}

function updateInfoDto(info: ElectronUpdateInfo) {
  return {
    version: info.version,
    date: info.releaseDate ?? null,
    body: releaseNotesText(info.releaseNotes),
    current_version: app.getVersion(),
  };
}

export async function checkElectronUpdate() {
  if (!app.isPackaged && !process.env.STORYCAPTURE_DEBUG_UPDATER) {
    pendingUpdateCheck = null;
    return null;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  const result = await autoUpdater.checkForUpdates();
  pendingUpdateCheck = result;
  if (!result?.updateInfo) return null;
  if (result.updateInfo.version === app.getVersion()) return null;
  return updateInfoDto(result.updateInfo);
}

export async function installElectronUpdate(): Promise<null> {
  if (!app.isPackaged && !process.env.STORYCAPTURE_DEBUG_UPDATER) {
    throw new Error("updater install is unavailable in development builds");
  }

  if (!pendingUpdateCheck) {
    pendingUpdateCheck = await autoUpdater.checkForUpdates();
  }
  if (!pendingUpdateCheck?.updateInfo) {
    throw new Error("no update available");
  }

  await autoUpdater.downloadUpdate();
  autoUpdater.quitAndInstall(false, true);
  return null;
}

export function getPendingUpdateInfo(): ElectronUpdateInfo | null {
  return pendingUpdateCheck?.updateInfo ?? null;
}
