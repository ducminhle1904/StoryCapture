/**
 * Web Account connection panel for Settings > Accounts.
 *
 * Shows web account connection status with connect/disconnect flow.
 * OAuth flow opens the system browser and captures the callback via the host.
 *
 * data-testid="web-account-panel"
 */

import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { AlertCircle, CheckCircle2, Globe, Loader2, LogOut, User } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { useWebAccountStore } from "@/stores/web-account-store";

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
    : (account?.email?.[0]?.toUpperCase() ?? "?");

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
        <Globe className="h-4 w-4 text-[var(--color-text-secondary)]" aria-hidden="true" />
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
          Web account
        </h2>
      </div>

      <div className="brand-panel rounded-[var(--radius-page)] p-5">
        <div className="mb-5 grid gap-3 md:grid-cols-3">
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-background-muted)] px-4 py-3">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-text-secondary)]">
              Status
            </div>
            <div className="mt-2 text-sm font-medium text-[var(--color-text-primary)]">
              {account ? "Connected" : isConnecting ? "Authorizing" : "Local only"}
            </div>
          </div>
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-background-muted)] px-4 py-3">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-text-secondary)]">
              Uploads
            </div>
            <div className="mt-2 text-sm font-medium text-[var(--color-text-primary)]">
              {account ? "Ready" : "Locked until sign-in"}
            </div>
          </div>
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-background-muted)] px-4 py-3">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-text-secondary)]">
              Sync
            </div>
            <div className="mt-2 text-sm font-medium text-[var(--color-text-primary)]">
              {account ? "Enabled" : "Optional"}
            </div>
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="mb-4 flex items-start gap-2 rounded-2xl border border-[var(--color-error)]/25 bg-[var(--color-error)]/8 px-4 py-3 text-sm text-[var(--color-error)]"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        {!account && !isConnecting && (
          <div className="flex flex-col items-center gap-4 rounded-[var(--radius-page)] border border-[var(--color-border)] bg-[var(--color-background-muted)] px-6 py-8 text-center">
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-background-card)] p-4">
              <Globe className="h-8 w-8 text-[var(--color-text-secondary)]" aria-hidden="true" />
            </div>
            <div>
              <p className="text-base font-medium text-[var(--color-text-primary)]">
                Connect your web account
              </p>
              <p className="font-serif mt-2 max-w-sm text-sm leading-6 text-[var(--color-text-secondary)]">
                Sign in when you want uploads, team sharing, and cross-device project sync. Local
                desktop work stays available without this connection.
              </p>
            </div>
            <AstryxButton
              onClick={handleConnect}
              className="brand-button gap-2 rounded-xl px-4 text-[var(--color-text-primary)]"
              aria-label="Connect web account via GitHub"
              label="Connect web account via GitHub"
            >
              <Globe className="h-4 w-4" aria-hidden="true" />
              Connect Web Account
            </AstryxButton>
          </div>
        )}

        {isConnecting && (
          <div className="flex flex-col items-center gap-4 rounded-[var(--radius-page)] border border-[var(--color-border)] bg-[var(--color-background-muted)] px-6 py-8 text-center">
            <Loader2
              className="h-8 w-8 animate-spin text-[var(--color-accent)]"
              aria-hidden="true"
            />
            <div>
              <p className="text-base font-medium text-[var(--color-text-primary)]">
                Waiting for browser authentication...
              </p>
              <p className="font-serif mt-2 text-sm leading-6 text-[var(--color-text-secondary)]">
                Complete the sign-in in your browser. This window will update automatically.
              </p>
            </div>
          </div>
        )}

        {account && !isConnecting && (
          <div className="rounded-[var(--radius-page)] border border-[var(--color-border)] bg-[var(--color-background-muted)] p-5">
            <div className="flex flex-col gap-4 md:flex-row md:items-center">
              {account.avatarUrl ? (
                <img
                  src={account.avatarUrl}
                  alt={`${account.name ?? account.email} avatar`}
                  className="h-14 w-14 rounded-2xl border border-[var(--color-border)] object-cover"
                />
              ) : (
                <div
                  className="flex h-14 w-14 items-center justify-center rounded-2xl border border-[var(--color-border)] bg-[var(--color-accent)]/15 text-sm font-semibold text-[var(--color-accent)]"
                  aria-hidden="true"
                >
                  {initials}
                </div>
              )}

              <div className="min-w-0 flex-1">
                {account.name && (
                  <p className="truncate text-sm font-medium text-[var(--color-text-primary)]">
                    {account.name}
                  </p>
                )}
                <p className="truncate text-sm text-[var(--color-text-secondary)]">
                  {account.email}
                </p>
                {connectedDate && (
                  <p className="mt-0.5 text-xs text-[var(--color-text-secondary)]">
                    Connected since {connectedDate}
                  </p>
                )}
              </div>

              <span className="inline-flex items-center gap-1 rounded-full border border-[var(--color-success)]/25 bg-[var(--color-success)]/12 px-2.5 py-0.5 text-xs font-medium text-[var(--color-success)]">
                <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                Connected
              </span>

              <AstryxButton
                size="sm"
                variant="ghost"
                onClick={() => setShowDisconnectConfirm(true)}
                aria-label="Disconnect web account"
                className="rounded-xl border border-[var(--color-border)] bg-[var(--color-background-card)] text-[var(--color-text-secondary)] hover:bg-[var(--color-background-popover)] hover:text-[var(--color-error)]"
                label="Disconnect web account"
              >
                <LogOut className="h-4 w-4" aria-hidden="true" />
              </AstryxButton>
            </div>
          </div>
        )}
      </div>

      <div className="rounded-[var(--radius-page)] border border-[var(--color-border)] bg-[var(--color-background-card)] p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <User className="h-4 w-4 text-[var(--color-text-secondary)]" aria-hidden="true" />
            <span className="text-sm font-medium text-[var(--color-text-primary)]">
              Upload Settings
            </span>
          </div>
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
              account
                ? "border border-[var(--color-success)]/25 bg-[var(--color-success)]/12 text-[var(--color-success)]"
                : "border border-[var(--color-border)] bg-[var(--color-background-body)]/60 text-[var(--color-text-secondary)]",
            )}
          >
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                account ? "bg-[var(--color-success)]" : "bg-[var(--color-text-secondary)]/40",
              )}
              aria-hidden="true"
            />
            {account ? "Connected" : "Not connected"}
          </span>
        </div>
      </div>

      <AlertDialog
        isOpen={showDisconnectConfirm}
        onOpenChange={setShowDisconnectConfirm}
        title="Disconnect web account?"
        description="Your API token will be removed from the OS keychain. You will need to sign in again to upload videos or sync projects."
        actionLabel="Disconnect"
        actionVariant="destructive"
        onAction={() => void handleDisconnect()}
      />
    </div>
  );
}
