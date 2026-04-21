import type { ComponentType, ReactNode } from "react";

export interface EmptyStateProps {
  illustration?: ReactNode;
  icon?: ComponentType<{ size?: number; "aria-hidden"?: boolean; style?: React.CSSProperties }>;
  title: string;
  body?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
}

export function EmptyState({ illustration, icon: Icon, title, body, actions, footer }: EmptyStateProps) {
  return (
    <div style={{ display: "grid", placeItems: "center", minHeight: 400, padding: 40 }}>
      <div style={{ textAlign: "center", maxWidth: 460 }}>
        {illustration ? (
          <div style={{ margin: "0 auto 24px" }}>{illustration}</div>
        ) : Icon ? (
          <div
            style={{
              width: 56,
              height: 56,
              margin: "0 auto 20px",
              borderRadius: 12,
              background: "var(--sc-surface-3)",
              border: "1px solid var(--sc-border-2)",
              display: "grid",
              placeItems: "center",
            }}
          >
            <Icon size={22} aria-hidden style={{ color: "var(--sc-text-3)" }} />
          </div>
        ) : null}
        <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 6 }}>{title}</div>
        {body ? (
          <div
            style={{
              fontSize: 13,
              color: "var(--sc-text-3)",
              lineHeight: 1.5,
              marginBottom: 20,
            }}
          >
            {body}
          </div>
        ) : null}
        {actions ? (
          <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>{actions}</div>
        ) : null}
        {footer ? (
          <div style={{ marginTop: 24, fontSize: 11, color: "var(--sc-text-4)" }}>{footer}</div>
        ) : null}
      </div>
    </div>
  );
}
