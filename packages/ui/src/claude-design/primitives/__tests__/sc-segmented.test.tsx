import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ScSegmented } from "../sc-segmented";

describe("ScSegmented", () => {
  it("renders toggle group with sc-segmented class and all options", () => {
    const { container } = render(
      <ScSegmented
        value="b"
        onValueChange={() => {}}
        options={[
          { value: "a", label: "A" },
          { value: "b", label: "B" },
          { value: "c", label: "C" },
        ]}
      />,
    );
    expect(container.querySelector(".sc-segmented")).not.toBeNull();
    expect(container.querySelectorAll(".sc-segmented-item").length).toBe(3);
  });
});
