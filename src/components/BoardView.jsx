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
import ContextMenu from './ContextMenu.jsx';
import ScoreBadge from './ScoreBadge.jsx';
import { ordinal } from '../lib/score.js';
import { genreLabels } from '../lib/media.js';

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
  // { id, x, y } while a card's right-click menu is open.
  const [menu, setMenu] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
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
  const menuItem = menu ? items.find((item) => item.id === menu.id) : null;

  const closeMenu = useCallback(() => setMenu(null), []);

  /* Keep the keyboard cursor pointing at something that still exists. */
  useEffect(() => {
    if (selectedId && !ids.includes(selectedId)) setSelectedId(null);
  }, [ids, selectedId]);

  const confirmDelete = useCallback(
    (item) => {
      const ok = window.confirm(
        `Delete "${item.title}"? Its images and notes will be removed. This cannot be undone.`,
      );
      if (ok) onDelete(item.id);
    },
    [onDelete],
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
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (items.length === 0) return;

      const index = selectedId ? ids.indexOf(selectedId) : -1;
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
        case 'Backspace':
          if (index >= 0) {
            event.preventDefault();
            confirmDelete(items[index]);
          }
          return;
        case 'Escape':
          if (selectedId) {
            event.preventDefault();
            setSelectedId(null);
          }
          return;
        default:
          return;
      }

      event.preventDefault();
      const id = ids[next];
      setSelectedId(id);
      cardRefs.current.get(id)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [ids, items, selectedId, columnCount, onOpen, confirmDelete]);

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
    setSelectedId(item.id);
    setMenu({ id: item.id, x: event.clientX, y: event.clientY });
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
      position: index + 1,
      isMenuTarget: menu?.id === item.id,
      isSelected: selectedId === item.id,
      registerCard,
      onOpen: () => onOpen(item.id),
      onSelect: () => setSelectedId(item.id),
      onContextMenu: (event) => openMenu(item, event),
    };
    return reorderable ? (
      <SortableCard key={item.id} {...shared} />
    ) : (
      <StaticCard key={item.id} {...shared} />
    );
  });

  const menuNode = menuItem ? (
    <ContextMenu
      x={menu.x}
      y={menu.y}
      onClose={closeMenu}
      items={[
        { key: 'open', label: 'Open', onSelect: () => onOpen(menuItem.id) },
        { key: 'compare', label: 'Compare with...', onSelect: () => onCompare(menuItem.id) },
        {
          key: 'delete',
          label: `Delete "${truncate(menuItem.title)}"`,
          danger: true,
          onSelect: () => confirmDelete(menuItem),
        },
      ]}
    />
  ) : null;

  if (!reorderable) {
    return (
      <>
        <ul className="board__grid" ref={gridRef}>
          {cards}
        </ul>
        {menuNode}
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
          <ul className="board__grid" ref={gridRef}>
            {cards}
          </ul>
        </SortableContext>

        <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.2, 0, 0, 1)' }}>
          {activeItem ? (
            <div className="card card--overlay">
              <CardBody item={activeItem} config={config} position={activePosition} />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {menuNode}
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
  position,
  isMenuTarget,
  isSelected,
  registerCard,
  onOpen,
  onSelect,
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
      onOpen();
      return;
    }
    listeners?.onKeyDown?.(event);
  }

  // Marks the card selected *and* still hands the press to dnd-kit's own
  // pointer sensor - this prop is applied after the `{...listeners}` spread,
  // so without the explicit forward it would silently swallow dnd-kit's
  // handler and no drag would ever start.
  function handlePointerDown(event) {
    onSelect();
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
      onClick={onOpen}
      onPointerDown={handlePointerDown}
      onContextMenu={onContextMenu}
      aria-label={cardLabel(item, position)}
    >
      <CardBody item={item} config={config} position={position} />
    </li>
  );
}

/** Same card without any drag wiring, for sorted or filtered views. */
function StaticCard({
  item,
  config,
  position,
  isMenuTarget,
  isSelected,
  registerCard,
  onOpen,
  onSelect,
  onContextMenu,
}) {
  return (
    <li
      ref={(node) => registerCard(item.id, node)}
      className={cardClass({ isDragging: false, isMenuTarget, isSelected })}
      tabIndex={0}
      onClick={onOpen}
      onPointerDown={onSelect}
      onContextMenu={onContextMenu}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          onOpen();
        }
      }}
      aria-label={cardLabel(item, position)}
    >
      <CardBody item={item} config={config} position={position} />
    </li>
  );
}

function CardBody({ item, config, position }) {
  const src = item.mainImage ? window.api.imageUrl(item.mainImage) : null;
  const genres = genreLabels(config, item.genres);

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
