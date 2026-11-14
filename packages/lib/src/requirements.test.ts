import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BASELINE_FILE } from './baseline.ts';
import { Context } from './context.ts';
import { lintCitations } from './lints.ts';
import {
  checkCommitMessage,
  checkCompendium,
  checkRepo,
  extractRequirements,
  planBaseline,
  readCitable,
  requirementName,
  scanPage,
} from './requirements.ts';
import { bundledIndex } from './standardIndex.ts';
import { fakeIo, type Tree } from './testing/fakeIo.ts';

// Citations, names and identifiers are put together at run time: this repo's
// own `plx requirements` reads these sources, and a literal would be a hit.
const cite = (n: string, code: string) => `§ ${n} ${code}`;
const name = (...parts: string[]) => `PLX-${parts.join('/')}`;
const id = (key: string, n: number) => `${key}-${n}`;

const standard = [
  '---',
  'code: PLX-Alpha',
  'maturity: standard',
  'binds: repo',
  'depends: [PLX-Beta]',
  '---',
  '',
  'Prose with MUSTs, the plural, is fine.',
  '',
  '## § 1 One',
  '',
  '> - A repo MUST alpha.',
  '> - A repo SHOULD beta.',
  '',
  '```',
  '> - not a requirement, MUST not count',
  '```',
  '',
  '### § 1.1 Sub',
  '',
  '> - It MAY gamma.',
  '',
  '## Maintaining',
  '',
  'Maintainers ship it.',
  '',
].join('\n');

test('scanPage extracts requirements by section and skips fences', () => {
  const scan = scanPage(standard, 'contracts/alpha.md', 'module');
  assert.deepEqual(scan.defects, []);
  assert.deepEqual(scan.requirements, ['§ 1 A repo MUST alpha.', '§ 1 A repo SHOULD beta.', '§ 1.1 It MAY gamma.']);
  assert.deepEqual(
    [scan.code, scan.maturity, scan.binds, scan.depends],
    ['PLX-Alpha', 'standard', 'repo', ['PLX-Beta']],
  );
  assert.deepEqual(extractRequirements(standard), scan.requirements);
});

test('scanPage names every defect with its line', () => {
  const bad = [
    '---',
    'code: plx-bad',
    'kind: contract',
    'maturity: draft',
    'binds: cloud',
    '---',
    '> - before any heading',
    'A host MUST not say so in prose.',
    '## § 1 One',
    '> quoted, not a bullet',
    '## Maintaining',
    '> - under maintaining',
    '## § 2 Late',
  ].join('\n');
  const scan = scanPage(bad, 'approaches/bad.md', 'module');
  assert.deepEqual(scan.defects, [
    '✗ approaches/bad.md: line 3: kind is the folder, contracts/ or approaches/, not a field',
    '✗ approaches/bad.md: line 7: requirement in a module at draft maturity: > - before any heading',
    '✗ approaches/bad.md: line 8: BCP 14 keyword outside a requirement: A host MUST not say so in prose.',
    '✗ approaches/bad.md: line 10: blockquote line is not a "> - " requirement bullet',
    '✗ approaches/bad.md: line 12: requirement in a module at draft maturity: > - under maintaining',
    '✗ approaches/bad.md: line 13: numbered section after Maintaining',
    '✗ approaches/bad.md: line 13: maturity must be note, candidate or standard, not "draft"',
    '✗ approaches/bad.md: line 13: binds must be repo, app, host or organisation, not "cloud"',
    '✗ approaches/bad.md: line 13: code must be PLX- plus one capitalised word, not "plx-bad"',
  ]);
  assert.deepEqual(scanPage('---\ntitle: x\n---\n\n> - The map MUST not.\n', 'essentials/standard.md', 'map').defects, [
    '✗ essentials/standard.md: line 5: requirement in the map: > - The map MUST not.',
  ]);
  assert.deepEqual(scanPage('---\ncode: PLX-Note\nmaturity: note\nbinds: repo\n---\n', 'n.md', 'module').defects, [
    '✗ n.md: line 5: a note carries no code',
  ]);
});

