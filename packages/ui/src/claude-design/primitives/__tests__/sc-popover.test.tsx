import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  ScPopover,
  ScPopoverContent,
  ScPopoverTitle,
  ScPopoverTrigger,
} from "../sc-popover";

describe("ScPopover", () => {
  it("opens accessible supplementary content", async () => {
    render(
      <ScPopover>
        <ScPopoverTrigger>Open controls</ScPopoverTrigger>
        <ScPopoverContent>
          <ScPopoverTitle>Canvas controls</ScPopoverTitle>
        </ScPopoverContent>
      </ScPopover>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open controls" }));
    expect(await screen.findByText("Canvas controls")).not.toBeNull();
  });
});
