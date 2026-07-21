import axe from "axe-core";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ComponentCatalog } from "../catalog";

describe("ComponentCatalog accessibility", () => {
  it("has no critical or serious axe violations", async () => {
    const { container } = render(<ComponentCatalog />);
    const result = await axe.run(container, {
      rules: {
        "color-contrast": { enabled: false },
      },
    });
    const blocking = result.violations.filter(
      (violation) => violation.impact === "critical" || violation.impact === "serious",
    );
    expect(blocking).toEqual([]);
  });
});