const page = (code: string, maturity: string, binds: string, extra = '') =>
  `---\n${code ? `code: ${code}\n` : ''}maturity: ${maturity}\nbinds: ${binds}\n${extra}---\n\nProse.\n`;

test('checkCompendium applies the cross-page rules', async () => {
  const tree: Tree = {
    c: {
      essentials: { 'standard.md': '---\ntitle: map\n---\n\nProse.\n' },
      contracts: {
        'index.md': '---\ntitle: index\n---\n',
        'repo.md': page('PLX-Repo', 'standard', 'repo'),
        'host.md': page('PLX-Host', 'candidate', 'host'),
        'twin.md': page('PLX-Repo', 'candidate', 'repo'),
        'odd.md': page('PLX-Odd', 'candidate', 'repo', 'depends: [PLX-Deploy]\nconsumes: [PLX-Host]\n'),
      },
      approaches: {
        'deploy.md': page(
          'PLX-Deploy',
          'candidate',
          'app',
          'depends: [PLX-Repo, PLX-Gone]\nconsumes: [PLX-Host, PLX-Deploy, PLX-Nope]\n',
        ),
        'ops.md': page('PLX-Ops', 'candidate', 'host', 'depends: [PLX-Deploy]\n'),
        'note.md': page('', 'note', 'host'),
      },
    },
  };
  const result = await checkCompendium(new Context({}, fakeIo(tree)), '/c');
  assert.equal(result.contracts, 4);
  assert.equal(result.approaches, 3);
  assert.deepEqual(result.defects.sort(), [
    '✗ PLX-Deploy consumes PLX-Deploy, which is an approach; only a contract is consumed across a seam',
    '✗ PLX-Deploy consumes unknown module PLX-Nope',
    '✗ PLX-Odd is a contract and consumes PLX-Host; a contract has no other side to consume',
    '✗ PLX-Odd is a contract and depends on the approach PLX-Deploy',
    '✗ PLX-Ops (host) depends on PLX-Deploy (app) across the dev/ops seam; only a contract may be depended on across a seam',
    '✗ duplicate module code: PLX-Repo',
    '✗ unknown module in depends: PLX-Gone',
  ]);
});

test('checkCompendium is clean on a well-formed compendium', async () => {
  const tree: Tree = {
    c: {
      essentials: { 'standard.md': '---\ntitle: map\n---\n\nProse.\n' },
      contracts: { 'repo.md': page('PLX-Repo', 'standard', 'repo'), 'app.md': page('PLX-App', 'standard', 'app') },
      approaches: {
        'platform.md': page('PLX-Platform', 'candidate', 'host', 'consumes: [PLX-App]\n'),
        'js.md': page('PLX-JS', 'candidate', 'repo', 'depends: [PLX-Repo]\n'),
      },
    },
  };
  const result = await checkCompendium(new Context({}, fakeIo(tree)), '/c');
  assert.deepEqual(result.defects, []);
});

test('requirementName reads the name a requirement line opens with, and names a malformed one', () => {
  const read = (bullet: string) => requirementName(bullet);
  assert.deepEqual(read(`\`${name('App', 'LoopbackPort')}\`: The app MUST listen.`), {
    name: name('App', 'LoopbackPort'),
  });
  assert.deepEqual(read(`\`${name('App', 'Stateful', 'MigrateService')}\`: It MUST migrate.`), {
    name: name('App', 'Stateful', 'MigrateService'),
  });
  assert.equal(read('The app MUST listen.'), undefined);
  assert.equal(read(`The app MUST, per \`${name('App', 'LoopbackPort')}\`: listen.`), undefined);
  assert.equal(read('`compose.yaml`: MUST exist.'), undefined, 'a code span that is no name');
  const format = 'the format is PLX-<Module>[/<Profile>]/<Name>, each segment capitalised';
  assert.deepEqual(read(`\`${name('App', 'lowercase')}\`: no.`), { name: name('App', 'lowercase'), malformed: format });
  assert.deepEqual(read(`\`${name('App', 'A', 'B', 'C')}\`: no.`), {
    name: name('App', 'A', 'B', 'C'),
    malformed: format,
  });
  assert.deepEqual(read(`\`${name('App', 'LoopbackPort')}\` without the colon.`), {
    name: name('App', 'LoopbackPort'),
    malformed: 'a name is followed by a colon and a blank',
  });
});

