import { render } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it } from "vitest";

import { ScTextarea } from "../sc-textarea";

describe("ScTextarea", () => {
  it("renders textarea with shared input styling", () => {
    const { container } = render(<ScTextarea placeholder="Notes" />);
    const textarea = container.querySelector("textarea");
    expect(textarea?.className).toContain("sc-input");
    expect(textarea?.className).toContain("sc-textarea");
    expect(textarea?.getAttribute("placeholder")).toBe("Notes");
  });

  it("forwards ref", () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(<ScTextarea ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLTextAreaElement);
  });
});
