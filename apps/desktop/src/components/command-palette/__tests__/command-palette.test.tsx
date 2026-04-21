import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";

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
  it("opens on Cmd/Ctrl+K", async () => {
    const user = userEvent.setup();
    renderWithRouter();
    expect(screen.queryByPlaceholderText(/type a command/i)).not.toBeInTheDocument();
    await user.keyboard("{Meta>}k{/Meta}");
    expect(screen.getByPlaceholderText(/type a command/i)).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    renderWithRouter();
    await user.keyboard("{Meta>}k{/Meta}");
    expect(screen.getByPlaceholderText(/type a command/i)).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByPlaceholderText(/type a command/i)).not.toBeInTheDocument();
  });

  it("navigates when a command is activated", async () => {
    const user = userEvent.setup();
    renderWithRouter();
    await user.keyboard("{Meta>}k{/Meta}");
    const input = screen.getByPlaceholderText(/type a command/i);
    await user.type(input, "settings");
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("location")).toHaveTextContent("/settings");
  });
});
