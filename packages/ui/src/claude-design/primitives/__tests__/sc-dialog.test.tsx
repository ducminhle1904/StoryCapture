import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  ScDialog,
  ScDialogContent,
  ScDialogDescription,
  ScDialogTitle,
  ScDialogTrigger,
} from "../sc-dialog";

describe("ScDialog", () => {
  it("opens a labelled modal", async () => {
    render(
      <ScDialog>
        <ScDialogTrigger>Open export</ScDialogTrigger>
        <ScDialogContent>
          <ScDialogTitle>Export video</ScDialogTitle>
          <ScDialogDescription>Choose output settings.</ScDialogDescription>
        </ScDialogContent>
      </ScDialog>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open export" }));
    expect(await screen.findByRole("dialog", { name: "Export video" })).not.toBeNull();
  });
});
