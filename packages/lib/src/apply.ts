// apply: bring a repo's files in line with its markers.
import type { Context } from './context.ts';
import { ANSWERS_FILE } from './copier.ts';
import { crossedOver } from './doctor.ts';
import { MARKER_FILE } from './marker.ts';
import { findSites } from './sites.ts';

export interface ApplyOptions {
  /** The repo, a directory inside git's working tree at its top. */
  repo: string;
  /** The Plexus version of the running plx. */
  plxVersion: string;
  /** The root of the templates; default the ones this plx bundles. */
  templates?: string;
}

/** What apply did to one site. */
export interface SiteApplied {
  dir: string;
  report: { path: string; outcome: string }[];
  defaults: Record<string, unknown>;
}

export interface Applied {
  sites: SiteApplied[];
  conflicted: number;
  applied: boolean;
}

/** Where a repo that still has copier answers is pointed; the cutover writes the runbook's address here, once. */
export const CROSSOVER_RUNBOOK = 'the crossover runbook';

export async function apply(ctx: Context, options: ApplyOptions): Promise<Applied> {
  const { repo, plxVersion } = options;
  const tracked = (await ctx.read('git', ['ls-files', '-z'], { cwd: repo })).split('\0');
  if (!crossedOver(tracked))
    throw new Error(
      `${repo} still tracks a ${ANSWERS_FILE}, so it has not crossed over from copier to the markers: follow ${CROSSOVER_RUNBOOK}`,
    );
  const now = await findSites(ctx, repo);
  const before = await findSites(ctx, repo, 'HEAD');
  const lists = [...now, ...before].some((s) => s.config?.templates !== undefined);
  const version = now.find((s) => s.dir === '.')?.config?.version;
  if (lists && version !== plxVersion)
    throw new Error(
      version === undefined
        ? `the root ${MARKER_FILE} names no version, and plx ${plxVersion} cannot tell which one the repo is on`
        : `the root ${MARKER_FILE} names version ${version}, and this plx is ${plxVersion}: apply with the plx that version pins`,
    );
  return { sites: [], conflicted: 0, applied: false };
}
