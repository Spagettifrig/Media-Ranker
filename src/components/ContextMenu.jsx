import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const EDGE_GAP_PX = 8;

/**
 * A right-click menu anchored to the cursor. Rendered in a portal so no card
 * transform or `overflow: hidden` can clip it, and clamped to the window so it
 * is always fully visible.
 *
 * `items`: [{ key, label, danger?, onSelect }]
 */
export default function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Measure once mounted, then nudge back inside the viewport if needed.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const left = Math.max(EDGE_GAP_PX, Math.min(x, window.innerWidth - width - EDGE_GAP_PX));
    const top = Math.max(EDGE_GAP_PX, Math.min(y, window.innerHeight - height - EDGE_GAP_PX));
    setPos({ left, top });
    el.focus({ preventScroll: true });
  }, [x, y]);

  // Anything that isn't a click on the menu itself dismisses it.
  useEffect(() => {
    function onPointerDown(event) {
      if (!ref.current?.contains(event.target)) onClose();
    }
    function onKeyDown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    }
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    document.addEventListener('scroll', onClose, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
      document.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className="ctx"
      role="menu"
      tabIndex={-1}
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          className={`ctx__item${item.danger ? ' ctx__item--danger' : ''}`}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
