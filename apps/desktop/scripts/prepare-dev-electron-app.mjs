#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, rename as fsRename, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const identity = JSON.parse(
  await readFile(path.join(desktopRoot, "electron", "identity.json"), "utf8"),
);

const scriptVersion = 4;
const devAppName = identity.devAppName;
const devBundleId = identity.devBundleId;
const devRoot = path.join(desktopRoot, ".electron-dev");
const devAppPath = path.join(devRoot, `${devAppName}.app`);
const markerPath = path.join(devRoot, "metadata.json");
const iconFilename = "icon.icns";
const iconSourcePath = path.join(desktopRoot, "icons", iconFilename);

function stockElectronAppPath(electronExecutable) {
  const macOSDir = path.dirname(electronExecutable);
  const contentsDir = path.dirname(macOSDir);
  return path.dirname(contentsDir);
}

function setPlistString(plistPath, key, value) {
  try {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plistPath], {
      stdio: "ignore",
    });
  } catch {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Add :${key} string ${value}`, plistPath], {
      stdio: "ignore",
    });
  }
}

async function readJson(pathname) {
  try {
    return JSON.parse(await readFile(pathname, "utf8"));
  } catch {
    return null;
  }
}

async function fileHash(pathname) {
  return createHash("sha256")
    .update(await readFile(pathname))
    .digest("hex");
}

export async function prepareDevElectronApp() {
  const electronExecutable = require("electron");
  if (process.platform !== "darwin") {
    return {
      appPath: null,
      executablePath: electronExecutable,
    };
  }

  const electronVersion = require("electron/package.json").version;
  const sourceAppPath = stockElectronAppPath(electronExecutable);
  const iconHash = await fileHash(iconSourcePath);
  const expectedMarker = {
    scriptVersion,
    electronVersion,
    sourceAppPath,
    appName: devAppName,
    bundleId: devBundleId,
    iconHash,
  };
  const currentMarker = await readJson(markerPath);
  const markerMatches =
    currentMarker != null &&
    Object.entries(expectedMarker).every(([key, value]) => currentMarker[key] === value);

  if (!markerMatches) {
    await mkdir(devRoot, { recursive: true });
    await rm(devAppPath, { recursive: true, force: true });
    await cp(sourceAppPath, devAppPath, { recursive: true, verbatimSymlinks: true });

    const plistPath = path.join(devAppPath, "Contents", "Info.plist");
    const originalExecutablePath = path.join(
      devAppPath,
      "Contents",
      "MacOS",
      path.basename(electronExecutable),
    );
    const devExecutablePath = path.join(devAppPath, "Contents", "MacOS", devAppName);
    await rm(devExecutablePath, { force: true });
    await fsRename(originalExecutablePath, devExecutablePath);

    const resourcesPath = path.join(devAppPath, "Contents", "Resources");
    await mkdir(resourcesPath, { recursive: true });
    await cp(iconSourcePath, path.join(resourcesPath, iconFilename));

    setPlistString(plistPath, "CFBundleIdentifier", devBundleId);
    setPlistString(plistPath, "CFBundleName", devAppName);
    setPlistString(plistPath, "CFBundleDisplayName", devAppName);
    setPlistString(plistPath, "CFBundleExecutable", devAppName);
    setPlistString(plistPath, "CFBundleIconFile", iconFilename);
    setPlistString(
      plistPath,
      "NSMicrophoneUsageDescription",
      "StoryCapture records optional voice-over audio while capturing demos.",
    );

    execFileSync("codesign", ["--force", "--sign", "-", devAppPath], {
      stdio: "inherit",
    });
    await writeFile(markerPath, `${JSON.stringify(expectedMarker, null, 2)}\n`);
  }

  return {
    appPath: devAppPath,
    executablePath: path.join(devAppPath, "Contents", "MacOS", devAppName),
  };
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const result = await prepareDevElectronApp();
  if (process.argv.includes("--print-executable")) {
    console.log(result.executablePath);
  } else if (result.appPath) {
    console.log(`Prepared ${result.appPath}`);
  } else {
    console.log("Dev app bundle preparation is only required on macOS.");
  }
}
