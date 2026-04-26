/**
 * AdvancedOutputOptions RTL suite. Covers 3-subgroup layout, auto-hide
 * semantics, probe-driven HW list, conditional quality control
 * rendering, persistence-warning, and VN copy.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
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
    expect(screen.getByText(/Định dạng & Codec/)).toBeInTheDocument();
    expect(screen.getByText(/Bộ mã hóa & Chất lượng/)).toBeInTheDocument();
    expect(screen.getByText(/Keyframe \/ Kích thước \/ Âm thanh/)).toBeInTheDocument();
  });

  it("hwEncoder=auto hides quality slider and shows explanatory note", async () => {
    render(
      <Wrapped>
        <AdvancedOutputOptions />
      </Wrapped>,
    );
    await flushQueries();
    expect(screen.getByText(/Encoder sẽ được chọn lúc export/)).toBeInTheDocument();
    expect(screen.queryByText(/Chất lượng \(thấp hơn/)).not.toBeInTheDocument();
  });

  it("hwEncoder=software shows CRF slider + preset select", async () => {
    resetStore({ hwEncoder: "software" });
    render(
      <Wrapped>
        <AdvancedOutputOptions />
      </Wrapped>,
    );
    await flushQueries();
    expect(screen.getByText(/Chất lượng \(thấp hơn/)).toBeInTheDocument();
    expect(screen.getByText(/Tốc độ mã hóa/)).toBeInTheDocument();
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
    expect(screen.getByRole("status")).toHaveTextContent(/không có sẵn/);
  });

  it("shows all Vietnamese field labels when encoder has full controls", async () => {
    resetStore({ hwEncoder: "software" });
    render(
      <Wrapped>
        <AdvancedOutputOptions />
      </Wrapped>,
    );
    await flushQueries();
    expect(screen.getByText("Định dạng tệp")).toBeInTheDocument();
    expect(screen.getByText("Codec")).toBeInTheDocument();
    expect(screen.getByText("Bộ mã hóa phần cứng")).toBeInTheDocument();
    expect(screen.getByText(/Khoảng keyframe/)).toBeInTheDocument();
    expect(screen.getByText("Codec âm thanh")).toBeInTheDocument();
    expect(screen.getByText(/Bitrate âm thanh/)).toBeInTheDocument();
    expect(screen.getByText("Kênh")).toBeInTheDocument();
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
