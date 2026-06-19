import { app, BrowserWindow, nativeImage, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

import identity from "./identity.json";
import { registerIpcHandlers } from "./ipc";
import { registerLocalAssetProtocol, registerLocalAssetScheme } from "./local-assets";
import { isDevRuntime } from "./runtime";

const here = path.dirname(fileURLToPath(import.meta.url));
const devServerUrl = process.env[identity.devServerUrlEnv] ?? identity.defaultDevServerUrl;
const titleBarOverlayHeight = 48;
const shouldUseDevServer = isDevRuntime(app);

let mainWindow: BrowserWindow | null = null;

registerLocalAssetScheme();

function createAppIcon(): Electron.NativeImage | undefined {
  const iconFilename = process.platform === "win32" ? "icon.ico" : "icon.png";
  const image = nativeImage.createFromPath(path.join(app.getAppPath(), "icons", iconFilename));
  return image.isEmpty() ? undefined : image;
}

function createMainWindow(): void {
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
    mainWindow?.show();
    console.log("[electron] main window ready");
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
}

registerIpcHandlers();

void app.whenReady().then(() => {
  registerLocalAssetProtocol();
  const appIcon = createAppIcon();
  if (process.platform === "darwin" && appIcon) {
    app.dock?.setIcon(appIcon);
  }
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
