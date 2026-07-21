import brandMarkSrc from "@/assets/branding/ribbon-s-mark-product.png";
import { cn } from "@/lib/utils";

interface BrandMarkProps {
  className?: string;
  size?: number;
}

export function BrandMark({ className, size = 40 }: BrandMarkProps) {
  const innerSize = Math.max(size - 8, 16);

  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-[10px] border border-[var(--color-border)] bg-[var(--color-background-card)] p-[3px] shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_1px_2px_rgba(0,0,0,0.35)]",
        className,
      )}
      style={{ height: size, width: size }}
    >
      <img
        src={brandMarkSrc}
        alt=""
        width={innerSize}
        height={innerSize}
        className="select-none rounded-[6px]"
      />
    </span>
  );
}

interface BrandWordmarkProps {
  className?: string;
  muted?: boolean;
}

export function BrandWordmark({ className, muted = false }: BrandWordmarkProps) {
  return (
    <span
      className={cn(
        "font-semibold tracking-[-0.02em]",
        muted ? "text-[var(--color-text-secondary)]" : "text-[var(--color-text-primary)]",
        className,
      )}
      style={{ fontFamily: "'Outfit Variable', 'Outfit', sans-serif" }}
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
