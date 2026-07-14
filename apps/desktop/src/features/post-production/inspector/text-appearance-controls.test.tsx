import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clearSystemFontCatalogCache } from "../state/system-font-catalog";
import type { AnnotationClip } from "../state/timeline-slice";
import { TextAppearanceControls } from "./text-appearance-controls";

function annotation(overrides: Partial<AnnotationClip> = {}): AnnotationClip {
  return {
    id: "text-1",
    trackId: "annotations",
    startMs: 1000,
    durationMs: 2000,
    text: "Example",
    pos: { x: 0.5, y: 0.5 },
    sizePt: 24,
    styleId: "callout",
    ...overrides,
  };
}

function installQueryLocalFonts(value: unknown) {
  Object.defineProperty(window, "queryLocalFonts", {
    configurable: true,
    value,
  });
}

afterEach(() => {
  Reflect.deleteProperty(window, "queryLocalFonts");
  clearSystemFontCatalogCache();
});

describe("TextAppearanceControls", () => {
  it("allows intrinsic-width controls to shrink inside a narrow inspector", () => {
    const { container } = render(<TextAppearanceControls clip={annotation()} onChange={vi.fn()} />);

    expect(container.firstElementChild).toHaveClass("min-w-0", "max-w-full");
    const fontSearch = screen.getByLabelText("Search system fonts");
    expect(fontSearch).toHaveClass("min-w-0", "max-w-full");
    expect(fontSearch.parentElement).toHaveClass("min-w-0", "grid-cols-[minmax(0,1fr)_auto]");
    expect(screen.getByLabelText("Annotation max width")).toHaveClass(
      "w-full",
      "min-w-0",
      "max-w-full",
    );
  });

  it("exposes approved ranges and preserves null versus inherited semantics", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const textShadow = { color: "#00000080", blurPx: 8, offsetXpx: 2, offsetYpx: 3 };
    const boxShadow = { color: "#00000066", blurPx: 16, offsetXpx: 0, offsetYpx: 5 };
    const boxStyle = {
      paddingPx: 12,
      radiusPx: 18,
      bgColor: "#101215e6",
      borderColor: "#ffffff2e",
      borderWidthPx: 1,
      shadow: boxShadow,
    };
    render(
      <TextAppearanceControls clip={annotation({ textShadow, boxStyle })} onChange={onChange} />,
    );

    expect(screen.getByLabelText("Annotation size")).toHaveAttribute("min", "12");
    expect(screen.getByLabelText("Annotation size")).toHaveAttribute("max", "72");
    expect(screen.getByLabelText("Annotation max width")).toHaveAttribute("min", "20");
    expect(screen.getByLabelText("Annotation max width")).toHaveAttribute("max", "100");
    expect(screen.getByLabelText("Annotation line height")).toHaveAttribute("step", "0.05");
    expect(screen.getByLabelText("Annotation letter spacing")).toHaveAttribute("min", "-4");
    expect(screen.getByLabelText("Annotation letter spacing")).toHaveAttribute("max", "20");
    expect(screen.getByLabelText("Text shadow blur")).toHaveAttribute("max", "64");
    expect(screen.getByLabelText("Text shadow opacity")).toHaveAttribute("max", "100");
    expect(screen.getByLabelText("Box shadow offset x")).toHaveAttribute("min", "-32");
    expect(screen.getByLabelText("Box shadow blur")).toHaveAttribute("max", "64");
    expect(screen.getByLabelText("Text background opacity")).toHaveAttribute("min", "0");
    expect(screen.getByLabelText("Text background padding")).toHaveAttribute("max", "64");
    expect(screen.getByLabelText("Text background radius")).toHaveAttribute("max", "100");
    expect(screen.getByLabelText("Text border width")).toHaveAttribute("max", "8");

    fireEvent.change(screen.getByLabelText("Annotation max width"), {
      target: { value: "77" },
    });
    expect(onChange).toHaveBeenCalledWith("maxWidthPct", undefined, 77);

    await user.click(screen.getByLabelText("Text shadow enabled"));
    expect(onChange).toHaveBeenCalledWith("textShadow", textShadow, null);
    await user.click(screen.getByRole("button", { name: "Text shadow inherit" }));
    expect(onChange).toHaveBeenCalledWith("textShadow", textShadow, undefined);

    await user.click(screen.getByLabelText("Text background enabled"));
    expect(onChange).toHaveBeenCalledWith("boxStyle", boxStyle, null);
    await user.click(screen.getByRole("button", { name: "Text background inherit" }));
    expect(onChange).toHaveBeenCalledWith("boxStyle", boxStyle, undefined);

    await user.click(screen.getByLabelText("Box shadow enabled"));
    expect(onChange).toHaveBeenCalledWith(
      "boxStyle",
      boxStyle,
      expect.objectContaining({ shadow: null }),
    );
    await user.click(screen.getByRole("button", { name: "Box shadow inherit" }));
    expect(onChange).toHaveBeenCalledWith(
      "boxStyle",
      boxStyle,
      expect.objectContaining({ shadow: undefined }),
    );

    await user.click(screen.getByRole("button", { name: "Pill" }));
    expect(onChange).toHaveBeenCalledWith(
      "boxStyle",
      boxStyle,
      expect.objectContaining({ radiusPx: 999 }),
    );
  });

  it("loads system fonts only after consent and filters grouped faces", async () => {
    const user = userEvent.setup();
    const queryLocalFonts = vi.fn().mockResolvedValue([
      {
        family: "Inter",
        fullName: "Inter Regular",
        postscriptName: "Inter-Regular",
        style: "Regular",
      },
      {
        family: "Roboto",
        fullName: "Roboto Bold",
        postscriptName: "Roboto-Bold",
        style: "Bold",
      },
    ]);
    installQueryLocalFonts(queryLocalFonts);
    const onChange = vi.fn();
    const { unmount } = render(<TextAppearanceControls clip={annotation()} onChange={onChange} />);

    expect(queryLocalFonts).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Load system fonts" }));
    await waitFor(() => expect(queryLocalFonts).toHaveBeenCalledOnce());
    expect(document.querySelector('optgroup[label="Inter"]')).not.toBeNull();
    expect(document.querySelector('optgroup[label="Roboto"]')).not.toBeNull();

    await user.type(screen.getByLabelText("Search system fonts"), "Inter");
    expect(document.querySelector('optgroup[label="Inter"]')).not.toBeNull();
    expect(document.querySelector('optgroup[label="Roboto"]')).toBeNull();

    fireEvent.change(screen.getByLabelText("Annotation font face"), {
      target: { value: "system:Inter-Regular" },
    });
    expect(onChange).toHaveBeenCalledWith(
      "font",
      undefined,
      expect.objectContaining({
        kind: "system",
        family: "Inter",
        postscriptName: "Inter-Regular",
      }),
    );

    unmount();
    render(<TextAppearanceControls clip={annotation()} onChange={onChange} />);
    expect(document.querySelector('optgroup[label="Inter"]')).not.toBeNull();
    expect(queryLocalFonts).toHaveBeenCalledOnce();
  });

  it("reports unavailable and denied local-font access", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<TextAppearanceControls clip={annotation()} onChange={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Load system fonts" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/unavailable/i);

    unmount();
    installQueryLocalFonts(vi.fn().mockRejectedValue({ name: "NotAllowedError" }));
    render(<TextAppearanceControls clip={annotation()} onChange={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Load system fonts" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/denied/i);
  });

  it("warns when the selected system face is missing from the loaded catalog", async () => {
    const user = userEvent.setup();
    installQueryLocalFonts(
      vi.fn().mockResolvedValue([
        {
          family: "Inter",
          fullName: "Inter Regular",
          postscriptName: "Inter-Regular",
          style: "Regular",
        },
      ]),
    );
    render(
      <TextAppearanceControls
        clip={annotation({
          font: {
            kind: "system",
            family: "Missing Sans",
            fullName: "Missing Sans Regular",
            postscriptName: "MissingSans-Regular",
            faceStyle: "Regular",
            weight: 400,
            style: "normal",
          },
        })}
        onChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Load system fonts" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Missing Sans Regular is no longer available/i,
    );
  });
});
