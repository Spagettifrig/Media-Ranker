import { LIBRARIES } from '../lib/media.js';

/**
 * The rail down the left: which library you are ranking, plus the settings
 * that apply to the whole app.
 */
export default function Sidebar({
  library,
  counts,
  onLibraryChange,
  onOpenSettings,
  onOpenAccount,
  onOpenFriends,
  friendRequestCount = 0,
  user,
}) {
  function handleKeyDown(event) {
    const delta = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const index = LIBRARIES.findIndex((item) => item.key === library);
    onLibraryChange(LIBRARIES[(index + delta + LIBRARIES.length) % LIBRARIES.length].key);
  }

  return (
    <nav className="sidebar" aria-label="Libraries">
      <div className="sidebar__brand">
        <span className="sidebar__mark" aria-hidden="true">
          <RankIcon />
        </span>
        <span className="sidebar__brand-text">Ranker</span>
      </div>

      <ul className="sidebar__list" role="tablist" aria-orientation="vertical" onKeyDown={handleKeyDown}>
        {LIBRARIES.map((item, index) => (
          <li key={item.key}>
            <button
              type="button"
              role="tab"
              aria-selected={library === item.key}
              tabIndex={library === item.key ? 0 : -1}
              className={`sidebar__item${library === item.key ? ' is-active' : ''}`}
              onClick={() => onLibraryChange(item.key)}
              title={`${item.label} (Alt+${index + 1})`}
            >
              <span className="sidebar__icon" aria-hidden="true">
                <LibraryIcon libraryKey={item.key} />
              </span>
              <span className="sidebar__label">{item.label}</span>
              <span className="sidebar__count">{counts[item.key] ?? 0}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className="sidebar__foot">
        <button
          type="button"
          className="sidebar__tool"
          onClick={onOpenAccount}
          title={user ? `Signed in as ${user.email}` : 'Sign in or create an account'}
        >
          <span
            className={`sidebar__account-dot${user ? ' is-on' : ''}`}
            aria-hidden="true"
          />
          <span className="sidebar__label">{user ? user.email : 'Not signed in'}</span>
        </button>
        {/* Signed out there is nobody to be friends with, and the sheet
            would only be able to say so - so it isn't offered at all. */}
        {user ? (
          <button
            type="button"
            className="sidebar__tool"
            onClick={onOpenFriends}
            title="Friends"
          >
            <span className="sidebar__icon" aria-hidden="true">
              <FriendsIcon />
            </span>
            <span className="sidebar__label">Friends</span>
            {friendRequestCount > 0 ? (
              <span className="sidebar__count sidebar__count--alert">{friendRequestCount}</span>
            ) : null}
          </button>
        ) : null}
        <button
          type="button"
          className="sidebar__tool"
          onClick={onOpenSettings}
          title="Settings (?)"
        >
          <span className="sidebar__icon" aria-hidden="true">
            <GearIcon />
          </span>
          <span className="sidebar__label">Settings</span>
        </button>
      </div>
    </nav>
  );
}

/** One icon per library. An unknown key falls back to the controller. */
function LibraryIcon({ libraryKey }) {
  if (libraryKey === 'movies') return <FilmIcon />;
  if (libraryKey === 'series') return <TvIcon />;
  return <ControllerIcon />;
}

function RankIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="7" width="3.4" height="7" rx="1.2" fill="currentColor" />
      <rect x="6.3" y="2.5" width="3.4" height="11.5" rx="1.2" fill="currentColor" />
      <rect x="10.6" y="5" width="3.4" height="9" rx="1.2" fill="currentColor" />
    </svg>
  );
}

function ControllerIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M7.5 8h9a4.5 4.5 0 0 1 4.4 3.6l.8 4A3.2 3.2 0 0 1 18.6 19c-.9 0-1.7-.4-2.3-1.1L15 16.4H9l-1.3 1.5C7.1 18.6 6.3 19 5.4 19a3.2 3.2 0 0 1-3.1-3.4l.8-4A4.5 4.5 0 0 1 7.5 8Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M7 11.6v2.2M5.9 12.7h2.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="16" cy="12" r="1" fill="currentColor" />
      <circle cx="18" cy="14" r="1" fill="currentColor" />
    </svg>
  );
}

function FilmIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 4.5v15M16 4.5v15M3 9.5h5M3 14.5h5M16 9.5h5M16 14.5h5" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function TvIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2.5" y="7.5" width="19" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="m8 3.5 4 4 4-4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FriendsIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="9" cy="8.4" r="3.4" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3.2 19.2a5.8 5.8 0 0 1 11.6 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path
        d="M16.4 5.4a3.4 3.4 0 0 1 0 6M18 13.7a5.8 5.8 0 0 1 2.8 4.9"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M12 3.5v2.3M12 18.2v2.3M20.5 12h-2.3M5.8 12H3.5M17.7 6.3l-1.6 1.6M7.9 16.1l-1.6 1.6M17.7 17.7l-1.6-1.6M7.9 7.9 6.3 6.3"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
