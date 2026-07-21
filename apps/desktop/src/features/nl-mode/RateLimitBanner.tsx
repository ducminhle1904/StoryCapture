/**
 * Rate-limit banner with retry countdown.
 */

import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { useEffect, useState } from "react";

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
    <Banner
      status="warning"
      title={message || "Provider đang giới hạn tốc độ."}
      description={`Thử lại sau ${countdown}s hoặc chuyển sang fallback provider.`}
      data-testid="rate-limit-banner"
      endContent={
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={onRetry}
            isDisabled={countdown > 0}
            label="Đợi và thử lại"
          />
          <Button
            size="sm"
            variant="ghost"
            onClick={onSwitchProvider}
            label={`Dùng ${fallbackProvider}`}
          />
        </div>
      }
    />
  );
}
