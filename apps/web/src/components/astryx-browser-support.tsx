"use client";

import { useEffect } from "react";

export function AstryxBrowserSupport() {
  useEffect(() => {
    let active = true;
    const forceFallback = process.env.NEXT_PUBLIC_UI_FORCE_ANCHOR_FALLBACK === "1";
    const hasAnchorPositioning =
      typeof CSS !== "undefined" && CSS.supports("anchor-name", "--storycapture-anchor");

    async function installAnchorPositioningSupport() {
      if (forceFallback || !hasAnchorPositioning) {
        await import("@oddbird/css-anchor-positioning");
        if (active) document.documentElement.dataset.astryxAnchorPositioning = "polyfill";
        return;
      }

      document.documentElement.dataset.astryxAnchorPositioning = "native";
    }

    void installAnchorPositioningSupport();

    return () => {
      active = false;
    };
  }, []);

  return null;
}
