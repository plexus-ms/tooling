import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareBaseline, parseBaseline, renderBaseline } from './baseline.ts';
import {
  headerLines,
  keyOf,
  lintCitations,
  lintCommitMessage,
  lintDateOrVersion,
  lintIssueIds,
  lintTemplateHeader,
  type Violation,
} from './lints.ts';

// Citations, names and identifiers are put together at run time: this repo's
// own `plx requirements` reads these sources, and a literal would be a hit.
const cite = (n: string, code: string) => `§ ${n} ${code}`;
const name = (...parts: string[]) => `PLX-${parts.join('/')}`;
const id = (key: string, n: number) => `${key}-${n}`;

const excerpts = (vs: Violation[]) => vs.map((v) => `${v.line}: ${v.excerpt}`);

test('date-or-version flags dates and versions in prose', () => {
  const page = [
    '---',
    'version: 0.120.0',
    'timestamp: 2026-11-13',
    '---',
    '',
    'Since 2025 the verb did this; on 2026-11-04 it stopped.',
    'Plexus 0.111.0 shipped it, measured in November 2026 and Nov. 4, 2026.',
    'It needs pnpm@12 and node v24, and 1.2.3-rc.1 was a prerelease.',
    '```yaml',
    'plexus: 0.60.0 # an example, exempt',
    '```',
    'An example in a span is code too: `plexus: 0.60.0`, `v0`.',
  ].join('\n');
  assert.deepEqual(excerpts(lintDateOrVersion(page, 'a.md')), [
    '6: Since 2025',
    '6: 2026-11-04',
    '7: 0.111.0',
    '7: November 2026',
    '7: Nov. 4, 2026',
    '8: 12',
    '8: v24',
    '8: 1.2.3-rc.1',
  ]);
  assert.equal(lintDateOrVersion(page, 'a.md')[0]?.lint, 'date-or-version');
});

test('date-or-version leaves numbers that are no date and no version', () => {
  const prose = [
    'A module MUST cite § 1.3 PLX and § 13.4.2 of itself; sections 2 and 3.',
    'The loopback 127.0.0.1, the network 10.0.0.0/8, port 8080 and port 2000.',
    'BCP 14 (RFC 2119, RFC 8174); a 0.x version promises nothing until 1.0.0.',
    'IPv4 and IPv6, 1.42 GiB per hour, 600 integration tests, the PLX-App contract.',
    'A path /baremetal/v1/zones in prose, 99.9 % uptime.',
  ].join('\n');
  assert.deepEqual(lintDateOrVersion(prose, 'a.md'), []);
});

test('citations resolve against the citable index', () => {
  const citable = new Set([cite('1', 'PLX'), cite('1.3', 'PLX'), cite('2', 'PLX-Alpha'), name('Alpha', 'Port')]);
  const text = [
    `Good: (${cite('1.3', 'PLX')}), [${cite('2', 'PLX-Alpha')}](a.md), ${name('Alpha', 'Port')}.`,
    `Bad: ${cite('9', 'PLX')}, ${cite('2', 'PLX-Gone')}, ${name('Alpha', 'Gone')}, ${name('Alpha', 'Prof', 'Gone')}.`,
    `Many: §§ 1 and 2 ${'PLX'}, §§ 1, 2 and 3 ${'PLX-Alpha'}.`,
    `# wrapped in a comment (§ 3`,
    '# PLX-Alpha), and a module code alone, PLX-Alpha, is no citation.',
  ].join('\n');
  assert.deepEqual(
    lintCitations(text, 'f.ts', citable).map((v) => `${v.line}: ${v.message}`),
    [
      `2: ${cite('9', 'PLX')} cites a section that does not exist`,
      `2: ${cite('2', 'PLX-Gone')} cites PLX-Gone, which is no module`,
      `2: ${name('Alpha', 'Gone')} names no requirement line`,
      `2: ${name('Alpha', 'Prof', 'Gone')} names no requirement line`,
      `3: ${cite('2', 'PLX')} cites a section that does not exist`,
      `3: ${cite('1', 'PLX-Alpha')} cites a section that does not exist`,
      `3: ${cite('3', 'PLX-Alpha')} cites a section that does not exist`,
      `4: ${cite('3', 'PLX-Alpha')} cites a section that does not exist`,
    ],
  );
  assert.deepEqual(lintCitations(text.split('\n')[0] ?? '', 'f.ts', citable), []);
});

