/**
 * Everything the Stats view draws is derived here, so the charts stay dumb.
 * Nothing is stored: these numbers are always recomputed from the board.
 */
import { SCORE_BANDS, clampScore, scoreBand } from './score.js';

/** Single hue for charts that show one measure and need no identity colours. */
export const ACCENT = '#7f9bff';

const HOURS_CHART_LIMIT = 12;

function average(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, n) => sum + n, 0) / values.length;
}

/** 12.5 -> "12.5h", 40 -> "40h" */
export function formatHours(hours) {
  if (hours === null || hours === undefined) return '--';
  const rounded = Math.round(hours * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}h`;
}

/** "2019-04-07" -> "7 Apr 2019" */
export function formatDate(value) {
  if (!value) return '--';
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Counts and mean score for one set of tags (genres or modes). */
function tagBreakdown(items, tags, field) {
  return tags
    .map((tag) => {
      const owned = items.filter((item) => (item[field] ?? []).includes(tag.key));
      const mean = average(owned.map((item) => clampScore(item.overallScore)));
      return {
        key: tag.key,
        label: tag.label,
        count: owned.length,
        average: mean === null ? null : Math.round(mean),
      };
    })
    .filter((entry) => entry.count > 0);
}

export function summarize(items, config) {
  const scores = items.map((item) => clampScore(item.overallScore));
  const timed = items.filter((item) => typeof item.hoursPlayed === 'number' && item.hoursPlayed > 0);
  const dated = items.filter((item) => Boolean(item.firstPlayed));

  const totalHours = timed.reduce((sum, item) => sum + item.hoursPlayed, 0);
  const best = items.reduce(
    (top, item) => (top === null || item.overallScore > top.overallScore ? item : top),
    null,
  );

  /* Score distribution, drawn low -> high so the axis reads left to right. */
  const bands = [...SCORE_BANDS].reverse().map((band) => ({
    key: `${band.min}-${band.max}`,
    label: band.min === 0 ? '0-19' : `${band.min}-${band.max}`,
    color: band.color,
    name: band.name,
    count: scores.filter((score) => score >= band.min && score <= band.max).length,
  }));

  /* How the library scores per category - where your taste actually sits.
     Items with the category marked N/A sit out of that category's average. */
  const categoryAverages = config.categories.map((category) => {
    const applicable = items.filter((item) => !(item.disabledCategories ?? []).includes(category.key));
    const mean = average(applicable.map((item) => clampScore(item.categoryScores[category.key])));
    return {
      key: category.key,
      label: category.label,
      value: mean === null ? null : Math.round(mean),
    };
  });

  /* Biggest time sinks, longest first. */
  const hoursRanking = timed
    .slice()
    .sort((a, b) => b.hoursPlayed - a.hoursPlayed)
    .slice(0, HOURS_CHART_LIMIT)
    .map((item) => ({
      id: item.id,
      title: item.title,
      hours: item.hoursPlayed,
      score: clampScore(item.overallScore),
    }));

  /* Items started per year, gap years included so the axis is honest. */
  const years = dated.map((item) => Number(item.firstPlayed.slice(0, 4)));
  let yearCounts = [];
  if (years.length > 0) {
    const from = Math.min(...years);
    const to = Math.max(...years);
    const span = to - from + 1;
    // A giant range would produce unreadable bars; fall back to only real years.
    const axis =
      span <= 30
        ? Array.from({ length: span }, (_, i) => from + i)
        : [...new Set(years)].sort((a, b) => a - b);
    yearCounts = axis.map((year) => ({
      year,
      count: years.filter((y) => y === year).length,
    }));
  }

  /* Hours against score - does time spent track how much you liked it? */
  const scatter = timed.map((item) => ({
    id: item.id,
    title: item.title,
    hours: item.hoursPlayed,
    score: clampScore(item.overallScore),
    color: scoreBand(item.overallScore).color,
  }));

  const genreBreakdown = tagBreakdown(items, config.genres, 'genres');
  const modeBreakdown = tagBreakdown(items, config.modes, 'modes');

  return {
    count: items.length,
    averageScore: scores.length === 0 ? null : Math.round(average(scores)),
    totalHours: timed.length === 0 ? null : totalHours,
    timedCount: timed.length,
    datedCount: dated.length,
    longest: hoursRanking[0] ?? null,
    best,
    bands,
    categoryAverages,
    hoursRanking,
    yearCounts,
    scatter,
    genreBreakdown: [...genreBreakdown].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    modeBreakdown,
    untaggedCount: items.filter((item) => (item.genres ?? []).length === 0).length,
  };
}
