import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ScToggleGroup, ScToggleGroupItem } from "../sc-toggle-group";

describe("ScToggleGroup", () => {
  it("supports keyboard-oriented pressed state", () => {
    render(
      <ScToggleGroup aria-label="Alignment">
        <ScToggleGroupItem value="left">Left</ScToggleGroupItem>
        <ScToggleGroupItem value="center">Center</ScToggleGroupItem>
      </ScToggleGroup>,
    );

    const left = screen.getByRole("button", { name: "Left" });
    fireEvent.click(left);
    expect(left.getAttribute("aria-pressed")).toBe("true");
  });
});
