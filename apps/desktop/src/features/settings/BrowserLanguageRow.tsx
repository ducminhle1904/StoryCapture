import {
  ScSelect,
  ScSelectContent,
  ScSelectItem,
  ScSelectTrigger,
  ScSelectValue,
} from "@storycapture/ui";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import {
  type BrowserLanguageOption,
  getBrowserLanguageOptions,
  setBrowserLanguage,
} from "@/ipc/settings";
import { useAppSettingsStore } from "@/state/app-settings";

export function BrowserLanguageRow() {
  const [language, setLanguage] = useState("system");
  const [options, setOptions] = useState<BrowserLanguageOption[]>([
    { value: "system", label: "System default" },
  ]);
  const [busy, setBusy] = useState(false);
  const settings = useAppSettingsStore((s) => s.settings);
  const hydrate = useAppSettingsStore((s) => s.hydrate);

  useEffect(() => {
    Promise.all([settings ? Promise.resolve(settings) : hydrate(), getBrowserLanguageOptions()])
      .then(([nextSettings, nextOptions]) => {
        setLanguage(nextSettings.browser_language || "system");
        if (nextOptions.length > 0) {
          setOptions(nextOptions);
        }
      })
      .catch(() => {});
  }, [hydrate, settings]);

  const save = useCallback(
    async (nextLanguage: string) => {
      if (nextLanguage === language) return;
      setLanguage(nextLanguage);
      setBusy(true);
      try {
        const next = await setBrowserLanguage(nextLanguage);
        useAppSettingsStore.setState({ settings: next });
        setLanguage(next.browser_language);
        toast.success("Browser language updated");
      } catch {
        setLanguage(language);
        toast.error("Could not update browser language");
      } finally {
        setBusy(false);
      }
    },
    [language],
  );

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-[var(--color-fg-primary)]">
            Browser language
          </div>
          <div className="mt-0.5 max-w-[480px] text-[11px] leading-4 text-[var(--color-fg-muted)]">
            Requests this language for Live Preview, Simulator, and Record. Sites that do not
            support it may use their own default language.
          </div>
        </div>
        <ScSelect value={language} onValueChange={(value) => save(String(value))}>
          <ScSelectTrigger disabled={busy} aria-label="Browser language" style={{ width: 220 }}>
            <ScSelectValue />
          </ScSelectTrigger>
          <ScSelectContent>
            {options.map((option) => (
              <ScSelectItem key={option.value} value={option.value}>
                {option.label}
              </ScSelectItem>
            ))}
          </ScSelectContent>
        </ScSelect>
      </div>
    </div>
  );
}
