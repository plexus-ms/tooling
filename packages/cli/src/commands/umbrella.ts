// plx umbrella up|down [dir]: one pnpm workspace over the repos under a directory.
//
// lib's `readUmbrella` reads the repos and plans the files and commands (its
// header has the hand-run form); this file maps the arguments, applies the plan
// and prints which dependencies were linked. The verbs behave like Docker
// Compose's: `up` stays in the foreground on the watcher's log, and Ctrl+C
// there is `down`; `up -d` leaves the watcher running and returns; `down` stops
// it, deletes what `up` wrote and installs every repo on its own again.
//
//   plx umbrella up                      # every pnpm workspace under the current directory
//   plx umbrella up -d --only harness,my-app ~/dev/acme
//   plx umbrella down
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { type Context, readUmbrella, readUmbrellaDown, type Umbrella } from '@plexus-ms/lib';
import type { Command } from 'commander';
import { contextOf } from '../program.ts';

export function register(program: Command): void {
  const umbrella = program
    .command('umbrella')
    .description('develop across repos: one pnpm workspace over the repos under a directory, linking their packages');

  umbrella
    .command('up')
    .description('link the repos, build the linked packages and rebuild them on change; Ctrl+C restores')
    .argument('[dir]', 'the directory that holds the clones', '.')
    .option('-d, --detach', 'leave the watcher running in the background and return')
    .option('--only <repos>', 'the repos to link, comma-separated (default: every pnpm workspace under dir)')
    .action(async (dir: string, opts: { detach?: boolean; only?: string }, command: Command) => {
      const ctx = contextOf(command);
      const root = resolve(dir);
      const plan = await readUmbrella(ctx, root, opts.only?.split(',').filter(Boolean));
      await ctx.apply(plan.plan);
      ctx.result(plan, renderUmbrella);
      if (ctx.dryRun) return;
      if (opts.detach || plan.watched.length === 0) {
        ctx.done(`umbrella up over ${plan.repos.join(', ')}; \`plx umbrella down\` restores`);
        return;
      }
      ctx.say(`watching ${plan.watched.join(', ')}; Ctrl+C restores`);
      await follow(plan.log);
      await down(ctx, root);
    });

  umbrella
    .command('down')
    .description('stop the watcher, delete what up wrote, and install every repo on its own again')
    .argument('[dir]', 'the directory that holds the clones', '.')
    .action(async (dir: string, _opts: unknown, command: Command) => {
      await down(contextOf(command), resolve(dir));
    });
}

async function down(ctx: Context, root: string): Promise<void> {
  const { repos, plan } = await readUmbrellaDown(ctx, root);
  await ctx.apply(plan);
  ctx.done(repos.length > 0 ? `umbrella down; ${repos.join(', ')} installed on their own` : 'no umbrella is up');
}

/** Show the watcher's log until this process is interrupted; the signal ends the following, not plx. */
function follow(log: string): Promise<void> {
  return new Promise((done) => {
    const tail = spawn('tail', ['-n', '+1', '-f', log], { stdio: ['ignore', process.stderr.fd, process.stderr.fd] });
    const stop = () => tail.kill();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    tail.on('close', () => {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      done();
    });
  });
}

export function renderUmbrella(u: Umbrella): string {
  const lines = u.links.map((l) =>
    l.linked
      ? `  linked      ${l.from} → ${l.to} (${l.toRepo} at ${l.version})`
      : `  not linked  ${l.from} → ${l.to}: ${l.range} does not admit ${l.toRepo}'s ${l.version}`,
  );
  if (lines.length === 0) lines.push('  no package of one repo depends on a package of another');
  for (const notice of u.notices) lines.push(`  ${notice}`);
  for (const name of u.unwatched) lines.push(`  ${name} has no dev script: it is not rebuilt on a change`);
  lines.push('  while up, pnpm inside a repo acts on the umbrella: its own lockfile catches up at down');
  return lines.join('\n');
}
