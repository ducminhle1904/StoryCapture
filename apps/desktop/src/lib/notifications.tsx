import { Button } from "@astryxdesign/core/Button";
import { Text } from "@astryxdesign/core/Text";
import {
  type ShowToastFn,
  type ToastDismissFn,
  type ToastOptions,
  useToast,
} from "@astryxdesign/core/Toast";
import {
  CircleCheck,
  CircleX,
  Info,
  type LucideIcon,
  MessageSquare,
  TriangleAlert,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect } from "react";

export interface NotificationAction {
  label: string;
  onClick: () => void;
}

export interface NotificationOptions {
  description?: ReactNode;
  duration?: number;
  id?: string;
  action?: NotificationAction;
  cancel?: NotificationAction;
}

type NotificationLevel = "info" | "success" | "warning" | "error" | "message";

const LEVEL_PRESENTATION: Record<
  NotificationLevel,
  { label: string; color: string; icon: LucideIcon }
> = {
  info: { label: "Info", color: "var(--color-accent)", icon: Info },
  success: { label: "Success", color: "var(--color-success)", icon: CircleCheck },
  warning: { label: "Warning", color: "var(--color-warning)", icon: TriangleAlert },
  error: { label: "Error", color: "var(--color-error)", icon: CircleX },
  message: { label: "Message", color: "var(--color-accent)", icon: MessageSquare },
};

interface QueuedNotification {
  level: NotificationLevel;
  title: ReactNode;
  options?: NotificationOptions;
}

let presenter: ShowToastFn | null = null;
const pending: QueuedNotification[] = [];

function runAndDismiss(action: NotificationAction, dismiss: ToastDismissFn) {
  return () => {
    try {
      action.onClick();
    } finally {
      dismiss();
    }
  };
}

function toToastOptions(
  { level, title, options }: QueuedNotification,
  dismiss: ToastDismissFn,
): ToastOptions {
  const presentation = LEVEL_PRESENTATION[level];
  const LevelIcon = presentation.icon;
  const endContent =
    options?.action || options?.cancel ? (
      <div className="flex items-center gap-1">
        {options.cancel ? (
          <Button
            label={options.cancel.label}
            size="sm"
            variant="ghost"
            onClick={runAndDismiss(options.cancel, dismiss)}
          />
        ) : null}
        {options.action ? (
          <Button
            label={options.action.label}
            size="sm"
            variant="secondary"
            onClick={runAndDismiss(options.action, dismiss)}
          />
        ) : null}
      </div>
    ) : undefined;

  return {
    type: level === "error" ? "error" : "info",
    body: (
      <div className="flex min-w-0 items-start gap-2">
        <LevelIcon
          size={16}
          aria-hidden="true"
          className="mt-0.5 shrink-0"
          style={{ color: presentation.color }}
        />
        <div className="flex min-w-0 flex-col gap-0.5">
          <Text type="label" display="block">
            <span className="sr-only">{presentation.label}: </span>
            {title}
          </Text>
          {options?.description ? (
            <Text type="supporting" display="block">
              {options.description}
            </Text>
          ) : null}
        </div>
      </div>
    ),
    endContent,
    uniqueID: options?.id,
    isAutoHide: options?.duration !== Number.POSITIVE_INFINITY,
    autoHideDuration: options?.duration ?? (level === "error" ? 8_000 : 5_000),
  };
}

function present(showToast: ShowToastFn, notification: QueuedNotification) {
  let dismiss: ToastDismissFn = () => {};
  dismiss = showToast(toToastOptions(notification, () => dismiss()));
}

function show(level: NotificationLevel, title: ReactNode, options?: NotificationOptions) {
  const notification = { level, title, options } satisfies QueuedNotification;
  if (!presenter) {
    pending.push(notification);
    return;
  }
  present(presenter, notification);
}

export const notifications = {
  info: (title: ReactNode, options?: NotificationOptions) => show("info", title, options),
  success: (title: ReactNode, options?: NotificationOptions) => show("success", title, options),
  warning: (title: ReactNode, options?: NotificationOptions) => show("warning", title, options),
  error: (title: ReactNode, options?: NotificationOptions) => show("error", title, options),
  message: (title: ReactNode, options?: NotificationOptions) => show("message", title, options),
};

export function NotificationPresenter() {
  const showToast = useToast();

  useEffect(() => {
    presenter = showToast;
    for (const notification of pending.splice(0)) {
      present(showToast, notification);
    }
    return () => {
      if (presenter === showToast) presenter = null;
    };
  }, [showToast]);

  return null;
}
