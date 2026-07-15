import { describe, expect, it } from "vitest";
import { recordingCompatibilityMixArgs } from "./audio-tracks";

describe("recordingCompatibilityMixArgs", () => {
  it("pads leading gaps, mixes all stems, and preserves video duration", () => {
    const args = recordingCompatibilityMixArgs({
      stems: [
        { path: "/take/audio/microphone.webm", firstPtsUs: 80_000 },
        { path: "/take/audio/tab.webm", firstPtsUs: 120_000 },
      ],
      outputPath: "/take/audio/compatibility.m4a",
      videoDurationUs: 10_000_000,
    });
    const command = args.join(" ");
    expect(command).toContain("adelay=delays=80:all=1");
    expect(command).toContain("adelay=delays=120:all=1");
    expect(command).toContain("amix=inputs=2:duration=longest");
    expect(command).toContain("atrim=duration=10.000000");
    expect(command).not.toContain("-shortest");
  });
});
