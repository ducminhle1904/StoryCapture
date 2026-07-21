import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";

import { useDashboardStore } from "@/state/projects";
import { CommandPalette } from "../command-palette";

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname}</div>;
}

function renderWithRouter() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <CommandPalette />
      <LocationProbe />
      <Routes>
        <Route path="*" element={null} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("CommandPalette", () => {
  beforeEach(() => {
    useDashboardStore.setState({ paletteOpen: false });
  });

  it("opens on Cmd/Ctrl+K", async () => {
    const user = userEvent.setup();
    renderWithRouter();
    const dialog = document.querySelector('dialog[aria-label="Command palette"]');
    expect(dialog).not.toHaveAttribute("open");
    await user.keyboard("{Meta>}k{/Meta}");
    await waitFor(() => expect(dialog).toHaveAttribute("open"));
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    renderWithRouter();
    const dialog = document.querySelector('dialog[aria-label="Command palette"]');
    await user.keyboard("{Meta>}k{/Meta}");
    await waitFor(() => expect(dialog).toHaveAttribute("open"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(dialog).not.toHaveAttribute("open"));
  });

  it("navigates when a command is activated", async () => {
    const user = userEvent.setup();
    renderWithRouter();
    await user.keyboard("{Meta>}k{/Meta}");
    const input = screen.getByPlaceholderText(/type a command/i);
    await user.type(input, "settings");
    await screen.findByText("Open Settings");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(screen.getByTestId("location")).toHaveTextContent("/settings");
  });
});
