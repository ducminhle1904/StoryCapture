import { AccountsPage } from "@/features/settings/AccountsPage";
import AutoUpdaterSettings from "@/features/settings/auto-updater";

export default function SettingsRoute() {
  return (
    <main id="main-content" className="flex h-full flex-col">
      <header className="flex shrink-0 items-center border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] px-6 py-3">
        <h1 className="text-sm font-semibold text-[var(--color-fg-primary)]">
          Settings
        </h1>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-10 px-6 py-8">
          <AccountsPage />

          <div className="h-px bg-[var(--color-border-subtle)]" />

          <AutoUpdaterSettings />
        </div>
      </div>
    </main>
  );
}
