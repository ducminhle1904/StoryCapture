import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ScSelect, ScSelectTrigger, ScSelectValue } from "../sc-select";

describe("ScSelect", () => {
  it("renders trigger with sc-select class", () => {
    const { container } = render(
      <ScSelect defaultValue="one">
        <ScSelectTrigger>
          <ScSelectValue />
        </ScSelectTrigger>
      </ScSelect>,
    );
    const trigger = container.querySelector(".sc-select");
    expect(trigger).not.toBeNull();
  });
});
