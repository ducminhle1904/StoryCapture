import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it } from "vitest";

import { ScCallout } from "../sc-callout";

describe("ScCallout", () => {
  it("renders title and body with status role by default", () => {
    render(
      <ScCallout title="Preview paused" tone="info">
        Resume the author session before picking another target.
      </ScCallout>,
    );

    expect(screen.getByRole("status").className).toContain("sc-callout");
    expect(screen.getByRole("status").className).toContain("no-icon");
    expect(screen.getByText("Preview paused").className).toContain("sc-callout-title");
  });

  it("uses alert role for warning and danger tones", () => {
    render(
      <ScCallout title="Render failed" tone="danger">
        FFmpeg exited before writing the first frame.
      </ScCallout>,
    );

    expect(screen.getByRole("alert").className).toContain("danger");
  });

  it("forwards ref", () => {
    const ref = createRef<HTMLDivElement>();
    render(<ScCallout ref={ref}>Message</ScCallout>);
    expect(ref.current).toBeInstanceOf(HTMLDivElement);
  });
});
