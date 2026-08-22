import { useMemo } from 'react';
import ScoreBadge from './ScoreBadge.jsx';
import { scoreBand } from '../lib/score.js';
import { ACCENT, formatDate, formatHours, summarize } from '../lib/stats.js';
import { genreLabels } from '../lib/media.js';

/**
 * A read-only look at the board: how the scores spread out, where the time
 * went, and when things were played. Every chart is derived from the same
 * items array the board renders, so the two can never disagree.
 */
export default function StatsView({ items, config, onOpen }) {
  const stats = useMemo(() => summarize(items, config), [items, config]);

  if (stats.count === 0) {
    return (
      <div className="empty">
        <h2>No stats yet</h2>
        <p>
          Rank a few {config.items} and this page fills in - score spread, category averages,
          genres, {config.hours.label.toLowerCase()} and when you first got to each one.
        </p>
      </div>
    );
  }

  return (
    <div className="stats">
      <section className="tiles" aria-label="Summary">
        <Tile label={`${config.Item}s ranked`} value={stats.count} />
        <Tile
          label="Average score"
          value={stats.averageScore}
          accent={scoreBand(stats.averageScore).color}
        />
        <Tile
          label={config.hours.totalLabel}
          value={stats.totalHours === null ? '--' : formatHours(stats.totalHours)}
          note={
            stats.timedCount === stats.count
              ? `across every ${config.item}`
              : `across ${stats.timedCount} of ${stats.count} ${config.items}`
          }
        />
        <Tile
          label={config.hours.longestLabel}
          value={stats.longest ? formatHours(stats.longest.hours) : '--'}
          note={stats.longest ? stats.longest.title : 'nothing logged yet'}
        />
      </section>

      <Chart
        title="Score distribution"
        note="How many land in each colour band of the 1-100 scale."
      >
        <Columns
          items={stats.bands.map((band) => ({
            key: band.key,
            label: band.label,
            value: band.count,
            color: band.color,
            title: `${band.name} (${band.label}): ${band.count} ${band.count === 1 ? config.item : config.items}`,
          }))}
          format={(n) => n || ''}
        />
      </Chart>

      <Chart
        title="Category averages"
        note="Your library's mean score in each category, coloured by the same scale."
      >
        <div className="bars">
          {stats.categoryAverages.map((category) => (
            <Bar
              key={category.key}
              label={category.label}
              value={category.value}
              max={100}
              color={scoreBand(category.value).color}
              display={String(category.value)}
            />
          ))}
        </div>
      </Chart>

      {stats.genreBreakdown.length > 0 ? (
        <Chart
          title="Genres"
          note={
            stats.untaggedCount > 0
              ? `How many carry each genre, and how they average. ${stats.untaggedCount} untagged.`
              : 'How many carry each genre, and how they average.'
          }
        >
          <div className="bars">
            {stats.genreBreakdown.map((genre) => (
              <Bar
                key={genre.key}
                label={genre.label}
                value={genre.count}
                max={stats.genreBreakdown[0].count}
                color={scoreBand(genre.average).color}
                display={`${genre.count} · avg ${genre.average}`}
              />
            ))}
          </div>
        </Chart>
      ) : (
        <Chart title="Genres" note="Nothing tagged yet.">
          <p className="chart__empty">
            Open {config.item === 'movie' ? 'a movie' : 'a game'} and pick its{' '}
            <strong>genres</strong> to break the library down here.
          </p>
        </Chart>
      )}

      {stats.modeBreakdown.length > 0 ? (
        <Chart title={config.modesLabel} note={`How the library splits by ${config.modesLabel.toLowerCase()}.`}>
          <div className="bars">
            {stats.modeBreakdown.map((mode) => (
              <Bar
                key={mode.key}
                label={mode.label}
                value={mode.count}
                max={Math.max(...stats.modeBreakdown.map((entry) => entry.count))}
                color={ACCENT}
                display={`${mode.count} · avg ${mode.average}`}
              />
            ))}
          </div>
        </Chart>
      ) : null}

      {stats.hoursRanking.length > 0 ? (
        <Chart title={config.hours.chartTitle} note={config.hours.chartNote}>
          <div className="bars">
            {stats.hoursRanking.map((entry) => (
              <Bar
                key={entry.id}
                label={entry.title}
                value={entry.hours}
                max={stats.hoursRanking[0].hours}
                color={ACCENT}
                display={formatHours(entry.hours)}
                onSelect={() => onOpen(entry.id)}
              />
            ))}
          </div>
        </Chart>
      ) : (
        <Chart title={config.hours.chartTitle} note="Nothing logged yet.">
          <p className="chart__empty">
            Open one and fill in <strong>{config.hours.label}</strong> to see it charted here.
          </p>
        </Chart>
      )}

      {stats.scatter.length > 1 ? (
        <Chart
          title={config.hours.scatterTitle}
          note="One dot each - hours across, score up - coloured by its score band."
        >
          <Scatter points={stats.scatter} onOpen={onOpen} />
        </Chart>
      ) : null}

      {stats.yearCounts.length > 0 ? (
        <Chart title={config.date.chartTitle} note={config.date.chartNote}>
          <Columns
            items={stats.yearCounts.map((entry) => ({
              key: entry.year,
              label: String(entry.year),
              value: entry.count,
              color: ACCENT,
              title: `${entry.year}: ${entry.count} ${entry.count === 1 ? config.item : config.items}`,
            }))}
            format={(n) => n || ''}
          />
        </Chart>
      ) : (
        <Chart title={config.date.chartTitle} note="No dates yet.">
          <p className="chart__empty">
            Open one and set <strong>{config.date.label}</strong> to build a timeline here.
          </p>
        </Chart>
      )}

      <Chart title="Full ranking" note="The board as a table - scores, genres and dates.">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">{config.Item}</th>
                <th scope="col">Genres</th>
                <th scope="col">Score</th>
                <th scope="col">{config.hours.label}</th>
                <th scope="col">{config.date.label}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, index) => (
                <tr
                  key={item.id}
                  onClick={() => onOpen(item.id)}
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') onOpen(item.id);
                  }}
                >
                  <td className="table__num">{index + 1}</td>
                  <td className="table__title">
                    <ScoreBadge value={item.overallScore} size="sm" />
                    <span>{item.title}</span>
                  </td>
                  <td className="table__tags">{genreLabels(config, item.genres).join(', ') || '--'}</td>
                  <td className="table__num">{item.overallScore}</td>
                  <td className="table__num">{formatHours(item.hoursPlayed)}</td>
                  <td className="table__num">{formatDate(item.firstPlayed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Chart>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Pieces
 * ------------------------------------------------------------------ */
function Tile({ label, value, note, accent }) {
  return (
    <div className="tile">
      <span className="tile__label">{label}</span>
      <span className="tile__value" style={accent ? { color: accent } : undefined}>
        {value ?? '--'}
      </span>
      {note ? <span className="tile__note">{note}</span> : null}
    </div>
  );
}

function Chart({ title, note, children }) {
  return (
    <section className="chart" aria-label={title}>
      <div className="chart__head">
        <h2 className="chart__title">{title}</h2>
        {note ? <p className="chart__note">{note}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** Vertical bars. Heights are exact; the value floats above the bar. */
function Columns({ items, format }) {
  const max = Math.max(1, ...items.map((item) => item.value));
  return (
    <div className="cols">
      {items.map((item) => (
        <div className="col" key={item.key}>
          <div className="col__plot">
            <div
              className="col__bar"
              style={{ height: `${(item.value / max) * 100}%`, background: item.color }}
              title={item.title}
            >
              <span className="col__value">{format(item.value)}</span>
            </div>
          </div>
          <span className="col__label">{item.label}</span>
        </div>
      ))}
    </div>
  );
}

/** One horizontal bar. Clickable rows jump to that item's detail page. */
function Bar({ label, value, max, color, display, onSelect }) {
  const width = max > 0 ? Math.max(1.5, (value / max) * 100) : 0;
  const Row = onSelect ? 'button' : 'div';
  return (
    <Row
      className={`bar${onSelect ? ' bar--action' : ''}`}
      type={onSelect ? 'button' : undefined}
      onClick={onSelect}
      title={`${label}: ${display}`}
    >
      <span className="bar__label">{label}</span>
      <span className="bar__track">
        <span className="bar__fill" style={{ width: `${width}%`, background: color }} />
      </span>
      <span className="bar__value">{display}</span>
    </Row>
  );
}

const PLOT = { w: 720, h: 320, left: 44, right: 16, top: 16, bottom: 34 };

function Scatter({ points, onOpen }) {
  const maxHours = Math.max(...points.map((point) => point.hours));
  const innerW = PLOT.w - PLOT.left - PLOT.right;
  const innerH = PLOT.h - PLOT.top - PLOT.bottom;

  const x = (hours) => PLOT.left + (maxHours > 0 ? (hours / maxHours) * innerW : 0);
  const y = (score) => PLOT.top + innerH - (score / 100) * innerH;

  const yTicks = [0, 25, 50, 75, 100];
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(maxHours * f));

  return (
    <svg
      className="scatter"
      viewBox={`0 0 ${PLOT.w} ${PLOT.h}`}
      role="img"
      aria-label={`Hours against score for ${points.length} entries`}
    >
      {yTicks.map((tick) => (
        <g key={`y${tick}`}>
          <line
            x1={PLOT.left}
            x2={PLOT.w - PLOT.right}
            y1={y(tick)}
            y2={y(tick)}
            className="scatter__grid"
          />
          <text x={PLOT.left - 10} y={y(tick) + 4} className="scatter__tick" textAnchor="end">
            {tick}
          </text>
        </g>
      ))}

      {xTicks.map((tick, i) => (
        <text
          key={`x${i}`}
          x={x(tick)}
          y={PLOT.h - 12}
          className="scatter__tick"
          textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}
        >
          {tick}h
        </text>
      ))}

      {points.map((point) => (
        <circle
          key={point.id}
          cx={x(point.hours)}
          cy={y(point.score)}
          r="6"
          fill={point.color}
          className="scatter__dot"
          onClick={() => onOpen(point.id)}
        >
          <title>{`${point.title} - ${formatHours(point.hours)}, score ${point.score}`}</title>
        </circle>
      ))}
    </svg>
  );
}
