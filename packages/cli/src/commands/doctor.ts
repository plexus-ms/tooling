// plx doctor [dir]: the repo's checks (§ 13.4 PLX).
//
// lib's `examine` reads, `diagnose` checks; this file maps the argument and
// renders the report: which repo was checked when the directory is inside
// one; a failing check is one line, `✗ <requirement> <unit>: <what is
// wrong>`; a unit with none is `✓ <unit>`, with its profile and the
// deviations its marker lists; a hint, which fails nothing, as `• <unit>:
// <hint>`; in a workspace, one line naming the git roots
// that are not Plexus repos; then a summary. Exit code 1 when a check fails
// or no unit is found. -q keeps the failures and the summary only.
import { resolve } from 'node:path';
import { diagnose, type Examination, examine, type Report } from '@plexus-ms/lib';
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
      const given = resolve(dir);
      const { facts, ...examined } = await examine(ctx, given);
      const report: DoctorReport = { ...examined, ...diagnose(facts) };
      const s = style(opts.color ?? colorByDefault());
      ctx.result(report, (r) => renderReport(r, s, !ctx.quiet, given));
      if (report.failed > 0 || report.units.length === 0) process.exitCode = 1;
    });
}

/** The report as the verb prints it, and as `--json` gives it. */
export type DoctorReport = Report & Omit<Examination, 'facts'>;

export function renderReport(report: DoctorReport, s: Style, showPassing: boolean, given = report.root): string {
  const lines: string[] = [];
  if (report.inRepo && given !== report.root) lines.push(s.dim(`• the repo at ${report.root}`));
  for (const u of report.units) {
    if (u.findings.length === 0) {
      const notes = [u.kind === 'repo' ? '' : u.kind, u.profile ?? '', ...u.deviations.map((d) => `deviates: ${d}`)];
      const note = notes.filter(Boolean).join(', ');
      if (showPassing) lines.push(`${s.ok('✓')} ${u.path}${note ? ` ${s.dim(`[${note}]`)}` : ''}`);
    }
    for (const f of u.findings) lines.push(`${s.warn('✗')} ${f.requirement} ${u.path}: ${f.problem}`);
    if (showPassing) for (const h of u.hints ?? []) lines.push(s.dim(`• ${u.path}: ${h}`));
  }
  if (report.skipped.length > 0)
    lines.push(s.dim(`• not Plexus repos (no PLEXUS.md, no app in apps/), not checked: ${report.skipped.join(', ')}`));
  const n = report.units.length;
  const units = `${n} unit${n === 1 ? '' : 's'}`;
  if (n === 0) lines.push(s.warn(report.inRepo ? '✗ no unit found' : '✗ no Plexus repo found'));
  else if (report.failed > 0)
    lines.push(s.warn(`✗ ${report.failed} of ${units} ${report.failed === 1 ? 'fails' : 'fail'} a check`));
  else lines.push(s.ok(`✓ ${units} pass${n === 1 ? 'es' : ''} every check`));
  return lines.join('\n');
}
