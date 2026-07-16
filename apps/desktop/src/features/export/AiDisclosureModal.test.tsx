import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AiDisclosureModal } from "./AiDisclosureModal";

describe("AiDisclosureModal", () => {
  it("uses truthful XMP-only copy and defaults metadata embedding on", () => {
    const onResult = vi.fn();
    render(<AiDisclosureModal open ttsClipCount={3} onResult={onResult} />);

    expect(screen.getByText(/EU AI Act/)).toBeInTheDocument();
    const checkbox = screen.getByRole("checkbox", {
      name: /Embed AI-generated voice metadata \(XMP\)/i,
    });
    expect(checkbox).toBeChecked();
    expect(screen.queryByText(/C2PA/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /export anyway/i }));
    expect(onResult).toHaveBeenCalledWith({ proceed: true, embedXmp: true });
  });

  it("returns the disabled XMP choice and stays hidden without TTS", () => {
    const onResult = vi.fn();
    const { rerender } = render(<AiDisclosureModal open ttsClipCount={1} onResult={onResult} />);
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Embed AI-generated voice metadata \(XMP\)/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /export anyway/i }));
    expect(onResult).toHaveBeenCalledWith({ proceed: true, embedXmp: false });

    rerender(<AiDisclosureModal open ttsClipCount={0} onResult={onResult} />);
    expect(
      screen.queryByText(/This export contains AI-generated voiceover/i),
    ).not.toBeInTheDocument();
  });
});
