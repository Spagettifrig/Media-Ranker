/**
 * App-wide settings (as opposed to per-library data). Kept small and
 * validated on load, since this shape is persisted to disk and read back.
 */

export const DEFAULT_COVER_ASPECT = '5 / 4';

/** Curated so an average user finds their box art / poster shape without guessing a raw ratio. */
export const COVER_ASPECT_OPTIONS = [
  { value: '1 / 1', label: 'Square' },
  { value: '3 / 4', label: 'Portrait' },
  { value: '2 / 3', label: 'Poster' },
  { value: '9 / 16', label: 'Tall' },
  { value: DEFAULT_COVER_ASPECT, label: 'Standard' },
  { value: '4 / 3', label: 'Classic' },
  { value: '3 / 2', label: 'Photo' },
  { value: '16 / 9', label: 'Widescreen' },
];

const VALID_ASPECTS = new Set(COVER_ASPECT_OPTIONS.map((option) => option.value));

export function normalizeCoverAspect(value) {
  return VALID_ASPECTS.has(value) ? value : DEFAULT_COVER_ASPECT;
}
