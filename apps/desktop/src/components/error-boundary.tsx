import { Button as AstryxButton } from "@astryxdesign/core/Button";
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
          color: "var(--color-text-primary)",
          background: "var(--color-background-card)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-element)",
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Something broke in the UI</div>
        <div style={{ color: "var(--color-text-secondary)", marginBottom: 12 }}>
          The error has been written to the log file. You can keep using the app or reload the
          window.
        </div>
        <code
          style={{
            display: "block",
            marginBottom: 12,
            fontSize: 11,
            color: "var(--color-text-disabled)",
          }}
        >
          {this.state.error.message}
        </code>
        <AstryxButton label="Try again" variant="primary" size="sm" onClick={this.reset}>
          Try again
        </AstryxButton>
      </section>
    );
  }
}
