import { defineTheme } from "@astryxdesign/core/theme";
import { gothicTheme } from "@astryxdesign/theme-gothic";

/**
 * StoryCapture's dark-only application theme.
 *
 * The Gothic palette, icon registry, display treatments, and component
 * overrides remain inherited. The typography scale is tightened for dense
 * authoring, recording, and post-production workspaces.
 */
export const storyCaptureGothicTheme = defineTheme({
  name: "storycapture-gothic",
  extends: gothicTheme,
  typography: {
    scale: { base: 14, ratio: 1.2 },
    body: {
      family: "Fustat",
      fallbacks:
        '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    },
    heading: {
      family: "Fustat",
      fallbacks:
        '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      weights: { 3: "bold", 4: "bold" },
    },
    code: {
      family: "JetBrains Mono",
      fallbacks: '"SF Mono", Monaco, Consolas, monospace',
    },
  },
  tokens: {
    "--text-body-size": "0.875rem",
    "--text-label-size": "0.875rem",
    "--text-code-size": "0.8125rem",
    "--text-supporting-size": "0.75rem",
  },
});
