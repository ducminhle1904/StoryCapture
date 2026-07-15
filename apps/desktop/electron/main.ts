import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, nativeImage, shell } from "electron";

import identity from "./identity.json";
import { registerIpcHandlers } from "./ipc";
import { runExportCompositorArtifactSmoke } from "./ipc/export-compositor-smoke";
import { initializeExportOutputLifecycle } from "./ipc/legacy/export-output-lifecycle";
import { registerLocalAssetProtocol, registerLocalAssetScheme } from "./local-assets";
import { isDevRuntime } from "./runtime";

const here = path.dirname(fileURLToPath(import.meta.url));
const devServerUrl = process.env[identity.devServerUrlEnv] ?? identity.defaultDevServerUrl;
const titleBarOverlayHeight = 48;
const shouldUseDevServer = isDevRuntime(app);
const exportCompositorSmokeResultPath =
  app.commandLine.getSwitchValue("storycapture-export-compositor-smoke-result") ||
  process.env.STORYCAPTURE_EXPORT_COMPOSITOR_SMOKE_RESULT;

let mainWindow: BrowserWindow | null = null;

registerLocalAssetScheme();

function createAppIcon(): Electron.NativeImage | undefined {
  const iconFilename = process.platform === "win32" ? "icon.ico" : "icon.png";
  const image = nativeImage.createFromPath(path.join(app.getAppPath(), "icons", iconFilename));
  return image.isEmpty() ? undefined : image;
}

function createMainWindow(showWhenReady = true, loadFailures?: string[]): BrowserWindow {
  const appIcon = createAppIcon();
  const titleBarOptions =
    process.platform === "darwin"
      ? {
          titleBarStyle: "hidden" as const,
          trafficLightPosition: { x: 14, y: 14 },
        }
      : {
          titleBarStyle: "hidden" as const,
          titleBarOverlay: {
            color: "#050504",
            symbolColor: "#f3efe7",
            height: titleBarOverlayHeight,
          },
        };

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1080,
    minHeight: 720,
    title: "StoryCapture",
    show: false,
    backgroundColor: "#111111",
    ...(appIcon ? { icon: appIcon } : {}),
    ...titleBarOptions,
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    if (showWhenReady) mainWindow?.show();
    console.log("[electron] main window ready");
  });

  mainWindow.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    loadFailures?.push(`${isMainFrame ? "main" : "subframe"}:${code}:${description}:${url}`);
  });

  mainWindow.webContents.once("did-finish-load", () => {
    console.log("[electron] renderer finished loading");
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (shouldUseDevServer) {
    void mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    void mainWindow.loadFile(path.join(here, "..", "dist", "index.html"));
  }
  return mainWindow;
}

registerIpcHandlers();

void app.whenReady().then(async () => {
  registerLocalAssetProtocol();
  await initializeExportOutputLifecycle(app.getPath("userData")).catch((error) => {
    console.warn("[export-render] orphan cleanup failed", error);
  });
  const appIcon = createAppIcon();
  if (process.platform === "darwin" && appIcon) {
    app.dock?.setIcon(appIcon);
  }
  const mainLoadFailures: string[] = [];
  const createdMainWindow = createMainWindow(!exportCompositorSmokeResultPath, mainLoadFailures);
  if (exportCompositorSmokeResultPath) {
    const succeeded = await runExportCompositorArtifactSmoke(
      createdMainWindow,
      mainLoadFailures,
      exportCompositorSmokeResultPath,
    );
    app.exit(succeeded ? 0 : 1);
    return;
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
