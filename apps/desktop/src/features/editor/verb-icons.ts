import {
  ArrowRight,
  Camera,
  CheckCheck,
  Clock,
  Hourglass,
  Keyboard,
  ListChecks,
  type LucideIcon,
  MousePointerClick,
  Move,
  MoveVertical,
  Pause,
  Pointer,
  Upload,
  Zap,
} from "lucide-react";

import type { Command } from "@/ipc/parse";

export function verbIcon(verb: Command["verb"] | string | null | undefined): LucideIcon {
  switch (verb) {
    case "navigate":
      return ArrowRight;
    case "wait-for":
      return Hourglass;
    case "wait":
      return Clock;
    case "click":
      return MousePointerClick;
    case "type":
      return Keyboard;
    case "hover":
      return Pointer;
    case "scroll":
      return MoveVertical;
    case "select":
      return ListChecks;
    case "assert":
      return CheckCheck;
    case "screenshot":
      return Camera;
    case "drag":
      return Move;
    case "upload":
      return Upload;
    case "pause":
      return Pause;
  }
  return Zap;
}
