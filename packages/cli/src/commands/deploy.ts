// plx deploy <host> <app>: launch a released artifact into an
// execution environment (§ 6 PLX-Delivery), from a checkout of the app's
// source repo.
//
// lib's `deploy` does the work; this file maps the arguments and prints the
// live image. Exit code 1 when the app is not healthy at the end, rolled back
// or not. An empty option value is the same as an absent one, so a mount can
// always pass the flag. `-n` prints every ssh line the deploy would run.
//
//   plx deploy deploy@1.2.3.4 website --image ghcr.io/org/website:<sha>
//   plx deploy deploy@1.2.3.4 beszel            # third-party: image pinned in the file
//   plx deploy deploy@1.2.3.4 website -e staging --image …   # the staging deployment, /opt/stacks/website-staging
//   plx deploy deploy@1.2.3.4 website --image … --display-version 1.4   # the app shows 1.4, where its file uses ${PLEXUS_DISPLAY_VERSION}
import { resolve } from 'node:path';
import { type Deploy, deploy } from '@plexus-ms/lib';
import type { Command } from 'commander';
import { contextOf } from '../program.ts';

interface Opts {
  image?: string;
  displayVersion?: string;
  retries: string;
  environment?: string;
  appDir?: string;
  source?: string;
  dir: string;
}

export function register(program: Command): void {
  program
    .command('deploy')
    .description(
      'render the app’s compose file with the image pinned, stage it on the host, pull, migrate, swap, up, wait for the healthcheck, roll back on failure',
    )
    .argument('<host>', 'ssh target, deploy@host')
    .argument('<app>', 'the app, apps/<app> in the checkout')
    .option('--image <ref>', 'the image ref to pin; absent for a third-party app whose compose.yaml pins its own')
    .option(
      '--display-version <string>',
      'the string the app shows as its version, pinned where its compose.yaml uses ${PLEXUS_DISPLAY_VERSION}; ignored where it does not',
    )
    .option('--retries <n>', 'looks at the app container’s health status, two seconds apart', '30')
    .option(
      '-e, --environment <name>',
      'the environment deployed into; decides the app dir’s slug (default: production)',
    )
    .option(
      '--app-dir <path>',
      'the app dir on the host (default: /opt/stacks/<app>, or <app>-<environment> outside production)',
    )
    .option('--source <path>', 'the app’s dir in the checkout (default: apps/<app>)')
    .option('-C, --dir <dir>', 'the checkout to read', '.')
    .action(async (host: string, app: string, opts: Opts, command: Command) => {
      const ctx = contextOf(command);
      const result = await deploy(ctx, {
        host,
        app,
        image: opts.image,
        displayVersion: opts.displayVersion,
        retries: Number(opts.retries),
        environment: opts.environment,
        appDir: opts.appDir,
        source: opts.source,
        dir: resolve(opts.dir),
      });
      ctx.result(result, renderDeploy);
      if (!result.healthy) process.exitCode = 1;
    });
}

export function renderDeploy(d: Deploy): string {
  if (d.healthy) return d.live ?? '';
  return d.rolledBack ? `rolled back to ${d.live ?? 'the previous compose.yaml'}` : 'not healthy';
}
