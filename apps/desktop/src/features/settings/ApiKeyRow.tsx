/**
 * Single API key row for the Accounts page.
 *
 * Displays provider logo, name, masked key input, status badge,
 * test button, and remove action with AlertDialog confirmation.
 *
 * T-03-20-01: type="password" on input prevents plain-text display.
 * T-03-20-02: Raw key is NOT held in React state post-save. After
 * key_set succeeds, local state reverts to "".
 */

import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "@base-ui-components/react/dialog";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Shield, Trash2, Loader2 } from "lucide-react";

export interface ApiKeyRowProps {
  providerId: string;
  displayName: string;
  present: boolean;
  testStatus?: "valid" | "invalid" | "rate_limited" | "untested";
  onPresenceChange: (present: boolean) => void;
  onTestStatusChange: (status: "valid" | "invalid" | "rate_limited" | "untested") => void;
}

export function ApiKeyRow({
  providerId,
  displayName,
  present,
  testStatus,
  onPresenceChange,
  onTestStatusChange,
}: ApiKeyRowProps) {
  const [editing, setEditing] = useState(false);
  const [keyValue, setKeyValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const handleSave = useCallback(async () => {
    if (!keyValue.trim()) return;
    setSaving(true);
    try {
      await invoke("key_set", { provider: providerId, key: keyValue });
      // clear local state immediately after save
      setKeyValue("");
      setEditing(false);
      onPresenceChange(true);

      // Auto-test after save
      try {
        const report = (await invoke("key_test", {
          provider: providerId,
        })) as { ok: boolean; latency_ms: number; detail: string };
        onTestStatusChange(report.ok ? "valid" : "invalid");
      } catch {
        onTestStatusChange("invalid");
      }
    } catch {
      // Save failed
    } finally {
      setSaving(false);
    }
  }, [keyValue, providerId, onPresenceChange, onTestStatusChange]);

  const handleTest = useCallback(async () => {
    setTesting(true);
    try {
      const report = (await invoke("key_test", {
        provider: providerId,
      })) as { ok: boolean; latency_ms: number; detail: string };
      onTestStatusChange(report.ok ? "valid" : "invalid");
    } catch {
      onTestStatusChange("invalid");
    } finally {
      setTesting(false);
    }
  }, [providerId, onTestStatusChange]);

  const handleDelete = useCallback(async () => {
    try {
      await invoke("key_delete", { provider: providerId });
      onPresenceChange(false);
      onTestStatusChange("untested");
      setShowConfirm(false);
    } catch {
      // Delete failed
    }
  }, [providerId, onPresenceChange, onTestStatusChange]);

  const statusBadge = testStatus && testStatus !== "untested" && (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        testStatus === "valid" &&
          "border border-[var(--color-success)]/25 bg-[var(--color-success)]/12 text-[var(--color-success)]",
        testStatus === "invalid" &&
          "border border-[var(--color-danger)]/25 bg-[var(--color-danger)]/12 text-[var(--color-danger)]",
        testStatus === "rate_limited" &&
          "border border-[var(--color-warning)]/25 bg-[var(--color-warning)]/12 text-[var(--color-warning)]",
      )}
    >
      {testStatus === "valid" && "valid"}
      {testStatus === "invalid" && "invalid"}
      {testStatus === "rate_limited" && "rate_limited"}
    </span>
  );

  return (
    <div className="rounded-[24px] border border-white/8 bg-black/14 p-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
        <div className="flex items-center gap-3">
          <div className="rounded-xl border border-white/8 bg-white/5 p-2">
            <Shield className="h-5 w-5 shrink-0 text-[var(--color-fg-muted)]" />
          </div>
          <div>
            <div className="text-sm font-medium text-[var(--color-fg-primary)]">
              {displayName}
            </div>
            <div className="mt-1 text-xs text-[var(--color-fg-muted)]">
              {present ? "Stored in keychain" : "No key saved yet"}
            </div>
          </div>
        </div>

        <div className="min-w-0 flex-1">
        {present && !editing ? (
          <span className="font-mono text-sm text-[var(--color-fg-muted)]">
            {"\u2022\u2022\u2022\u2022 last4"}
          </span>
        ) : editing ? (
          <div className="flex items-center gap-2">
            <input
              type="password"
              autoComplete="off"
              value={keyValue}
              onChange={(e) => setKeyValue(e.target.value)}
              placeholder={`Paste ${displayName} API key`}
              className="flex-1 rounded-xl border border-white/8 bg-black/18 px-3 py-2 text-sm font-mono text-[var(--color-fg-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
              aria-label={`API key cho ${displayName}`}
            />
            <Button
              size="sm"
              onClick={handleSave}
              disabled={saving || !keyValue.trim()}
              className="brand-button rounded-xl text-white"
            >
              {saving ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                "Save"
              )}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setKeyValue("");
              }}
              className="rounded-xl border border-white/8 bg-white/4 hover:bg-white/8"
            >
              Cancel
            </Button>
          </div>
        ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
          {statusBadge}

          {!present && !editing && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEditing(true)}
              className="rounded-xl border-white/8 bg-white/4 hover:bg-white/8"
            >
              Add key
            </Button>
          )}

          {present && (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={handleTest}
                disabled={testing}
                className="rounded-xl border-white/8 bg-white/4 hover:bg-white/8"
              >
                {testing ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  "Test connection"
                )}
              </Button>

              <Button
                size="icon"
                variant="ghost"
                onClick={() => setShowConfirm(true)}
                aria-label={`Delete API key ${displayName}`}
                className="rounded-xl border border-white/8 bg-white/4 hover:bg-white/8"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </>
          )}
        </div>
      </div>

      <Dialog.Root open={showConfirm} onOpenChange={setShowConfirm}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
          <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(14,17,24,0.98),rgba(8,10,15,0.98))] p-6 shadow-[0_32px_90px_rgba(0,0,0,0.42)]">
            <Dialog.Title className="mb-2 text-lg font-semibold text-[var(--color-fg-primary)]">
              {`Delete ${displayName} key?`}
            </Dialog.Title>
            <Dialog.Description className="mb-4 text-sm text-[var(--color-fg-muted)]">
              This removes the key from the OS keychain. You will need to add it
              again before this provider can be used.
            </Dialog.Description>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setShowConfirm(false)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={handleDelete}>
                Remove key
              </Button>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
