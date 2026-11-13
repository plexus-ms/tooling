// What a repo taking a version writes besides copier's update: the workflow
// refs moved to the version, and the marker synced to the answers file. Pure
// functions from a file's text to its new text. The bookkeeping of cutting a
// version, every other pin the version owns, lives in `@plexus-ms/dev`.
import { setFrontmatterField } from './frontmatter.ts';

export const WORKFLOW_REF = 'plexus-ms/tooling/.github/workflows/';

/** Every `uses: plexus-ms/tooling/.github/workflows/<file>@<ref>` pinned to the version. */
export const bumpWorkflowRefs = (text: string, version: string): string =>
  text.replace(/(plexus-ms\/tooling\/\.github\/workflows\/[A-Za-z0-9._-]+)@v?[0-9.]+/g, `$1@${version}`);

/** Leftovers of a three-way apply that did not go through. */
export const hasConflictMarkers = (text: string): boolean => /^<<<<<<< /m.test(text);

/** Whether `git status --porcelain` output shows unmerged entries. */
export const hasUnmergedEntries = (porcelain: string): boolean => /^(UU|AA|DU|UD)/m.test(porcelain);

/**
 * The marker says which version a unit was brought up to (§ 1.4 PLX). copier
 * re-renders it only when the template's content changed, so a version that
 * touched nothing in a template would leave `plexus:` behind while bumping the
 * answers file; this syncs it to the answers file's `_commit`, which copier
 * always writes. A marker with conflict markers is left to the human.
 */
export function syncMarker(marker: string, commit: string): string {
  if (hasConflictMarkers(marker)) return marker;
  return setFrontmatterField(marker, 'plexus', commit);
}
