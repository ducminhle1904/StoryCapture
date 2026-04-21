import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ScSlider } from "../sc-slider";

describe("ScSlider", () => {
  it("renders slider root with sc-slider class", () => {
    const { container } = render(<ScSlider defaultValue={50} />);
    expect(container.querySelector(".sc-slider")).not.toBeNull();
  });

  it("renders track and thumb", () => {
    const { container } = render(<ScSlider defaultValue={25} />);
    expect(container.querySelector(".sc-slider-track")).not.toBeNull();
    expect(container.querySelector(".sc-slider-thumb")).not.toBeNull();
  });
});
