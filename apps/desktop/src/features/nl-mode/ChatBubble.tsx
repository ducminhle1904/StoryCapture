/**
 * Chat bubble component.
 *
 * Role-based border tint: user=blue-ish, assistant=neutral.
 */

import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import { StreamingDot } from "./StreamingDot";

export interface ChatBubbleProps {
  speaker: "user" | "assistant";
  text: string;
  isStreaming?: boolean;
  className?: string;
}

export function ChatBubble({ speaker, text, isStreaming = false, className }: ChatBubbleProps) {
  const reducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

  const sharedClassName = cn(
    "rounded-lg border p-2 text-sm leading-relaxed",
    "bg-[var(--color-card,#13151C)]",
    speaker === "user" ? "border-blue-800/40 ml-6" : "border-[var(--color-border,#242733)] mr-6",
    className,
  );

  const children = (
    <>
      <div className="mb-1 text-xs font-semibold text-[var(--color-muted-foreground,#8A90A2)]">
        {speaker === "user" ? "You" : "StoryCapture AI"}
      </div>
      <div className="whitespace-pre-wrap text-[var(--color-foreground,#E6E8EE)]">
        {text}
        {isStreaming && (
          <span className="ml-1 inline-flex items-center align-middle">
            <StreamingDot />
          </span>
        )}
      </div>
    </>
  );

  if (reducedMotion) {
    return (
      <div className={sharedClassName} data-testid={`chat-bubble-${speaker}`}>
        {children}
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className={sharedClassName}
      data-testid={`chat-bubble-${speaker}`}
    >
      {children}
    </motion.div>
  );
}
