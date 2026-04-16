import brandMarkSrc from "@/assets/branding/ribbon-s-mark.png";
import { cn } from "@/lib/utils";

interface BrandMarkProps {
  className?: string;
  size?: number;
}

export function BrandMark({ className, size = 40 }: BrandMarkProps) {
  return (
    <img
      src={brandMarkSrc}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      className={cn("shrink-0 select-none", className)}
    />
  );
}

interface BrandWordmarkProps {
  className?: string;
  muted?: boolean;
}

export function BrandWordmark({
  className,
  muted = false,
}: BrandWordmarkProps) {
  return (
    <span
      className={cn(
        "font-semibold tracking-[-0.04em]",
        muted ? "text-[var(--color-fg-secondary)]" : "text-white",
        className,
      )}
    >
      storycapture
    </span>
  );
}

interface BrandLockupProps {
  className?: string;
  markClassName?: string;
  wordmarkClassName?: string;
  size?: number;
  muted?: boolean;
}

export function BrandLockup({
  className,
  markClassName,
  wordmarkClassName,
  size = 40,
  muted = false,
}: BrandLockupProps) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <BrandMark size={size} className={markClassName} />
      <BrandWordmark muted={muted} className={wordmarkClassName} />
    </div>
  );
}
