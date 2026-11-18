// plx overview [dir]: an at-a-glance map of a folder of repos.
//
// The reader is lib's `overview`; this file maps the argument onto it and
// renders the tree. Each directory that carries a facet is annotated:
//
//   [<branch><* if dirty> <tag> → <remote>]   git: tag = latest on the default branch;
//                                             --sync fetches first and adds ↓<behind> ↑<ahead>
//   [template <tag>]                          a copier template
//   [copier <commit> ← <src>]                 a copier-managed project
//   [repo <plexus version>]                   a repo (PLEXUS.md), on the version its plx pin
//   [operations <plexus version>]             names; the operations repo by its answers file
//   [app <profile>]                           an app (PLEXUS.md under a repo's apps/), with
//                                             the profile its marker states; it is on its
//                                             repo's version
import { resolve } from 'node:path';
import { type Directory, type Kind, overview, shortRemote, unitsOf } from '@plexus-ms/lib';
import type { Command } from 'commander';
import { contextOf } from '../program.ts';
import { colorByDefault, type Style, style } from '../style.ts';

export function register(program: Command): void {
  program
    .command('overview')
    .description('map the git repos, copier templates and projects, and Plexus units under a directory')
    .argument('[dir]', 'directory to map', '.')
    .option('-s, --sync', 'fetch every repo first, to show branches behind (or ahead of) their upstream')
    .option('--color', 'colour the tree even when piped')
    .option('--no-color', 'never colour the tree')
    .action(async (dir: string, opts: { sync?: boolean; color?: boolean }, command: Command) => {
      const ctx = contextOf(command);
      const tree = await overview(ctx, resolve(dir), { fetch: opts.sync ?? false });
      const s = style(opts.color ?? colorByDefault());
      ctx.result(tree, (t) => renderTree(t, s));
    });
}

export function renderTree(root: Directory, s: Style): string {
  const kinds = new Map(unitsOf(root).map((u) => [u.dir, u.kind]));
  const annotate = (dir: Directory) => annotation(dir, kinds.get(dir), s);
  const lines = [`${s.bold(`${root.name}/`)}${annotate(root)}`];
  const walk = (dir: Directory, prefix: string) => {
    dir.children.forEach((child, i) => {
      const last = i === dir.children.length - 1;
      lines.push(`${s.dim(`${prefix}${last ? '└─ ' : '├─ '}`)}${s.bold(`${child.name}/`)}${annotate(child)}`);
      walk(child, `${prefix}${last ? '   ' : '│  '}`);
    });
  };
  walk(root, '');
  if (root.children.length === 0 && !annotate(root))
    lines.push(s.dim(`(no git repos, copier templates or projects, or Plexus units found under ${root.path})`));
  return lines.join('\n');
}

function annotation(dir: Directory, kind: Kind | undefined, s: Style): string {
  const tags: string[] = [];
  if (dir.git) {
    const { branch, dirty, tag, remote, ahead, behind } = dir.git;
    // Pieces coloured one by one: a nested reset would end the green at the star.
    const drift = `${behind ? ` ↓${behind}` : ''}${ahead ? ` ↑${ahead}` : ''}`;
    const rest = `${tag ? ` ${tag}` : ''}${remote ? ` → ${remote}` : ''}]`;
    tags.push(`${s.ok(`[${branch}`)}${dirty ? s.warn('*') : ''}${drift ? s.warn(drift) : ''}${s.ok(rest)}`);
  }
  if (dir.template) tags.push(s.note(`[template ${dir.template.tag ?? 'untagged'}]`));
  if (dir.copier) {
    const src = dir.copier.src === undefined ? '?' : shortRemote(dir.copier.src);
    tags.push(s.info(`[copier ${dir.copier.commit ?? '?'} ← ${src}]`));
  }
  if (dir.declaration && kind) {
    const detail = kind === 'app' ? dir.declaration.profile : dir.pin;
    tags.push(s.bold(`[${kind}${detail ? ` ${detail}` : ''}]`));
  }
  for (const p of dir.problems ?? []) tags.push(s.warn(`[! ${p}]`));
  return tags.length ? ` ${tags.join(' ')}` : '';
}
