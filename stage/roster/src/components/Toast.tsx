export type ToastAction = { label: string; fn: () => any };
export type ToastState = { text: string; undo: (() => any) | null; action: ToastAction | null; shown: boolean };

export default function Toast({ t, onUndo, onAction }: { t: ToastState; onUndo: () => void; onAction: () => void }) {
  return (
    <div className="toast" id="toast" hidden={!t.shown} role="status" aria-live="polite">
      <span id="toast-t">{t.text}</span>
      {t.undo ? (
        <button id="toast-undo" onClick={onUndo}>
          Undo
        </button>
      ) : null}
      {t.action ? (
        <button id="toast-action" onClick={onAction}>
          {t.action.label}
        </button>
      ) : null}
    </div>
  );
}
