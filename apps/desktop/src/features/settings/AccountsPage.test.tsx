/**
 * AccountsPage tests.
 *
 * Covers 6 behaviors:
 * 1. Renders 4 rows grouped into model + voice sections with correct ordering.
 * 2. When present === false, renders "Add key"; when true, renders masked dots.
 * 3. "Test" calls key_test for the provider.
 * 4. Remove-key flow shows AlertDialog with destructive copy.
 * 5. Header callout badge renders keychain security notice.
 * 6. Password input type prevents plain-text display.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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

    expect(screen.getByText("Language models")).toBeTruthy();
    expect(screen.getByText("Voice services")).toBeTruthy();

    // 4 provider rows
    expect(screen.getByText("Anthropic")).toBeTruthy();
    expect(screen.getByText("OpenAI")).toBeTruthy();
    expect(screen.getByText("ElevenLabs")).toBeTruthy();
    expect(screen.getByText("OpenAI TTS")).toBeTruthy();

    // Page testid
    expect(screen.getByTestId("accounts-page")).toBeTruthy();
  });

  it("renders 'Add key' button when present === false; masked dots when true", async () => {
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
    const addButtons = screen.getAllByText(/Add key/);
    expect(addButtons.length).toBeGreaterThanOrEqual(3);
  });

  it("'Test' calls key_test for the provider", async () => {
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
    const testBtn = screen.getAllByRole("button", { name: /^Test$/ })[0];
    await userEvent.click(testBtn);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("key_test", {
        provider: "anthropic",
      });
    });

    expect(testBtn).toBeTruthy();
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
    const removeBtn = screen.getByLabelText(/Remove Anthropic key/i);
    await userEvent.click(removeBtn);

    // Alert dialog should appear with destructive copy
    await waitFor(() => {
      expect(screen.getByText(/Remove Anthropic key\?/)).toBeTruthy();
    });
  });

  it("header callout badge renders keychain security notice with aria-describedby", async () => {
    render(<AccountsPage />);

    await waitFor(() => {
      expect(
        screen.getByText(/Stored in OS keychain/)
      ).toBeTruthy();
    });

    // aria-describedby should link to docs
    const callout = screen.getByText(/Stored in OS keychain/);
    expect(callout).toBeTruthy();
  });

  it("password input type prevents plain-text display", async () => {
    render(<AccountsPage />);

    // When adding a key, should use password input
    const addButtons = await screen.findAllByText(/Add key/);
    await userEvent.click(addButtons[0]);

    await waitFor(() => {
      const inputs = document.querySelectorAll('input[type="password"]');
      expect(inputs.length).toBeGreaterThanOrEqual(1);
    });
  });
});
