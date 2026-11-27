// Bundle plx-ci into one script, as plx is (packages/cli/build.js): src/ and
// its dependencies, @plexus-ms/lib and commander, inlined. The inlined packages
// stay declared as dependencies so that a release of theirs releases this cli.
// The template engine, which lib loads on first use and plx-ci never uses, is
// neither bundled nor needed (lib's engine.ts).
import { join } from 'node:path';
import { build } from 'esbuild';

// The output directory is `dist`, or the argument: a test builds into a scratch
// directory so that it never writes where a concurrent build does.
const out = process.argv[2] ?? 'dist';

await build({
  entryPoints: ['src/bin.ts'],
  outfile: join(out, 'plx-ci.js'),
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
