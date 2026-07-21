import { render, screen } from "@testing-library/react";
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

  it("disables an unavailable option and exposes its reason", () => {
    render(
      <ScSegmented
        value="best_effort"
        options={[
          { value: "best_effort", label: "Standard" },
          { value: "strict", label: "Strict", disabled: true, title: "Profile unavailable" },
        ]}
      />,
    );

    const strict = screen.getByRole("button", { name: "Strict" }) as HTMLButtonElement;
    expect(strict.disabled).toBe(true);
    expect(strict.getAttribute("title")).toBe("Profile unavailable");
  });
});
