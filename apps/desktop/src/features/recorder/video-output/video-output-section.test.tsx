/**
 * RTL suite for <VideoOutputSection /> + <OutputSummaryBadge />.
 * Resets the shared output-prefs store before each test.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DEFAULT_EXPORT_KNOBS, PRESET_BUNDLES, useOutputPrefsStore } from "@/state/output-prefs";

import { OutputSummaryBadge } from "./output-summary-badge";
import { VideoOutputSection } from "./video-output-section";

beforeEach(() => {
  useOutputPrefsStore.setState({
    activePreset: "Standard",
    recordingKnobs: PRESET_BUNDLES.Standard,
    exportKnobs: DEFAULT_EXPORT_KNOBS,
  });
});

describe("VideoOutputSection", () => {
  it("renders all 5 knob labels in English at Standard preset", () => {
    render(<VideoOutputSection />);
    expect(screen.getByText("Video output")).toBeInTheDocument();
    expect(screen.getByLabelText("Resolution")).toBeInTheDocument();
    expect(screen.getByLabelText("FPS")).toBeInTheDocument();
    expect(screen.getByLabelText("Fit mode")).toBeInTheDocument();
    expect(screen.getByLabelText("Pad color")).toBeInTheDocument();
    expect(screen.getByLabelText("Quality")).toBeInTheDocument();
  });

  it("estimates non-zero output for Match source with capture dimensions", () => {
    render(<VideoOutputSection captureDims={{ w: 3600, h: 2338 }} />);
    expect(screen.getByLabelText("Estimated bitrate")).toHaveTextContent(
      "~31.6 Mbps • ~231 MB/min",
    );
  });

  it("typing 1281 into Custom W flags the hard error + aria-invalid", async () => {
    const user = userEvent.setup();
    useOutputPrefsStore.setState({
      activePreset: "Custom",
      recordingKnobs: {
        ...PRESET_BUNDLES.Standard,
        resolution: { kind: "custom", w: 1280, h: 720 },
      },
    });
    render(<VideoOutputSection />);
    const wInput = screen.getByLabelText("Width") as HTMLInputElement;
    await user.clear(wInput);
    await user.type(wInput, "1281");
    expect(
      screen.getByText("Width/height must be even numbers within 16–7680 × 16–4320."),
    ).toBeInTheDocument();
    expect(wInput).toHaveAttribute("aria-invalid", "true");
  });

  it("lossless + 4K + HW encoder surfaces soft warning in live region", () => {
    useOutputPrefsStore.setState((s) => ({
      recordingKnobs: { ...s.recordingKnobs, resolution: { kind: "p2160" }, quality: "lossless" },
      exportKnobs: { ...s.exportKnobs, hwEncoder: "h264_videotoolbox" },
      activePreset: "Custom",
    }));
    render(<VideoOutputSection />);
    const live = screen.getByRole("status");
    expect(live).toHaveTextContent(/Lossless.*4K.*HW encoder/);
  });

  it("picking Pad = Custom reveals ColorField starting at #000000 and syncs hex → store", async () => {
    const user = userEvent.setup();
    render(<VideoOutputSection />);
    const customToggle = screen.getAllByRole("button", { name: "Custom" })[0];
    await user.click(customToggle);
    const picker = screen.getByLabelText("Pad color picker") as HTMLInputElement;
    expect(picker.value).toBe("#000000");
    const hexInputs = document.querySelectorAll<HTMLInputElement>('input[type="text"]');
    const hexInput = Array.from(hexInputs).find((el) => /^#[0-9a-f]{6}$/.test(el.value));
    if (!hexInput) throw new Error("hex text input not found");
    await user.clear(hexInput);
    await user.type(hexInput, "#ff6b2d");
    const pad = useOutputPrefsStore.getState().recordingKnobs.pad;
    expect(pad).toEqual({ kind: "custom", r: 255, g: 107, b: 45 });
  });

  it("changing FPS 60 → 30 from Standard flips activePreset to Custom", async () => {
    const user = userEvent.setup();
    render(<VideoOutputSection captureDims={{ w: 1920, h: 1080 }} />);
    expect(screen.getByLabelText("Estimated bitrate")).toHaveTextContent(
      "~7.8 Mbps • ~57 MB/min",
    );
    const thirty = screen.getByLabelText("30");
    await user.click(thirty);
    expect(useOutputPrefsStore.getState().activePreset).toBe("Custom");
    expect(screen.getByLabelText("Estimated bitrate")).toHaveTextContent(
      "~3.9 Mbps • ~28 MB/min",
    );
  });

  it("Quality Standard → Lossless flips activePreset to Lossless", async () => {
    const user = userEvent.setup();
    render(<VideoOutputSection />);
    await user.click(screen.getByLabelText("Lossless"));
    expect(useOutputPrefsStore.getState().activePreset).toBe("Lossless");
  });
});

describe("OutputSummaryBadge", () => {
  it("renders 'Match source • 60fps • Letterbox • Standard' at Standard preset", () => {
    render(<OutputSummaryBadge onActivate={() => {}} />);
    expect(screen.getByRole("button")).toHaveTextContent(
      "Match source • 60fps • Letterbox • Standard",
    );
  });

  it("invokes scrollIntoView through onActivate when clicked", async () => {
    const user = userEvent.setup();
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    const onActivate = vi.fn(() => {
      document.createElement("div").scrollIntoView();
    });
    render(<OutputSummaryBadge onActivate={onActivate} />);
    await user.click(screen.getByRole("button"));
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(scrollSpy).toHaveBeenCalledTimes(1);
  });
});
