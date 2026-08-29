import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { COVER_ASPECT_OPTIONS } from '../lib/settings.js';
import { LIBRARIES } from '../lib/media.js';

/**
 * The credentials the online catalog needs, in the order it makes sense to
 * collect them. `hint` is the whole setup instruction - there is nowhere else
 * in the app that explains where these come from.
 */
const CREDENTIAL_FIELDS = [
  {
    key: 'tmdbToken',
    label: 'TMDB read access token',
    // One token covers both TMDB libraries - films and shows are the same API.
    for: 'Movies & TV Series',
    hint: 'themoviedb.org → Settings → API. Copy the API Read Access Token, not the v3 key.',
    secret: true,
  },
  {
    key: 'twitchClientId',
    label: 'Twitch client ID',
    for: 'Games',
    hint: 'dev.twitch.tv/console → Register Your Application. Needs 2FA on the Twitch account.',
    secret: false,
  },
  {
    key: 'twitchClientSecret',
    label: 'Twitch client secret',
    for: 'Games',
    hint: 'Generated on the same page as the client ID. Regenerate it any time.',
    secret: true,
  },
];

/** Full walkthroughs for the two credential hints above - one-liners point at where to look, these spell out every click. */
const CATALOG_SETUP_GUIDES = [
  {
    title: 'Getting a TMDB token (Movies)',
    steps: [
      'Create a free account at themoviedb.org.',
      'Go to Settings → API, and request an API key - pick "Developer" when it asks how you\'ll use it.',
      'Once it\'s approved, copy the "API Read Access Token" (the long token) - not the shorter "API Key (v3 auth)".',
      'Paste it into the TMDB field above.',
    ],
  },
  {
    title: 'Getting IGDB credentials (Games)',
    steps: [
      'Go to dev.twitch.tv/console. You\'ll need a Twitch account with two-factor authentication turned on.',
      'Click "Register Your Application". Any name works; set the OAuth Redirect URL to http://localhost and the category to "Application Integration".',
      'Copy the Client ID it generates into the field above.',
      'On the same page, click "New Secret" to generate a Client Secret, and copy that into the field above too.',
    ],
  },
];

const SHORTCUT_SECTIONS = [
  {
    title: 'Anywhere',
    rows: [
      [['?'], 'Show or hide settings'],
      [['Ctrl', 'F'], 'Jump to the search box'],
      [['/'], 'Jump to the search box'],
      // Generated, so a new library in media.js cannot leave this sheet
      // advertising a shortcut list that no longer matches the rail.
      ...LIBRARIES.map((library, index) => [
        ['Alt', String(index + 1)],
        `Switch to ${library.label}`,
      ]),
      [['Ctrl', 'E'], 'Export the ranking as a PNG'],
      [['Esc'], 'Close, clear, or step back'],
    ],
  },
  {
    title: 'On the board',
    rows: [
      [['←', '→'], 'Move along the row'],
      [['↑', '↓'], 'Move up and down a row'],
      [['Home', 'End'], 'First or last card'],
      [['Enter'], 'Open the selected card'],
      [['Delete'], 'Delete the selected card'],
    ],
  },
  {
    title: 'On a detail page',
    rows: [
      [['↑', '↓'], 'Pick a category to score'],
      [['0', '-', '9'], 'Type a score for that category'],
      [['←', '→'], 'Flip through the images'],
      [['Enter'], 'Commit the typed score'],
      [['Esc'], 'Back to the board'],
    ],
  },
];

/**
 * Settings sheet: appearance (theme, cover aspect ratio) and the keyboard
 * reference. Opened with `?`, from the sidebar, or the first time someone
 * goes looking for either.
 */
