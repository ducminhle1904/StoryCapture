import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import "./generated/storycapture-gothic.css";
import "./product-tokens.css";

import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Dialog } from "@astryxdesign/core/Dialog";
import { proportional, Table } from "@astryxdesign/core/Table";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Toast } from "@astryxdesign/core/Toast";
import { render, screen } from "@testing-library/react";
import { storycaptureGothicTheme } from "./generated/storycapture-gothic.js";
import { StoryCaptureThemeProvider } from "./provider";

function FoundationFixture() {
  return (
    <StoryCaptureThemeProvider>
      <main>
        <Button label="Create recording" variant="primary" />
        <TextInput label="Project name" value="Gothic demo" onChange={() => {}} />
        <Card data-testid="foundation-card">Card content</Card>
        <Table
          data={[{ id: "1", name: "Demo" }]}
          idKey="id"
          columns={[{ key: "name", header: "Name", width: proportional(1) }]}
        />
        <Dialog isOpen onOpenChange={() => {}} aria-label="Foundation dialog">
          Dialog content
        </Dialog>
        <Toast
          type="info"
          body="Theme ready"
          isAutoHide={false}
          autoHideDuration={5_000}
          onDismiss={() => {}}
        />
      </main>
    </StoryCaptureThemeProvider>
  );
}

describe("StoryCapture Gothic foundation", () => {
  it("renders the required Astryx primitives in the dark-only provider", () => {
    render(<FoundationFixture />);

    expect(screen.getByRole("button", { name: "Create recording" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Project name" })).toHaveValue("Gothic demo");
    expect(screen.getByTestId("foundation-card")).toBeVisible();
    expect(screen.getByRole("table")).toBeVisible();
    expect(screen.getByRole("dialog", { name: "Foundation dialog" })).toBeVisible();
    expect(screen.getByText("Theme ready")).toBeVisible();

    const themeRoot = screen.getByText("Card content").closest("[data-theme]");
    expect(themeRoot).toHaveAttribute("data-theme", "dark");
    expect(storycaptureGothicTheme.tokens["--color-background-body"]).toBe("#101314");
  });

  it("keeps component styles after reset CSS is loaded", () => {
    render(<FoundationFixture />);

    const button = screen.getByRole("button", { name: "Create recording" });
    const input = screen.getByRole("textbox", { name: "Project name" });

    expect(getComputedStyle(button).display).not.toBe("none");
    expect(getComputedStyle(button).height).not.toBe("0px");
    expect(getComputedStyle(input).display).not.toBe("none");
    expect(getComputedStyle(input).color).not.toBe("transparent");
  });
});
