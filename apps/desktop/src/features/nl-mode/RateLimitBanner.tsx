/**
 * Rate-limit banner with retry countdown.
 *
 * UI-SPEC copy: "{provider} dang gioi han toc do. Thu lai sau {N}s
 * hoac chuyen sang fallback provider."
 * CTA: "Doi va thu lai" + secondary "Dung {fallback}".
 * Warning color per UI-SPEC Color table.
 */

import * as React from "react";
import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";

export interface RateLimitBannerProps {
  message: string;
  retryAfterS?: number;
  onRetry?: () => void;
  onSwitchProvider?: () => void;
  fallbackProvider?: string;
}

export function RateLimitBanner({
  message,
  retryAfterS = 30,
  onRetry,
  onSwitchProvider,
  fallbackProvider = "OpenAI",
}: RateLimitBannerProps) {
  const [countdown, setCountdown] = useState(retryAfterS);

  useEffect(() => {
    setCountdown(retryAfterS);
    if (retryAfterS <= 0) return;

    const interval = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [retryAfterS]);

  return (
    <div
      role="alert"
      className="rounded-md border border-[var(--color-warning,#E5A000)]/30 bg-[var(--color-warning,#E5A000)]/10 p-3 text-sm"
      data-testid="rate-limit-banner"
    >
      <p className="text-[var(--color-foreground,#E6E8EE)]">
        {message || "Provider \u0111ang gi\u1edbi h\u1ea1n t\u1ed1c \u0111\u1ed9."}{" "}
        {"Th\u1eed l\u1ea1i sau "}{countdown}{"s ho\u1eb7c chuy\u1ec3n sang fallback provider."}
      </p>
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={onRetry}
          disabled={countdown > 0}
        >
          {"\u0110\u1ee3i v\u00e0 th\u1eed l\u1ea1i"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onSwitchProvider}>
          {"D\u00f9ng "}{fallbackProvider}
        </Button>
      </div>
    </div>
  );
}
