import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TargetPicker } from "./TargetPicker";

afterEach(cleanup);

describe("TargetPicker recovery", () => {
  it("keeps Refresh enabled when no target list is loaded", async () => {
    const onRefresh = vi.fn(async () => {});

    render(
      <TargetPicker
        availableTargets={null}
        value={null}
        onValueChange={() => {}}
        onRefresh={onRefresh}
      />,
    );

    expect(screen.getByRole("combobox", { name: "Capture target" })).toBeDisabled();
    const refresh = screen.getByRole("button", { name: "Refresh capture targets" });
    expect(refresh).toBeEnabled();
    fireEvent.click(refresh);
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
  });
});
