import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  ScAccordion,
  ScAccordionContent,
  ScAccordionItem,
  ScAccordionTrigger,
} from "../sc-accordion";

describe("ScAccordion", () => {
  it("exposes accessible expanded state and toggles from the keyboard", () => {
    render(
      <ScAccordion>
        <ScAccordionItem value="details">
          <ScAccordionTrigger>Details</ScAccordionTrigger>
          <ScAccordionContent>Capture settings</ScAccordionContent>
        </ScAccordionItem>
      </ScAccordion>,
    );

    const trigger = screen.getByRole("button", { name: "Details" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });
});