test('template-header counts the comment lines a template file opens with', () => {
  const hash = (n: number) => Array.from({ length: n }, (_, i) => `# line ${i + 1}`).join('\n');
  assert.equal(headerLines(`${hash(2)}\nkey: value\n`, 'template/a.yml'), 2);
  assert.equal(headerLines(`${hash(3)}\nkey: value\n`, 'template/a.yml'), 3);
  // A workflow names itself first; Jinja tags are not content.
  assert.equal(headerLines(`{% raw %}name: on_pr\n\n${hash(4)}\non: push\n`, 'template/w.yml.jinja'), 4);
  assert.equal(headerLines(`#!/bin/bash\n${hash(2)}\n\nset -e\n`, 'template/run'), 2);
  assert.equal(headerLines(`# syntax=docker/dockerfile:1\n${hash(2)}\nFROM node\n`, 'template/Dockerfile'), 2);
  assert.equal(headerLines(`---\n${hash(3)}\n- hosts: all\n`, 'template/p.yml'), 3);
  // A comment below the content is no header; a Markdown heading is no comment.
  assert.equal(headerLines(`a = 1\nb = 2\n${hash(5)}\n`, 'template/mise.toml.jinja'), 0);
  assert.equal(headerLines('# Title\n\nProse.\n', 'template/README.md'), 0);
  assert.equal(headerLines('<!-- one\ntwo\nthree -->\n# Title\n', 'template/README.md'), 3);
  assert.equal(headerLines('/**\n * one\n * two\n */\nexport {};\n', 'template/a.ts'), 4);
  assert.equal(headerLines('// one\n// two\nexport {};\n', 'template/a.ts'), 2);

  assert.deepEqual(lintTemplateHeader(`${hash(2)}\nkey: value\n`, 'template/a.yml'), []);
  assert.deepEqual(lintTemplateHeader(`${hash(3)}\nkey: value\n`, 'template/a.yml').map(keyOf), [
    'template-header template/a.yml: 3 header comment lines',
  ]);
});

test('issue-id flags tracker identifiers and passes module codes', () => {
  const text = [
    `Fixes ${id('PLX', 12)} and ${id('DMG', 3)}.`,
    'PLX-App, PLX-AppStateful, the PLX map, PLX-Repo and a DMG-free line pass.',
    `As do X${id('PLX', 1)}, ${id('PLX', 1)}a and ${id('ABC', 12)}: other keys are not this tracker's.`,
  ].join('\n');
  assert.deepEqual(excerpts(lintIssueIds(text, 'f.md')), [`1: ${id('PLX', 12)}`, `1: ${id('DMG', 3)}`]);
});

test('the commit message check leaves out what git strips', () => {
  const message = [
    `feat: a change for ${id('DMG', 7)}`,
    '',
    `# On branch someone/${id('PLX', 99)}-a-branch`,
    '# ------------------------ >8 ------------------------',
    `diff mentioning ${id('PLX', 5)}`,
  ].join('\n');
  assert.deepEqual(excerpts(lintCommitMessage(message)), [`1: ${id('DMG', 7)}`]);
  assert.deepEqual(lintCommitMessage('fix(ship): name the PLX-Delivery section\n'), []);
});

test('the baseline holds known violations as a multiset and names what no longer occurs', () => {
  const v = (file: string, excerpt: string): Violation => ({
    lint: 'date-or-version',
    file,
    line: 1,
    excerpt,
    message: '',
  });
  const known = [v('a.md', '2026-11-04'), v('a.md', '2026-11-04'), v('b.md', '0.111.0')];
  const baseline = parseBaseline(renderBaseline(known));
  assert.deepEqual(baseline, [
    'date-or-version a.md: 2026-11-04',
    'date-or-version a.md: 2026-11-04',
    'date-or-version b.md: 0.111.0',
  ]);
  assert.deepEqual(compareBaseline(known, baseline), { fresh: [], stale: [], known: 3 });

  const now = [v('a.md', '2026-11-04'), v('b.md', '0.111.0'), v('c.md', '0.112.0')];
  const compared = compareBaseline(now, baseline);
  assert.deepEqual(compared.fresh.map(keyOf), ['date-or-version c.md: 0.112.0']);
  assert.deepEqual(compared.stale, ['date-or-version a.md: 2026-11-04']);
  assert.equal(compared.known, 2);
});