export default function SettingsView({
  theme,
  onThemeChange,
  coverAspect,
  onCoverAspectChange,
  credentials,
  onCredentialChange,
  appVersion,
  updateStatus,
  onCheckForUpdates,
  onInstallUpdate,
  onClose,
}) {
  const ref = useRef(null);
  const [reveal, setReveal] = useState(false);

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    function onKeyDown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  return createPortal(
    <div className="overlay" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Settings" tabIndex={-1} ref={ref}>
        <header className="sheet__head">
          <h2>Settings</h2>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="settings__body">
          <section className="settings__section">
            <h3 className="keys__title">Appearance</h3>
            <div className="settings__row">
              <div>
                <p className="settings__row-title">Theme</p>
                <p className="settings__row-desc">Switch the whole app between dark, light and true black.</p>
              </div>
              <div className="segmented" role="radiogroup" aria-label="Theme">
                <button
                  type="button"
                  role="radio"
                  aria-checked={theme === 'dark'}
                  className={`segmented__item${theme === 'dark' ? ' is-on' : ''}`}
                  onClick={() => onThemeChange('dark')}
                >
                  <MoonIcon />
                  Dark
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={theme === 'black'}
                  className={`segmented__item${theme === 'black' ? ' is-on' : ''}`}
                  onClick={() => onThemeChange('black')}
                >
                  <BlackIcon />
                  True black
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={theme === 'light'}
                  className={`segmented__item${theme === 'light' ? ' is-on' : ''}`}
                  onClick={() => onThemeChange('light')}
                >
                  <SunIcon />
                  Light
                </button>
              </div>
            </div>
          </section>

          <section className="settings__section">
            <h3 className="keys__title">Cover aspect ratio</h3>
            <p className="settings__row-desc">
              The shape covers are cropped to on the board and in compare. Pick whatever matches your art.
            </p>
            <div className="aspect-grid" role="radiogroup" aria-label="Cover aspect ratio">
              {COVER_ASPECT_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={coverAspect === option.value}
                  className={`aspect-swatch${coverAspect === option.value ? ' is-on' : ''}`}
                  onClick={() => onCoverAspectChange(option.value)}
                >
                  <span className="aspect-swatch__box" aria-hidden="true">
                    <span className="aspect-swatch__box-inner" style={{ aspectRatio: option.value }} />
                  </span>
                  <span className="aspect-swatch__label">{option.label}</span>
                  <span className="aspect-swatch__ratio">{option.value.replace(/\s/g, '')}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="settings__section">
            <div className="settings__row">
              <div>
                <h3 className="keys__title">Online catalog</h3>
                <p className="settings__row-desc">
                  Lets you search for a title and add it with its cover already attached. Stored
                  only on this machine, in your local data file. Leave blank to keep importing
                  images by hand.
                </p>
              </div>
              <button
                type="button"
                className={`btn btn--ghost btn--sm${reveal ? ' is-on' : ''}`}
                onClick={() => setReveal((value) => !value)}
              >
                {reveal ? 'Hide' : 'Show'}
              </button>
            </div>

            <div className="settings__creds">
              {CREDENTIAL_FIELDS.map((field) => (
                <label key={field.key} className="field">
                  <span className="field__label">
                    {field.label}
                    <span className="field__for">{field.for}</span>
                  </span>
                  <span className="field__control">
                    <input
                      type={field.secret && !reveal ? 'password' : 'text'}
                      className="field__input field__input--cred"
                      value={credentials?.[field.key] ?? ''}
                      onChange={(event) => onCredentialChange(field.key, event.target.value)}
                      placeholder="Not set"
                      spellCheck="false"
                      autoComplete="off"
                    />
                  </span>
                  <span className="field__hint">{field.hint}</span>
                </label>
              ))}
            </div>

            <div className="settings__guides">
              {CATALOG_SETUP_GUIDES.map((guide) => (
                <div key={guide.title} className="settings__guide">
                  <h4 className="keys__title">{guide.title}</h4>
                  <ol className="settings__steps">
                    {guide.steps.map((step, index) => (
                      <li key={index}>{step}</li>
                    ))}
                  </ol>
                </div>
              ))}
            </div>
          </section>

          <UpdateSection
            appVersion={appVersion}
            updateStatus={updateStatus}
            onCheckForUpdates={onCheckForUpdates}
            onInstallUpdate={onInstallUpdate}
          />

          <section className="settings__section">
            <h3 className="keys__title">Keyboard shortcuts</h3>
            <div className="settings__keys">
              {SHORTCUT_SECTIONS.map((section) => (
                <div key={section.title} className="keys">
                  <h4 className="keys__title">{section.title}</h4>
                  <dl className="keys__list">
                    {/* Two shortcuts can share a description (Ctrl+F and / both
                        jump to search), so the key has to include the combo. */}
                    {section.rows.map(([combo, description]) => (
                      <div key={`${section.title}-${combo.join('+')}`} className="keys__row">
                        <dt>
                          {combo.map((key, index) => {
                            // '-' is a range marker ("0 - 9"), not a key, and it
                            // replaces the "+" that would otherwise join the pair.
                            if (key === '-') {
                              return (
                                <span key={`${key}-${index}`} className="keys__join">
                                  –
                                </span>
                              );
                            }
                            const joined = index > 0 && combo[index - 1] !== '-';
                            return (
                              <span key={`${key}-${index}`}>
                                {joined ? <span className="keys__join">+</span> : null}
                                <kbd>{key}</kbd>
                              </span>
                            );
                          })}
                        </dt>
                        <dd>{description}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
            </div>
            <p className="sheet__foot">
              Typing a score works digit by digit — press <kbd>8</kbd> then <kbd>5</kbd> for 85, or
              <kbd>1</kbd> <kbd>0</kbd> <kbd>0</kbd> for 100. It commits on its own after a moment.
            </p>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}


/**
 * The app already checks for updates on its own - at launch and every four
 * hours - and downloads and prompts silently when it finds one (see the
 * "update ready" toast). This is purely a convenience for "check right now"
 * instead of waiting or having to fully close and reopen the app, which is
 * otherwise the only way to force an immediate check.
 */
function UpdateSection({ appVersion, updateStatus, onCheckForUpdates, onInstallUpdate }) {
  const status = updateStatus?.status ?? 'idle';
  const checking = status === 'checking';

  return (
    <section className="settings__section">
      <h3 className="keys__title">Updates</h3>
      <div className="settings__row">
        <div>
          <p className="settings__row-title">
            {appVersion ? `Version ${appVersion}` : 'Checking version…'}
          </p>
          <p className="settings__row-desc">{updateStatusText(status, updateStatus)}</p>
        </div>
        {status === 'ready' ? (
          <button type="button" className="btn btn--primary btn--sm" onClick={onInstallUpdate}>
            Restart & update
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={onCheckForUpdates}
            disabled={checking}
          >
            {checking ? 'Checking…' : 'Check for updates'}
          </button>
        )}
      </div>
    </section>
  );
}

function updateStatusText(status, updateStatus) {
  switch (status) {
    case 'checking':
      return 'Checking for updates…';
    case 'downloading':
      return updateStatus?.version
        ? `Downloading version ${updateStatus.version}…`
        : 'Downloading the update…';
    case 'not-available':
      return "You're on the latest version.";
    case 'ready':
      return updateStatus?.version
        ? `Version ${updateStatus.version} is downloaded and ready.`
        : 'An update is downloaded and ready.';
    case 'error':
      return updateStatus?.message ? `Could not check: ${updateStatus.message}` : 'Could not check for updates.';
    default:
      // Idle: a check already ran automatically when the app opened, so
      // there is nothing stale-sounding to say here - just what the button is for.
      return 'Checks automatically every few hours. Updates download in the background and only need a restart to finish.';
  }
}

function SunIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7M18.5 18.5l-1.7-1.7M7.2 7.2 5.5 5.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M20 14.2A8.4 8.4 0 0 1 9.8 4a8.4 8.4 0 1 0 10.2 10.2Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A filled disc, half-cut - distinct from the outlined moon, and reads as "solid black" at a glance. */
function BlackIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.4" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 3.6a8.4 8.4 0 0 1 0 16.8Z" fill="currentColor" />
    </svg>
  );
}
