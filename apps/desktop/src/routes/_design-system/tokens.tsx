import { ScBadge, ScCard } from "@storycapture/ui";

const NEUTRALS = [
  "975", "950", "925", "900", "850", "800", "700", "600",
  "500", "400", "300", "200", "100", "50", "25", "0",
];
const ACCENTS = ["100", "200", "300", "400", "500", "600", "700"];
const SEMANTIC = [
  { k: "record", v: "var(--sc-record)", label: "Record / destructive" },
  { k: "success", v: "var(--sc-success)", label: "Success / export" },
  { k: "warn", v: "var(--sc-warn)", label: "Warn" },
  { k: "info", v: "var(--sc-info)", label: "Info" },
] as const;
const RADII: [string, number][] = [
  ["xs", 3], ["sm", 5], ["md", 7], ["lg", 10], ["xl", 14], ["2xl", 20],
];
const SPACING = [2, 4, 6, 8, 10, 12, 16, 20, 24, 32, 40];
const SHADOWS = ["sh-1", "sh-2", "sh-3", "sh-pop"] as const;

export default function DesignSystemTokensRoute() {
  return (
    <main id="main-content" className="h-full overflow-auto p-8">
      <div className="sc-toolbar">
        <div className="sc-toolbar-title">Design Tokens</div>
        <ScBadge tone="muted">Claude Design · --sc-* CSS variables</ScBadge>
      </div>
      <div style={{ maxWidth: 960, padding: "28px 0" }}>
        <H2>Neutral ramp</H2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(16, 1fr)", gap: 4, marginBottom: 24 }}>
          {NEUTRALS.map((k) => (
            <div key={k}>
              <div
                style={{
                  height: 56,
                  background: `var(--sc-n-${k})`,
                  borderRadius: 4,
                  border: "1px solid var(--sc-border)",
                }}
              />
              <div style={{ fontSize: 10, fontFamily: "var(--sc-font-mono)", color: "var(--sc-text-4)", marginTop: 4, textAlign: "center" }}>
                {k}
              </div>
            </div>
          ))}
        </div>

        <H2>Accent — warm amber</H2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6, marginBottom: 24 }}>
          {ACCENTS.map((a) => (
            <div key={a}>
              <div style={{ height: 72, background: `var(--sc-accent-${a})`, borderRadius: 6 }} />
              <div style={{ fontSize: 11, fontFamily: "var(--sc-font-mono)", marginTop: 6 }}>
                accent-{a}
              </div>
            </div>
          ))}
        </div>

        <H2>Semantic</H2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 24 }}>
          {SEMANTIC.map((s) => (
            <ScCard key={s.k}>
              <div style={{ height: 44, background: s.v, borderRadius: 4, marginBottom: 8 }} />
              <div style={{ fontSize: 12, fontWeight: 600 }}>{s.k}</div>
              <div style={{ fontSize: 11, color: "var(--sc-text-4)", marginTop: 1 }}>{s.label}</div>
            </ScCard>
          ))}
        </div>

        <H2>Spacing &amp; radii</H2>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 24 }}>
          <ScCard title="Spacing scale (px)">
            {SPACING.map((n) => (
              <div key={n} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                <div style={{ width: 34, fontSize: 11, fontFamily: "var(--sc-font-mono)", color: "var(--sc-text-4)" }}>{n}</div>
                <div style={{ width: n, height: 10, background: "var(--sc-accent-400)", borderRadius: 2 }} />
              </div>
            ))}
          </ScCard>
          <ScCard title="Radii">
            {RADII.map(([k, v]) => (
              <div key={k} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                <div style={{ width: 44, fontSize: 11, fontFamily: "var(--sc-font-mono)", color: "var(--sc-text-4)" }}>{k}</div>
                <div style={{ width: 40, height: 26, background: "var(--sc-surface-3)", border: "1px solid var(--sc-border-2)", borderRadius: v }} />
                <span style={{ fontSize: 11, color: "var(--sc-text-4)", fontFamily: "var(--sc-font-mono)" }}>{v}px</span>
              </div>
            ))}
          </ScCard>
        </div>

        <H2>Shadows</H2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, padding: 20, background: "var(--sc-chrome-2)", borderRadius: 8 }}>
          {SHADOWS.map((k) => (
            <div key={k} style={{ textAlign: "center" }}>
              <div
                style={{
                  height: 70,
                  background: "var(--sc-surface)",
                  border: "1px solid var(--sc-border)",
                  borderRadius: 8,
                  boxShadow: `var(--sc-${k})`,
                  marginBottom: 8,
                }}
              />
              <div style={{ fontSize: 11, fontFamily: "var(--sc-font-mono)", color: "var(--sc-text-3)" }}>{k}</div>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}

function H2({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 600,
        color: "var(--sc-text-3)",
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        marginBottom: 10,
        marginTop: 32,
      }}
    >
      {children}
    </div>
  );
}
