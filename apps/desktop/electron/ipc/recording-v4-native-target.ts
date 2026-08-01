export interface MacRecordingV4SurfaceTarget {
  kind: "window";
  windowID: number;
  ownerPID: number;
  ownerBundleID: string;
  mediaSourceID: string;
}

export type WindowsRecordingV4Target =
  | { kind: "display"; device_path: string }
  | {
      kind: "window";
      hwnd: string;
      process_id: number;
      executable_path: string;
      class_name: string;
    };
