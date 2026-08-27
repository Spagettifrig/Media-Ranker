import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

/**
 * A small in-app replacement for window.confirm(), styled like the rest of the
 * app's sheets. Rendered in a portal over a scrim; Esc or a click on the scrim
 * cancels. For destructive prompts focus lands on Cancel, so a stray Enter
 * can't delete anything.
 *
 * Props: title, message, confirmLabel, cancelLabel, danger, onConfirm, onCancel.
 */
export default function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  danger = true,
  onConfirm,
  onCancel,
}) {
  const confirmRef = useRef(null);
  const cancelRef = useRef(null);

  useEffect(() => {
    (danger ? cancelRef : confirmRef).current?.focus({ preventScroll: true });
  }, [danger]);

  // Swallow Escape before the board's own key handling sees it.
  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onCancel]);

  return createPortal(
    <div
      className="overlay"
      onPointerDown={(event) => event.target === event.currentTarget && onCancel()}
    >
      <div
        className="sheet sheet--confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
        tabIndex={-1}
      >
        <div className="confirm">
          <h2 className="confirm__title" id="confirm-title">{title}</h2>
          <p className="confirm__message" id="confirm-message">{message}</p>
          <div className="confirm__actions">
            <button ref={cancelRef} type="button" className="btn btn--ghost" onClick={onCancel}>
              {cancelLabel}
            </button>
            <button
              ref={confirmRef}
              type="button"
              className={danger ? 'btn btn--danger' : 'btn btn--primary'}
              onClick={onConfirm}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
