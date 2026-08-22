/**
 * A row of toggle chips, used both to tag an item on its detail page and to
 * narrow the board on the filter bar. Same component, same look, so a genre
 * always reads the same wherever it appears.
 */
export default function TagChips({ tags, selected, onToggle, size = 'md', ariaLabel }) {
  const chosen = new Set(selected ?? []);

  return (
    <div className={`chips chips--${size}`} role="group" aria-label={ariaLabel}>
      {tags.map((tag) => {
        const active = chosen.has(tag.key);
        return (
          <button
            key={tag.key}
            type="button"
            className={`chip${active ? ' is-active' : ''}`}
            aria-pressed={active}
            onClick={() => onToggle(tag.key)}
          >
            {tag.label}
          </button>
        );
      })}
    </div>
  );
}

/** Read-only version: the tags an item carries, with nothing to click. */
export function TagList({ labels, size = 'sm', empty = null }) {
  if (!labels || labels.length === 0) {
    return empty ? <span className="chips__empty">{empty}</span> : null;
  }
  return (
    <div className={`chips chips--${size} chips--static`}>
      {labels.map((label) => (
        <span key={label} className="chip chip--static">
          {label}
        </span>
      ))}
    </div>
  );
}
