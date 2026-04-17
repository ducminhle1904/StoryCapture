export const modalBackdropTransition = {
  duration: 0.18,
  ease: "easeOut",
} as const;

export const modalPanelInitial = {
  opacity: 0,
  y: 16,
  scale: 0.985,
} as const;

export const modalPanelAnimate = {
  opacity: 1,
  y: 0,
  scale: 1,
} as const;

export const modalPanelExit = {
  opacity: 0,
  y: 12,
  scale: 0.985,
} as const;

export const modalPanelTransition = {
  duration: 0.22,
  ease: [0.22, 1, 0.36, 1],
} as const;

/**
 * Base UI sets `data-[starting-style]` while the element is mounting and
 * `data-[ending-style]` while it is unmounting. Tailwind's arbitrary
 * variants let us drive CSS transitions off those states — giving smooth
 * enter/exit without pulling in motion primitives per Dialog.
 */

export const dialogBackdropMotionClassName =
  "transition-[opacity,backdrop-filter] duration-200 ease-out " +
  "data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 " +
  "data-[starting-style]:backdrop-blur-none data-[ending-style]:backdrop-blur-none";

export const dialogViewportClassName =
  "fixed inset-0 z-50 flex items-center justify-center p-4";

export const dialogSideSheetViewportClassName =
  "fixed inset-0 z-50 flex items-stretch justify-end p-3 pl-10";

// Centered modal: fade + subtle lift + scale for the "material appears"
// feel. Ease-out on enter, faster ease-in on exit.
export const dialogCenteredPopupMotionClassName =
  "origin-center " +
  "transition-[opacity,transform] duration-[220ms] ease-[cubic-bezier(0.22,1,0.36,1)] " +
  "data-[starting-style]:opacity-0 data-[starting-style]:translate-y-2 data-[starting-style]:scale-[0.985] " +
  "data-[ending-style]:opacity-0 data-[ending-style]:translate-y-1 data-[ending-style]:scale-[0.985] " +
  "data-[ending-style]:duration-150";

// Side sheet: slide in from the right edge.
export const dialogSideSheetPopupMotionClassName =
  "origin-right " +
  "transition-[opacity,transform] duration-[250ms] ease-[cubic-bezier(0.22,1,0.36,1)] " +
  "data-[starting-style]:opacity-0 data-[starting-style]:translate-x-4 " +
  "data-[ending-style]:opacity-0 data-[ending-style]:translate-x-2 " +
  "data-[ending-style]:duration-[180ms]";

// Compatibility alias for stale HMR/module graphs that still import the old name.
export const dialogPopupMotionClassName = dialogCenteredPopupMotionClassName;
