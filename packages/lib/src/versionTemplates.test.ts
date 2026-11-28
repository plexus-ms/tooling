// The templates of a Plexus version and the engine that renders them, without
// the network: the registry is a fake `npm` that lays out what an install
// would, and another version's plx-template is this workspace's, run as a
// process the way an installed one is.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';
import { Context, ExecError, type Fetched, fromRegistry, realIo, templatesOf } from './index.ts';
import { quietContext, scratchDir, templatesAt } from './testing/siteRepo.ts';

const scratch = scratchDir('versions');
after(scratch.remove);

/** This workspace's plx-template, standing in for another version's. */
const PLX_TEMPLATE = join(import.meta.dirname, '..', '..', 'cli-template', 'src', 'bin.ts');

const BASKET = {
  manifest: ['name: basket', 'questions:', '  fruit:', '    type: str', '  count:', '    default: 3', ''].join('\n'),
  files: { 'list.txt.jinja': '{{ count }} {{ fruit }}s\n', 'notes.md': 'notes\n' },
};

test('the running version is rendered from the bundled templates by this plx, and nothing is fetched', async () => {
  const bundled = templatesAt(scratch.fresh('bundled'), { basket: BASKET });
  const templates = await templatesOf(quietContext(), '0.2.0', {
    plxVersion: '0.2.0',
    bundled,
    scratch: scratch.fresh('work'),
    fetch: async () => assert.fail('nothing is fetched for the running version'),
  });
  assert.deepEqual(templates, { root: bundled });
});

test('another version is fetched once and rendered by its own plx-template, the render read with its policies', async () => {
  const fetched = templatesAt(scratch.fresh('fetched'), { basket: BASKET });
  const work = scratch.fresh('work');
  const asked: { version: string; into: string }[] = [];
  const templates = await templatesOf(quietContext(), '0.1.0', {
    plxVersion: '0.2.0',
    scratch: work,
    fetch: async (_ctx, version, into) => {
      asked.push({ version, into });
      return { plxTemplate: PLX_TEMPLATE, templates: fetched };
    },
  });
  assert.deepEqual(asked, [{ version: '0.1.0', into: join(work, '0.1.0') }]);
  assert.equal(templates.root, fetched);
  const result = await templates.render?.(['basket'], { fruit: 'pear' });
  assert.deepEqual(result?.errors, []);
  assert.deepEqual(result?.rendered?.answers, { fruit: 'pear', count: 3 });
  assert.equal(new TextDecoder().decode(result?.rendered?.tree.get('list.txt')?.bytes), '3 pears\n');
  assert.deepEqual([...(result?.rendered?.policies.keys() ?? [])], ['list.txt', 'notes.md']);
  const again = await templates.render?.(['basket'], { fruit: 'plum' });
  assert.equal(new TextDecoder().decode(again?.rendered?.tree.get('list.txt')?.bytes), '3 plums\n', 'a render each');
});

test("the errors of another version's render are listed, not thrown; a plx-template that fails is an error", async () => {
  const fetched = templatesAt(scratch.fresh('fetched'), { basket: BASKET });
  const options = (plxTemplate: string) => ({
    plxVersion: '0.2.0',
    scratch: scratch.fresh('work'),
    fetch: async (): Promise<Fetched> => ({ plxTemplate, templates: fetched }),
  });
  const templates = await templatesOf(quietContext(), '0.1.0', options(PLX_TEMPLATE));
  const missing = await templates.render?.(['basket'], {});
  assert.equal(missing?.rendered, undefined);
  assert.equal(missing?.errors.length, 1);
  assert.match(missing?.errors[0] ?? '', /fruit/);
  const broken = await templatesOf(quietContext(), '0.1.0', options(join(fetched, 'no-such-bin.js')));
  await assert.rejects(broken.render?.(['basket'], { fruit: 'pear' }) ?? Promise.resolve(), /plx-template of 0\.1\.0/);
});

test('a version whose templates cannot be fetched fails loudly, naming the version', async () => {
  await assert.rejects(
    templatesOf(quietContext(), '0.1.0', {
      plxVersion: '0.2.0',
      scratch: scratch.fresh('work'),
      fetch: async () => {
        throw new Error('the registry is down');
      },
    }),
    /0\.1\.0.*the registry is down/s,
  );
});

/** A context whose `npm` lays out the install `files` describe below `--prefix`, or fails when there are none. */
function npmContext(files: Record<string, string> | undefined) {
  const calls: { args: string[]; cwd?: string }[] = [];
  const io = realIo();
  const ctx = new Context(
    { yes: true },
    {
      ...io,
      stderr: new PassThrough(),
      exec: async (command, args, options) => {
        if (command !== 'npm') return io.exec(command, args, options);
        calls.push({ args, ...(options?.cwd ? { cwd: options.cwd } : {}) });
        if (!files) throw new ExecError('npm install', 1, 'npm error 404 Not Found');
        const prefix = args[args.indexOf('--prefix') + 1] ?? '';
        for (const [path, text] of Object.entries(files)) {
          mkdirSync(join(prefix, path, '..'), { recursive: true });
          writeFileSync(join(prefix, path), text);
        }
        return '';
      },
    },
  );
  return { ctx, calls };
}

const INSTALLED = {
  'node_modules/@plexus-ms/cli/dist/templates/basket/template.yml': BASKET.manifest,
  'node_modules/@plexus-ms/cli-template/package.json': '{"bin": {"plx-template": "./dist/bin.js"}}',
  'node_modules/@plexus-ms/cli-template/dist/bin.js': '',
};

test('from the registry: @plexus-ms/cli of the version installed into the directory, its templates and plx-template', async () => {
  const into = scratch.fresh('into');
  const { ctx, calls } = npmContext(INSTALLED);
  const fetched = await fromRegistry(ctx, '0.1.0', into);
  assert.deepEqual(fetched, {
    plxTemplate: join(into, 'node_modules/@plexus-ms/cli-template/dist/bin.js'),
    templates: join(into, 'node_modules/@plexus-ms/cli/dist/templates'),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.cwd, into, "run outside the repo, so that the repo's own npm settings do not apply");
  assert.deepEqual(calls[0]?.args.slice(0, 3), ['install', '--prefix', into]);
  assert.equal(calls[0]?.args.at(-1), '@plexus-ms/cli@0.1.0');
  assert.ok(calls[0]?.args.includes('--ignore-scripts'), 'no install script of the package runs');
});

test('from the registry: an install that fails, or a version that bundles no templates, fails loudly', async () => {
  const failing = npmContext(undefined);
  await assert.rejects(
    fromRegistry(failing.ctx, '0.1.0', scratch.fresh('into')),
    /cannot fetch @plexus-ms\/cli@0\.1\.0 from the registry/,
  );
  const old = npmContext({ 'node_modules/@plexus-ms/cli/dist/plx.js': '' });
  await assert.rejects(
    fromRegistry(old.ctx, '0.1.0', scratch.fresh('into')),
    /@plexus-ms\/cli@0\.1\.0 bundles no templates/,
  );
});
