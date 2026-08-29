import Dropdown from './Dropdown.jsx';
import ScoreBadge from './ScoreBadge.jsx';
import { TagList } from './TagChips.jsx';
import { ordinal, scoreBand } from '../lib/score.js';
import { formatDate, formatHours } from '../lib/stats.js';
import { genreLabels, modeLabels } from '../lib/media.js';

/**
 * Two items, side by side, so a close call can be settled by looking at the
 * numbers rather than by memory. Every category row marks whichever side won
 * it, and the header shows the gap in the overall score.
 */
export default function CompareView({ items, config, selection, onSelect, onSwap, onOpen }) {
  if (items.length < 2) {
    return (
      <div className="empty">
        <h2>Not enough to compare</h2>
        <p>
          Add at least two {config.items} and you can put any pair side by side here — cover art,
          every category score, and the notes you wrote for each.
        </p>
      </div>
    );
  }

  const byId = new Map(items.map((item) => [item.id, item]));
  const left = byId.get(selection[0]) ?? items[0];
  const right = byId.get(selection[1]) ?? items.find((item) => item.id !== left.id) ?? items[1];

  const gap = left.overallScore - right.overallScore;

  return (
    <div className="compare">
      <div className="compare__bar">
        <Picker
          items={items}
          value={left.id}
          exclude={right.id}
          label={`Left ${config.item}`}
          onChange={(id) => onSelect(0, id)}
        />

        <div className="compare__verdict">
          <button type="button" className="btn btn--ghost btn--sm" onClick={onSwap} title="Swap sides">
            <SwapIcon />
            Swap
          </button>
          <p className="compare__gap">
            {gap === 0 ? (
              'Dead even'
            ) : (
              <>
                <strong style={{ color: scoreBand(gap > 0 ? left.overallScore : right.overallScore).color }}>
                  {gap > 0 ? left.title : right.title}
                </strong>{' '}
                leads by {Math.abs(gap)}
              </>
            )}
          </p>
        </div>

        <Picker
          items={items}
          value={right.id}
          exclude={left.id}
          label={`Right ${config.item}`}
          onChange={(id) => onSelect(1, id)}
        />
      </div>

      <div className="compare__grid">
        <CompareCard
          item={left}
          other={right}
          config={config}
          position={items.indexOf(left) + 1}
          onOpen={() => onOpen(left.id)}
        />
        <CompareCard
          item={right}
          other={left}
          config={config}
          position={items.indexOf(right) + 1}
          onOpen={() => onOpen(right.id)}
        />
      </div>
    </div>
  );
}

function Picker({ items, value, exclude, label, onChange }) {
  return (
    <Dropdown
      label={label}
      value={value}
      options={items.map((item) => ({ value: item.id, label: item.title, disabled: item.id === exclude }))}
      onChange={onChange}
      ariaLabel={label}
      wide
    />
  );
}

function CompareCard({ item, other, config, position, onOpen }) {
  const src = item.mainImage ? window.api.imageUrl(item.mainImage) : null;
  const genres = genreLabels(config, item.genres);
  const modes = modeLabels(config, item.modes);
  const note = item.descriptions?.overall?.trim();

  return (
    <article className="cmp">
      <div className="cmp__frame">
        {src ? (
          <img className="cmp__image" src={src} alt={item.title} draggable={false} />
        ) : (
          <div className="cmp__image cmp__image--empty">No image</div>
        )}
        <span className="cmp__rank">{ordinal(position)}</span>
      </div>

      <div className="cmp__body">
        <header className="cmp__head">
          <ScoreBadge value={item.overallScore} size="lg" />
          <div className="cmp__identity">
            <h2 className="cmp__title" title={item.title}>
              {item.title}
            </h2>
            <button type="button" className="cmp__open" onClick={onOpen}>
              Open detail page
            </button>
          </div>
        </header>

        <dl className="cmp__facts">
          <div>
            <dt>{config.hours.label}</dt>
            <dd>{formatHours(item.hoursPlayed)}</dd>
          </div>
          <div>
            <dt>{config.date.label}</dt>
            <dd>{formatDate(item.firstPlayed)}</dd>
          </div>
        </dl>

        <div className="cmp__section">
          <span className="cmp__label">Genres</span>
          <TagList labels={genres} empty="None tagged" />
        </div>

        <div className="cmp__section">
          <span className="cmp__label">{config.modesLabel}</span>
          <TagList labels={modes} empty="Not set" />
        </div>

        <div className="cmp__section">
          <span className="cmp__label">Category scores</span>
          <div className="cmp__rows">
            {config.categories.map((category) => {
              const mineNA = (item.disabledCategories ?? []).includes(category.key);
              const theirsNA = (other.disabledCategories ?? []).includes(category.key);
              const mine = item.categoryScores[category.key];
              const theirs = other.categoryScores[category.key];
              const comparable = !mineNA && !theirsNA;
              const state = !comparable ? 'na' : mine > theirs ? 'win' : mine < theirs ? 'lose' : 'tie';
              return (
                <div key={category.key} className={`cmp__row cmp__row--${state}`}>
                  <span className="cmp__row-label">{category.label}</span>
                  <span className="cmp__row-track">
                    {!mineNA ? (
                      <span
                        className="cmp__row-fill"
                        style={{ width: `${mine}%`, background: scoreBand(mine).color }}
                      />
                    ) : null}
                  </span>
                  <span className="cmp__row-value">
                    {mineNA ? 'N/A' : mine}
                    {comparable && state === 'win' ? (
                      <span className="cmp__win" title="Higher">+{mine - theirs}</span>
                    ) : null}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="cmp__section">
          <span className="cmp__label">Overall note</span>
          <p className={`cmp__note${note ? '' : ' cmp__note--empty'}`}>
            {note || 'Nothing written yet.'}
          </p>
        </div>
      </div>
    </article>
  );
}

function SwapIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3 5.5h9M9.5 3 12 5.5 9.5 8M13 10.5H4M6.5 8 4 10.5 6.5 13"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
