import { PageContentTransition } from "@/components/page-content-transition";
import { AccountsPage } from "@/features/settings/AccountsPage";

export default function SettingsRoute() {
  return (
    <main id="main-content" className="flex h-full flex-col">
      <header className="flex shrink-0 items-center border-b border-[var(--sc-border)] bg-[var(--sc-bg)] px-6 py-3">
        <h1 className="text-sm font-semibold text-[var(--sc-text)]">
          Settings
        </h1>
      </header>

      <PageContentTransition className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-8 py-8">
          <AccountsPage />
        </div>
      </PageContentTransition>
    </main>
  );
}
