/** Quiet confirmation that autosave is doing its job. */
export default function SaveIndicator({ state }) {
  const saving = state === 'saving';
  return (
    <span className={`save-indicator${saving ? ' is-saving' : ''}`} role="status" aria-live="polite">
      <span className="save-indicator__dot" aria-hidden="true" />
      {saving ? 'Saving' : 'Saved'}
    </span>
  );
}
