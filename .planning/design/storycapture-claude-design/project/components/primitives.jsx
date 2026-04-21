/* global React, I */
const useState = React.useState;
const useEffect = React.useEffect;
const useRef = React.useRef;
const useCallback = React.useCallback;
const useMemo = React.useMemo;

// ─── Buttons / Chips ─────────────────────────────────────
function Btn({ children, variant = "default", size = "md", icon, iconRight, onClick, className = "", style = {}, title, kbd, disabled }) {
  const v = { default: "", primary: "primary", ghost: "ghost", danger: "danger", success: "success" }[variant] || "";
  const s = { sm: "sm", md: "", lg: "lg", icon: "icon" }[size] || "";
  return (
    <button className={`sc-btn ${v} ${s} ${className}`} onClick={onClick} title={title} disabled={disabled}
      style={{ opacity: disabled ? 0.5 : 1, ...style }}>
      {icon}
      {size !== "icon" && children}
      {iconRight}
      {kbd && <span className="sc-kbd" style={{ marginLeft: 4 }}>{kbd}</span>}
    </button>
  );
}

// ─── Badge ───────────────────────────────────────────────
function Badge({ children, variant = "", dot = false, icon }) {
  return (
    <span className={`sc-badge ${variant}`}>
      {dot && <span className="dot" />}
      {icon}
      {children}
    </span>
  );
}

// ─── Input ───────────────────────────────────────────────
function Input({ icon, kbd, style = {}, wrapStyle = {}, ...rest }) {
  return (
    <div className="sc-input-wrap" style={wrapStyle}>
      {icon && <span className="icon">{icon}</span>}
      <input className="sc-input" style={style} {...rest} />
      {kbd && <span className="sc-kbd" style={{ position: "absolute", right: 8 }}>{kbd}</span>}
    </div>
  );
}

// ─── Select ──────────────────────────────────────────────
function Select({ value, options, onChange, style = {} }) {
  const cur = options.find(o => o.value === value) || options[0];
  return (
    <div className="sc-select" style={style} onClick={() => {
      const i = options.findIndex(o => o.value === value);
      onChange && onChange(options[(i + 1) % options.length].value);
    }}>
      <span>{cur?.label}</span>
      <I.ChevronDown size={12} />
    </div>
  );
}

// ─── Slider ──────────────────────────────────────────────
function Slider({ value, min = 0, max = 100, step = 1, onChange, accent = true }) {
  const ref = useRef(null);
  const pct = ((value - min) / (max - min)) * 100;
  const handle = useCallback((e) => {
    const rect = ref.current.getBoundingClientRect();
    const px = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    let v = min + px * (max - min);
    v = Math.round(v / step) * step;
    onChange && onChange(v);
  }, [min, max, step, onChange]);
  const onDown = (e) => {
    handle(e);
    const mv = (ev) => handle(ev);
    const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
  };
  return (
    <div className="sc-slider" ref={ref} onMouseDown={onDown}>
      <div className="sc-slider-track">
        <div className="sc-slider-fill" style={{ width: pct + '%', background: accent ? undefined : 'var(--sc-text-3)' }} />
      </div>
      <div className="sc-slider-thumb" style={{ left: pct + '%' }} />
    </div>
  );
}

// ─── Switch ──────────────────────────────────────────────
function Switch({ checked, onChange }) {
  return <div className={`sc-switch ${checked ? 'on' : ''}`} onClick={() => onChange && onChange(!checked)} role="switch" aria-checked={checked} tabIndex={0} />;
}

// ─── Row (labeled field) ─────────────────────────────────
function Row({ label, children, hint }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 12, alignItems: "center", padding: "8px 0" }}>
      <div>
        <div style={{ fontSize: 12.5, color: "var(--sc-text-2)", fontWeight: 500 }}>{label}</div>
        {hint && <div style={{ fontSize: 11, color: "var(--sc-text-4)", marginTop: 2 }}>{hint}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

// ─── Tooltip wrapper (title-attr for simplicity) ─────────
const Tip = ({ tip, children }) => React.cloneElement(children, { title: tip });

// ─── Segmented control ──────────────────────────────────
function Segmented({ value, options, onChange, size = "md" }) {
  const h = size === "sm" ? 24 : 28;
  return (
    <div style={{
      display: "inline-flex",
      background: "var(--sc-surface-2)",
      border: "1px solid var(--sc-border)",
      borderRadius: "var(--sc-r-md)",
      padding: 2,
      height: h,
    }}>
      {options.map(o => {
        const active = o.value === value;
        return (
          <button key={o.value} onClick={() => onChange && onChange(o.value)}
            style={{
              height: h - 4, padding: "0 10px",
              display: "inline-flex", alignItems: "center", gap: 5,
              background: active ? "var(--sc-surface-4)" : "transparent",
              color: active ? "var(--sc-text)" : "var(--sc-text-3)",
              border: "none",
              borderRadius: "calc(var(--sc-r-md) - 1px)",
              boxShadow: active ? "0 1px 2px rgba(0,0,0,0.3), 0 1px 0 rgba(255,255,255,0.06) inset" : "none",
              fontSize: 12, fontFamily: "inherit", fontWeight: 500,
              cursor: "default",
            }}>
            {o.icon}{o.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Image placeholder (striped) ─────────────────────────
function Ph({ label = "", w = "100%", h = 120, radius = 6, style = {}, accent = false, children }) {
  return (
    <div style={{
      width: w, height: h, borderRadius: radius,
      background: accent
        ? `repeating-linear-gradient(135deg, oklch(0.35 0.08 var(--sc-accent-h)) 0 8px, oklch(0.30 0.07 var(--sc-accent-h)) 8px 16px)`
        : `repeating-linear-gradient(135deg, var(--sc-surface-2) 0 8px, var(--sc-surface-3) 8px 16px)`,
      border: "1px solid var(--sc-border)",
      display: "grid", placeItems: "center",
      position: "relative", overflow: "hidden",
      ...style,
    }}>
      {label && <div style={{ fontFamily: "var(--sc-font-mono)", fontSize: 10, color: "var(--sc-text-4)",
        background: "var(--sc-surface)", padding: "2px 6px", borderRadius: 3, border: "1px solid var(--sc-border)" }}>{label}</div>}
      {children}
    </div>
  );
}

Object.assign(window, { Btn, Badge, Input, Select, Slider, Switch, Row, Tip, Segmented, Ph });
