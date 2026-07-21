import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ScTabs, ScTabsContent, ScTabsList, ScTabsTrigger } from "../sc-tabs";

describe("ScTabs", () => {
  it("switches the active panel with accessible tab semantics", () => {
    render(
      <ScTabs defaultValue="script">
        <ScTabsList aria-label="Editor views">
          <ScTabsTrigger value="script">Script</ScTabsTrigger>
          <ScTabsTrigger value="preview">Preview</ScTabsTrigger>
        </ScTabsList>
        <ScTabsContent value="script">Story source</ScTabsContent>
        <ScTabsContent value="preview">Live preview</ScTabsContent>
      </ScTabs>,
    );

    const preview = screen.getByRole("tab", { name: "Preview" });
    fireEvent.click(preview);
    expect(preview.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").textContent).toContain("Live preview");
  });
});
