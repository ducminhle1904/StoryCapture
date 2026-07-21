import type { ReactNode } from "react";

export interface SettingsRowProps {
  label: string;
  hint?: string;
  control: ReactNode;
  last?: boolean;
}

// Form-row primitive matching the Claude Design mock's Row pattern.
export function SettingsRow({ label, hint, control, last }: SettingsRowProps) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr auto",
        gap: 16,
        alignItems: "center",
        padding: "14px 0",
        borderBottom: last ? "none" : "1px solid var(--color-border)",
      }}
    >
      <div>
        <div style={{ fontSize: 13, fontWeight: 500 }}>{label}</div>
        {hint && (
          <div style={{ fontSize: 11, color: "var(--color-text-disabled)", marginTop: 2 }}>
            {hint}
          </div>
        )}
      </div>
      <div>{control}</div>
    </div>
  );
}

export interface SettingsPanelProps {
  title: string;
  desc?: string;
  children: ReactNode;
}

export function SettingsPanel({ title, desc, children }: SettingsPanelProps) {
  return (
    <div style={{ maxWidth: 620 }}>
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>{title}</div>
      {desc && (
        <div
          style={{
            fontSize: 12.5,
            color: "var(--color-text-secondary)",
            marginBottom: 20,
            lineHeight: 1.5,
          }}
        >
          {desc}
        </div>
      )}
      <div>{children}</div>
    </div>
  );
}

export interface SettingsCardProps {
  children: ReactNode;
}

// Card wrapper used to group rows inside a panel.
export function SettingsCard({ children }: SettingsCardProps) {
  return (
    <div
      style={{
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-container)",
        background: "var(--color-background-surface)",
        padding: "0 16px",
      }}
    >
      {children}
    </div>
  );
}
