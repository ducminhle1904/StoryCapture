import { Selector as AstryxSelector } from "@astryxdesign/core/Selector";
import { useCallback, useEffect, useState } from "react";
import {
  type BrowserLanguageOption,
  getBrowserLanguageOptions,
  setBrowserLanguage,
} from "@/ipc/settings";
import { notifications } from "@/lib/notifications";
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
        notifications.success("Browser language updated");
      } catch {
        setLanguage(language);
        notifications.error("Could not update browser language");
      } finally {
        setBusy(false);
      }
    },
    [language],
  );

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-background-card)] p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-[var(--color-text-primary)]">
            Browser language
          </div>
          <div className="mt-0.5 max-w-[480px] text-[11px] leading-4 text-[var(--color-text-secondary)]">
            Requests this language for Live Preview, Simulator, and Record. Sites that do not
            support it may use their own default language.
          </div>
        </div>
        <AstryxSelector
          label="Browser language"
          isLabelHidden
          value={language}
          options={options}
          onChange={(value) => void save(value)}
          isDisabled={busy}
          width={220}
        />
      </div>
    </div>
  );
}
