// planSync on scratch repos, as `plx update` calls it: the two sides of a site
// from two versions' templates, each rendered by its own side, and the version
// written into the root marker with the defaults. `apply`'s use of it is
// tested through `apply` (apply.test.ts).
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { type Answers, readTree, render } from '@plexus-ms/cli-template';
import { planSync, type Source } from './index.ts';
import { quietContext, repoWith, scratchDir, templatesAt, text } from './testing/siteRepo.ts';

const scratch = scratchDir('sync');
after(scratch.remove);

const BASKET = {
  manifest: ['name: basket', 'questions:', '  fruit:', '    type: str', ''].join('\n'),
  files: { 'list.txt.jinja': '{{ fruit }}s\nfresh\n' },
};
/** The basket of the next version: a question with a default, and a line more in its file. */
const BASKET_NEXT = {
  manifest: ['name: basket', 'questions:', '  fruit:', '    type: str', '  count:', '    default: 3', ''].join('\n'),
  files: { 'list.txt.jinja': '{{ count }} {{ fruit }}s\nfresh\n' },
};
const CRATE = {
  manifest: ['name: crate', 'reads:', '  count:', '    default: 1', ''].join('\n'),
  files: { 'crate.txt.jinja': 'a crate of {{ count }}\n' },
};

const marker = (keys: string) => `---\n${keys}---\n\n- A repo.\n`;
const ROOT = marker('version: 0.1.0\ntemplates: [basket]\nfruit: apple\n');
const basket: Source = { templates: ['basket'], answers: { fruit: 'apple' } };

test("planSync renders a side by that side's own render, the root first and its resolved answers given to the nested", async () => {
  const old = templatesAt(scratch.fresh('v1'), { basket: BASKET, crate: CRATE });
  const next = templatesAt(scratch.fresh('v2'), { basket: BASKET_NEXT, crate: CRATE });
  const repo = repoWith(scratch.fresh('repo'), {
    'PLEXUS.md': ROOT,
    'list.txt': 'apples\nfresh\n',
    'apps/x/PLEXUS.md': marker('templates: [crate]\n'),
    'apps/x/crate.txt': 'a crate of 1\n',
  });
  const given: { names: readonly string[]; answers: Answers }[] = [];
  // Another version's plx-template, as the caller would run it: here the engine on the templates of `next`.
  const renderNext = async (names: readonly string[], answers: Answers) => {
    given.push({ names, answers });
    const result = render(await Promise.all(names.map((n) => readTree(join(next, n)))), answers);
    return {
      rendered: { tree: result.tree, policies: result.files, answers: result.answers },
      errors: result.errors.map((e) => e.message),
    };
  };
  const crate: Source = { templates: ['crate'], answers: {} };
  const plan = await planSync(quietContext(), repo, { old: { root: old }, new: { root: next, render: renderNext } }, [
    { dir: 'apps/x', old: crate, new: crate },
    { dir: '.', old: basket, new: basket },
  ]);
  assert.deepEqual(given, [
    { names: ['basket'], answers: { fruit: 'apple' } },
    { names: ['crate'], answers: { fruit: 'apple', count: 3 } },
  ]);
  await plan.perform();
  assert.equal(text(repo, 'list.txt'), '3 apples\nfresh\n');
  assert.equal(text(repo, 'apps/x/crate.txt'), 'a crate of 3\n', "the root's new default reached the nested render");
  assert.equal(text(repo, 'apps/x/PLEXUS.md'), marker('templates: [crate]\n'), 'nothing written into it');
});

test("planSync lists the errors of a side's own render with the site and the side", async () => {
  const root = templatesAt(scratch.fresh('templates'), { basket: BASKET });
  const repo = repoWith(scratch.fresh('repo'), { 'PLEXUS.md': ROOT, 'list.txt': 'apples\nfresh\n' });
  const refuse = async () => ({ errors: ['a question without an answer (question size)'] });
  await assert.rejects(
    planSync(
      quietContext(),
      repo,
      { old: { root }, new: { root, render: refuse } },
      [{ dir: '.', old: basket, new: basket }],
      { labels: { old: 'the templates of 0.1.0', new: 'the templates of 0.2.0' } },
    ),
    { message: '.: a question without an answer (question size) [the templates of 0.2.0]' },
  );
  assert.equal(text(repo, 'list.txt'), 'apples\nfresh\n');
});

test('planSync writes the version into the root marker in the same splice as its defaults', async () => {
  const old = templatesAt(scratch.fresh('v1'), { basket: BASKET });
  const next = templatesAt(scratch.fresh('v2'), { basket: BASKET_NEXT });
  const repo = repoWith(scratch.fresh('repo'), { 'PLEXUS.md': ROOT, 'list.txt': 'apples\nfresh\n' });
  const plan = await planSync(
    quietContext(),
    repo,
    { old: { root: old }, new: { root: next } },
    [{ dir: '.', old: basket, new: basket }],
    { version: '0.2.0' },
  );
  assert.deepEqual(plan.sites[0]?.defaults, { count: 3 });
  await plan.perform();
  assert.equal(text(repo, 'PLEXUS.md'), marker('version: 0.2.0\ntemplates: [basket]\nfruit: apple\ncount: 3\n'));
  assert.equal(text(repo, 'list.txt'), '3 apples\nfresh\n');
});

test('planSync writes the version into a root marker that renders nothing, and nowhere under a dry run', async () => {
  const root = templatesAt(scratch.fresh('templates'), { basket: BASKET });
  const repo = repoWith(scratch.fresh('repo'), { 'PLEXUS.md': marker('version: 0.1.0\n') });
  const none: Source = { templates: [], answers: {} };
  const sites = [{ dir: '.', old: none, new: none, contextOnly: true }];
  const dry = await planSync(quietContext({ yes: true, dryRun: true }), repo, root, sites, { version: '0.2.0' });
  await dry.perform();
  assert.equal(text(repo, 'PLEXUS.md'), marker('version: 0.1.0\n'));
  const plan = await planSync(quietContext(), repo, root, sites, { version: '0.2.0' });
  assert.deepEqual(plan.sites, [], 'the root is no site of the plan');
  await plan.perform();
  assert.equal(text(repo, 'PLEXUS.md'), marker('version: 0.2.0\n'));
});
