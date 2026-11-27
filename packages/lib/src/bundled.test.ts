// The templates a plx bundles, and the loader of one template's manifest.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { bundledTemplatesRoot, loadTemplate } from './index.ts';
import { scratchDir, templatesAt } from './testing/siteRepo.ts';

const scratch = scratchDir('bundled');
after(scratch.remove);

const BASKET = ['name: basket', 'questions:', '  fruit:', '    type: str', '  count:', '    default: 3', ''].join('\n');

test('the bundled templates have no root until the templates are bundled, and say so', () => {
  assert.throws(() => bundledTemplatesRoot(), /no bundled templates/);
});

test('loadTemplate returns the manifest of the template of that name below the root', async () => {
  const root = templatesAt(scratch.fresh('root'), { basket: { manifest: BASKET, files: { 'a.txt': 'a' } } });
  const manifest = await loadTemplate(root, 'basket');
  assert.equal(manifest.name, 'basket');
  assert.deepEqual(
    manifest.questions.map((q) => q.name),
    ['fruit', 'count'],
  );
});

test('loadTemplate names the root and the template when there is no such template', async () => {
  const root = templatesAt(scratch.fresh('root'), { basket: { manifest: BASKET } });
  await assert.rejects(loadTemplate(root, 'ghost'), (error: Error) => {
    assert.match(error.message, /no template ghost/);
    assert.ok(error.message.includes(root));
    return true;
  });
});

test('loadTemplate rejects a name that leaves the root', async () => {
  const root = templatesAt(scratch.fresh('root'), { basket: { manifest: BASKET } });
  await assert.rejects(loadTemplate(root, '../basket'), /not a template name/);
});
