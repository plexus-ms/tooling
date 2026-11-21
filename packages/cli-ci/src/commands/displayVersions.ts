// plx-ci display-versions <environment> <sha> --deploys <json>: the string
// each deployed app shows as its version, and the version a production
// release cuts (core/displayVersions.ts states how both are read from the
// tags and the forge's registry). Needs a checkout with its tags and crane
// on the PATH, logged in to the forge's registry. From the environment:
// IMAGE_PREFIX, where the images live (default ghcr.io/<owner of
// GITHUB_REPOSITORY>). Writes version= and display-versions= (a JSON object,
// app to string) to GITHUB_OUTPUT when that is set.
//
// plx-ci tag-display-version <version> <sha>: tag the version at the commit
// with a GitHub Release listing the commits since the previous version. From
// the environment: GITHUB_REPOSITORY, and GITHUB_TOKEN, allowed to write the
// repo's contents.
//
//   plx-ci display-versions production "$GITHUB_SHA" --deploys "$DEPLOYS"
//   plx-ci tag-display-version 1.4 "$GITHUB_SHA"
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { UsageError } from '@plexus-ms/lib';
import type { Command } from 'commander';
import { displayVersions, tagDisplayVersion } from '../core/displayVersions.ts';
import { contextOf } from '../program.ts';
import { imagePrefix, need } from './shared.ts';

/** The app names of _verify.yml's output `deploys`. */
export function appsOfDeploys(json: string): string[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new UsageError('--deploys is not JSON');
  }
  if (!Array.isArray(data)) throw new UsageError('--deploys is not a list');
  return data.map((d) => {
    const app = (d as { app?: unknown })?.app;
    if (typeof app !== 'string' || app === '') throw new UsageError('--deploys: every entry names its app');
    return app;
  });
}

export function register(program: Command): void {
  program
    .command('display-versions')
    .description('the string each deployed app shows as its version, and the version a production release cuts')
    .argument('<environment>', 'the environment released into')
    .argument('<sha>', 'the commit released')
    .requiredOption('--deploys <json>', 'the deploys, _verify.yml’s output `deploys`')
    .option('-C, --dir <dir>', 'the checkout to read, with its tags', '.')
    .action(async (environment: string, sha: string, opts: { deploys: string; dir: string }, command: Command) => {
      const ctx = contextOf(command);
      const result = await displayVersions(ctx, {
        dir: resolve(opts.dir),
        environment,
        sha,
        apps: appsOfDeploys(opts.deploys),
        prefix: imagePrefix(),
      });
      ctx.result(result, (r) =>
        [
          ...(r.version ? [`version ${r.version}`] : []),
          ...Object.entries(r.apps).map(([app, shown]) => `${app} ${shown}`),
        ].join('\n'),
      );
      if (process.env.GITHUB_OUTPUT)
        appendFileSync(
          process.env.GITHUB_OUTPUT,
          `version=${result.version}\ndisplay-versions=${JSON.stringify(result.apps)}\n`,
        );
    });

  program
    .command('tag-display-version')
    .description('tag a version at its commit, with a GitHub Release listing the commits since the previous one')
    .argument('<version>', 'the version, MAJOR.MINOR')
    .argument('<sha>', 'the commit released')
    .option('-C, --dir <dir>', 'the checkout to read, with its tags', '.')
    .action(async (version: string, sha: string, opts: { dir: string }, command: Command) => {
      const ctx = contextOf(command);
      const result = await tagDisplayVersion(ctx, {
        dir: resolve(opts.dir),
        repo: need('GITHUB_REPOSITORY'),
        token: need('GITHUB_TOKEN'),
        version,
        sha,
      });
      ctx.result(result, (r) => `${r.version} ${r.sha}${r.existed ? ' (was there)' : ''}`);
    });
}
