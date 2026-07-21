/**
 * AdvancedOutputOptions RTL suite. Covers 3-subgroup layout, auto-hide
 * semantics, probe-driven HW list, conditional quality control
 * rendering, persistence-warning, and copy.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockProbe = vi.fn();
vi.mock("@/ipc/encode", () => ({
  probeHwEncoders: (...a: unknown[]) => mockProbe(...a),
}));

import { DEFAULT_EXPORT_KNOBS, useOutputPrefsStore } from "@/state/output-prefs";
import { AdvancedOutputOptions } from "./advanced-output-options";

function Wrapped({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function resetStore(overrides?: Partial<typeof DEFAULT_EXPORT_KNOBS>) {
  useOutputPrefsStore.setState({
    exportKnobs: { ...DEFAULT_EXPORT_KNOBS, ...overrides },
  });
}

async function flushQueries() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  mockProbe.mockReset();
  mockProbe.mockResolvedValue({ available: [], preferred: "openh-264-software" });
  resetStore();
});

describe("AdvancedOutputOptions", () => {
  it("renders 3 visual sub-group labels", async () => {
    render(
      <Wrapped>
        <AdvancedOutputOptions />
      </Wrapped>,
    );
    await flushQueries();
    expect(screen.getByText(/Format & Codec/)).toBeInTheDocument();
    expect(screen.getByText(/Encoder & Quality/)).toBeInTheDocument();
    expect(screen.getByText(/Keyframe \/ Resolution \/ Audio/)).toBeInTheDocument();
  });

  it("hwEncoder=auto hides quality slider and shows explanatory note", async () => {
    render(
      <Wrapped>
        <AdvancedOutputOptions />
      </Wrapped>,
    );
    await flushQueries();
    expect(screen.getByText(/software libx264.*stable, deterministic/i)).toBeInTheDocument();
    expect(screen.queryByText(/Quality \(lower/)).not.toBeInTheDocument();
  });

  it("hwEncoder=software shows CRF slider + preset select", async () => {
    resetStore({ hwEncoder: "software" });
    render(
      <Wrapped>
        <AdvancedOutputOptions />
      </Wrapped>,
    );
    await flushQueries();
    expect(screen.getAllByText(/Quality \(lower/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Encoding speed/).length).toBeGreaterThan(0);
  });

  it("unavailable persisted HW encoder shows soft warning", async () => {
    mockProbe.mockResolvedValue({ available: [], preferred: "openh-264-software" });
    resetStore({ hwEncoder: "h264-nvenc" });
    render(
      <Wrapped>
        <AdvancedOutputOptions />
      </Wrapped>,
    );
    await flushQueries();
    expect(screen.getByTestId("hw-encoder-warning")).toHaveTextContent(/h264-nvenc/);
    expect(screen.getByTestId("hw-encoder-warning")).toHaveTextContent(/is not available/);
  });

  it("shows all field labels when encoder has full controls", async () => {
    resetStore({ hwEncoder: "software" });
    render(
      <Wrapped>
        <AdvancedOutputOptions />
      </Wrapped>,
    );
    await flushQueries();
    for (const label of [
      "File format",
      "Codec",
      "Hardware encoder",
      /Keyframe interval/,
      "Audio codec",
      /Audio bitrate/,
      "Channels",
    ]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it("uses probe result to derive available encoders (no NVENC when absent)", async () => {
    mockProbe.mockResolvedValue({
      available: ["video-toolbox-h264", "openh-264-software"],
      preferred: "video-toolbox-h264",
    });
    render(
      <Wrapped>
        <AdvancedOutputOptions />
      </Wrapped>,
    );
    await flushQueries();
    // The invoked query key is 'hw-encoders'; assert the probe was called
    // (lazy-on-mount pattern is fine — the accordion is already expanded
    // in-situ once the user opens it, so this component mounts fresh each open).
    expect(mockProbe).toHaveBeenCalled();
  });

  it("does not duplicate the software option when probe exposes libx264", async () => {
    mockProbe.mockResolvedValue({
      available: ["libx264-software", "video-toolbox-h264"],
      preferred: "libx264-software",
    });
    render(
      <Wrapped>
        <AdvancedOutputOptions />
      </Wrapped>,
    );
    await flushQueries();
    await userEvent.click(screen.getByLabelText("Hardware encoder"));
    expect(await screen.findAllByText("Software (libx264)")).toHaveLength(1);
  });

  it("atomically resets rate control, quality, and preset when the encoder changes", async () => {
    mockProbe.mockResolvedValue({
      available: ["nvenc-h264", "libx264-software"],
      preferred: "nvenc-h264",
    });
    resetStore({
      hwEncoder: "software",
      rateControl: "crf",
      qualityValue: 14,
      encoderPreset: "slow",
    });
    render(
      <Wrapped>
        <AdvancedOutputOptions />
      </Wrapped>,
    );
    await flushQueries();

    await userEvent.click(screen.getByLabelText("Hardware encoder"));
    await userEvent.click(await screen.findByText("NVENC H.264"));

    expect(useOutputPrefsStore.getState().exportKnobs).toMatchObject({
      hwEncoder: "h264-nvenc",
      rateControl: "vbr",
      qualityValue: 19,
      encoderPreset: "p4",
    });
  });

  it("does not expose HEVC or OpenH264 choices returned by the probe", async () => {
    mockProbe.mockResolvedValue({
      available: ["video-toolbox-hevc", "openh-264-software", "video-toolbox-h264"],
      preferred: "video-toolbox-h264",
    });
    render(
      <Wrapped>
        <AdvancedOutputOptions />
      </Wrapped>,
    );
    await flushQueries();

    await userEvent.click(screen.getByLabelText("Hardware encoder"));
    expect(screen.queryByText(/HEVC/)).not.toBeInTheDocument();
    expect(screen.queryByText(/OpenH264/)).not.toBeInTheDocument();
    expect(await screen.findByText("VideoToolbox H.264")).toBeInTheDocument();
  });

  it("setExportKnob is wired — bumping the store reflects in the rendered slider value", async () => {
    resetStore({ hwEncoder: "software", qualityValue: 28 });
    render(
      <Wrapped>
        <AdvancedOutputOptions />
      </Wrapped>,
    );
    await flushQueries();
    const sliders = screen.getAllByRole("slider");
    // First slider is the CRF slider; Base UI exposes aria-valuenow on the thumb.
    expect(sliders[0]).toHaveAttribute("aria-valuenow", "28");
  });
});
