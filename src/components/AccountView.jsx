import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CoffeeIcon } from './SupporterMark.jsx';
import { SUPPORT_CONFIGURED, openSupportPage } from '../lib/support.js';

/**
 * Account settings, in their own sheet.
 *
 * Deliberately not a section of the general Settings sheet: the sidebar has
 * two separate entry points - your email and the gear - and having both land
 * on the same screen meant the email button appeared to do nothing. The email
 * opens this; the gear opens Settings; neither contains the other.
 */
export default function AccountView({
  user,
  onSignUp,
  onSignIn,
  onSignOut,
  profile,
  onDefaultVisibilityChange,
  onUsernameChange,
  onClose,
}) {
  const ref = useRef(null);

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
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Account" tabIndex={-1} ref={ref}>
        <header className="sheet__head">
          <h2>Account</h2>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="settings__body">
          <AccountBody
            user={user}
            onSignUp={onSignUp}
            onSignIn={onSignIn}
            onSignOut={onSignOut}
            profile={profile}
            onDefaultVisibilityChange={onDefaultVisibilityChange}
            onUsernameChange={onUsernameChange}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Signing in is entirely optional - staying signed out is the same fully
 * offline app as before. Email+password only for now, so there is no
 * browser hop to bounce back into the desktop window from.
 */
/**
 * Your username, which is what other people search for. Edited against a
 * local copy so the field does not fight the user mid-type, and only pushed
 * on Save - a username that changes on every keystroke would take the name
 * from someone else for a moment on the way past.
 */
function UsernameRow({ profile, onUsernameChange }) {
  const saved = profile?.username ?? '';
  const [value, setValue] = useState(saved);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState(null);

  // Follow the profile when it arrives (or is changed elsewhere), but never
  // clobber what is currently being typed.
  useEffect(() => {
    setValue((current) => (current === '' || !pending ? saved : current));
  }, [saved]); // eslint-disable-line react-hooks/exhaustive-deps

  const changed = value.trim().toLowerCase() !== saved;

  async function save() {
    if (pending || !changed) return;
    setPending(true);
    setMessage(null);
    const result = await onUsernameChange(value);
    setPending(false);
    setMessage(result?.ok ? { kind: 'ok', text: 'Username updated.' } : { kind: 'error', text: result?.error ?? 'Could not save that.' });
  }

  return (
    <div className="settings__row">
      <div>
        <p className="settings__row-title">Username</p>
        <p className="settings__row-desc">
          How friends find you. Lowercase letters, numbers and underscores, 3–24 characters.
        </p>
        {message ? (
          <p className={`field__hint${message.kind === 'error' ? ' field__hint--error' : ''}`}>
            {message.text}
          </p>
        ) : null}
      </div>
      <div className="settings__username">
        <label className="field">
          <span className="field__control">
            <span className="field__prefix">@</span>
            <input
              type="text"
              className="field__input"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && save()}
              spellCheck="false"
              autoComplete="off"
              aria-label="Username"
            />
          </span>
        </label>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={pending || !changed}
          onClick={save}
        >
          Save
        </button>
      </div>
    </div>
  );
}

/**
 * Buying the developer a coffee, and what it gets you.
 *
 * Two states rather than a hidden button once you have donated: a supporter
 * should be able to see that the app knows, and should still be able to do it
 * again if they want to. Neither state promises a feature - see
 * src/lib/support.js for why the ring is the whole of it.
 *
 * The badge itself is granted by the payment webhook and matched on email, so
 * there is a gap between paying and the ring appearing (a page refresh's
 * worth, usually) and a case where it never appears at all: paying with a
 * different address than you signed in with. The copy says both out loud,
 * because a badge that silently does not turn up reads as a broken payment.
 */
