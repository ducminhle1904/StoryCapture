import { useEffect, useRef } from "react";

// Force the browser-side `setTimeout` numeric handle (Node's `setTimeout` from
// @types/node returns a `Timeout` object that conflicts with `clearTimeout`'s
// browser overload).
type Timer = number;

/**
 * Stable debounced callback. When `key` is omitted, behaves as a single-key
 * debouncer (one pending timer). When `key` is supplied, maintains a per-key
 * timer map so independent keys don't cancel each other — useful for
 * per-line / per-id validators.
 *
 * The returned function is stable across renders. Pending timers are
 * cancelled on unmount.
 */
export function useDebouncedCallback<TArgs extends unknown[]>(
  fn: (...args: TArgs) => void,
  delayMs: number,
): {
  run: (...args: TArgs) => void;
  runKeyed: (key: string | number, ...args: TArgs) => void;
  cancel: (key?: string | number) => void;
} {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const single = useRef<Timer | null>(null);
  const keyed = useRef<Map<string | number, Timer>>(new Map());

  useEffect(
    () => () => {
      if (single.current != null) window.clearTimeout(single.current);
      for (const t of keyed.current.values()) window.clearTimeout(t);
      keyed.current.clear();
    },
    [],
  );

  return {
    run: (...args: TArgs) => {
      if (single.current != null) window.clearTimeout(single.current);
      single.current = window.setTimeout(() => {
        single.current = null;
        fnRef.current(...args);
      }, delayMs);
    },
    runKeyed: (key, ...args) => {
      const prev = keyed.current.get(key);
      if (prev != null) window.clearTimeout(prev);
      const handle = window.setTimeout(() => {
        keyed.current.delete(key);
        fnRef.current(...args);
      }, delayMs);
      keyed.current.set(key, handle);
    },
    cancel: (key) => {
      if (key === undefined) {
        if (single.current != null) {
          window.clearTimeout(single.current);
          single.current = null;
        }
        for (const t of keyed.current.values()) window.clearTimeout(t);
        keyed.current.clear();
        return;
      }
      const t = keyed.current.get(key);
      if (t != null) {
        window.clearTimeout(t);
        keyed.current.delete(key);
      }
    },
  };
}
