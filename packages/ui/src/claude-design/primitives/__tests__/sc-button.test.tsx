import { render } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it } from "vitest";

import { ScButton } from "../sc-button";

describe("ScButton", () => {
  it("renders sc-btn class with default variant/size", () => {
    const { container } = render(<ScButton>Run</ScButton>);
    const btn = container.querySelector("button");
    expect(btn?.className).toContain("sc-btn");
    expect(btn?.textContent).toBe("Run");
  });

  it("applies variant + size classes", () => {
    const { container } = render(<ScButton variant="primary" size="lg">Go</ScButton>);
    const btn = container.querySelector("button")!;
    expect(btn.className).toMatch(/primary/);
    expect(btn.className).toMatch(/lg/);
  });

  it("forwards ref to underlying button element", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<ScButton ref={ref}>x</ScButton>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });

  it("omits text when size=icon", () => {
    const { container } = render(<ScButton size="icon">SHOULD-NOT-RENDER</ScButton>);
    expect(container.textContent).not.toContain("SHOULD-NOT-RENDER");
  });
});
