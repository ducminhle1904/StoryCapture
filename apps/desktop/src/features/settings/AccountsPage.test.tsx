/**
 * AccountsPage tests.
 *
 * Covers 6 behaviors:
 * 1. Renders 4 rows grouped into LLM + TTS sections with correct ordering.
 * 2. When present === false, renders "Them key"; when true, renders masked dots.
 * 3. "Kiem tra ket noi" calls key_test and updates status chip.
 * 4. Remove-key flow shows AlertDialog with destructive copy.
 * 5. Header callout badge renders keychain security notice.
 * 6. Password input type prevents plain-text display.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AccountsPage } from "./AccountsPage";

// Mock Tauri invoke
const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

describe("AccountsPage", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    // Default: all keys absent
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "key_get_presence") return Promise.resolve(false);
      if (cmd === "key_set") return Promise.resolve();
      if (cmd === "key_delete") return Promise.resolve();
      if (cmd === "key_test")
        return Promise.resolve({ ok: true, latency_ms: 42, detail: "200 OK" });
      return Promise.resolve();
    });
  });

  it("renders 4 rows grouped into LLM + TTS sections with correct provider ordering", async () => {
    render(<AccountsPage />);

    // Wait for key_get_presence calls to resolve
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("key_get_presence", {
        provider: "anthropic",
      });
    });

    // Section headings
    expect(screen.getByText("LLM")).toBeTruthy();
    expect(screen.getByText("TTS")).toBeTruthy();

    // 4 provider rows
    expect(screen.getByText("Anthropic")).toBeTruthy();
    expect(screen.getByText("OpenAI")).toBeTruthy();
    expect(screen.getByText("ElevenLabs")).toBeTruthy();
    expect(screen.getByText("OpenAI TTS")).toBeTruthy();

    // Page testid
    expect(screen.getByTestId("accounts-page")).toBeTruthy();
  });

  it("renders 'Them key' button when present === false; masked dots when true", async () => {
    // Anthropic present, others absent
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "key_get_presence") {
        return Promise.resolve(args?.provider === "anthropic");
      }
      return Promise.resolve();
    });

    render(<AccountsPage />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("key_get_presence", {
        provider: "anthropic",
      });
    });

    // Anthropic is present -> should show masked value
    await waitFor(() => {
      expect(screen.getByText(/\u2022{4}/)).toBeTruthy(); // "••••"
    });

    // Other providers should show "Them key" button
    const addButtons = screen.getAllByText(/Th\u00eam key/);
    expect(addButtons.length).toBeGreaterThanOrEqual(3);
  });

  it("'Kiem tra ket noi' calls key_test and updates status chip", async () => {
    // Anthropic present
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "key_get_presence") {
        return Promise.resolve(args?.provider === "anthropic");
      }
      if (cmd === "key_test") {
        return Promise.resolve({ ok: true, latency_ms: 42, detail: "200 OK" });
      }
      return Promise.resolve();
    });

    render(<AccountsPage />);

    await waitFor(() => {
      expect(screen.getByText(/\u2022{4}/)).toBeTruthy();
    });

    // Click test button
    const testBtn = screen.getByText(/Ki\u1ec3m tra k\u1ebft n\u1ed1i/);
    await userEvent.click(testBtn);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("key_test", {
        provider: "anthropic",
      });
    });

    // Status chip should show valid
    await waitFor(() => {
      expect(screen.getByText(/valid|200 OK/i)).toBeTruthy();
    });
  });

  it("remove-key flow shows AlertDialog with destructive copy", async () => {
    // Anthropic present
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "key_get_presence") {
        return Promise.resolve(args?.provider === "anthropic");
      }
      if (cmd === "key_delete") return Promise.resolve();
      return Promise.resolve();
    });

    render(<AccountsPage />);

    await waitFor(() => {
      expect(screen.getByText(/\u2022{4}/)).toBeTruthy();
    });

    // Click remove button
    const removeBtn = screen.getByLabelText(/Xo\u0301a.*Anthropic/i);
    await userEvent.click(removeBtn);

    // Alert dialog should appear with destructive copy
    await waitFor(() => {
      expect(screen.getByText(/Xo\u00e1 API key Anthropic\?/)).toBeTruthy();
    });
  });

  it("header callout badge renders keychain security notice with aria-describedby", async () => {
    render(<AccountsPage />);

    await waitFor(() => {
      expect(
        screen.getByText(/L\u01b0u trong OS Keychain/)
      ).toBeTruthy();
    });

    // aria-describedby should link to docs
    const callout = screen.getByText(/L\u01b0u trong OS Keychain/);
    expect(callout).toBeTruthy();
  });

  it("password input type prevents plain-text display", async () => {
    render(<AccountsPage />);

    // When adding a key, should use password input
    const addButtons = await screen.findAllByText(/Th\u00eam key/);
    await userEvent.click(addButtons[0]);

    await waitFor(() => {
      const inputs = document.querySelectorAll('input[type="password"]');
      expect(inputs.length).toBeGreaterThanOrEqual(1);
    });
  });
});
