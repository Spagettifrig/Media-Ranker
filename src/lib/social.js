/**
 * The first `count` sentences of free text, for a review excerpt. Splits on
 * `.`/`!`/`?` followed by whitespace - good enough for prose, no need for
 * real sentence-boundary detection here.
 */
export function firstSentences(text, count = 2) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return '';
  const sentences = trimmed.match(/[^.!?]+[.!?]*/g) ?? [trimmed];
  return sentences.slice(0, count).join(' ').trim();
}

/** Whether an excerpt actually dropped text, i.e. whether "Read more" has anything to reveal. */
export function isTruncated(text, count = 2) {
  return firstSentences(text, count).length < String(text ?? '').trim().length;
}
