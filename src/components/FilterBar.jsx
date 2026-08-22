import { useEffect, useRef, useState } from 'react';
import TagChips from './TagChips.jsx';
import { SORTS, isFiltered, isReorderable } from '../lib/collection.js';
import { EXPORT_FORMATS } from '../lib/export-image.js';

/**
 * Search, tag filters, sort order and the image export - everything that
 * changes *what* the board shows without changing the ranking itself.
 */
export default function FilterBar({
  config,
  filters,
  onChange,
  total,
  shown,
  onExport,
  exporting,
  searchRef,
}) {
  const filtered = isFiltered(filters);
  const [open, setOpen] = useState(false);
  const tagCount = filters.genres.length + filters.modes.length;

  function patch(next) {
    onChange({ ...filters, ...next });
  }

  function toggle(field, key) {
    const current = filters[field];
    patch({
      [field]: current.includes(key) ? current.filter((k) => k !== key) : [...current, key],
    });
  }

  return (
    <div className="filters">
      <div className="filters__row">
        <div className="search">
          <span className="search__icon" aria-hidden="true">
            <SearchIcon />
          </span>
          <input
            ref={searchRef}
            type="search"
            className="search__input"
            value={filters.query}
            placeholder={`Search ${config.items} by title or notes...`}
            aria-label={`Search ${config.items}`}
            onChange={(event) => patch({ query: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && filters.query) {
                event.stopPropagation();
                patch({ query: '' });
              }
            }}
          />
          {filters.query ? (
            <button
              type="button"
              className="search__clear"
              onClick={() => patch({ query: '' })}
              aria-label="Clear search"
            >
              &times;
            </button>
          ) : null}
        </div>

        <label className="select">
          <span className="select__label">Sort</span>
          <select
            className="select__input"
            value={filters.sort}
            onChange={(event) => patch({ sort: event.target.value })}
            aria-label="Sort order"
          >
            {SORTS.map((sort) => (
              <option key={sort.key} value={sort.key}>
                {sort.label}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className={`btn btn--ghost btn--sm${tagCount > 0 ? ' is-on' : ''}`}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <FilterIcon />
          Filters
          {tagCount > 0 ? <span className="btn__badge">{tagCount}</span> : null}
        </button>

        <ExportMenu onExport={onExport} exporting={exporting} />
      </div>

      {open || tagCount > 0 ? (
        <div className="filters__panel">
          <div className="filters__group">
            <span className="filters__label">Genres</span>
            <TagChips
              tags={config.genres}
              selected={filters.genres}
              onToggle={(key) => toggle('genres', key)}
              ariaLabel="Filter by genre"
            />
          </div>

          <div className="filters__group">
            <span className="filters__label">{config.modesLabel}</span>
            <TagChips
              tags={config.modes}
              selected={filters.modes}
              onToggle={(key) => toggle('modes', key)}
              ariaLabel={`Filter by ${config.modesLabel.toLowerCase()}`}
            />
          </div>

          {tagCount > 0 ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm filters__clear"
              onClick={() => patch({ genres: [], modes: [] })}
            >
              Clear filters
            </button>
          ) : null}
        </div>
      ) : null}

      <p className="filters__status">
        {filtered ? (
          <>
            Showing <strong>{shown}</strong> of {total} {total === 1 ? config.item : config.items}
          </>
        ) : (
          <>
            {total} {total === 1 ? config.item : config.items}
          </>
        )}
        {!isReorderable(filters) && total > 1 ? (
          <span className="filters__note">
            {' '}
            · drag to reorder is paused while this view is filtered or sorted
          </span>
        ) : null}
      </p>
    </div>
  );
}

/** Small popover so PNG and JPEG are one click apart. */
function ExportMenu({ onExport, exporting }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event) {
      if (!ref.current?.contains(event.target)) setOpen(false);
    }
    function onKeyDown(event) {
      if (event.key === 'Escape') setOpen(false);
    }
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  return (
    <div className="export" ref={ref}>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        disabled={exporting}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <DownloadIcon />
        {exporting ? 'Exporting...' : 'Export'}
      </button>

      {open ? (
        <div className="export__menu" role="menu">
          {EXPORT_FORMATS.map((format) => (
            <button
              key={format.key}
              type="button"
              role="menuitem"
              className="export__item"
              onClick={() => {
                setOpen(false);
                onExport(format.key);
              }}
            >
              Save as {format.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.6" stroke="currentColor" strokeWidth="1.6" />
      <path d="m10.6 10.6 3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.5 4h11L9.4 8.6v3.6l-2.8 1.4V8.6L2.5 4Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 2.5v7.5m0 0L5.2 7.2M8 10l2.8-2.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.8 11.5v1.2a.8.8 0 0 0 .8.8h8.8a.8.8 0 0 0 .8-.8v-1.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
