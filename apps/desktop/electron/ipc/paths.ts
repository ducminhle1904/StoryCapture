import path from "node:path";
import { app } from "electron";

export function userDataPath(...parts: string[]): string {
  return path.join(app.getPath("userData"), ...parts);
}
