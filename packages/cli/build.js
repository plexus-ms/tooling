// Bundle plx into one script: src/ and its dependencies, @plexus-ms/lib,
// commander and the prompt, all inlined. `pnpm build` and `prepack` run this.
// The inlined packages are declared as dependencies all the same, so that a
// release of theirs releases the cli that carries them (changesets bumps a
// dependent, `plx changeset` reads the runtime fields); the install they
// cause is redundant and small.
//
// The templates of `tooling` (templates/ at its root, outside this package)
// are copied to dist/templates, so that `dist`, the one directory the package
// publishes, holds them; `templatesRoot` of @plexus-ms/lib finds them beside
// the bundle. A copy that keeps modes, dotfiles included.
import { cpSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

await build({
  entryPoints: ['src/bin.ts'],
  outfile: 'dist/plx.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  banner: {
    js: [
      '// Bundled by esbuild (build.js) after the shebang of src/bin.ts; edit src/, not this file.',
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
});

rmSync('dist/templates', { recursive: true, force: true });
cpSync('../../templates', 'dist/templates', { recursive: true });
