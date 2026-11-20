// The summary of a run that takes a version in one or more repos (`update`,
// `update --recursive`) or previews one (the dry run of `plx-dev ship`): what
// each repo's run came to (`Outcome`, update.ts), folded into lists by
// `summarize` at the edge, where the run is rendered, and rendered for a
// human: one line per site, the pull requests, the line that merges the
// clean ones, then the verdict. Every tool that prints a Summary prints it
// this way.
import { versionBranch } from './pull.ts';
import { needsHand } from './take.ts';
import type { Outcome } from './update.ts';

export interface Summary {
  version: string;
  /** True for a dry run: nothing in the workspace changed. */
  preview: boolean;
  /** Sites, relative to the workspace. */
  clean: string[];
  /** Sites left with conflicts, and files that hold conflict markers outside them: in a pull request opened, or on a version branch found on origin. */
  conflicted: string[];
  /** Sites whose update exited nonzero or, on a version branch found on origin, whose answers do not record the version; consumers that could not be cloned or pushed, lockfiles that failed to refresh, and review requests the forge refused. */
  failed: string[];
  /** Consumers left untouched, with the reason. */
  skipped: { path: string; reason: string }[];
  /** Repos that need no version yet and rest on the one they have (need.ts), with what would end the rest. */
  resting: { path: string; reason: string }[];
  /** The pull requests opened or found, one per consumer that changed. */
  pulls: string[];
  /** Those of `pulls` that are no draft and need no hand: ready to merge once their checks pass. */
  mergeable: string[];
  /** The version branches on origin with no pull request that a dry run would open one of. */
  opening: string[];
}

/** A repo's file as the run names it: under the repo's name, `.` for a repo run from inside. */
const inRun = (repo: string, file: string): string => (repo === '.' ? file : `${repo}/${file}`);

/** True when nothing in the summary needs a human but the pull requests. */
export const isClean = (s: Summary): boolean =>
  s.conflicted.length === 0 && s.failed.length === 0 && s.skipped.length === 0;

/**
 * The summary of what the repos' runs came to, in their order. Its version is
 * the one given, else the first a run names.
 */
export function summarize(
  outcomes: readonly Outcome[],
  preview: boolean,
  version = outcomes.find((o) => o.version)?.version ?? '',
): Summary {
  const s: Summary = {
    version,
    preview,
    clean: [],
    conflicted: [],
    failed: [],
    skipped: [],
    resting: [],
    pulls: [],
    mergeable: [],
    opening: [],
  };
  for (const o of outcomes) {
    switch (o.kind) {
      case 'current':
        break;
      case 'skipped':
        s.skipped.push({ path: o.repo, reason: o.reason });
        break;
      case 'resting':
        s.resting.push({ path: o.repo, reason: o.reason });
        break;
      case 'failed':
        s.failed.push(o.repo);
        break;
      case 'found':
        // Files that still hold markers need a human, like a conflicted site.
        for (const file of o.marked) s.conflicted.push(inRun(o.repo, file));
        // A site copier did not run at needs a human to run it.
        for (const site of o.behind)
          s.failed.push(`${site === '.' ? o.repo : inRun(o.repo, site)} (not at ${o.version})`);
        if (o.failed !== undefined) s.failed.push(o.repo);
        if (o.pull) s.pulls.push(o.pull);
        if (o.opening) s.opening.push(`${o.repo} ${versionBranch(o.version)}`);
        if (o.pull && o.mergeable) s.mergeable.push(o.pull);
        if (o.review && 'failed' in o.review) s.failed.push(`${o.repo} (review request)`);
        break;
      case 'taken': {
        const t = o.taken;
        for (const site of t.sites) s[site.outcome].push(site.rel);
        // A file that holds a marker makes the pull request a draft too: listed
        // unless a conflicted site it lies in says so already.
        const conflicted = t.sites.filter((x) => x.outcome === 'conflicted').map((x) => x.rel);
        for (const file of t.marked ?? []) {
          const path = inRun(t.rel, file);
          if (!conflicted.some((site) => site === '.' || path === site || path.startsWith(`${site}/`)))
            s.conflicted.push(path);
        }
        if (t.lockfile === 'failed') s.failed.push(`${t.rel}/pnpm-lock.yaml`);
        if (t.failed !== undefined) s.failed.push(t.rel);
        if (t.pull) s.pulls.push(t.pull.url ?? `${t.rel} ${t.pull.branch}`);
        if (t.pull?.url && !t.pull.draft && !needsHand(t)) s.mergeable.push(t.pull.url);
        // The pull request stands; who was to review it needs a human to ask.
        if (t.review && 'failed' in t.review) s.failed.push(`${t.rel} (review request)`);
        break;
      }
    }
  }
  return s;
}

/**
 * One line to paste that merges the given pull requests, each with a merge
 * commit and its branch deleted: `gh pr merge -md -R <org>/<repo> <number>`,
 * chained so that the first refusal stops the rest. plx merges nothing itself.
 */
export function mergeLine(urls: string[]): string {
  return urls
    .map((url) => /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(url))
    .filter((m) => m !== null)
    .map((m) => `gh pr merge -md -R ${m[1]} ${m[2]}`)
    .join(' && ');
}

/** The summary: one line per site, the pull requests, then the verdict. */
export function renderSummary(s: Summary, realCommand: string, verb = 'update'): string {
  const lines = ['── summary ──────────────────────────────────────────────────────────────'];
  for (const p of s.clean) lines.push(`  ✓ clean:      ${p}`);
  for (const p of s.conflicted) lines.push(`  ✗ conflicts:  ${p}`);
  for (const p of s.failed) lines.push(`  ✗ failed:     ${p}`);
  for (const { path, reason } of s.skipped) lines.push(`  ⚠ skipped:    ${path} (${reason})`);
  for (const { path, reason } of s.resting) lines.push(`  • resting:    ${path} (${reason})`);
  for (const url of s.pulls) lines.push(`  → pull:       ${url}`);
  for (const branch of s.opening) lines.push(`  → to open:    ${branch}`);
  const merge = s.preview ? '' : mergeLine(s.mergeable);
  if (merge) lines.push('  the clean ones, to merge once their checks pass:', `  ${merge}`);
  const clean = isClean(s);
  // A run that took no version and opens nothing (resting, already there, its pull request found) has nothing to run for real.
  const idle = clean && s.clean.length === 0 && s.opening.length === 0;
  if (s.preview && !idle) {
    lines.push('  (preview only — nothing was changed)');
    if (clean) lines.push(`✓ dry run clean — run it for real: ${realCommand}`);
  } else if (clean) {
    lines.push(s.pulls.length > 0 ? '✓ done — review and merge the pull requests' : '✓ done — no pull request');
  }
  if (!clean) lines.push(`✗ needs attention — see above; fix the repo, then re-run ${verb}`);
  return lines.join('\n');
}
