import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  policy: "best_effort" as "best_effort" | "strict_local" | "strict_certified",
  probeEnvironment: vi.fn(),
  setPolicy: vi.fn(),
}));

vi.mock("@storycapture/ui", () => ({
  ScSegmented: ({
    options,
    onValueChange,
  }: {
    options: Array<{ value: string; label: string; disabled?: boolean; title?: string }>;
    onValueChange?: (value: string) => void;
  }) => (
    <div>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={option.disabled}
          title={option.title}
          onClick={() => onValueChange?.(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  ),
  ScSlider: () => <div />,
  ScSwitch: () => <button type="button">switch</button>,
}));

vi.mock("@/ipc/encode", () => ({
  probeRecordingV3Environment: mocks.probeEnvironment,
}));

vi.mock("@/state/app-settings", () => ({
  useAppSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({ settings: { render: { parallel_renders: 2 } }, patchRender: vi.fn() }),
}));

vi.mock("@/state/output-prefs", () => ({
  useOutputPrefsStore: (selector: (state: unknown) => unknown) =>
    selector({
      recordingKnobs: { resolution: { kind: "p1080" } },
      recordingPolicyPreference: mocks.policy,
      exportKnobs: { codec: "h264", hwEncoder: "auto" },
      setRecordingKnob: vi.fn(),
      setRecordingPolicyPreference: mocks.setPolicy,
      setExportKnob: vi.fn(),
    }),
}));

vi.mock("../settings-row", () => ({
  SettingsPanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SettingsCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SettingsRow: ({ label, control }: { label: string; control: React.ReactNode }) => (
    <section>
      <span>{label}</span>
      {control}
    </section>
  ),
}));

import { RenderCategory } from "./render-category";

describe("RenderCategory Recording V3 policy", () => {
  beforeEach(() => {
    mocks.policy = "best_effort";
    mocks.probeEnvironment.mockReset().mockResolvedValue({
      failure_codes: [],
    });
    mocks.setPolicy.mockReset();
  });

  it("shows Standard, Local and Certified and selects Local without an environment gate", async () => {
    render(<RenderCategory />);

    expect(await screen.findByRole("button", { name: "Standard" })).toBeEnabled();
    const local = screen.getByRole("button", { name: "Strict Local" });
    expect(local).toBeEnabled();
    expect(screen.getByRole("button", { name: "Strict Certified" })).toBeEnabled();
    fireEvent.click(local);
    expect(mocks.setPolicy).toHaveBeenCalledWith("strict_local");
  });

  it("keeps Certified visible with the exact unavailable reason", async () => {
    mocks.probeEnvironment.mockResolvedValue({ failure_codes: ["manifest_missing"] });
    render(<RenderCategory />);

    const certified = await screen.findByRole("button", { name: "Strict Certified" });
    expect(certified).toBeDisabled();
    expect(certified).toHaveAttribute(
      "title",
      "This build does not include a Recording V3 certification manifest.",
    );
  });

  it("shows the Local provenance warning while Local is selected", async () => {
    mocks.policy = "strict_local";
    render(<RenderCategory />);

    expect(
      await screen.findByText("Strict Local — runtime-verified, not release-certified"),
    ).toBeVisible();
  });
});
