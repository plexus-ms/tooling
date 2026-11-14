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

test('issue-id flags three capitals, a dash and digits, and passes module codes', () => {
  const text = [
    `Fixes ${id('ABC', 12)} and ${id('XYZ', 3)}; branch ${id('ABC', 12)}-a-slug.`,
    'PLX-App, PLX-AppStateful, the PLX map, PLX-Repo and a ABC-free line pass.',
    `As do X${id('ABC', 1)}, ${id('ABC', 1)}a, ${id('ABCD', 12)}, ${id('AB', 12)} and ${id('abc', 12)}.`,
    `Five standard prefixes pass: ${['SHA', 'UTF', 'GPL', 'PDF', 'ADR'].map((p) => id(p, 1)).join(', ')}.`,
    `No other does: ${id('KIT', 1)}, ${id('ISO', 8601)}.`,
  ].join('\n');
  assert.deepEqual(excerpts(lintIssueIds(text, 'f.md')), [
    `1: ${id('ABC', 12)}`,
    `1: ${id('XYZ', 3)}`,
    `1: ${id('ABC', 12)}`,
    `5: ${id('KIT', 1)}`,
    `5: ${id('ISO', 8601)}`,
  ]);
});

test('the commit message check reads # lines and leaves out what git adds', () => {
  const editor = [
    `feat: a change for ${id('ABC', 7)}`,
    '',
    `#${id('ABC', 8)} kept by git under -m, so linted`,
    '# Please enter the commit message for your changes. Lines starting',
    `# On branch someone/${id('ABC', 99)}-a-branch`,
    '# ------------------------ >8 ------------------------',
    `diff mentioning ${id('ABC', 5)}`,
  ].join('\n');
  assert.deepEqual(excerpts(lintCommitMessage(editor)), [`1: ${id('ABC', 7)}`, `3: ${id('ABC', 8)}`]);
  // `git commit -m`: no template, every line is the message.
  assert.deepEqual(excerpts(lintCommitMessage(`fix: x\n\n#${id('ABC', 12)} at line start\n`)), [`3: ${id('ABC', 12)}`]);
  assert.deepEqual(lintCommitMessage('fix(ship): name the PLX-Delivery section\n'), []);
  // Another comment character: git's template and scissors are recognised by it.
  const semicolon = editor.replaceAll(/^#(?= )/gm, ';');
  assert.deepEqual(excerpts(lintCommitMessage(semicolon, ';')), [`1: ${id('ABC', 7)}`, `3: ${id('ABC', 8)}`]);
  assert.equal(lintCommitMessage(semicolon).length, 4, 'read with the default, the template is linted');
  assert.deepEqual(excerpts(lintCommitMessage(semicolon, 'auto')), [`1: ${id('ABC', 7)}`, `3: ${id('ABC', 8)}`]);
});

test('citations: the reverse order, ranges and lists, and a bare sign on a page of the compendium', () => {
  const citable = new Set([
    cite('1', 'PLX-CLI'),
    cite('8', 'PLX-Delivery'),
    cite('2', 'PLX-Delivery'),
    cite('1', 'PLX-Own'),
  ]);
  const text = [
    `${'PLX-CLI'} § 1 and (${'PLX-Delivery'}, § 8) resolve; ${'PLX-Delivery'} § 99 does not.`,
    `A range: §§ 2–99 ${'PLX-Delivery'}; a list: §§ 2, 8 or 9 ${'PLX-Delivery'}.`,
    `${'PLX-Delivery'}, § 2 ${'PLX-CLI'}: the sign belongs to the code after it.`,
    '## § 7 A heading defines a section, it does not cite one',
    'Bare: § 1 resolves on its own page, § 7 does not.',
  ].join('\n');
  const found = (own?: string) =>
    lintCitations(text, 'contracts/own.md', citable, own).map((v) => `${v.line}: ${v.excerpt}`);
  assert.deepEqual(found('PLX-Own'), [
    `1: ${cite('99', 'PLX-Delivery')}`,
    `2: ${cite('99', 'PLX-Delivery')}`,
    `2: ${cite('9', 'PLX-Delivery')}`,
    `3: ${cite('2', 'PLX-CLI')}`,
    `5: ${cite('7', 'PLX-Own')}`,
  ]);
  // Outside the compendium a bare sign has no page.
  assert.deepEqual(found(), found('PLX-Own').slice(0, -1));
});

test('citations: a code, a comma and a bare sign read as a reverse citation, on a page of the compendium too', () => {
  const citable = new Set([cite('8', 'PLX-Own')]);
  const text = `It consumes ${'PLX-Other'}, § 8 says how.`;
  assert.deepEqual(
    lintCitations(text, 'approaches/own.md', citable, 'PLX-Own').map((v) => v.excerpt),
    [cite('8', 'PLX-Other')],
    'read as section 8 of the code before it, not of the page',
  );
});

test('citations: a malformed requirement name is a violation, not ignored', () => {
  const text = `${name('App', 'loopbackPort')}, ${name('App', 'Stateful', 'Migrate', 'Extra')}, ${name('App', 'Port')}`;
  assert.deepEqual(
    lintCitations(text, 'f.md', new Set([name('App', 'Port')])).map((v) => v.message),
    [
      `${name('App', 'loopbackPort')} is no requirement name: PLX-<Module>[/<Profile>]/<Name>, each segment capitalised`,
      `${name('App', 'Stateful', 'Migrate', 'Extra')} is no requirement name: PLX-<Module>[/<Profile>]/<Name>, each segment capitalised`,
    ],
  );
});

test('template-header: blank lines, Jinja comments and consecutive blocks all count', () => {
  // A block after a blank line, itself followed by one, pads the header and counts.
  assert.equal(headerLines('# a\n# b\n\n# c\n# d\n# e\n# f\n\nk: 1\n', 'template/a.yml'), 6);
  assert.equal(headerLines('# a\n\n# b\n\n# c\n', 'template/a.yml'), 3);
  // A block directly above a line of content is that content's own comment.
  assert.equal(headerLines('# a\n# b\n\n# c\n# d\n# e\n# f\nk: 1\n', 'template/a.yml'), 2);
  assert.equal(headerLines('# a\n# b\n\n# about k\nk: 1\n\n# c\n\n', 'template/a.yml'), 2);
  // The first block is the header even when content follows it at once.
  assert.equal(headerLines('# a\n# b\n# c\nk: 1\n', 'template/a.yml'), 3);
  assert.equal(headerLines('{# a #}\n{# b\n   c #}\n\nk: 1\n', 'template/a.yml.jinja'), 3);
  assert.equal(headerLines('{# a #}\n# b\nk: 1\n', 'template/a.yml.jinja'), 2);
  assert.equal(headerLines('/* a\n b */\n/* c\n d */\nexport {};\n', 'template/a.ts'), 4);
  // Outside a .jinja file `{#` is no comment.
  assert.equal(headerLines('{# a #}\n{# b #}\n{# c #}\nk: 1\n', 'template/a.yml'), 0);
});

test('template-header on the heads of three real template files', () => {
  // template-repo-operations as of Plexus 0.120.0: a two-line header and a
  // one-line header, each followed by the comment of a setting, and a header
  // that is five lines long whatever the rule.
  const real: [string, string, number][] = [
    [
      'template/inventory/group_vars/platform.yml.jinja',
      "# The hosts that run this tenant's apps (PLX-Platform). The apps themselves\n# are per host (host_vars/<host>.yml, plexus_apps).\n\n# Unprivileged user that owns app dirs and runs the deploy verb (via CI SSH).\nplexus_deploy_user: plexus\nplexus_deploy_root: /opt/stacks\n\n# Re-create containers during a platform-playbook run (rotation \u2014 PLX-Secrets)\n# and pull + start apps whose compose file the deploy verb has already placed.\n# Safe to leave true: an app never deployed yet is skipped, not fatal.\nplexus_up: true\n",
      2,
    ],
    [
      'template/inventory/group_vars/all.yml.jinja',
      '# What every host of this tenant gets, whichever layer\'s playbook reaches it.\n\n# Human admins (iam): a personal account on every host, key-only SSH,\n# passwordless sudo. At least one is required: after a first run as root,\n# connect as an admin, and root logins close (sshd).\n#   - name: alice\n#     ssh_keys: ["ssh-ed25519 AAAA\u2026 alice@example.org"]\niam_admins: []\n\n# Host firewall (firewall): inbound closed except SSH and what the roles open\n# themselves (caddy: 80, 443). List an overlay network\'s interface here to\n# accept its traffic whole, e.g. [wt0] for NetBird.\nfirewall_trusted_interfaces: []\n',
      1,
    ],
    [
      'template/mise.toml.jinja',
      "# The tenant's operations repo (\u00a7 3 PLX-Tenancy): the ops side, applied by\n# playbook runs on its own occasions \u2014 it has no release cycle (\u00a7 3 PLX-Delivery).\n# One playbook per layer, each shipped in its plexus.* collection and mounted\n# here (platform.yml{% if infrastructure %}, infrastructure.yml{% endif %}{% if ci_strategy != 'github' %}, ci.yml{% endif %}); third-party apps the tenant\n# merely operates live under apps/<name>/ (\u00a7 2 PLX-App).\n\n# Verbs are asked as `mise :verb` at the repo root like in every tenant repo\n# (\u00a7 2 PLX-Repo); that form needs the root marker even without sub-projects.\nmonorepo_root = true\n# mise no longer walks the tree for project configs; the root is the only one.\n[monorepo]\nconfig_roots = [\".\"]\n",
      5,
    ],
  ];
  for (const [file, text, n] of real) assert.equal(headerLines(text, file), n, file);
});

test('date-or-version catches a timestamp', () => {
  assert.deepEqual(excerpts(lintDateOrVersion('It ran at 2026-11-04T10:00Z and 2026-11-04T10:00:05+01:00.', 'a.md')), [
    '1: 2026-11-04T10:00Z',
    '1: 2026-11-04T10:00:05+01:00',
  ]);
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
