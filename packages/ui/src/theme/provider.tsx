"use client";

import { LayerProvider } from "@astryxdesign/core/Layer";
import { Theme } from "@astryxdesign/core/theme";
import type { ReactNode } from "react";

import { storycaptureGothicTheme } from "./generated/storycapture-gothic.js";

export interface StoryCaptureThemeProviderProps {
  children: ReactNode;
}

export function StoryCaptureThemeProvider({ children }: StoryCaptureThemeProviderProps) {
  return (
    <Theme theme={storycaptureGothicTheme} mode="dark">
      <LayerProvider toast={{ position: "bottomStart", maxVisible: 5 }}>{children}</LayerProvider>
    </Theme>
  );
}
