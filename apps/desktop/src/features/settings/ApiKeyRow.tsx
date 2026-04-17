import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "@base-ui-components/react/dialog";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  dialogBackdropMotionClassName,
  dialogCenteredPopupMotionClassName,
  dialogViewportClassName,
} from "@/components/ui/dialog-motion";
import { Loader2 } from "lucide-react";

export interface ApiKeyRowProps {
  providerId: string;
  displayName: string;
  present: boolean;
  testStatus?: "valid" | "invalid" | "rate_limited" | "untested";
  onPresenceChange: (present: boolean) => void;
  onTestStatusChange: (
    status: "valid" | "invalid" | "rate_limited" | "untested",
  ) => void;
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
      setKeyValue("");
      setEditing(false);
      onPresenceChange(true);
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

  return (
    <div
      className={cn(
        "flex items-center gap-4 rounded-[var(--radius-lg)] border px-4 py-3 transition-colors",
        present
          ? "border-[var(--color-border-subtle)] bg-[var(--color-surface-100)]"
          : "border-dashed border-[var(--color-border-default)] bg-transparent",
      )}
    >
      {/* Provider name + status */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-[var(--color-fg-primary)]">
            {displayName}
          </span>
          {testStatus === "valid" && (
            <span className="rounded-full bg-[var(--color-success)]/12 px-2 py-0.5 text-[10px] font-medium text-[var(--color-success)]">
              connected
            </span>
          )}
          {testStatus === "invalid" && (
            <span className="rounded-full bg-[var(--color-danger)]/12 px-2 py-0.5 text-[10px] font-medium text-[var(--color-danger)]">
              invalid
            </span>
          )}
          {testStatus === "rate_limited" && (
            <span className="rounded-full bg-[var(--color-warning)]/12 px-2 py-0.5 text-[10px] font-medium text-[var(--color-warning)]">
              rate limited
            </span>
          )}
        </div>
        {present && !editing && (
          <span className="mt-0.5 block font-mono text-xs text-[var(--color-fg-muted)]">
            ••••••••
          </span>
        )}
      </div>

      {/* Inline edit form */}
      {editing && (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <input
            type="password"
            autoComplete="off"
            value={keyValue}
            onChange={(e) => setKeyValue(e.target.value)}
            placeholder={`Paste ${displayName} key`}
            className="min-w-0 flex-1 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-200)] px-3 py-1.5 font-mono text-xs text-[var(--color-fg-primary)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent-primary)]"
            aria-label={`API key for ${displayName}`}
          />
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saving || !keyValue.trim()}
            className="shrink-0 rounded-[var(--radius-md)] px-3 text-xs"
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
          </Button>
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setKeyValue("");
            }}
            className="shrink-0 text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg-primary)]"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Actions */}
      {!editing && (
        <div className="flex shrink-0 items-center gap-2">
          {!present && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-xs font-medium text-[var(--color-accent-primary)] hover:underline"
            >
              Add key
            </button>
          )}
          {present && (
            <>
              <button
                type="button"
                onClick={handleTest}
                disabled={testing}
                className="text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg-primary)] disabled:opacity-50"
              >
                {testing ? (
                  <Loader2 className="inline h-3 w-3 animate-spin" />
                ) : (
                  "Test"
                )}
              </button>
              <span className="text-[var(--color-border-default)]">|</span>
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg-primary)]"
              >
                Replace
              </button>
              <span className="text-[var(--color-border-default)]">|</span>
              <button
                type="button"
                onClick={() => setShowConfirm(true)}
                className="text-xs text-[var(--color-danger)]/70 hover:text-[var(--color-danger)]"
                aria-label={`Remove ${displayName} key`}
              >
                Remove
              </button>
            </>
          )}
        </div>
      )}

      {/* Delete confirmation dialog */}
      <Dialog.Root open={showConfirm} onOpenChange={setShowConfirm}>
        <Dialog.Portal>
          <Dialog.Backdrop
            className={`fixed inset-0 z-50 bg-black/40 backdrop-blur-sm ${dialogBackdropMotionClassName}`}
          />
          <Dialog.Viewport className={dialogViewportClassName}>
            <Dialog.Popup
              className={`w-full max-w-sm rounded-[var(--radius-xl)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] p-6 shadow-[var(--shadow-card)] ${dialogCenteredPopupMotionClassName}`}
            >
              <Dialog.Title className="text-base font-semibold text-[var(--color-fg-primary)]">
              Remove {displayName} key?
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-sm text-[var(--color-fg-muted)]">
              This deletes the key from the OS keychain. You can add it again
              later.
            </Dialog.Description>
            <div className="mt-5 flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowConfirm(false)}
              >
                Cancel
              </Button>
              <Button variant="destructive" size="sm" onClick={handleDelete}>
                Remove
              </Button>
            </div>
            </Dialog.Popup>
          </Dialog.Viewport>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