const named = (code: string, ...names: string[]) =>
  [
    '---',
    `code: ${code}`,
    'maturity: standard',
    'binds: app',
    '---',
    '',
    '## § 1 One',
    '',
    ...names.map((n) => `> - \`${n}\`: It MUST hold.`),
    '> - An unnamed line MUST still count.',
    '',
    '### § 1.1 Sub',
    '',
    '## § 2 Two',
    '',
  ].join('\n');

test('scanPage collects sections and requirement names, and refuses a malformed one or one of another module', () => {
  const scan = scanPage(
    named('PLX-App', name('App', 'Port'), name('App', 'Stateful', 'Migrate')),
    'contracts/app.md',
    'module',
  );
  assert.deepEqual(scan.defects, []);
  assert.deepEqual(scan.sections, ['1', '1.1', '2']);
  assert.deepEqual(scan.names, [name('App', 'Port'), name('App', 'Stateful', 'Migrate')]);
  assert.equal(scan.requirements.length, 3);

  const wrong = scanPage(
    named('PLX-App', name('Repo', 'Port'), name('App', 'port'), name('App', 'A', 'B', 'C')),
    'contracts/app.md',
    'module',
  );
  assert.deepEqual(wrong.defects, [
    `✗ contracts/app.md: line 9: requirement name ${name('Repo', 'Port')} does not start with the page's code, PLX-App`,
    `✗ contracts/app.md: line 10: malformed requirement name ${name('App', 'port')}: the format is PLX-<Module>[/<Profile>]/<Name>, each segment capitalised`,
    `✗ contracts/app.md: line 11: malformed requirement name ${name('App', 'A', 'B', 'C')}: the format is PLX-<Module>[/<Profile>]/<Name>, each segment capitalised`,
  ]);
  assert.deepEqual(wrong.names, []);

  // The profile's own page: its lines are named on the page of the module, never under the joined code.
  const profile = scanPage(named('PLX-AppStateful', name('App', 'Stateful', 'Migrate')), 'p.md', 'module');
  assert.deepEqual(profile.defects, [
    `✗ p.md: line 9: requirement name ${name('App', 'Stateful', 'Migrate')} does not start with the page's code, PLX-AppStateful`,
  ]);
});

test('checkCompendium refuses a profile spelled as a module', async () => {
  const tree = compendium();
  ((tree.c as Tree).contracts as Tree)['app-stateful.md'] = named('PLX-AppStateful', name('AppStateful', 'Migrate'));
  const result = await checkCompendium(new Context({}, fakeIo(tree)), '/c');
  assert.deepEqual(result.defects, [
    `✗ requirement name ${name('AppStateful', 'Migrate')} spells a profile of PLX-App as a module; a profile's lines are named PLX-App/<Profile>/<Name> on the page of PLX-App`,
  ]);
});

/** A tree as a git checkout: `git ls-files -z` lists its files. */
const checkout = (tree: Tree, root: string) =>
  fakeIo(tree, (cwd, args) => {
    if (cwd !== `/${root}` || args.join(' ') !== 'ls-files -z') return undefined;
    const files: string[] = [];
    const walk = (node: Tree, prefix: string) => {
      for (const [k, v] of Object.entries(node))
        typeof v === 'string' ? files.push(prefix + k) : walk(v, `${prefix}${k}/`);
    };
    walk(tree[root] as Tree, '');
    return files.map((f) => `${f}\0`).join('');
  });

const compendium = (extra: Record<string, string> = {}): Tree => ({
  c: {
    'README.md': 'The compendium.\n',
    essentials: { 'standard.md': '---\nversion: 0.1.0\n---\n\n## § 1 Map\n\nProse.\n\n### § 1.1 More\n' },
    contracts: {
      'app.md': named('PLX-App', name('App', 'Port'), name('App', 'Stateful', 'Migrate')),
      'app-stateful.md': named('PLX-AppStateful'),
    },
    approaches: { 'note.md': '---\nmaturity: note\nbinds: host\n---\n\n## § 1 Unciteable\n' },
    ...extra,
  },
});

