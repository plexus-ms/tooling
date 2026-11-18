// plx doctor [dir]: the repo's checks (§ 13.4 PLX).
//
// lib's `examine` reads, `diagnose` checks; this file maps the argument and
// renders the report: a failing check is one line, `✗ <requirement> <unit>:
// <what is wrong>`; a unit with none is `✓ <unit>`, with its profile and the
// deviations its marker lists; then a summary. Exit code 1 when a check fails
// or no unit is found. -q keeps the failures and the summary only.
import { resolve } from 'node:path';
import { diagnose, examine, type Report } from '@plexus-ms/lib';
import type { Command } from 'commander';
import { contextOf } from '../program.ts';
import { colorByDefault, type Style, style } from '../style.ts';

export function register(program: Command): void {
  program
    .command('doctor')
    .description(
      'run the checks of the contracts over this repo and its apps, or every unit with a marker under a directory',
    )
    .argument('[dir]', 'a repo, or a directory of repos', '.')
    .option('--color', 'colour the report even when piped')
    .option('--no-color', 'never colour the report')
    .action(async (dir: string, opts: { color?: boolean }, command: Command) => {
      const ctx = contextOf(command);
      const report = diagnose(await examine(ctx, resolve(dir)));
      const s = style(opts.color ?? colorByDefault());
      ctx.result(report, (r) => renderReport(r, s, !ctx.quiet));
      if (report.failed > 0 || report.units.length === 0) process.exitCode = 1;
    });
}

export function renderReport(report: Report, s: Style, showPassing: boolean): string {
  const lines: string[] = [];
  for (const u of report.units) {
    if (u.findings.length === 0) {
      const notes = [u.kind === 'repo' ? '' : u.kind, u.profile ?? '', ...u.deviations.map((d) => `deviates: ${d}`)];
      const note = notes.filter(Boolean).join(', ');
      if (showPassing) lines.push(`${s.ok('✓')} ${u.path}${note ? ` ${s.dim(`[${note}]`)}` : ''}`);
      continue;
    }
    for (const f of u.findings) lines.push(`${s.warn('✗')} ${f.requirement} ${u.path}: ${f.problem}`);
  }
  const n = report.units.length;
  const units = `${n} unit${n === 1 ? '' : 's'}`;
  if (n === 0) lines.push(s.warn('✗ no PLEXUS.md marker found'));
  else if (report.failed > 0)
    lines.push(s.warn(`✗ ${report.failed} of ${units} ${report.failed === 1 ? 'fails' : 'fail'} a check`));
  else lines.push(s.ok(`✓ ${units} pass${n === 1 ? 'es' : ''} every check`));
  return lines.join('\n');
}
