import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ScSwitch } from "../sc-switch";

describe("ScSwitch", () => {
  it("renders Base UI switch root with sc-switch class", () => {
    const { container } = render(<ScSwitch />);
    const root = container.querySelector(".sc-switch");
    expect(root).not.toBeNull();
  });

  it("honors checked prop", () => {
    const { container } = render(<ScSwitch checked onCheckedChange={() => {}} />);
    const root = container.querySelector(".sc-switch");
    expect(root?.getAttribute("data-checked")).not.toBeNull();
  });
});
