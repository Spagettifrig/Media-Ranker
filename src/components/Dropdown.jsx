import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const EDGE_GAP_PX = 8;
const MENU_GAP_PX = 6;

/**
 * A single-select dropdown that looks and behaves like the rest of the app,
 * not like the browser's own `<select>` popup - which on Windows ignores
 * almost every style rule thrown at it (no radius, no theme colours, no
 * matching spacing). The trigger keeps the existing `.select` pill; only the
 * popup list is custom, built the same way as `ContextMenu` - portaled to
 * `document.body` so nothing can clip it, and clamped to the viewport.
 *
 * `options`: [{ value, label, disabled? }]
 */
export default function Dropdown({ label, value, options, onChange, ariaLabel, wide = false }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);

  const selected = options.find((option) => option.value === value) ?? options[0];
  const selectableIndexes = options.reduce((acc, option, index) => {
    if (!option.disabled) acc.push(index);
    return acc;
  }, []);

  const close = useCallback(() => setOpen(false), []);

  function openMenu(initialIndex) {
    const fallback = options.findIndex((option) => option.value === selected?.value);
    setActiveIndex(initialIndex ?? (fallback >= 0 ? fallback : (selectableIndexes[0] ?? -1)));
    setOpen(true);
  }

  // Measured after the menu mounts, then nudged back inside the window - the
  // same two-pass approach ContextMenu uses, since the menu's own size isn't
  // known until it has rendered once.
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;

    const anchor = trigger.getBoundingClientRect();
    const { width, height } = menu.getBoundingClientRect();

    let left = anchor.left;
    left = Math.max(EDGE_GAP_PX, Math.min(left, window.innerWidth - width - EDGE_GAP_PX));

    const spaceBelow = window.innerHeight - anchor.bottom - MENU_GAP_PX;
    const openUpward = spaceBelow < height && anchor.top > spaceBelow;
    const top = openUpward
      ? Math.max(EDGE_GAP_PX, anchor.top - MENU_GAP_PX - height)
      : anchor.bottom + MENU_GAP_PX;

    setPos({ left, top, minWidth: anchor.width, maxHeight: Math.max(160, window.innerHeight - top - EDGE_GAP_PX) });
  }, [open]);

  // Dismiss on anything outside, same triggers ContextMenu already uses.
  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event) {
      if (menuRef.current?.contains(event.target) || triggerRef.current?.contains(event.target)) return;
      close();
    }
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    document.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [open, close]);

  useEffect(() => {
    if (open) menuRef.current?.focus({ preventScroll: true });
  }, [open]);

  function moveActive(delta) {
    if (selectableIndexes.length === 0) return;
    const at = selectableIndexes.indexOf(activeIndex);
    const nextAt = at === -1 ? 0 : (at + delta + selectableIndexes.length) % selectableIndexes.length;
    setActiveIndex(selectableIndexes[nextAt]);
  }

  function commit(index) {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  }

  function onTriggerKeyDown(event) {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      openMenu(event.key === 'ArrowUp' ? selectableIndexes[selectableIndexes.length - 1] : undefined);
    }
  }

  function onMenuKeyDown(event) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      commit(activeIndex);
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      close();
      triggerRef.current?.focus({ preventScroll: true });
    }
  }

  return (
    <div className={`select${wide ? ' select--wide' : ''}`}>
      {label ? <span className="select__label">{label}</span> : null}
      <button
        ref={triggerRef}
        type="button"
        className="select__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="select__trigger-value">{selected?.label ?? ''}</span>
        <CaretIcon />
      </button>

      {open
        ? createPortal(
            <ul
              ref={menuRef}
              className="dropdown__menu"
              role="listbox"
              aria-label={ariaLabel}
              tabIndex={-1}
              style={
                pos
                  ? {
                      left: pos.left,
                      top: pos.top,
                      minWidth: pos.minWidth,
                      maxHeight: pos.maxHeight,
                    }
                  : { visibility: 'hidden' }
              }
              onKeyDown={onMenuKeyDown}
            >
              {options.map((option, index) => (
                <li key={option.value}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={option.value === selected?.value}
                    className={`dropdown__option${index === activeIndex ? ' is-active' : ''}${
                      option.value === selected?.value ? ' is-selected' : ''
                    }`}
                    disabled={option.disabled}
                    onPointerEnter={() => !option.disabled && setActiveIndex(index)}
                    onClick={() => commit(index)}
                  >
                    {option.label}
                  </button>
                </li>
              ))}
            </ul>,
            document.body,
          )
        : null}
    </div>
  );
}

function CaretIcon() {
  return (
    <svg className="dropdown__caret" width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
