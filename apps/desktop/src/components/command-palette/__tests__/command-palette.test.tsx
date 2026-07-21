import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";

import { useDashboardStore } from "@/state/projects";
import { CommandPalette } from "../command-palette";

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname}</div>;
}

function renderWithRouter(initialEntry = "/") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
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

  it("does not offer project actions without a project context", async () => {
    const user = userEvent.setup();
    renderWithRouter();
    await user.keyboard("{Meta>}k{/Meta}");
    expect(screen.queryByText("Open Recorder")).not.toBeInTheDocument();
    expect(screen.queryByText("Open Edit")).not.toBeInTheDocument();
  });

  it("keeps project actions scoped to the active project", async () => {
    const user = userEvent.setup();
    renderWithRouter("/editor/project%201");
    await user.keyboard("{Meta>}k{/Meta}");
    await user.click(screen.getByText("Open Recorder"));
    expect(screen.getByTestId("location")).toHaveTextContent("/recorder/project%201");
  });
});
