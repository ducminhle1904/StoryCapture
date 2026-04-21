import { render } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it } from "vitest";

import { ScCard } from "../sc-card";

describe("ScCard", () => {
  it("renders div with sc-card class and children", () => {
    const { container } = render(<ScCard>body</ScCard>);
    const div = container.querySelector("div.sc-card");
    expect(div).not.toBeNull();
    expect(div?.textContent).toContain("body");
  });

  it("renders title when provided", () => {
    const { container } = render(<ScCard title="Buttons">x</ScCard>);
    expect(container.querySelector(".sc-card-header")).not.toBeNull();
    expect(container.textContent).toContain("Buttons");
  });

  it("forwards ref", () => {
    const ref = createRef<HTMLDivElement>();
    render(<ScCard ref={ref}>x</ScCard>);
    expect(ref.current).toBeInstanceOf(HTMLDivElement);
  });
});
