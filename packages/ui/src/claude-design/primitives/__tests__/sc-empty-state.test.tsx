import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it } from "vitest";

import { ScButton } from "../sc-button";
import { ScEmptyState } from "../sc-empty-state";

describe("ScEmptyState", () => {
  it("renders title, body, icon, and actions", () => {
    const { container } = render(
      <ScEmptyState
        title="No recordings"
        body="Capture a run before opening post-production."
        icon={<span data-testid="icon" />}
        actions={<ScButton>Record</ScButton>}
      />,
    );

    expect(screen.getByText("No recordings").className).toContain("sc-empty-title");
    expect(screen.getByText("Capture a run before opening post-production.").className).toContain(
      "sc-empty-body",
    );
    expect(screen.getByTestId("icon").parentElement?.className).toContain("sc-empty-icon");
    expect(container.querySelector(".sc-empty-actions")).not.toBeNull();
  });

  it("supports centered alignment and forwards ref", () => {
    const ref = createRef<HTMLDivElement>();
    const { container } = render(<ScEmptyState ref={ref} align="center" title="Nothing here" />);
    expect(container.querySelector(".sc-empty.center")).not.toBeNull();
    expect(ref.current).toBeInstanceOf(HTMLDivElement);
  });
});
