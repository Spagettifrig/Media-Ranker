import { useCallback, useEffect, useRef, useState } from 'react';
import CommunityReviews from './CommunityReviews.jsx';
import ConfirmDialog from './ConfirmDialog.jsx';
import ScoreSlider from './ScoreSlider.jsx';
import SaveIndicator from './SaveIndicator.jsx';
import TagChips from './TagChips.jsx';
import TrophyBadge from './TrophyBadge.jsx';
import { isGoldScore, ordinal } from '../lib/score.js';
import { allImagesOf } from '../lib/model.js';
import { trophiesFor, trophyTitle } from '../lib/awards.js';
import { hasPlatforms, platformGroups } from '../lib/media.js';
import { formatDate, formatHours } from '../lib/stats.js';

const VISIBILITY_OPTIONS = [
  { value: 'inherit', label: 'Inherit' },
  { value: 'public', label: 'Public' },
  { value: 'private', label: 'Private' },
];

const SWIPE_THRESHOLD_PX = 60;
/** How long a typed score sits half-finished before it commits itself. */
const SCORE_ENTRY_IDLE_MS = 900;

export default function DetailView({
  item,
  config,
  position,
  saveState,
  importing,
  onBack,
  onTitleChange,
  onScoreChange,
  onDescriptionChange,
  onAddImages,
  onMakeMain,
  onRemoveImage,
  onDelete,
  onHoursChange,
  onFirstPlayedChange,
  onToggleGenre,
  onToggleMode,
  onTogglePlatform,
  onToggleCategoryApplicable,
  trophies,
  user,
  onVisibilityChange,
  onOpenProfile,
}) {
  const images = allImagesOf(item);
  const won = trophiesFor(trophies, item);
  const [index, setIndex] = useState(0);
  const swipeStart = useRef(null);

  /* Which category the keyboard is pointed at, and the digits typed so far. */
  const [activeCategory, setActiveCategory] = useState(0);
  const [entry, setEntry] = useState('');
  const entryTimer = useRef(null);

  // Keep the carousel in range when the item or its images change.
  useEffect(() => {
    setIndex(0);
    setActiveCategory(0);
    setEntry('');
  }, [item.id]);

  useEffect(() => {
    setIndex((current) => (current > images.length - 1 ? Math.max(0, images.length - 1) : current));
  }, [images.length]);

  useEffect(() => () => clearTimeout(entryTimer.current), []);

  const step = useCallback(
    (delta) => {
      if (images.length < 2) return;
      setIndex((current) => (current + delta + images.length) % images.length);
    },
    [images.length],
  );

  const categories = config.categories;
  const disabledCategories = item.disabledCategories ?? [];
  const enabledCount = categories.length - disabledCategories.length;

  /* Digits land on the highlighted category, one at a time: "8" then "5" is
     85, "1" "0" "0" is 100. Each keystroke applies straight away so the slider
     tracks what you typed, and the buffer clears once you stop. A category
     marked N/A doesn't take typed scores - toggle it back on first. */
  const pushDigit = useCallback(
    (digit) => {
      const category = categories[activeCategory];
      if (!category || disabledCategories.includes(category.key)) return;
      setEntry((current) => {
        const next = current.length >= 3 ? digit : `${current}${digit}`;
        onScoreChange(category.key, Number(next));
        clearTimeout(entryTimer.current);
        entryTimer.current = setTimeout(() => setEntry(''), SCORE_ENTRY_IDLE_MS);
        return next;
      });
    },
    [activeCategory, categories, disabledCategories, onScoreChange],
  );

  useEffect(() => {
    function onKeyDown(event) {
      const tag = event.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target?.isContentEditable) {
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      if (/^[0-9]$/.test(event.key)) {
        event.preventDefault();
        pushDigit(event.key);
        return;
      }

      switch (event.key) {
        case 'ArrowLeft':
          event.preventDefault();
          step(-1);
          break;
        case 'ArrowRight':
          event.preventDefault();
          step(1);
          break;
        case 'ArrowUp':
          event.preventDefault();
          setEntry('');
          setActiveCategory((current) => (current - 1 + categories.length) % categories.length);
          break;
        case 'ArrowDown':
          event.preventDefault();
          setEntry('');
          setActiveCategory((current) => (current + 1) % categories.length);
          break;
        case 'Enter':
          if (entry) {
            event.preventDefault();
            clearTimeout(entryTimer.current);
            setEntry('');
          }
          break;
        case 'Escape':
          event.preventDefault();
          if (entry) {
            clearTimeout(entryTimer.current);
            setEntry('');
          } else {
            onBack();
          }
          break;
        default:
          break;
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [step, onBack, pushDigit, categories.length, entry]);

  function handlePointerDown(event) {
    swipeStart.current = { x: event.clientX, y: event.clientY };
  }

  function handlePointerUp(event) {
    const start = swipeStart.current;
    swipeStart.current = null;
    if (!start) return;
    const dx = event.clientX - start.x;
    if (Math.abs(dx) > SWIPE_THRESHOLD_PX && Math.abs(dx) > Math.abs(event.clientY - start.y)) {
      step(dx < 0 ? 1 : -1);
    }
  }

  const currentFile = images[index] ?? null;
  const isMain = currentFile != null && currentFile === item.mainImage;

  /* Hours are edited as free text so half-typed values like "12." survive; the
     board only ever stores the parsed number. */
  const [hoursText, setHoursText] = useState(
    item.hoursPlayed === null ? '' : String(item.hoursPlayed),
  );
  useEffect(() => {
    setHoursText(item.hoursPlayed === null ? '' : String(item.hoursPlayed));
  }, [item.id]);

  function handleHoursInput(event) {
    setHoursText(event.target.value);
    onHoursChange(event.target.value);
  }

  function handleHoursBlur(event) {
    const next = item.hoursPlayed === null ? '' : String(item.hoursPlayed);
    setHoursText(next);
    // A half-typed value ("12.") leaves a number input in its "bad input" state,
    // where it reports '' - React sees no change and skips the rewrite, so the
    // stale text has to be cleared by hand.
    if (event.target.validity?.badInput || event.target.value !== next) {
      event.target.value = next;
    }
  }

  function handleRemoveImage() {
    if (!currentFile) return;
    onRemoveImage(currentFile);
  }

  const [confirmingDelete, setConfirmingDelete] = useState(false);

  return (
    <>
    <div className="screen detail">
      <header className="detail__header">
        <button type="button" className="btn btn--ghost" onClick={onBack}>
          <ArrowLeftIcon />
          Board
        </button>

        <div className="detail__identity">
          <span className="detail__rank">{ordinal(position)}</span>
          <input
            className="detail__title"
            value={item.title}
            onChange={(event) => onTitleChange(event.target.value)}
            placeholder={`Untitled ${config.Item}`}
            aria-label={`${config.Item} title`}
            spellCheck="false"
          />
        </div>

        <div className="detail__header-actions">
          {won.length > 0 ? <TrophyBadge trophies={won} size="lg" /> : null}
          <SaveIndicator state={saveState} />
          <button
            type="button"
            className="btn btn--danger-ghost"
            onClick={() => setConfirmingDelete(true)}
          >
            Delete
          </button>
        </div>
      </header>

      <div className="detail__body">
        <section className="stage" aria-label="Images">
          <div
            className={`stage__frame${isGoldScore(item.overallScore) ? ' stage__frame--gold' : ''}`}
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
          >
            {currentFile ? (
              <img
                className="stage__image"
                src={window.api.imageUrl(currentFile)}
                alt={`${item.title} image ${index + 1} of ${images.length}`}
                draggable={false}
              />
            ) : (
              <div className="stage__placeholder">
                <p>No images yet</p>
                <button type="button" className="btn btn--primary" onClick={onAddImages} disabled={importing}>
                  Add images
                </button>
              </div>
            )}

            {images.length > 1 ? (
              <>
                <button
                  type="button"
                  className="stage__arrow stage__arrow--prev"
                  onClick={() => step(-1)}
                  aria-label="Previous image"
                >
                  <ChevronIcon />
                </button>
                <button
                  type="button"
                  className="stage__arrow stage__arrow--next"
                  onClick={() => step(1)}
                  aria-label="Next image"
                >
                  <ChevronIcon />
                </button>
                <span className="stage__counter">
                  {index + 1} / {images.length}
                </span>
              </>
            ) : null}

            {isMain && images.length > 1 ? <span className="stage__badge">Main image</span> : null}
          </div>

          {images.length > 0 ? (
            <div className="stage__tools">
              <div className="thumbs" role="tablist" aria-label="Gallery">
                {images.map((file, i) => (
                  <button
                    key={file}
                    type="button"
                    role="tab"
                    aria-selected={i === index}
                    className={`thumb${i === index ? ' is-active' : ''}`}
                    onClick={() => setIndex(i)}
                    aria-label={`Image ${i + 1}`}
                  >
                    <img src={window.api.imageUrl(file)} alt="" draggable={false} />
                  </button>
                ))}
                <button
                  type="button"
                  className="thumb thumb--add"
                  onClick={onAddImages}
                  disabled={importing}
                  aria-label="Add images"
                  title="Add images"
                >
                  +
                </button>
              </div>

              <div className="stage__buttons">
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => onMakeMain(currentFile)}
                  disabled={isMain || !currentFile}
                >
                  Set as main
                </button>
                <button
                  type="button"
                  className="btn btn--danger-ghost btn--sm"
                  onClick={handleRemoveImage}
                  disabled={!currentFile}
                >
                  Remove image
                </button>
              </div>
            </div>
          ) : null}
        </section>

        <section className="tagging" aria-label="Tags">
          <div className="tagging__group">
            <span className="field__label">Genres</span>
            <TagChips
              tags={config.genres}
              selected={item.genres}
              onToggle={onToggleGenre}
              ariaLabel="Genres"
            />
          </div>
          <div className="tagging__group">
            <span className="field__label">{config.modesLabel}</span>
            <TagChips
              tags={config.modes}
              selected={item.modes}
              onToggle={onToggleMode}
              ariaLabel={config.modesLabel}
            />
          </div>

          {/* Grouped by console family, and multi-select on purpose: playing
              the same game on a 360 and later on a PC is the normal case. */}
          {hasPlatforms(config) ? (
            <div className="tagging__group tagging__group--wide">
              <span className="field__label">{config.platformsLabel}</span>
              <div className="platforms">
                {platformGroups(config).map((group) => (
                  <div key={group.label} className="platforms__group">
                    <span className="platforms__family">{group.label}</span>
                    <TagChips
                      tags={group.platforms}
                      selected={item.platforms}
                      onToggle={onTogglePlatform}
                      ariaLabel={`${config.platformsLabel} - ${group.label}`}
                    />
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </section>

        {won.length > 0 ? (
          <section className="detail__trophies" aria-label="Awards">
            {won.map((trophy) => (
              <span
                key={`${trophy.year}-${trophy.categoryKey}-${trophy.kind}`}
                className={`detail__trophy detail__trophy--${trophy.kind}${
                  trophy.direction === 'worst' ? ' detail__trophy--worst' : ''
                }`}
              >
                {trophyTitle(trophy)}
              </span>
            ))}
          </section>
        ) : null}

        <section className="playlog" aria-label="Log">
          <label className="field">
            <span className="field__label">{config.hours.label}</span>
            <div className="field__control">
              <input
                className="field__input"
                type="number"
                min="0"
                step="0.5"
                inputMode="decimal"
                value={hoursText}
                onChange={handleHoursInput}
                onBlur={handleHoursBlur}
                placeholder="0"
              />
              <span className="field__unit">{config.hours.unit}</span>
            </div>
            <span className="field__hint">
              {item.hoursPlayed === null
                ? config.hours.untracked
                : `${formatHours(item.hoursPlayed)} ${config.hours.logged}`}
            </span>
          </label>

          <label className="field">
            <span className="field__label">{config.date.label}</span>
            <div className="field__control">
              <input
                className="field__input"
                type="date"
                max="9999-12-31"
                value={item.firstPlayed}
                onChange={(event) => onFirstPlayedChange(event.target.value)}
              />
            </div>
            <span className="field__hint">
              {item.firstPlayed ? formatDate(item.firstPlayed) : config.date.empty}
            </span>
          </label>

          <div className="field">
            <span className="field__label">Added to board</span>
            <div className="field__control field__control--static">
              <span className="field__static">
                {item.addedAt ? formatDate(item.addedAt.slice(0, 10)) : 'Before this was tracked'}
              </span>
            </div>
            <span className="field__hint">Used by the “Recently added” sort</span>
          </div>
        </section>

        <section className="scores" aria-label="Scores">
          <ScoreSlider
            label="Overall Score"
            value={item.overallScore}
            variant="overall"
            readOnly
            hint={
              enabledCount < categories.length
                ? `Average of ${enabledCount} of ${categories.length} categories below — ${
                    categories.length - enabledCount
                  } marked N/A`
                : `Average of the ${categories.length} categories below`
            }
          />

          <div className="scores__grid">
            {categories.map((category, i) => (
              <ScoreSlider
                key={category.key}
                label={category.label}
                value={item.categoryScores[category.key]}
                active={i === activeCategory}
                pending={i === activeCategory ? entry : ''}
                notApplicable={disabledCategories.includes(category.key)}
                onChange={(value) => onScoreChange(category.key, value)}
                onFocus={() => setActiveCategory(i)}
                onToggleApplicable={() => onToggleCategoryApplicable(category.key)}
              />
            ))}
          </div>

          <p className="scores__hint">
            <kbd>↑</kbd> <kbd>↓</kbd> pick a category, then type a score —{' '}
            <kbd>8</kbd> <kbd>5</kbd> for 85. Mark a category <strong>N/A</strong> if it doesn't
            apply to this {config.item} — it's left out of the average.
          </p>
        </section>

        <section className="notes" aria-label="Notes">
          {config.descriptionFields.map((field) => (
            <label key={field.key} className={`note note--${field.key === 'overall' ? 'overall' : 'category'}`}>
              <span className="note__label">{field.label}</span>
              <textarea
                className="note__input"
                value={item.descriptions[field.key] ?? ''}
                placeholder={field.placeholder}
                onChange={(event) => onDescriptionChange(field.key, event.target.value)}
                rows={field.key === 'overall' ? 3 : 4}
              />
            </label>
          ))}
        </section>

        {user && item.provider && item.providerId ? (
          <section className="sharing" aria-label="Sharing">
            <div className="settings__row">
              <div>
                <p className="settings__row-title">Sharing</p>
                <p className="settings__row-desc">
                  Inherit follows your account's default (Settings → Account). Public or
                  Private always override it for just this one review.
                </p>
              </div>
              <div className="segmented" role="radiogroup" aria-label="Visibility">
                {VISIBILITY_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={(item.visibility ?? 'inherit') === option.value}
                    className={`segmented__item${(item.visibility ?? 'inherit') === option.value ? ' is-on' : ''}`}
                    onClick={() => onVisibilityChange(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </section>
        ) : null}

        <CommunityReviews item={item} user={user} config={config} onOpenProfile={onOpenProfile} />
      </div>
    </div>
    {confirmingDelete ? (
      <ConfirmDialog
        title={`Delete this ${config.item}?`}
        message={`"${item.title}" and its images and notes will be removed. This can't be undone.`}
        confirmLabel="Delete"
        onConfirm={() => {
          setConfirmingDelete(false);
          onDelete();
        }}
        onCancel={() => setConfirmingDelete(false)}
      />
    ) : null}
    </>
  );
}

function ArrowLeftIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M10 3 5 8l5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M10 3 5 8l5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
