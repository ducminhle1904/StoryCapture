/**
 * Chat bubble component.
 *
 * Card with role-based border tint per UI-SPEC:
 * - user: blue-ish subtle border
 * - assistant: neutral border
 * Body text 14px Regular per Typography contract.
 */

import * as React from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import { StreamingDot } from "./StreamingDot";

export interface ChatBubbleProps {
  role: "user" | "assistant";
  text: string;
  isStreaming?: boolean;
  className?: string;
}

export function ChatBubble({
  role,
  text,
  isStreaming = false,
  className,
}: ChatBubbleProps) {
  const reducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

  const Wrapper = reducedMotion ? "div" : motion.div;
  const animationProps = reducedMotion
    ? {}
    : {
        initial: { opacity: 0, y: 8 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.18, ease: "easeOut" },
      };

  return (
    <Wrapper
      {...animationProps}
      className={cn(
        "rounded-lg border p-2 text-sm leading-relaxed",
        "bg-[var(--color-card,#13151C)]",
        role === "user"
          ? "border-blue-800/40 ml-6"
          : "border-[var(--color-border,#242733)] mr-6",
        className,
      )}
      data-testid={`chat-bubble-${role}`}
    >
      <div className="mb-1 text-xs font-semibold text-[var(--color-muted-foreground,#8A90A2)]">
        {role === "user" ? "You" : "StoryCapture AI"}
      </div>
      <div className="whitespace-pre-wrap text-[var(--color-foreground,#E6E8EE)]">
        {text}
        {isStreaming && (
          <span className="ml-1 inline-flex items-center align-middle">
            <StreamingDot />
          </span>
        )}
      </div>
    </Wrapper>
  );
}
