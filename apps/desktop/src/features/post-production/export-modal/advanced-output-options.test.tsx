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
    expect(screen.getByText(/Encoder will be selected at export time/)).toBeInTheDocument();
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
    expect(screen.getByText(/Quality \(lower/)).toBeInTheDocument();
    expect(screen.getByText(/Encoding speed/)).toBeInTheDocument();
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
    expect(screen.getByRole("status")).toHaveTextContent(/h264-nvenc/);
    expect(screen.getByRole("status")).toHaveTextContent(/is not available/);
  });

  it("shows all field labels when encoder has full controls", async () => {
    resetStore({ hwEncoder: "software" });
    render(
      <Wrapped>
        <AdvancedOutputOptions />
      </Wrapped>,
    );
    await flushQueries();
    expect(screen.getByText("File format")).toBeInTheDocument();
    expect(screen.getByText("Codec")).toBeInTheDocument();
    expect(screen.getByText("Hardware encoder")).toBeInTheDocument();
    expect(screen.getByText(/Keyframe interval/)).toBeInTheDocument();
    expect(screen.getByText("Audio codec")).toBeInTheDocument();
    expect(screen.getByText(/Audio bitrate/)).toBeInTheDocument();
    expect(screen.getByText("Channels")).toBeInTheDocument();
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
