import { Settings } from "lucide-react";

import { AccountsPage } from "@/features/settings/AccountsPage";
import AutoUpdaterSettings from "@/features/settings/auto-updater";

export default function SettingsRoute() {
  return (
    <main
      id="main-content"
      className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-8 py-8 pb-12"
    >
      <header className="brand-panel relative overflow-hidden rounded-[var(--radius-2xl)] px-7 py-7">
        <div className="absolute inset-y-0 right-0 w-[34%] bg-[var(--color-surface-100)] opacity-60" />
        <div className="absolute inset-x-0 top-0 h-24 bg-[var(--color-surface-200)]" />
        <div className="relative grid gap-8 xl:grid-cols-[minmax(0,1.2fr)_320px]">
          <div>
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.24em] text-[var(--color-fg-muted)]">
              <Settings size={12} aria-hidden="true" />
              Desktop settings
            </div>
            <h1 className="mt-3 max-w-3xl text-4xl font-semibold tracking-[-0.055em] text-[var(--color-fg-primary)]">
              Keep credentials, sync, and update controls in one local-first workspace.
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--color-fg-secondary)]">
              StoryCapture stores provider credentials in the OS keychain, keeps web
              sync optional, and leaves update checks off until you enable them.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <div className="rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-400)] px-4 py-3">
                <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-fg-muted)]">
                  Key storage
                </div>
                <div className="mt-2 text-sm font-medium text-[var(--color-fg-primary)]">
                  OS keychain only
                </div>
              </div>
              <div className="rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-400)] px-4 py-3">
                <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-fg-muted)]">
                  Sync model
                </div>
                <div className="mt-2 text-sm font-medium text-[var(--color-fg-primary)]">
                  Opt-in web account
                </div>
              </div>
              <div className="rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-400)] px-4 py-3">
                <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-fg-muted)]">
                  Updates
                </div>
                <div className="mt-2 text-sm font-medium text-[var(--color-fg-primary)]">
                  Manual by default
                </div>
              </div>
            </div>
          </div>

          <aside className="rounded-[var(--radius-2xl)] border border-[var(--color-border-default)] bg-[var(--color-surface-500)] p-5 shadow-[inset_0_1px_0_rgba(38,37,30,0.03)]">
            <p className="text-[11px] uppercase tracking-[0.2em] text-[var(--color-fg-muted)]">
              Operational notes
            </p>
            <div className="mt-4 space-y-4 text-sm text-[var(--color-fg-secondary)]">
              <div className="rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] px-4 py-3">
                Provider keys never leave the device unless a provider call requires them.
              </div>
              <div className="rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] px-4 py-3">
                Disconnecting the web account does not affect local projects or recordings.
              </div>
              <div className="rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] px-4 py-3">
                Update checks and installs stay explicit so support flows remain predictable.
              </div>
            </div>
          </aside>
        </div>
      </header>

      <div className="grid gap-8 xl:grid-cols-[minmax(0,1.15fr)_360px]">
        <section className="min-w-0">
          <AccountsPage />
        </section>
        <aside className="space-y-5 xl:sticky xl:top-8 xl:self-start">
          <AutoUpdaterSettings />
        </aside>
      </div>
    </main>
  );
}
