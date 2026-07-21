import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ScTooltip, ScTooltipContent, ScTooltipTrigger } from "../sc-tooltip";

describe("ScTooltip", () => {
  it("provides a focusable labelled trigger", () => {
    render(
      <ScTooltip>
        <ScTooltipTrigger aria-label="Preview help">?</ScTooltipTrigger>
        <ScTooltipContent>Preview keyboard shortcuts</ScTooltipContent>
      </ScTooltip>,
    );

    expect(screen.getByRole("button", { name: "Preview help" })).not.toBeNull();
  });
});
