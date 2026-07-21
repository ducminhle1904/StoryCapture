import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ScRadioGroup, ScRadioGroupItem } from "../sc-radio-group";

describe("ScRadioGroup", () => {
  it("supports labelled single selection", () => {
    render(
      <ScRadioGroup aria-label="Theme">
        <ScRadioGroupItem value="dark" aria-label="Dark" />
        <ScRadioGroupItem value="light" aria-label="Light" />
      </ScRadioGroup>,
    );

    const dark = screen.getByRole("radio", { name: "Dark" });
    fireEvent.click(dark);
    expect(dark.getAttribute("aria-checked")).toBe("true");
  });
});
