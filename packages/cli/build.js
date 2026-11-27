// Bundle plx into one script: src/ and its dependencies, @plexus-ms/lib,
// commander and the prompt, all inlined. `pnpm build` and `prepack` run this.
// The template engine stays outside the bundle: it loads its wasm library by a
// path relative to its own file, so it is installed with plx (a dependency,
// which brings the wasm library) and imported from there when a verb renders.
// The other inlined packages are declared as dependencies all the same, so that
// a release of theirs releases the cli that carries them (changesets bumps a
// dependent, `plx changeset` reads the runtime fields); the install they cause
// is redundant and small.
//
// The templates of `tooling` (templates/ at its root, outside this package)
// are copied to dist/templates, so that `dist`, the one directory the package
// publishes, holds them; `templatesRoot` of @plexus-ms/lib finds them beside
// the bundle. A copy that keeps modes, dotfiles included. The output directory
// is `dist`, or the argument: a test builds into a scratch directory so that it
// never writes where a concurrent build does.
import { cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';

const out = process.argv[2] ?? 'dist';

await build({
  entryPoints: ['src/bin.ts'],
  outfile: join(out, 'plx.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['@plexus-ms/cli-template'],
  banner: {
    js: [
      '// Bundled by esbuild (build.js) after the shebang of src/bin.ts; edit src/, not this file.',
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
});

rmSync(join(out, 'templates'), { recursive: true, force: true });
cpSync('../../templates', join(out, 'templates'), { recursive: true });
