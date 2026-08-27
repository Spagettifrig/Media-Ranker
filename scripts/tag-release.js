'use strict';

/**
 * Creates and pushes the git tag for the version in package.json, so that
 * `electron-builder --publish always` has a tag to publish *onto*.
 *
 * Why this exists
 * ---------------
 * GitHub's create-release API rejects `releaseType: "release"` unless a
 * matching tag already exists, which is why this project fell back to
 * publishing drafts. That fallback had two costs:
 *
 *  1. A draft is invisible to electron-updater, so every release from v1.2.1
 *     to v1.5.0 sat unpublished and nobody ever received an update. The
 *     "one manual click on GitHub" the old flow relied on is easy to forget,
 *     and nothing fails loudly when it is.
 *
 *  2. Drafts have no tag, so GitHub cannot tell two of them apart. When
 *     electron-builder ran its publisher twice concurrently, both calls saw
 *     "release doesn't exist" and each created its own draft - splitting the
 *     installer and latest.yml across two half-releases.
 *
 * Creating the tag first fixes both: the release publishes immediately, and a
 * second concurrent create is rejected as a duplicate, so electron-builder
 * reuses the existing release instead of inventing another one.
 *
 * Idempotent: re-running for a version that is already tagged and pushed is a
 * no-op, so a failed release can simply be retried.
 */

const { execFileSync } = require('node:child_process');
const { version } = require('../package.json');

const tag = `v${version}`;

/** git, captured. Throws on non-zero exit, which is what we want everywhere below. */
function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

/** Same, but a non-zero exit is an answer rather than a failure. */
function gitOk(...args) {
  try {
    git(...args);
    return true;
  } catch {
    return false;
  }
}

function fail(message) {
  console.error(`\n[tag-release] ${message}\n`);
  process.exit(1);
}

// A tag is a promise about what the code was at that moment; tagging a dirty
// tree makes it a lie, and the built installer would not match the tag.
if (git('status', '--porcelain')) {
  fail(
    `Working tree has uncommitted changes. Commit or stash them before releasing ${tag}.\n` +
      `Release builds must come from committed code - see RELEASING.md.`,
  );
}

const head = git('rev-parse', 'HEAD');

if (gitOk('rev-parse', '--verify', `refs/tags/${tag}`)) {
  // Already tagged locally. Fine if it points at HEAD - otherwise the version
  // in package.json was almost certainly not bumped for this release.
  const tagged = git('rev-list', '-n', '1', tag);
  if (tagged !== head) {
    fail(
      `Tag ${tag} already exists but points at ${tagged.slice(0, 7)}, not HEAD (${head.slice(0, 7)}).\n` +
        `Bump "version" in package.json - you are re-releasing a version that is already out.`,
    );
  }
  console.log(`[tag-release] ${tag} already exists at HEAD.`);
} else {
  git('tag', '-a', tag, '-m', `Release ${tag}`);
  console.log(`[tag-release] created ${tag} at ${head.slice(0, 7)}`);
}

// Push is not optional: electron-builder asks GitHub for the tag, so a tag that
// exists only on this machine helps nobody.
git('push', 'origin', tag);
console.log(`[tag-release] pushed ${tag} to origin.`);
