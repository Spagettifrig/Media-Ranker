import SaveIndicator from './SaveIndicator.jsx';

export const VIEWS = [
  { key: 'board', label: 'Board' },
  { key: 'stats', label: 'Stats' },
  { key: 'compare', label: 'Compare' },
  { key: 'awards', label: 'Awards' },
];

/**
 * The strip that sits above every top-level screen: which library you are in,
 * the view switcher, and the actions that apply everywhere.
 */
export default function TopStrip({
  config,
  view,
  onViewChange,
  subtitle,
  saveState,
  importing,
  onAdd,
  onSearchAdd,
}) {
  function handleKeyDown(event) {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const index = VIEWS.findIndex((item) => item.key === view);
    onViewChange(VIEWS[(index + delta + VIEWS.length) % VIEWS.length].key);
  }

  return (
    <header className="strip">
      <div className="strip__heading">
        <h1>{config.title}</h1>
        <p className="strip__subtitle">{subtitle}</p>
      </div>

      <div className="tabs" role="tablist" aria-label="View" onKeyDown={handleKeyDown}>
        {VIEWS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={view === item.key}
            tabIndex={view === item.key ? 0 : -1}
            className={`tab${view === item.key ? ' is-active' : ''}`}
            onClick={() => onViewChange(item.key)}
          >
            <TabIcon view={item.key} />
            {item.label}
          </button>
        ))}
      </div>

      <div className="strip__actions">
        <SaveIndicator state={saveState} />
        {/* The manual path stays first-class: the catalog needs a key and a
            connection, and neither is guaranteed. */}
        <button
          type="button"
          className="btn btn--ghost"
          onClick={onAdd}
          disabled={importing}
          title={`Add a ${config.item} from your own image files`}
        >
          <ImageIcon />
          {importing ? 'Importing...' : 'From file'}
        </button>
        <button type="button" className="btn btn--primary" onClick={onSearchAdd} disabled={importing}>
          <SearchPlusIcon />
          {`Add ${config.Item}`}
        </button>
      </div>
    </header>
  );
}

function TabIcon({ view }) {
  if (view === 'board') return <GridIcon />;
  if (view === 'stats') return <ChartIcon />;
  if (view === 'compare') return <CompareIcon />;
  return <TrophyTabIcon />;
}

function TrophyTabIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4.6 2.2h6.8v4a3.4 3.4 0 0 1-6.8 0v-4Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M4.6 3.4H2.8v1.2a2.2 2.2 0 0 0 2 2.19M11.4 3.4h1.8v1.2a2.2 2.2 0 0 1-2 2.19" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M8 9.6v2.4M5.6 13.8h4.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="2" width="5" height="5" rx="1.4" stroke="currentColor" strokeWidth="1.5" />
      <rect x="9" y="2" width="5" height="5" rx="1.4" stroke="currentColor" strokeWidth="1.5" />
      <rect x="2" y="9" width="5" height="5" rx="1.4" stroke="currentColor" strokeWidth="1.5" />
      <rect x="9" y="9" width="5" height="5" rx="1.4" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function ChartIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 13.5V9m5 4.5V3m5 10.5V6.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function CompareIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.8" y="3" width="5.2" height="10" rx="1.4" stroke="currentColor" strokeWidth="1.5" />
      <rect x="9" y="3" width="5.2" height="10" rx="1.4" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function ImageIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="1.6" stroke="currentColor" strokeWidth="1.5" />
      <path d="m3.4 11.2 2.9-3 2.4 2.4 1.9-1.7 2.1 2.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="10.2" cy="6.1" r="1.05" fill="currentColor" />
    </svg>
  );
}

function SearchPlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.7" />
      <path d="M7 5.2v3.6M5.2 7h3.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="m10.6 10.6 3 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
