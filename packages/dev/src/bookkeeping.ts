// The version bookkeeping as text transforms: every version number a versioned repo
// carries becomes the Plexus version, so cross-repo pins are right by
// construction (§ 1.5 PLX). Pure functions from a file's text to its new text;
// `ship` reads, transforms and plans a write for each one that changed. The
// workflow refs are moved by the same transform a repo taking the version runs,
// `bumpWorkflowRefs` of @plexus-ms/lib.
//
// One writer per pin (§ 1 PLX-Updates): the pins below are the version's and
// nobody else's; the update bot is told to leave them alone.
import { setFrontmatterField } from '@plexus-ms/lib';

/** The four collections of `tooling`, each with a `galaxy.yml` of its own (§ 2 PLX-Platform). */
export const COLLECTIONS = ['host', 'platform', 'infrastructure', 'ci'] as const;

/** A collection's `galaxy.yml` in `tooling`. */
export const galaxyFile = (collection: string): string => `ansible/${collection}/galaxy.yml`;

/** `galaxy.yml` mirrors the tag: SCM installs record this version and reinstall on any different one. */
export const bumpGalaxyVersion = (text: string, version: string): string =>
  text.replace(/^(version: )\d+\.\d+\.\d+/m, `$1${version}`);

/** The git source of the `plexus.*` collections, as an operations repo's requirements name it. */
export const COLLECTION_SOURCE = 'plexus-ms/tooling.git';

/** The `plexus.*` collections' pins in an operations repo's requirements, every entry from `tooling`; a collection from elsewhere in the same file stays. */
export function bumpCollectionPin(text: string, version: string): string {
  const lines = text.split('\n');
  let ours = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^\s*- /.test(line)) ours = line.includes(COLLECTION_SOURCE);
    const m = /^(\s*version: )v?[\d.]+$/.exec(line);
    if (ours && m) lines[i] = `${m[1]}${version}`;
  }
  return lines.join('\n');
}

/** Where the runner image of a runner host's slots is pinned: the role's defaults, in tooling. */
export const RUNNER_IMAGE_PIN_FILE = 'ansible/ci/roles/actions_runners/defaults/main.yml';

/** The runner image's tag, `ghcr.io/plexus-ms/ci-runner:<version>`, which runner-image.yml pushes from the version's release. */
export const bumpRunnerImagePin = (text: string, version: string): string =>
  text.replace(/(ghcr\.io\/plexus-ms\/ci-runner:)\d+\.\d+\.\d+/g, `$1${version}`);

/** A package manifest's own `version`: the first one in the file, which is the top-level field. */
export const bumpManifestVersion = (text: string, version: string): string =>
  text.replace(/^(\s*"version":\s*")[^"]*(")/m, `$1${version}$2`);

/** The plx and plx-ci pins in a `mise.toml`, exact, in either spelling: `"npm:@plexus-ms/cli" = "N"` or `= { version = "N", ... }`. */
export const PLX_PIN = 'npm:@plexus-ms/cli';
export const bumpPlxPin = (text: string, version: string): string =>
  text.replace(/("npm:@plexus-ms\/cli(?:-ci)?"\s*=\s*(?:\{\s*version\s*=\s*)?")[^"]*(")/g, `$1${version}$2`);

/** The map's frontmatter carries the Plexus version and the date it was cut (§ 1.5 PLX). */
export const stampStandard = (text: string, version: string, today: string): string =>
  setFrontmatterField(setFrontmatterField(text, 'version', version), 'timestamp', today);

/** `changed: <version>` on a module page: replaced in place, or inserted after `binds:` (the field order of § 1.3 PLX). */
export const stampChanged = (text: string, version: string): string =>
  setFrontmatterField(text, 'changed', version, { after: 'binds' });

/** Today as `YYYY-MM-DD` in local time, like `date +%F`. */
export function today(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
