import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { TextInput as AstryxTextInput } from "@astryxdesign/core/TextInput";
import { invoke } from "@tauri-apps/api/core";
import { Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
import { cn } from "@/lib/utils";

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
        "flex items-center gap-4 rounded-[var(--radius-container)] border px-4 py-3 transition-colors",
        present
          ? "border-[var(--color-border)] bg-[var(--color-background-card)]"
          : "border-dashed border-[var(--color-border)] bg-transparent",
      )}
    >
      {/* Provider name + status */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-[var(--color-text-primary)]">
            {displayName}
          </span>
          {testStatus === "valid" && (
            <span className="rounded-full bg-[var(--color-success)]/12 px-2 py-0.5 text-[10px] font-medium text-[var(--color-success)]">
              connected
            </span>
          )}
          {testStatus === "invalid" && (
            <span className="rounded-full bg-[var(--color-error)]/12 px-2 py-0.5 text-[10px] font-medium text-[var(--color-error)]">
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
          <span className="mt-0.5 block font-mono text-xs text-[var(--color-text-secondary)]">
            ••••••••
          </span>
        )}
      </div>

      {/* Inline edit form */}
      {editing && (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <AstryxTextInput
            type="password"
            value={keyValue}
            onChange={setKeyValue}
            placeholder={`Paste ${displayName} key`}
            label={`API key for ${displayName}`}
            isLabelHidden
            size="sm"
            width="100%"
            className="min-w-0 flex-1 font-mono"
          />
          <AstryxButton
            size="sm"
            onClick={handleSave}
            isDisabled={saving || !keyValue.trim()}
            className="shrink-0 rounded-[var(--radius-element)] px-3 text-xs"
            label="Save API key"
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
          </AstryxButton>
          <AstryxButton
            variant="ghost"
            size="sm"
            onClick={() => {
              setEditing(false);
              setKeyValue("");
            }}
            label="Cancel API key edit"
          >
            Cancel
          </AstryxButton>
        </div>
      )}

      {/* Actions */}
      {!editing && (
        <div className="flex shrink-0 items-center gap-2">
          {!present && (
            <AstryxButton
              variant="ghost"
              size="sm"
              onClick={() => setEditing(true)}
              label={`Add ${displayName} API key`}
            >
              Add key
            </AstryxButton>
          )}
          {present && (
            <>
              <AstryxButton
                variant="ghost"
                size="sm"
                onClick={handleTest}
                isDisabled={testing}
                label={`Test ${displayName} API key`}
              >
                {testing ? <Loader2 className="inline h-3 w-3 animate-spin" /> : "Test"}
              </AstryxButton>
              <span className="text-[var(--color-border)]">|</span>
              <AstryxButton
                variant="ghost"
                size="sm"
                onClick={() => setEditing(true)}
                label={`Replace ${displayName} API key`}
              >
                Replace
              </AstryxButton>
              <span className="text-[var(--color-border)]">|</span>
              <AstryxButton
                variant="ghost"
                size="sm"
                onClick={() => setShowConfirm(true)}
                label={`Remove ${displayName} key`}
              >
                Remove
              </AstryxButton>
            </>
          )}
        </div>
      )}

      <AlertDialog
        isOpen={showConfirm}
        onOpenChange={setShowConfirm}
        title={`Remove ${displayName} key?`}
        description="This deletes the key from the OS keychain. You can add it again later."
        actionLabel="Remove"
        actionVariant="destructive"
        onAction={() => void handleDelete()}
      />
    </div>
  );
}
