/**
 * Web Account connection panel for Settings > Accounts.
 *
 * Shows web account connection status with connect/disconnect flow.
 * OAuth flow opens the system browser and captures the callback
 * via a localhost server managed by the Rust backend.
 *
 * data-testid="web-account-panel"
 */

import { useEffect, useState, useCallback } from "react";
import { Dialog } from "@base-ui-components/react/dialog";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useWebAccountStore } from "@/stores/web-account-store";
import { Globe, LogOut, Loader2, AlertCircle, CheckCircle2, User } from "lucide-react";

export function WebAccountPanel() {
  const { account, isConnecting, error, fetchAccount, connect, disconnect, clearError } =
    useWebAccountStore();
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);

  // Fetch account info on mount
  useEffect(() => {
    fetchAccount();
  }, [fetchAccount]);

  const handleConnect = useCallback(async () => {
    clearError();
    await connect();
  }, [connect, clearError]);

  const handleDisconnect = useCallback(async () => {
    await disconnect();
    setShowDisconnectConfirm(false);
  }, [disconnect]);

  // Initials fallback for avatar
  const initials = account?.name
    ? account.name
        .split(" ")
        .map((part: string) => part[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : account?.email?.[0]?.toUpperCase() ?? "?";

  const connectedDate = account?.connectedAt
    ? new Date(account.connectedAt).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : null;

  return (
    <div data-testid="web-account-panel" className="space-y-4">
      <div className="flex items-center gap-2">
        <Globe
          className="h-4 w-4 text-[var(--color-fg-muted)]"
          aria-hidden="true"
        />
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--color-fg-muted)]">
          Web account
        </h2>
      </div>

      <div className="brand-panel rounded-[var(--radius-2xl)] p-5">
        <div className="mb-5 grid gap-3 md:grid-cols-3">
          <div className="rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-400)] px-4 py-3">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-fg-muted)]">
              Status
            </div>
            <div className="mt-2 text-sm font-medium text-[var(--color-fg-primary)]">
              {account ? "Connected" : isConnecting ? "Authorizing" : "Local only"}
            </div>
          </div>
          <div className="rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-400)] px-4 py-3">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-fg-muted)]">
              Uploads
            </div>
            <div className="mt-2 text-sm font-medium text-[var(--color-fg-primary)]">
              {account ? "Ready" : "Locked until sign-in"}
            </div>
          </div>
          <div className="rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-400)] px-4 py-3">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-fg-muted)]">
              Sync
            </div>
            <div className="mt-2 text-sm font-medium text-[var(--color-fg-primary)]">
              {account ? "Enabled" : "Optional"}
            </div>
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="mb-4 flex items-start gap-2 rounded-2xl border border-[var(--color-danger)]/25 bg-[var(--color-danger)]/8 px-4 py-3 text-sm text-[var(--color-danger)]"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        {!account && !isConnecting && (
          <div className="flex flex-col items-center gap-4 rounded-[var(--radius-2xl)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-400)] px-6 py-8 text-center">
            <div className="rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] p-4">
              <Globe className="h-8 w-8 text-[var(--color-fg-muted)]" aria-hidden="true" />
            </div>
            <div>
              <p className="text-base font-medium text-[var(--color-fg-primary)]">
                Connect your web account
              </p>
              <p className="mt-2 max-w-sm text-sm leading-6 text-[var(--color-fg-muted)]">
                Sign in when you want uploads, team sharing, and cross-device project
                sync. Local desktop work stays available without this connection.
              </p>
            </div>
            <Button
              onClick={handleConnect}
              className="brand-button gap-2 rounded-xl px-4 text-[var(--color-fg-primary)]"
              aria-label="Connect web account via GitHub"
            >
              <Globe className="h-4 w-4" aria-hidden="true" />
              Connect Web Account
            </Button>
          </div>
        )}

        {isConnecting && (
          <div className="flex flex-col items-center gap-4 rounded-[var(--radius-2xl)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-400)] px-6 py-8 text-center">
            <Loader2
              className="h-8 w-8 animate-spin text-[var(--color-accent)]"
              aria-hidden="true"
            />
            <div>
              <p className="text-base font-medium text-[var(--color-fg-primary)]">
                Waiting for browser authentication...
              </p>
              <p className="mt-2 text-sm leading-6 text-[var(--color-fg-muted)]">
                Complete the sign-in in your browser. This window will update automatically.
              </p>
            </div>
          </div>
        )}

        {account && !isConnecting && (
          <div className="rounded-[var(--radius-2xl)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-400)] p-5">
            <div className="flex flex-col gap-4 md:flex-row md:items-center">
            {account.avatarUrl ? (
              <img
                src={account.avatarUrl}
                alt={`${account.name ?? account.email} avatar`}
                className="h-14 w-14 rounded-2xl border border-[var(--color-border-default)] object-cover"
              />
            ) : (
              <div
                className="flex h-14 w-14 items-center justify-center rounded-2xl border border-[var(--color-border-default)] bg-[var(--color-accent)]/15 text-sm font-semibold text-[var(--color-accent)]"
                aria-hidden="true"
              >
                {initials}
              </div>
            )}

            <div className="min-w-0 flex-1">
              {account.name && (
                <p className="truncate text-sm font-medium text-[var(--color-fg-primary)]">
                  {account.name}
                </p>
              )}
              <p className="truncate text-sm text-[var(--color-fg-muted)]">{account.email}</p>
              {connectedDate && (
                <p className="mt-0.5 text-xs text-[var(--color-fg-muted)]">
                  Connected since {connectedDate}
                </p>
              )}
            </div>

            <span className="inline-flex items-center gap-1 rounded-full border border-[var(--color-success)]/25 bg-[var(--color-success)]/12 px-2.5 py-0.5 text-xs font-medium text-[var(--color-success)]">
              <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
              Connected
            </span>

            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowDisconnectConfirm(true)}
              aria-label="Disconnect web account"
              className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-300)] hover:text-[var(--color-danger)]"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
            </Button>
            </div>
          </div>
        )}
      </div>

      <div className="rounded-[var(--radius-2xl)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <User className="h-4 w-4 text-[var(--color-fg-muted)]" aria-hidden="true" />
            <span className="text-sm font-medium text-[var(--color-fg-primary)]">
              Upload Settings
            </span>
          </div>
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
              account
                ? "border border-[var(--color-success)]/25 bg-[var(--color-success)]/12 text-[var(--color-success)]"
                : "border border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)]/60 text-[var(--color-fg-muted)]",
            )}
          >
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                account ? "bg-[var(--color-success)]" : "bg-[var(--color-fg-muted)]/40",
              )}
              aria-hidden="true"
            />
            {account ? "Connected" : "Not connected"}
          </span>
        </div>
      </div>

      {/* Disconnect confirmation dialog */}
      <Dialog.Root open={showDisconnectConfirm} onOpenChange={setShowDisconnectConfirm}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-[var(--color-fg-primary)/50] backdrop-blur-sm" />
          <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-[var(--radius-2xl)] border border-[var(--color-border-default)] bg-[var(--color-surface-100)] p-6 shadow-[var(--shadow-card)]">
            <Dialog.Title className="mb-2 text-lg font-semibold text-[var(--color-fg-primary)]">
              Disconnect web account?
            </Dialog.Title>
            <Dialog.Description className="mb-4 text-sm text-[var(--color-fg-muted)]">
              Your API token will be removed from the OS keychain. You will need to sign in again to
              upload videos or sync projects.
            </Dialog.Description>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setShowDisconnectConfirm(false)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={handleDisconnect}>
                Disconnect
              </Button>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
