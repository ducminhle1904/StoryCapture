import { render } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it } from "vitest";

import { ScKbd } from "../sc-kbd";

describe("ScKbd", () => {
  it("renders kbd element with sc-kbd class", () => {
    const { container } = render(<ScKbd>⌘K</ScKbd>);
    const kbd = container.querySelector("kbd");
    expect(kbd?.className).toContain("sc-kbd");
    expect(kbd?.textContent).toBe("⌘K");
  });

  it("forwards ref", () => {
    const ref = createRef<HTMLElement>();
    render(<ScKbd ref={ref}>x</ScKbd>);
    expect(ref.current?.tagName.toLowerCase()).toBe("kbd");
  });
});
