import { render } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it } from "vitest";

import { ScBadge } from "../sc-badge";

describe("ScBadge", () => {
  it("renders span with sc-badge class", () => {
    const { container } = render(<ScBadge>Draft</ScBadge>);
    const span = container.querySelector("span");
    expect(span?.className).toContain("sc-badge");
  });

  it("applies tone class", () => {
    const { container } = render(<ScBadge tone="success">Done</ScBadge>);
    expect(container.querySelector("span")?.className).toMatch(/success/);
  });

  it("forwards ref", () => {
    const ref = createRef<HTMLSpanElement>();
    render(<ScBadge ref={ref}>x</ScBadge>);
    expect(ref.current).toBeInstanceOf(HTMLSpanElement);
  });
});
