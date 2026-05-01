import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it } from "vitest";

import { ScField } from "../sc-field";
import { ScInput } from "../sc-input";

describe("ScField", () => {
  it("renders label, helper, meta, and wires accessible descriptions", () => {
    render(
      <ScField
        id="project-name"
        label="Project name"
        helper="Visible in the sidebar"
        meta="required"
      >
        <ScInput />
      </ScField>,
    );

    const input = screen.getByLabelText("Project name");
    expect(input.getAttribute("id")).toBe("project-name");
    expect(input.getAttribute("aria-describedby")).toBe("project-name-helper");
    expect(screen.getByText("Visible in the sidebar").className).toContain("sc-field-helper");
    expect(screen.getByText("required").className).toContain("sc-field-meta");
  });

  it("marks child control invalid when error is present", () => {
    render(
      <ScField id="slug" label="Slug" error="Use lowercase letters">
        <ScInput />
      </ScField>,
    );

    const input = screen.getByLabelText("Slug");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe("slug-error");
    expect(screen.getByRole("alert").textContent).toBe("Use lowercase letters");
  });

  it("forwards ref to field wrapper", () => {
    const ref = createRef<HTMLDivElement>();
    render(
      <ScField ref={ref} label="Project path">
        <ScInput />
      </ScField>,
    );
    expect(ref.current).toBeInstanceOf(HTMLDivElement);
  });
});
