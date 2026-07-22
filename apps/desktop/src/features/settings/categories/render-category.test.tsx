import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  developmentMode: false,
  probeDevelopmentEnvironment: vi.fn(),
  setDevelopmentMode: vi.fn(),
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
  probeRecordingV3Environment: vi.fn().mockResolvedValue({ failure_codes: [] }),
  probeRecordingV3DevelopmentEnvironment: mocks.probeDevelopmentEnvironment,
}));

vi.mock("@/state/app-settings", () => ({
  useAppSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({ settings: { render: { parallel_renders: 2 } }, patchRender: vi.fn() }),
}));

vi.mock("@/state/output-prefs", () => ({
  useOutputPrefsStore: (selector: (state: unknown) => unknown) =>
    selector({
      recordingKnobs: { resolution: { kind: "p1080" } },
      recordingDeliveryPolicy: "best_effort",
      recordingV3DevelopmentMode: mocks.developmentMode,
      exportKnobs: { codec: "h264", hwEncoder: "auto" },
      setRecordingKnob: vi.fn(),
      setRecordingDeliveryPolicy: vi.fn(),
      setRecordingV3DevelopmentMode: mocks.setDevelopmentMode,
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

describe("RenderCategory Recording V3 development mode", () => {
  beforeEach(() => {
    mocks.developmentMode = false;
    mocks.probeDevelopmentEnvironment.mockReset().mockResolvedValue({
      development_enabled: true,
      development_available: true,
      failure_codes: [],
    });
    mocks.setDevelopmentMode.mockReset();
  });

  it("hides Dev V3 when the guarded development runtime is disabled", async () => {
    mocks.probeDevelopmentEnvironment.mockResolvedValue({
      development_enabled: false,
      development_available: false,
      failure_codes: [],
    });
    render(<RenderCategory />);

    await screen.findByRole("button", { name: "Standard" });
    expect(screen.queryByRole("button", { name: "Dev V3" })).not.toBeInTheDocument();
  });

  it("shows the gated Dev V3 option and selects the session-only mode", async () => {
    render(<RenderCategory />);

    const option = await screen.findByRole("button", { name: "Dev V3" });
    expect(option).toBeEnabled();
    fireEvent.click(option);
    expect(mocks.setDevelopmentMode).toHaveBeenCalledWith(true);
  });

  it("shows the mandatory warning while development mode is selected", async () => {
    mocks.developmentMode = true;
    render(<RenderCategory />);

    expect(
      await screen.findByText("Uncertified Development — not a Strict-certified recording"),
    ).toBeVisible();
  });
});
