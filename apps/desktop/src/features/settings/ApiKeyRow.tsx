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
        testStatus === "valid" && "bg-green-100 text-green-800",
        testStatus === "invalid" && "bg-red-100 text-red-800",
        testStatus === "rate_limited" && "bg-amber-100 text-amber-800",
      )}
    >
      {testStatus === "valid" && "valid"}
      {testStatus === "invalid" && "invalid"}
      {testStatus === "rate_limited" && "rate_limited"}
    </span>
  );

  return (
    <div className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] p-3">
      {/* Provider icon placeholder */}
      <Shield className="h-6 w-6 shrink-0 text-[var(--color-fg-muted)]" />

      {/* Provider name */}
      <span className="min-w-[100px] font-medium text-sm">{displayName}</span>

      {/* Key display / input */}
      <div className="flex-1">
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
              className="flex-1 rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
              aria-label={`API key cho ${displayName}`}
            />
            <Button
              size="sm"
              onClick={handleSave}
              disabled={saving || !keyValue.trim()}
            >
              {saving ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                "L\u01b0u v\u00e0o Keychain"
              )}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setKeyValue("");
              }}
            >
              {"\u0110\u00f3ng"}
            </Button>
          </div>
        ) : null}
      </div>

      {/* Status badge */}
      {statusBadge}

      {/* Actions */}
      <div className="flex items-center gap-1">
        {!present && !editing && (
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            {"Th\u00eam key"}
          </Button>
        )}

        {present && (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={handleTest}
              disabled={testing}
            >
              {testing ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                "Ki\u1ec3m tra k\u1ebft n\u1ed1i"
              )}
            </Button>

            <Button
              size="icon"
              variant="ghost"
              onClick={() => setShowConfirm(true)}
              aria-label={`Xo\u0301a API key ${displayName}`}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </>
        )}
      </div>

      {/* Confirm dialog overlay */}
      {showConfirm && (
        <div
          role="alertdialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
        >
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-6 shadow-lg max-w-sm">
            <h3 className="text-lg font-semibold mb-2">
              {`Xoá API key ${displayName}?`}
            </h3>
            <p className="text-sm text-[var(--color-fg-muted)] mb-4">
              {"Key s\u1ebd b\u1ecb xo\u00e1 kh\u1ecfi OS Keychain. B\u1ea1n s\u1ebd c\u1ea7n nh\u1eadp l\u1ea1i n\u1ebfu mu\u1ed1n d\u00f9ng l\u1ea1i."}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setShowConfirm(false)}>
                {"Hu\u1ef7"}
              </Button>
              <Button variant="destructive" onClick={handleDelete}>
                {"Xoá khỏi Keychain"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
