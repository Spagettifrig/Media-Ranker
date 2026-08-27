import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import ConfirmDialog from './ConfirmDialog.jsx';
import ContextMenu from './ContextMenu.jsx';
import ScoreBadge from './ScoreBadge.jsx';
import TrophyBadge from './TrophyBadge.jsx';
import { ordinal } from '../lib/score.js';
import { genreLabels } from '../lib/media.js';
import { trophiesFor } from '../lib/awards.js';

/**
 * The ranking grid.
 *
 * `items` is the *visible* list - already searched, filtered and sorted.
 * Dragging is only wired up when that list is the whole board in board order
 * (`reorderable`), because a drop into a filtered view has no honest meaning.
 */
export default function BoardView({
  items,
  config,
  trophies,
  reorderable,
  importing,
  filtered,
  onOpen,
  onReorder,
  onAdd,
  onSearchAdd,
  onDelete,
  onCompare,
  onClearFilters,
}) {
  const [activeId, setActiveId] = useState(null);
  // { ids, x, y } while a right-click menu is open. `ids` is every card the
  // menu acts on - one card, or the whole multi-selection.
  const [menu, setMenu] = useState(null);
  // The multi-selection: a Set of item ids picked out with Ctrl/Shift-click or
  // a marquee drag over empty board space.
  const [selection, setSelection] = useState(() => new Set());
  // The keyboard cursor, and the anchor a Shift-click range extends from.
  const [cursorId, setCursorId] = useState(null);
  // { left, top, right, bottom } in client coords while a marquee is dragging.
  const [marquee, setMarquee] = useState(null);
  // ids awaiting the delete confirmation, or null.
  const [pendingDelete, setPendingDelete] = useState(null);
  const gridRef = useRef(null);
  const cardRefs = useRef(new Map());

  const sensors = useSensors(
    // A small drag threshold keeps plain clicks working as "open this item".
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const ids = useMemo(() => items.map((item) => item.id), [items]);
  const activeItem = activeId ? items.find((item) => item.id === activeId) : null;
  const activePosition = activeItem ? items.indexOf(activeItem) + 1 : 0;
  const menuValid = menu ? menu.ids.some((id) => ids.includes(id)) : false;

  const closeMenu = useCallback(() => setMenu(null), []);
  const titleOf = useCallback(
    (id) => items.find((item) => item.id === id)?.title ?? '',
    [items],
  );

  /* Drop from the selection anything that has since been deleted. */
  useEffect(() => {
    if (cursorId && !ids.includes(cursorId)) setCursorId(null);
    setSelection((prev) => {
      const next = new Set([...prev].filter((id) => ids.includes(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [ids, cursorId]);

  /* Open the styled confirm for a set of ids. */
  const askDelete = useCallback(
    (idList) => {
      const present = idList.filter((id) => ids.includes(id));
      if (present.length === 0) return;
      setMenu(null);
      setPendingDelete(present);
    },
    [ids],
  );

  const performDelete = useCallback(() => {
    (pendingDelete ?? []).forEach((id) => onDelete(id));
    setPendingDelete(null);
    setSelection(new Set());
    setCursorId(null);
  }, [pendingDelete, onDelete]);

  /* Ctrl/Cmd-click toggles a card; Shift-click extends a range from the
     cursor. A plain click still just opens the card. */
  const handleCardClick = useCallback(
    (item, event) => {
      if (event.shiftKey) {
        event.preventDefault();
        const from = cursorId ?? item.id;
        const a = ids.indexOf(from);
        const b = ids.indexOf(item.id);
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          setSelection(new Set(ids.slice(lo, hi + 1)));
        }
        setCursorId(item.id);
        return;
      }
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        setSelection((prev) => {
          const next = new Set(prev);
          if (next.has(item.id)) next.delete(item.id);
          else next.add(item.id);
          return next;
        });
        setCursorId(item.id);
        return;
      }
      onOpen(item.id);
    },
    [ids, cursorId, onOpen],
  );

  /* ---- keyboard navigation ------------------------------------------- *
   * Arrows walk the grid, Enter opens, Delete removes. The column count is
   * read back off the CSS grid so up/down move a real row, whatever the
   * window width happens to be. */
  const columnCount = useCallback(() => {
    const grid = gridRef.current;
    if (!grid) return 1;
    const template = window.getComputedStyle(grid).gridTemplateColumns;
    const columns = template.split(' ').filter(Boolean).length;
    return Math.max(1, columns);
  }, []);

  useEffect(() => {
    function onKeyDown(event) {
      const tag = event.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target?.isContentEditable) {
        return;
      }
      if (pendingDelete || marquee) return;
      if (items.length === 0) return;

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        setSelection(new Set(ids));
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      const index = cursorId ? ids.indexOf(cursorId) : -1;
      const columns = columnCount();
      let next = null;

      switch (event.key) {
        case 'ArrowRight':
          next = index < 0 ? 0 : Math.min(items.length - 1, index + 1);
          break;
        case 'ArrowLeft':
          next = index < 0 ? 0 : Math.max(0, index - 1);
          break;
        case 'ArrowDown':
          next = index < 0 ? 0 : Math.min(items.length - 1, index + columns);
          break;
        case 'ArrowUp':
          next = index < 0 ? 0 : Math.max(0, index - columns);
          break;
        case 'Home':
          next = 0;
          break;
        case 'End':
          next = items.length - 1;
          break;
        case 'Enter':
          if (index >= 0) {
            event.preventDefault();
            onOpen(ids[index]);
          }
          return;
        case 'Delete':
        case 'Backspace': {
          const targets = selection.size > 0 ? [...selection] : index >= 0 ? [ids[index]] : [];
          if (targets.length) {
            event.preventDefault();
            askDelete(targets);
          }
          return;
        }
        case 'Escape':
          if (selection.size > 0 || cursorId) {
            event.preventDefault();
            setSelection(new Set());
            setCursorId(null);
          }
          return;
        default:
          return;
      }

      event.preventDefault();
      const id = ids[next];
      setCursorId(id);
      setSelection(new Set([id]));
      cardRefs.current.get(id)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [ids, items, cursorId, selection, pendingDelete, marquee, columnCount, onOpen, askDelete]);

  function handleDragEnd(event) {
    setActiveId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(active.id);
    const to = ids.indexOf(over.id);
    if (from < 0 || to < 0) return;
    onReorder(arrayMove(items, from, to));
  }

  const registerCard = useCallback((id, node) => {
    if (node) cardRefs.current.set(id, node);
    else cardRefs.current.delete(id);
  }, []);

  function openMenu(item, event) {
    event.preventDefault();
    setCursorId(item.id);
    // A right-click on a card that's part of a multi-selection acts on the
    // whole selection; otherwise it narrows to just that card.
    const acting =
      selection.size > 1 && selection.has(item.id) ? [...selection] : [item.id];
    if (acting.length === 1) setSelection(new Set(acting));
    setMenu({ ids: acting, x: event.clientX, y: event.clientY });
  }

  /* Right-click on empty board space, with a selection, offers the bulk menu. */
  function handleGridContextMenu(event) {
    if (event.target !== gridRef.current) return;
    if (selection.size === 0) return;
    event.preventDefault();
    setMenu({ ids: [...selection], x: event.clientX, y: event.clientY });
  }

  /* A press that starts on empty grid space (not on a card) drags a marquee
     that selects every card it touches. Holding Shift/Ctrl adds to the
     current selection instead of replacing it. */
  function beginMarquee(event) {
    if (event.button !== 0 || event.target !== gridRef.current) return;
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    const base = additive ? new Set(selection) : new Set();
    const origin = { x: event.clientX, y: event.clientY };
    let moved = false;
    setMenu(null);

    function onMove(e) {
      if (!moved && Math.hypot(e.clientX - origin.x, e.clientY - origin.y) < 4) return;
      moved = true;
      const rect = {
        left: Math.min(origin.x, e.clientX),
        top: Math.min(origin.y, e.clientY),
        right: Math.max(origin.x, e.clientX),
        bottom: Math.max(origin.y, e.clientY),
      };
      setMarquee(rect);
      const hit = new Set(base);
      for (const [id, node] of cardRefs.current) {
        if (!node) continue;
        const b = node.getBoundingClientRect();
        if (b.left < rect.right && b.right > rect.left && b.top < rect.bottom && b.bottom > rect.top) {
          hit.add(id);
        }
      }
      setSelection(hit);
    }

    function onUp() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setMarquee(null);
      if (!moved && !additive) {
        setSelection(new Set());
        setCursorId(null);
      }
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  if (items.length === 0) {
    return filtered ? (
      <div className="empty">
        <h2>Nothing matches</h2>
        <p>
          No {config.items} match that search and filter combination. Try a different word, or
          loosen the filters.
        </p>
        <button type="button" className="btn btn--ghost btn--lg" onClick={onClearFilters}>
          Clear search and filters
        </button>
      </div>
    ) : (
      <div className="empty">
        <div className="empty__art" aria-hidden="true">
          <ScoreBadge value={94} size="lg" />
          <ScoreBadge value={71} size="lg" />
          <ScoreBadge value={38} size="lg" />
        </div>
        <h2>Your board is empty</h2>
        <p>
          Search {config.catalog.provider} for {config.item === 'movie' ? 'a movie' : 'a game'} and
          it lands here with its cover already attached — or pick your own images instead.
          Everything is copied into the app and saved automatically.
        </p>
        <div className="empty__actions">
          <button
            type="button"
            className="btn btn--primary btn--lg"
            onClick={onSearchAdd}
            disabled={importing}
          >
            <PlusIcon />
            Add {config.Item}
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--lg"
            onClick={onAdd}
            disabled={importing}
          >
            From file
          </button>
        </div>
      </div>
    );
  }

  const cards = items.map((item, index) => {
    const shared = {
      item,
      config,
      trophies,
      position: index + 1,
      isMenuTarget: menu?.ids.includes(item.id) ?? false,
      isSelected: selection.has(item.id) || cursorId === item.id,
      registerCard,
      onActivate: (event) => handleCardClick(item, event),
      onCursor: () => setCursorId(item.id),
      onContextMenu: (event) => openMenu(item, event),
    };
    return reorderable ? (
      <SortableCard key={item.id} {...shared} />
    ) : (
      <StaticCard key={item.id} {...shared} />
    );
  });

  const menuNode = menuValid ? (
    <ContextMenu
      x={menu.x}
      y={menu.y}
      onClose={closeMenu}
      items={
        menu.ids.length > 1
          ? [
              {
                key: 'delete',
                label: `Delete ${menu.ids.length} ${config.items}`,
                danger: true,
                onSelect: () => askDelete(menu.ids),
              },
            ]
          : [
              { key: 'open', label: 'Open', onSelect: () => onOpen(menu.ids[0]) },
              { key: 'compare', label: 'Compare with...', onSelect: () => onCompare(menu.ids[0]) },
              {
                key: 'delete',
                label: `Delete "${truncate(titleOf(menu.ids[0]))}"`,
                danger: true,
                onSelect: () => askDelete([menu.ids[0]]),
              },
            ]
      }
    />
  ) : null;

  const deleteCount = pendingDelete?.length ?? 0;
  const deleteDialog = pendingDelete ? (
    <ConfirmDialog
      title={
        deleteCount === 1
          ? `Delete this ${config.item}?`
          : `Delete ${deleteCount} ${config.items}?`
      }
      message={
        deleteCount === 1
          ? `"${titleOf(pendingDelete[0])}" and its images and notes will be removed. This can't be undone.`
          : `${deleteCount} ${config.items} and all their images and notes will be removed. This can't be undone.`
      }
      confirmLabel={deleteCount === 1 ? 'Delete' : `Delete ${deleteCount}`}
      onConfirm={performDelete}
      onCancel={() => setPendingDelete(null)}
    />
  ) : null;

  const marqueeNode = marquee ? (
    <div
      className="marquee"
      style={{
        left: marquee.left,
        top: marquee.top,
        width: marquee.right - marquee.left,
        height: marquee.bottom - marquee.top,
      }}
    />
  ) : null;

  if (!reorderable) {
    return (
      <>
        <ul
          className={`board__grid${marquee ? ' is-marqueeing' : ''}`}
          ref={gridRef}
          onPointerDown={beginMarquee}
          onContextMenu={handleGridContextMenu}
        >
          {cards}
        </ul>
        {menuNode}
        {marqueeNode}
        {deleteDialog}
      </>
    );
  }

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={(event) => {
          setMenu(null);
          setActiveId(event.active.id);
        }}
        onDragCancel={() => setActiveId(null)}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={ids} strategy={rectSortingStrategy}>
          <ul
            className={`board__grid${marquee ? ' is-marqueeing' : ''}`}
            ref={gridRef}
            onPointerDown={beginMarquee}
            onContextMenu={handleGridContextMenu}
          >
            {cards}
          </ul>
        </SortableContext>

        <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.2, 0, 0, 1)' }}>
          {activeItem ? (
            <div className="card card--overlay">
              <CardBody
                item={activeItem}
                config={config}
                trophies={trophies}
                position={activePosition}
              />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {menuNode}
      {marqueeNode}
      {deleteDialog}
    </>
  );
}

function truncate(title, max = 28) {
  return title.length > max ? `${title.slice(0, max - 1).trimEnd()}...` : title;
}

function cardClass({ isDragging, isMenuTarget, isSelected }) {
  return [
    'card',
    isDragging ? 'card--dragging' : '',
    isMenuTarget ? 'card--menu' : '',
    isSelected ? 'card--selected' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function cardLabel(item, position) {
  return `${item.title}, ranked ${ordinal(position)}, score ${item.overallScore}`;
}

function SortableCard({
  item,
  config,
  trophies,
  position,
  isMenuTarget,
  isSelected,
  registerCard,
  onActivate,
  onCursor,
  onContextMenu,
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  // Enter opens the item; Space is left to dnd-kit for keyboard reordering.
  function handleKeyDown(event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      onActivate(event);
      return;
    }
    listeners?.onKeyDown?.(event);
  }

  // Moves the keyboard cursor here *and* still hands the press to dnd-kit's own
  // pointer sensor - this prop is applied after the `{...listeners}` spread,
  // so without the explicit forward it would silently swallow dnd-kit's
  // handler and no drag would ever start.
  function handlePointerDown(event) {
    onCursor();
    listeners?.onPointerDown?.(event);
  }

  return (
    <li
      ref={(node) => {
        setNodeRef(node);
        registerCard(item.id, node);
      }}
      style={style}
      className={cardClass({ isDragging, isMenuTarget, isSelected })}
      {...attributes}
      {...listeners}
      onKeyDown={handleKeyDown}
      onClick={onActivate}
      onPointerDown={handlePointerDown}
      onContextMenu={onContextMenu}
      aria-label={cardLabel(item, position)}
    >
      <CardBody item={item} config={config} trophies={trophies} position={position} />
    </li>
  );
}

/** Same card without any drag wiring, for sorted or filtered views. */
function StaticCard({
  item,
  config,
  trophies,
  position,
  isMenuTarget,
  isSelected,
  registerCard,
  onActivate,
  onCursor,
  onContextMenu,
}) {
  return (
    <li
      ref={(node) => registerCard(item.id, node)}
      className={cardClass({ isDragging: false, isMenuTarget, isSelected })}
      tabIndex={0}
      onClick={onActivate}
      onPointerDown={onCursor}
      onContextMenu={onContextMenu}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          onActivate(event);
        }
      }}
      aria-label={cardLabel(item, position)}
    >
      <CardBody item={item} config={config} trophies={trophies} position={position} />
    </li>
  );
}

function CardBody({ item, config, trophies, position }) {
  const src = item.mainImage ? window.api.imageUrl(item.mainImage) : null;
  const genres = genreLabels(config, item.genres);
  const won = trophiesFor(trophies, item);

  return (
    <>
      <div className="card__frame">
        {src ? (
          <img className="card__image" src={src} alt="" draggable={false} />
        ) : (
          <div className="card__image card__image--empty" aria-hidden="true">
            <ImageIcon />
          </div>
        )}
        <span className="card__position">{ordinal(position)}</span>
        {won.length > 0 ? (
          <span className="card__trophies">
            <TrophyBadge trophies={won} />
          </span>
        ) : null}
      </div>
      <div className="card__meta">
        <ScoreBadge value={item.overallScore} />
        <span className="card__text">
          <span className="card__title" title={item.title}>
            {item.title}
          </span>
          {genres.length > 0 ? (
            <span className="card__genres" title={genres.join(', ')}>
              {genres.join(' · ')}
            </span>
          ) : null}
        </span>
      </div>
    </>
  );
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function ImageIcon() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="8.5" cy="10" r="1.6" fill="currentColor" />
      <path d="m4 17 5-4.5 4 3.5 3-2.5 4 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}