test('readCitable lists every numbered section by code and every requirement name', async () => {
  assert.deepEqual(await readCitable(new Context({}, fakeIo(compendium())), '/c'), [
    cite('1', 'PLX'),
    cite('1.1', 'PLX'),
    cite('1', 'PLX-App'),
    cite('1.1', 'PLX-App'),
    cite('2', 'PLX-App'),
    name('App', 'Port'),
    name('App', 'Stateful', 'Migrate'),
    cite('1', 'PLX-AppStateful'),
    cite('1.1', 'PLX-AppStateful'),
    cite('2', 'PLX-AppStateful'),
  ]);
});

test('checkCompendium refuses a requirement name given twice', async () => {
  const tree = compendium();
  ((tree.c as Tree).contracts as Tree)['app.md'] = named('PLX-App', name('App', 'Port'), name('App', 'Port'));
  const result = await checkCompendium(new Context({}, fakeIo(tree)), '/c');
  assert.ok(result.defects.includes(`✗ duplicate requirement name: ${name('App', 'Port')}`), result.defects.join('\n'));
});

test('checkRepo passes a clean compendium and fails each planted violation', async () => {
  const clean = compendium({
    'guide.md': `See ${cite('1.1', 'PLX')}, ${cite('2', 'PLX-App')} and ${name('App', 'Stateful', 'Migrate')}.\n`,
  });
  const ok = await checkRepo(new Context({}, checkout(clean, 'c')), '/c');
  assert.deepEqual(ok.defects, []);
  assert.equal(ok.kind, 'compendium');

  const planted = compendium({
    'guide.md': [
      `Since Plexus 0.111.0, see ${cite('3', 'PLX-App')}, ${'PLX-App'} § 4 and ${name('App', 'Gone')}.`,
      `Fixed in ${id('ABC', 4)}.`,
    ].join('\n'),
  });
  // A bare sign on a module page names a section of that page.
  ((planted.c as Tree).contracts as Tree)['app.md'] += 'See § 2 and § 9.\n';
  const bad = await checkRepo(new Context({}, checkout(planted, 'c')), '/c');
  assert.deepEqual(bad.defects, [
    `✗ contracts/app.md: line 16: ${cite('9', 'PLX-App')} cites a section that does not exist`,
    '✗ guide.md: line 1: a date or version number in prose goes stale; say it once where it is maintained: 0.111.0',
    `✗ guide.md: line 1: ${cite('3', 'PLX-App')} cites a section that does not exist`,
    `✗ guide.md: line 1: ${cite('4', 'PLX-App')} cites a section that does not exist`,
    `✗ guide.md: line 1: ${name('App', 'Gone')} names no requirement line`,
    `✗ guide.md: line 2: ${id('ABC', 4)} reads as an issue identifier; say what it means instead`,
  ]);
});

test('checkRepo holds violations against the baseline, and the baseline against the violations', async () => {
  const tree = compendium({ 'guide.md': 'Measured on 2026-11-04 and 2026-11-05.\n' });
  const ctx = new Context({}, checkout(tree, 'c'));
  const [step] = await planBaseline(ctx, '/c');
  assert.ok(step?.kind === 'write' && step.path === `/c/${BASELINE_FILE}`);
  assert.deepEqual(
    step.content.split('\n').filter((l) => !l.startsWith('#')),
    ['date-or-version guide.md: 2026-11-04', 'date-or-version guide.md: 2026-11-05', ''],
  );

  (tree.c as Tree)[BASELINE_FILE] = step.content;
  const known = await checkRepo(new Context({}, checkout(tree, 'c')), '/c');
  assert.deepEqual([known.defects, known.known], [[], 2]);

  // One fixed, one added: the new one fails, and so does the entry left behind.
  (tree.c as Tree)['guide.md'] = 'Measured on 2026-11-04 and 2026-11-06.\n';
  const moved = await checkRepo(new Context({}, checkout(tree, 'c')), '/c');
  assert.deepEqual(moved.defects, [
    '✗ guide.md: line 1: a date or version number in prose goes stale; say it once where it is maintained: 2026-11-06',
    `✗ ${BASELINE_FILE}: no longer occurs, remove it: date-or-version guide.md: 2026-11-05`,
  ]);
});

