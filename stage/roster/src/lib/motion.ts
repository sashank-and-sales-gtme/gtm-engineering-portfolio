import { flushSync } from "react-dom";

/**
 * Runs a UI change inside a view transition where the browser supports it, so views and layouts cross-fade and
 * slide instead of jumping. Falls back to an instant change, and always does when the person prefers less motion.
 */
export function smooth(change: () => void) {
  const d = document as any;
  if (!d.startViewTransition || document.hidden || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return change();
  try {
    const t = d.startViewTransition(() => flushSync(change));
    // A transition interrupted by the next one rejects these promises; the change itself has still happened.
    for (const p of [t.ready, t.finished, t.updateCallbackDone]) p?.catch?.(() => {});
  } catch (_) {
    change();
  }
}
