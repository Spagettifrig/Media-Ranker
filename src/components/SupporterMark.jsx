/**
 * The mark someone carries for having bought the developer a coffee.
 *
 * Drawn next to a name; the gold ring that goes with it is a class on the
 * avatar itself (`is-supporter`), since a ring is a border on an existing
 * element rather than an element of its own.
 *
 * Renders nothing when they are not a supporter, so callers can drop it in
 * unconditionally rather than guarding every use site.
 */
export default function SupporterMark({ isSupporter, size = 'sm' }) {
  if (!isSupporter) return null;
  return (
    <span
      className={`supporter-mark supporter-mark--${size}`}
      title="Supporter — bought the developer a coffee"
      aria-label="Supporter"
    >
      <CoffeeIcon />
    </span>
  );
}

export function CoffeeIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.6 5.4h8.6v4.1a3.2 3.2 0 0 1-3.2 3.2H5.8a3.2 3.2 0 0 1-3.2-3.2V5.4Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M11.2 6.5h1.1a1.8 1.8 0 0 1 0 3.6h-1.1"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5.4 1.9v1.6M8.4 1.9v1.6"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}
