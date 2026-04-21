import { render } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it } from "vitest";

import { ScInput } from "../sc-input";

describe("ScInput", () => {
  it("renders input with sc-input class", () => {
    const { container } = render(<ScInput placeholder="search" />);
    const input = container.querySelector("input");
    expect(input?.className).toContain("sc-input");
    expect(input?.getAttribute("placeholder")).toBe("search");
  });

  it("forwards ref to underlying input", () => {
    const ref = createRef<HTMLInputElement>();
    render(<ScInput ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
  });
});