function SupporterRow({ profile }) {
  // Nothing to point at until the Buy Me a Coffee page exists. Better an
  // absent row than a button that opens a 404 in someone's browser.
  if (!SUPPORT_CONFIGURED) return null;

  const isSupporter = Boolean(profile?.isSupporter);

  return (
    <div className="settings__row">
      <div>
        <p className="settings__row-title">
          {isSupporter ? 'Supporter — thank you' : 'Buy me a coffee'}
        </p>
        <p className="settings__row-desc">
          {isSupporter
            ? 'Your profile carries a gold ring wherever other people see it. That is all it does — every feature in the app is the same for everyone.'
            : 'Game Ranker is free and stays free. If it has been worth something to you, a coffee is welcome — supporters get a gold ring on their profile and nothing else.'}
        </p>
        {!isSupporter ? (
          <p className="settings__row-desc">
            The ring is matched to the email you pay with, so use{' '}
            {profile ? 'the address you signed in with' : 'your account address'} if you want it.
            It can take a minute to appear.
          </p>
        ) : null}
      </div>
      <button type="button" className="btn btn--gold btn--sm" onClick={openSupportPage}>
        <CoffeeIcon size={14} />
        {isSupporter ? 'Buy another' : 'Buy me a coffee'}
      </button>
    </div>
  );
}

function AccountBody({
  user,
  onSignUp,
  onSignIn,
  onSignOut,
  profile,
  onDefaultVisibilityChange,
  onUsernameChange,
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);

  async function submit(action) {
    if (pending) return;
    setPending(true);
    setError(null);
    const run = action === 'signUp' ? onSignUp : onSignIn;
    const failure = await run(email, password);
    setPending(false);
    if (failure) setError(failure);
  }

  if (user) {
    const defaultVisibility = profile?.defaultVisibility ?? 'private';
    return (
      <section className="settings__section">
        <div className="settings__row">
          <div>
            <p className="settings__row-title">Signed in as {user.email}</p>
            <p className="settings__row-desc">
              Your rankings sync to your account. Signing out returns to fully local
              mode — nothing already on this device is deleted.
            </p>
          </div>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onSignOut}>
            Sign out
          </button>
        </div>

        <UsernameRow profile={profile} onUsernameChange={onUsernameChange} />

        <SupporterRow profile={profile} />

        <div className="settings__row">
          <div>
            <p className="settings__row-title">Default review visibility</p>
            <p className="settings__row-desc">
              Whether a new review is visible to other users by default. Any single
              review can still be overridden from its own page — see it there as
              Inherit / Public / Private.
            </p>
          </div>
          <div className="segmented" role="radiogroup" aria-label="Default review visibility">
            <button
              type="button"
              role="radio"
              aria-checked={defaultVisibility === 'private'}
              className={`segmented__item${defaultVisibility === 'private' ? ' is-on' : ''}`}
              onClick={() => onDefaultVisibilityChange('private')}
            >
              Private
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={defaultVisibility === 'public'}
              className={`segmented__item${defaultVisibility === 'public' ? ' is-on' : ''}`}
              onClick={() => onDefaultVisibilityChange('public')}
            >
              Public
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="settings__section">
      <p className="settings__row-desc">
        Sign in to sync your rankings across devices. Staying signed out keeps the app
        exactly as it works today — fully offline, nothing sent anywhere.
      </p>

      <div className="settings__creds">
        <label className="field">
          <span className="field__label">Email</span>
          <span className="field__control">
            <input
              type="email"
              className="field__input"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              spellCheck="false"
            />
          </span>
        </label>
        <label className="field">
          <span className="field__label">Password</span>
          <span className="field__control">
            <input
              type="password"
              className="field__input"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
            />
          </span>
        </label>
      </div>

      {error ? <p className="field__hint field__hint--error">{error}</p> : null}

      <div className="settings__account-actions">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={pending || !email || !password}
          onClick={() => submit('signIn')}
        >
          Sign in
        </button>
        <button
          type="button"
          className="btn btn--primary btn--sm"
          disabled={pending || !email || !password}
          onClick={() => submit('signUp')}
        >
          Sign up
        </button>
      </div>
    </section>
  );
}
