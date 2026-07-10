import { describe, expect, it } from "vitest";
import v1Raw from "@/ipc/__fixtures__/action-sidecars/v1-short-gap.actions.json";
import v1Normalized from "@/ipc/__fixtures__/action-sidecars/v1-short-gap.normalized.json";
import v2Raw from "@/ipc/__fixtures__/action-sidecars/v2-explicit-timing.actions.json";
import v2Normalized from "@/ipc/__fixtures__/action-sidecars/v2-explicit-timing.normalized.json";
import { parseActionSidecar } from "@/ipc/action-sidecar";

import { samplePreparedVirtualCursor, sampleVirtualCursor } from "../preview/virtual-cursor-path";
import { buildVirtualCursorSchedule } from "../state/virtual-cursor-scheduler";
import { parseExportCursorSidecar } from "./cursor-sidecar";

describe("export cursor sidecar parser parity", () => {
  it.each([
    [v1Raw, v1Normalized],
    [v2Raw, v2Normalized],
  ])("uses the same normalized actions as the renderer parser", (raw, golden) => {
    const exported = parseExportCursorSidecar(raw);

    expect(exported.kind).toBe("actions");
    expect(exported.sidecar).toEqual(golden);
    expect(exported.sidecar).toEqual(parseActionSidecar(raw));
  });

  it("fails closed for unknown action sidecars", () => {
    expect(parseExportCursorSidecar({ version: 99, events: [] })).toEqual({
      kind: "unknown",
      sidecar: null,
    });
  });

  it("matches renderer samples from one prepared export schedule", () => {
    const exported = parseExportCursorSidecar(v1Raw);
    const rendererActions = parseActionSidecar(v1Raw);
    if (exported.kind !== "actions" || !rendererActions) {
      throw new Error("expected normalized action sidecar");
    }
    const schedule = buildVirtualCursorSchedule(exported.sidecar, "natural");

    for (const timeMs of [289, 290, 927, 1107, 1108, 1109, 1628]) {
      expect(samplePreparedVirtualCursor(schedule, timeMs)).toEqual(
        sampleVirtualCursor(rendererActions, timeMs, "natural"),
      );
    }
  });
});
