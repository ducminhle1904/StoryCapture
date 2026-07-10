import { Component, type ErrorInfo, type ReactNode } from "react";

import { frontendLog } from "@/lib/log";

interface Props {
  /** Optional label for the boundary so logs can be traced to a region. */
  source?: string;
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode);
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * React error boundary that funnels render-time crashes into the canonical
 * tracing log via `frontendLog.error`. Async errors are caught separately
 * by `installGlobalErrorHandlers()` in `lib/log.ts`.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    const fields: Record<string, unknown> = {};
    if (info.componentStack) fields.component_stack = info.componentStack;
    frontendLog.error(this.props.source ?? "ErrorBoundary", "react render crashed", {
      error,
      fields,
    });
  }

  reset = () => this.setState({ error: null });

  override render() {
    if (!this.state.error) return this.props.children;
    const { fallback } = this.props;
    if (typeof fallback === "function") return fallback(this.state.error, this.reset);
    if (fallback !== undefined) return fallback;
    return (
      <section
        role="alert"
        style={{
          padding: 24,
          margin: 24,
          fontSize: 13,
          color: "var(--sc-text)",
          background: "var(--sc-surface-2)",
          border: "1px solid var(--sc-border)",
          borderRadius: "var(--sc-r-md)",
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Something broke in the UI</div>
        <div style={{ color: "var(--sc-text-3)", marginBottom: 12 }}>
          The error has been written to the log file. You can keep using the app or reload the
          window.
        </div>
        <code
          style={{
            display: "block",
            marginBottom: 12,
            fontSize: 11,
            color: "var(--sc-text-4)",
          }}
        >
          {this.state.error.message}
        </code>
        <button type="button" onClick={this.reset} className="sc-btn primary sm">
          Try again
        </button>
      </section>
    );
  }
}