test('checkRepo checks the file headers of a template, and only under its subdirectory', async () => {
  const header = (n: number) => `${Array.from({ length: n }, (_, i) => `# ${i}`).join('\n')}\nkey: 1\n`;
  const tree: Tree = {
    t: {
      'copier.yml': '_subdirectory: template\n\ntenant:\n  type: str\n',
      'mise.toml': header(5),
      template: { 'ok.yml': header(2), 'long.yml.jinja': header(3) },
    },
  };
  const check = await checkRepo(new Context({}, checkout(tree, 't')), '/t');
  assert.equal(check.kind, 'template');
  assert.deepEqual(check.defects, [
    '✗ template/long.yml.jinja: line 1: 3 header comment lines; a template file opens with at most 2, and the rest lives in the compendium',
  ]);
  (tree.t as Tree).template = { 'ok.yml': header(2), 'long.yml.jinja': header(2) };
  assert.deepEqual((await checkRepo(new Context({}, checkout(tree, 't')), '/t')).defects, []);
});

test('checkRepo in a tenant repo, no compendium in reach, resolves citations against the index plx carries', async () => {
  const index = bundledIndex();
  assert.ok(index.citable.includes(cite('1', 'PLX')) && index.citable.includes(cite('1', 'PLX-App')));
  const tree: Tree = {
    r: {
      'PLEXUS.md': '---\nplexus: 0.1.0\nmodules: [PLX-Repo]\n---\n',
      'mise.toml': `# The verbs (${cite('1', 'PLX')}, ${cite('1', 'PLX-App')}).\n`,
    },
  };
  const clean = await checkRepo(new Context({}, checkout(tree, 'r')), '/r');
  assert.deepEqual([clean.kind, clean.defects], ['repo', []]);
  assert.equal(clean.against, `Plexus ${index.version}, the index this plx carries`);

  (tree.r as Tree)['mise.toml'] = `# ${cite('999', 'PLX')} and ${name('App', 'NoSuchName')}\n`;
  const stale = await checkRepo(new Context({}, checkout(tree, 'r')), '/r');
  assert.deepEqual(stale.defects, [
    `✗ mise.toml: line 1: ${cite('999', 'PLX')} cites a section that does not exist`,
    `✗ mise.toml: line 1: ${name('App', 'NoSuchName')} names no requirement line`,
  ]);
});

test('checkRepo resolves against a compendium checkout when given one', async () => {
  const tree: Tree = { ...compendium(), r: { 'notes.txt': `${name('App', 'Port')} and ${cite('1.1', 'PLX-App')}\n` } };
  const check = await checkRepo(new Context({}, checkout(tree, 'r')), '/r', { compendium: '/c' });
  assert.deepEqual([check.defects, check.against], [[], 'the compendium at /c']);
  // The same line against the index this plx carries, which names no requirement yet.
  assert.equal(lintCitations(`${name('App', 'Port')}`, 'notes.txt', new Set(bundledIndex().citable)).length, 1);
});

test('checkCommitMessage reads the comment character from git', async () => {
  const message = `fix: x\n\n; Please enter the commit message for your changes.\n; On branch ${id('XYZ', 13)}-topic\n`;
  const io = (char: string | undefined) =>
    fakeIo({ r: { MSG: message } }, (cwd, args) =>
      cwd === '/r' && args.join(' ') === 'config --get core.commentChar' ? char : undefined,
    );
  assert.deepEqual(await checkCommitMessage(new Context({}, io(';\n')), '/r/MSG', '/r'), []);
  assert.deepEqual(
    (await checkCommitMessage(new Context({}, io(undefined)), '/r/MSG', '/r')).map((v) => v.excerpt),
    [id('XYZ', 13)],
    'unset, the character is #, and the template is read as message',
  );
});
