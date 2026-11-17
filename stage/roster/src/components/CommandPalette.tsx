import { useEffect, useMemo, useRef, useState } from "react";
import Icon from "./Icon";

export type Command = {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon?: string;
  keys?: string[];
  keywords?: string;
  run: () => void;
};

/** Words of the query must all appear, in any order; label-start matches rank first. */
function rank(c: Command, words: string[]): number {
  const hay = (c.label + " " + (c.hint || "") + " " + (c.keywords || "")).toLowerCase();
  if (!words.every((w) => hay.includes(w))) return -1;
  const l = c.label.toLowerCase();
  return l.startsWith(words[0]) ? 0 : l.includes(words[0]) ? 1 : 2;
}

/** ⌘K launcher: jump to a view, open an account, or run an action. A modal combobox with a listbox of results. */
export default function CommandPalette({ open, onClose, commands }: { open: boolean; onClose: () => void; commands: Command[] }) {
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      back.current = document.activeElement as HTMLElement | null;
      setQ("");
      setI(0);
      requestAnimationFrame(() => input.current?.focus());
    } else back.current?.focus?.();
  }, [open]);

  const results = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return commands.filter((c) => c.group !== "Accounts").concat(commands.filter((c) => c.group === "Accounts").slice(0, 6));
    const hits = commands.map((c, n) => ({ c, n, r: rank(c, words) })).filter((x) => x.r >= 0);
    // Keep each group together; the group with the best match comes first.
    const best = new Map<string, number>();
    hits.forEach((x) => best.set(x.c.group, Math.min(best.get(x.c.group) ?? 9, x.r)));
    return hits
      .sort((a, b) => best.get(a.c.group)! - best.get(b.c.group)! || (a.c.group < b.c.group ? -1 : a.c.group > b.c.group ? 1 : 0) || a.r - b.r || a.n - b.n)
      .slice(0, 40)
      .map((x) => x.c);
  }, [q, commands]);

  useEffect(() => {
    if (i >= results.length) setI(Math.max(0, results.length - 1));
  }, [results.length]);
  useEffect(() => {
    list.current?.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
  }, [i]);

  if (!open) return null;
  const run = (c?: Command) => {
    if (!c) return;
    onClose();
    setTimeout(c.run, 0);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setI((x) => (x + 1) % Math.max(1, results.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setI((x) => (x - 1 + results.length) % Math.max(1, results.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(results[i]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Tab") e.preventDefault();
  };

  let lastGroup = "";
  return (
    <div className="cmdk-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Command menu" onKeyDown={onKey}>
        <div className="cmdk-input">
          <Icon name="search" size={18} />
          <input
            ref={input}
            role="combobox"
            aria-expanded="true"
            aria-controls="cmdk-list"
            aria-activedescendant={results[i] ? "cmdk-" + results[i].id : undefined}
            aria-autocomplete="list"
            placeholder="Jump to a view, open an account, or run an action…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setI(0);
            }}
          />
          <kbd>esc</kbd>
        </div>
        <div className="cmdk-list" id="cmdk-list" role="listbox" aria-label="Results" ref={list}>
          {!results.length ? <p className="cmdk-empty">Nothing matches “{q}”.</p> : null}
          {results.map((c, n) => {
            const head = c.group !== lastGroup ? c.group : "";
            lastGroup = c.group;
            return (
              <div key={c.id} role="presentation">
                {head ? <div className="cmdk-group" role="presentation">{head}</div> : null}
                <div
                  id={"cmdk-" + c.id}
                  data-i={n}
                  role="option"
                  aria-selected={n === i}
                  className="cmdk-item"
                  onMouseMove={() => n !== i && setI(n)}
                  onClick={() => run(c)}
                >
                  <span className="cmdk-ic">
                    <Icon name={c.icon || "arrow"} size={16} />
                  </span>
                  <span className="cmdk-label">{c.label}</span>
                  {c.hint ? <span className="cmdk-hint">{c.hint}</span> : null}
                  {c.keys ? (
                    <span className="cmdk-keys">
                      {c.keys.map((k) => (
                        <kbd key={k}>{k}</kbd>
                      ))}
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
        <div className="cmdk-foot" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>?</kbd> all shortcuts</span>
        </div>
      </div>
    </div>
  );
}
