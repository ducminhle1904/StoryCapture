import { render } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it } from "vitest";

import { ScSkeleton } from "../sc-skeleton";

describe("ScSkeleton", () => {
  it("renders block skeleton by default", () => {
    const { container } = render(<ScSkeleton />);
    const skeleton = container.querySelector(".sc-skeleton");
    expect(skeleton?.className).toContain("block");
    expect(skeleton?.getAttribute("aria-hidden")).toBe("true");
  });

  it("supports text and circle variants", () => {
    const { container } = render(
      <>
        <ScSkeleton variant="text" />
        <ScSkeleton variant="circle" />
      </>,
    );
    expect(container.querySelector(".sc-skeleton.text")).not.toBeNull();
    expect(container.querySelector(".sc-skeleton.circle")).not.toBeNull();
  });

  it("forwards ref", () => {
    const ref = createRef<HTMLDivElement>();
    render(<ScSkeleton ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLDivElement);
  });
});
