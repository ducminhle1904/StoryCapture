import { app, BrowserWindow, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { registerIpcHandlers } from "./ipc";

const here = path.dirname(fileURLToPath(import.meta.url));
const devServerUrl = process.env.VITE_DEV_SERVER_URL ?? "http://127.0.0.1:1420";

let mainWindow: BrowserWindow | null = null;

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1080,
    minHeight: 720,
    title: "StoryCapture",
    show: false,
    backgroundColor: "#111111",
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

  if (app.isPackaged) {
    void mainWindow.loadFile(path.join(here, "..", "dist", "index.html"));
  } else {
    void mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
}

registerIpcHandlers();

void app.whenReady().then(() => {
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
