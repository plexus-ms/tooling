// The offline harness for the version, both sides of it: `ship` cutting it here,
// and @plexus-ms/lib's `update` taking it, in one repo and recursively, end to end. It
// lives in the package that depends on both. A scratch workspace laid out like ~/dev — the
// five versioned repos with bare "origin" remotes (the compendium among them), a
// tenant with a web repo (root + one app, on develop) and a platform repo (on
// main), each with a bare origin of its own — plus fakes for `copier`, `mise`,
// `gh` and `npm` on PATH, and a scratch "forge" the gh and npm fakes share.
// Each scenario builds a fresh fixture, runs `ship`, `update` or `update --recursive`
// against it with the real Io, and asserts on tags, releases, the consumers'
// origins, the summary and the narration.
//
// Fake copier: `copier update` writes "updated from <ref>" into
// template-owned.txt, bumps _commit in the answers file, and touches
// package.json at a web root (so the lockfile refresh triggers). Knobs:
//   FAKE_COPIER_FAIL=<substring>      exit 1 at a site whose path matches
//   FAKE_COPIER_CONFLICT=<substring>  leave <<<<<<< markers at a matching site
// Fake gh: releases and pull requests are files under the forge, keyed by the
// repo (the basename of origin); `release create` checks the tag is on origin,
// keeps the release's notes (notes-<tag>) and, on tooling, "publishes" the
// version to the fake registry. A pull request is pr-<branch> (its URL) with
// .body, .base, .draft and, once a human closes it, .state (CLOSED) beside
// it; `pr list` answers as JSON, `pr ready`
// (--undo) sets .draft, and `api repos/{owner}/{repo}/pulls/<n> --method
// PATCH -f body=…` rewrites .body, and `api …/pulls/<n>/requested_reviewers
// --method POST -f reviewers[]=…` appends the logins to .reviewers. Knobs:
//   FAKE_GH_LOGGED_OUT=1              `gh auth status` fails
//   FAKE_GH_MUTABLE=1                 releases are created mutable
//   FAKE_GH_CREATE_FAIL=<repo>        `gh release create` fails in that repo
//   FAKE_GH_REVIEW_FAIL=1             a review request fails
//   FAKE_GH_PR_CREATE_FAIL=1          `gh pr create` fails
//   FAKE_GH_PR_LIST_FAIL=1            `gh pr list` fails
//   FAKE_GH_USER=<login>              who `gh pr create` opens as (default plx-bot)
// `api repos/<o>/<r>/releases` lists that repo's releases as "<tag> <date>",
// the date from `versionCut` (default: 2026-01-01, the fixture's epoch).
// Fake npm: `npm view <pkg>@<v> version` answers once tooling's release of
// v exists and FAKE_NPM_POLLS polls have gone by; FAKE_NPM_NEVER=1 never answers.
// Every invocation is appended to FAKE_LOG.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';
import {
  COPIER_VERSION,
  Context,
  type Options,
  type RecursiveOptions,
  realIo,
  type Summary,
  summarize,
  type UpdateOptions,
  update,
  updateRecursive,
  VERSIONED_REPOS,
} from '@plexus-ms/lib';
import { type ShipOptions, type ShipResult, ship } from './ship.ts';

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'plx-ship-')));
after(() => rmSync(TMP, { recursive: true, force: true }));

// Git must not reach the user's config: no signing (1Password would prompt),
// a stand-in identity, main as the default branch.
const gitconfig = join(TMP, 'gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = gitconfig;
process.env.GIT_AUTHOR_DATE = '2026-01-01T00:00:00Z';
process.env.GIT_COMMITTER_DATE = '2026-01-01T00:00:00Z';
for (const [k, v] of [
  ['user.name', 'ship-test'],
  ['user.email', 'ship-test@localhost'],
  ['commit.gpgsign', 'false'],
  ['tag.gpgsign', 'false'],
  ['init.defaultBranch', 'main'],
])
  execFileSync('git', ['config', '--file', gitconfig, k ?? '', v ?? '']);

/**
 * Run `body` with git's colour forced on, as a user's config can: what plx
 * parses of git's output must not depend on it. The update runs go through it.
 */
async function coloured<T>(body: () => Promise<T>): Promise<T> {
  const pairs = [
    ['color.ui', 'always'],
    ['color.grep', 'always'],
    ['color.diff', 'always'],
    ['color.status', 'always'],
  ];
  process.env.GIT_CONFIG_COUNT = String(pairs.length);
  pairs.forEach(([k, v], i) => {
    process.env[`GIT_CONFIG_KEY_${i}`] = k;
    process.env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  try {
    return await body();
  } finally {
    delete process.env.GIT_CONFIG_COUNT;
    pairs.forEach((_, i) => {
      delete process.env[`GIT_CONFIG_KEY_${i}`];
      delete process.env[`GIT_CONFIG_VALUE_${i}`];
    });
  }
}

const FAKE_BIN = join(TMP, 'bin');
mkdirSync(FAKE_BIN);
const script = (name: string, body: string) => {
  writeFileSync(join(FAKE_BIN, name), `#!/usr/bin/env bash\nset -euo pipefail\n${body}`);
  chmodSync(join(FAKE_BIN, name), 0o755);
};
script(
  'copier',
  `src="$(sed -n 's/^_src_path: //p' .copier-answers.yml)"
echo "$PWD $src $*" >> "$FAKE_LOG"
ref="latest-tag"
while [ $# -gt 0 ]; do [ "$1" = --vcs-ref ] && ref="$2"; shift; done
[ -z "\${FAKE_COPIER_FAIL:-}" ] || case "$PWD" in *"$FAKE_COPIER_FAIL"*) echo "fake copier: failing on purpose" >&2; exit 1 ;; esac
echo "updated from $ref" > template-owned.txt
sed -i.bak 's/^_commit: .*/_commit: next/' .copier-answers.yml && rm -f .copier-answers.yml.bak
[ ! -f package.json ] || echo '{"name": "touched"}' > package.json
[ -z "\${FAKE_COPIER_CONFLICT:-}" ] || case "$PWD" in *"$FAKE_COPIER_CONFLICT"*) printf '<<<<<<< before\\nx\\n=======\\ny\\n>>>>>>> after\\n' > template-owned.txt ;; esac
`,
);
// Fake mise: logs, and runs the pinned copier (`mise exec copier@X -- copier …`)
// as the fake copier above. `mise run verify` in a template is its newborn
// test: two newborn repos (shapes `one` and `two`) rendered as copier
// would, each a git repo with a marker, under a directory made in TMPDIR,
// named by `kept: <dir>` under KEEP=1 as the real tests do, with each step
// announced as `→ <shape>: <step>`; it logs the environment ship gives it.
// `mise tasks ls --json` in a newborn lists the contract verbs from its own
// mise.toml. Knobs:
//   FAKE_NEWBORN_CHECK_FAIL=<template>   its newborn's check fails, in shape two
//   FAKE_NEWBORN_DOCTOR_FAIL=<template>  its newborn one has no `verify` task
//   FAKE_NEWBORN_KEPT=<template>=<path>  it says it kept them at <path> instead,
//                                        a literal $TMPDIR in it expanded
//   FAKE_PNPM_FAIL=1                     \`mise exec -- pnpm install\` fails
//   FAKE_NEWBORN_HANG=<template>         it hangs in shape one's check, in a
//                                        background sleep whose pid goes to
//                                        FAKE_NEWBORN_HANG_PID
// Anything else it only logs.
script(
  'mise',
  `echo "mise $* ignored=\${MISE_IGNORED_CONFIG_PATHS:-}" >> "$FAKE_LOG"
if [ "$1" = exec ] && [[ "$2" == copier@* ]] && [ "$3" = -- ]; then shift 3; exec "$@"; fi
case "$*" in "exec -- pnpm install"*) [ -z "\${FAKE_PNPM_FAIL:-}" ] || { echo "ERR_PNPM_FETCH_404 on purpose" >&2; exit 1; } ;; esac
if [ "$1 $2" = "run verify" ]; then
  t="$(basename "$PWD")"
  echo "verify[$t] KEEP=\${KEEP:-} TURBO_TEMPLATE=\${TURBO_TEMPLATE:-} TURBO_REF=\${TURBO_REF:-} TMPDIR=\${TMPDIR:-}" >> "$FAKE_LOG"
  tmp="$(mktemp -d "\${TMPDIR:-/tmp}/newborn.XXXXXX")"
  kept="$tmp"
  case "\${FAKE_NEWBORN_KEPT:-}" in "$t="*) kept="\${FAKE_NEWBORN_KEPT#*=}"; kept="\${kept/'$TMPDIR'/$TMPDIR}" ;; esac
  [ -z "\${KEEP:-}" ] || trap 'echo "kept: $kept"' EXIT
  for shape in one two; do
    echo "→ $shape: render"
    git init --quiet "$tmp/$shape"
    printf -- '---\\n---\\n\\n- A newborn.\\n' > "$tmp/$shape/PLEXUS.md"
    tasks="dev build verify lint check test"
    [ "\${FAKE_NEWBORN_DOCTOR_FAIL:-}" != "$t" ] || [ "$shape" != one ] || tasks="dev build lint check test"
    echo "$tasks" > "$tmp/$shape/mise.toml"
    echo "→ $shape: check"
    if [ "\${FAKE_NEWBORN_HANG:-}" = "$t" ]; then
      echo "waiting for a server that never answers"; sleep 60 & echo $! > "$FAKE_NEWBORN_HANG_PID"; wait
    fi
    if [ "\${FAKE_NEWBORN_CHECK_FAIL:-}" = "$t" ] && [ "$shape" = two ]; then
      echo "Error: the newborn's check fails on purpose" >&2; echo "[check] ERROR task failed" >&2; exit 1
    fi
    echo "✓ $shape"
  done
  exit 0
fi
if [ "$1 $2" = "tasks ls" ]; then
  src="$(pwd -P)/mise.toml"; sep=; printf '['
  for task in $(cat mise.toml); do printf '%s{"name":"%s","source":"%s"}' "$sep" "$task" "$src"; sep=,; done
  echo ']'
fi
`,
);
script(
  'gh',
  `repo="$(basename "$(git remote get-url origin 2>/dev/null || echo "$PWD")" .git)"
# \`gh api repos/<owner>/<repo>/...\` names its repo in the path.
case "$2" in repos/[!{]*/[!{]*/*) r="\${2#repos/*/}"; repo="\${r%%/*}" ;; esac
echo "gh[$repo] $*" >> "$FAKE_LOG"
dir="$FAKE_FORGE/$repo"; mkdir -p "$dir"
arg() { local k="$1"; shift; while [ $# -gt 0 ]; do [ "$1" = "$k" ] && { echo "$2"; return; }; shift; done; }
has() { local k="$1"; shift; for a in "$@"; do [ "$a" = "$k" ] && { echo true; return; }; done; echo false; }
prs() { for f in "$dir"/pr-*; do case "$f" in *.body|*.base|*.draft|*.reviewers|*.state|*.author) ;; *) [ -f "$f" ] && echo "$f" ;; esac; done; }
# \`-R <owner>/<repo>\` names the repo whatever the directory.
named="$(arg -R "$@")"; [ -z "$named" ] || { repo="\${named##*/}"; dir="$FAKE_FORGE/$repo"; mkdir -p "$dir"; }
case "$1 $2" in
  "auth status") [ -z "\${FAKE_GH_LOGGED_OUT:-}" ] || { echo "not logged in" >&2; exit 1; }; echo "logged in" ;;
  "release view") [ -f "$dir/release-$3" ] || { echo "release not found" >&2; exit 1; }; cat "$dir/release-$3" ;;
  "release create")
    [ "\${FAKE_GH_CREATE_FAIL:-}" != "$repo" ] || { echo "release create failed on purpose" >&2; exit 1; }
    git ls-remote --exit-code --tags origin "refs/tags/$3" >/dev/null || { echo "tag $3 not on origin" >&2; exit 1; }
    [ -z "\${FAKE_GH_MUTABLE:-}" ] && echo true > "$dir/release-$3" || echo false > "$dir/release-$3"
    arg --notes "$@" > "$dir/notes-$3"
    [ "$repo" != tooling ] || echo "$3" >> "$FAKE_FORGE/npm-published" ;;
  "api "*)
    case "$2" in
      *"/releases/tags/"*) cat "$dir/release-\${2##*/}" ;;
      *"/requested_reviewers")
        [ -z "\${FAKE_GH_REVIEW_FAIL:-}" ] || { echo "fake gh: a reviewer is not a collaborator" >&2; exit 1; }
        n="\${2%/requested_reviewers}"; n="\${n##*/}"
        for f in $(prs); do [ "$(sed 's|.*/||' "$f")" = "$n" ] || continue
          for a in "$@"; do case "$a" in "reviewers[]="*) echo "\${a#reviewers[]=}" >> "$f.reviewers" ;; esac; done; done ;;
      *"/pulls/"*)
        for f in $(prs); do [ "$(sed 's|.*/||' "$f")" = "\${2##*/}" ] || continue; b="$(arg -f "$@")"; printf '%s' "\${b#body=}" > "$f.body"; done ;;
      *"/releases") for f in "$dir"/release-*; do [ -f "$f" ] || continue; v="\${f##*/release-}"; echo "$v $(cat "$dir/date-$v" 2>/dev/null || echo 2026-01-01T00:00:00Z)"; done ;;
      *) ls "$dir"/release-* 2>/dev/null | tail -1 | xargs -r cat ;;
    esac ;;
  "pr view") for f in $(prs); do [ "$(cat "$f")" = "$3" ] && cat "$f.body"; done; true ;;
  "pr list")
    [ -z "\${FAKE_GH_PR_LIST_FAIL:-}" ] || { echo "fake gh: HTTP 502 on purpose" >&2; exit 1; }
    f="$dir/pr-$(arg --head "$@" | tr / -)"
    if [ -f "$f" ]; then printf '[{"url":"%s","number":%s,"isDraft":%s,"state":"%s","author":{"login":"%s"}}]\n' "$(cat "$f")" "$(sed 's|.*/||' "$f")" "$(cat "$f.draft")" "$(cat "$f.state" 2>/dev/null || echo OPEN)" "$(cat "$f.author")"; else echo '[]'; fi ;;
  "pr create")
    [ -z "\${FAKE_GH_PR_CREATE_FAIL:-}" ] || { echo "fake gh: pr create failed on purpose" >&2; exit 1; }
    head="$(arg --head "$@")"; f="$dir/pr-$(echo "$head" | tr / -)"
    [ ! -f "$f" ] || { echo "a pull request for $head already exists" >&2; exit 1; }
    echo "https://forge/$repo/pull/$(( $(prs | wc -l) + 1 ))" > "$f"
    has --draft "$@" > "$f.draft"; echo "\${FAKE_GH_USER:-plx-bot}" > "$f.author"
    arg --body "$@" > "$f.body"; arg --base "$@" > "$f.base"; cat "$f" ;;
  "pr ready") for f in $(prs); do [ "$(cat "$f")" = "$3" ] && has --undo "$@" > "$f.draft"; done; true ;;
  *) echo "fake gh: unexpected $*" >&2; exit 1 ;;
esac
`,
);
script(
  'npm',
  `echo "npm $*" >> "$FAKE_LOG"
[ "$1 $3" = "view version" ] || { echo "fake npm: unexpected $*" >&2; exit 1; }
v="\${2##*@}"
polls=$(( $(cat "$FAKE_FORGE/npm-polls" 2>/dev/null || echo 0) + 1 )); echo "$polls" > "$FAKE_FORGE/npm-polls"
[ -z "\${FAKE_NPM_NEVER:-}" ] || exit 0
[ "$polls" -gt "\${FAKE_NPM_POLLS:-0}" ] || exit 0
grep -qx "$v" "$FAKE_FORGE/npm-published" 2>/dev/null && echo "$v" || true
`,
);
process.env.PATH = `${FAKE_BIN}:${process.env.PATH}`;

// ── fixture ──────────────────────────────────────────────────────────────────
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (path: string, text: string) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};
const read = (path: string) => readFileSync(path, 'utf8');
const commit = (repo: string, message: string) => {
  git(repo, 'add', '-A');
  git(repo, 'commit', '--quiet', '-m', message);
};
const TOOLING_REF = 'plexus-ms/tooling/.github/workflows/';
/** A tenant repo's marker: nothing to state, so an empty frontmatter (§ 1.4 PLX). */
const MARKER = '---\n---\n\n- A tenant repo.\n';

let WS = '';
const FAKE_LOG = () => join(WS, 'fake.log');
const FORGE = () => join(WS, 'forge');
const fakeLog = () => read(FAKE_LOG()).split('\n').filter(Boolean);
const copierRuns = () => fakeLog().filter((l) => l.startsWith('/'));
const up = (r: string) => join(WS, 'plexus-ms', r);
const remote = (r: string) => join(WS, 'remotes', `${r}.git`);

/** A bare origin for a repo, with its branches and tags pushed. */
const withOrigin = (path: string, name: string) => {
  git(WS, 'init', '--quiet', '--bare', remote(name));
  git(path, 'remote', 'add', 'origin', remote(name));
  git(path, 'push', '--quiet', 'origin', '--all');
  git(path, 'push', '--quiet', 'origin', '--tags');
};

function fixture(name: string): void {
  WS = join(TMP, `ws-${name}`);
  rmSync(WS, { recursive: true, force: true });
  mkdirSync(join(WS, 'plexus-ms'), { recursive: true });
  mkdirSync(join(WS, 'remotes'));
  mkdirSync(join(WS, 'acme'));
  mkdirSync(FORGE());
  for (const r of VERSIONED_REPOS) git(WS, 'init', '--quiet', up(r));
  const prim = up('tooling');
  for (const c of ['host', 'platform', 'infrastructure', 'ci'])
    put(join(prim, `ansible/${c}/galaxy.yml`), 'version: 0.1.0                # mirrors the Plexus version tag\n');
  for (const p of ['cli', 'cli-ci', 'lib'])
    put(join(prim, `packages/${p}/package.json`), `{\n  "name": "@plexus-ms/${p}",\n  "version": "0.1.0"\n}\n`);
  put(
    join(prim, 'package.json'),
    '{\n  "name": "tooling",\n  "devDependencies": { "@plexus-ms/config": "^0.0.1" }\n}\n',
  );
  put(join(prim, '.github/workflows/pipeline.yml'), `jobs:\n  ci:\n    uses: ${TOOLING_REF}ci.yml@0.1.0\n`);
  put(join(prim, 'packages/lib/src/standard-index.json'), '{\n  "version": "0.1.0",\n  "citable": []\n}\n');
  const web = up('template-repo-turbo');
  put(join(web, 'copier.yml'), '_answers_file: .copier-answers.yml\n');
  put(
    join(web, 'template/.github/workflows/ci.yml.jinja'),
    `jobs:\n  changes:\n    uses: ${TOOLING_REF}changes.yml@0.1.0\n`,
  );
  put(
    join(web, 'template/mise.toml'),
    '[tools]\n"npm:@plexus-ms/cli" = { version = "0.0.1", allow_low_downloads = true }\n',
  );
  put(
    join(web, 'template/package.json.jinja'),
    '{\n  "devDependencies": {\n    "@plexus-ms/config": "^0.0.1"\n  }\n}\n',
  );
  put(
    join(web, 'template/pnpm-workspace.yaml'),
    'catalog:\n  typescript: ^6\ncatalogs:\n  plexus:\n    "@plexus-ms/config": 0.0.1\n',
  );
  const app = up('template-app-nextjs');
  put(join(app, 'copier.yml'), '_answers_file: .copier-answers.yml\n');
  put(
    join(app, 'template/package.json.jinja'),
    '{\n  "devDependencies": {\n    "@plexus-ms/config": "^0.0.1"\n  }\n}\n',
  );
  const plat = up('template-repo-operations');
  put(join(plat, 'copier.yml'), '_answers_file: .copier-answers.yml\n');
  put(
    join(plat, 'template/requirements.yml'),
    'collections:\n  - name: https://github.com/plexus-ms/tooling.git#/ansible/host/\n    type: git\n    version: 0.1.0\n  - name: https://github.com/plexus-ms/tooling.git#/ansible/platform/\n    type: git\n    version: 0.1.0\n  - name: community.docker\n    version: 9.9.9\n',
  );
  put(
    join(plat, 'template/mise.toml.jinja'),
    '[tools]\n"npm:@plexus-ms/cli" = { version = "0.0.1", allow_low_downloads = true }\n',
  );
  // The compendium: the map with a draft version, two standard modules (a
  // contract and an approach) and one candidate module.
  const comp = up('compendium');
  put(join(comp, 'mise.toml'), '[tools]\n"npm:@plexus-ms/cli" = { version = "0.0.1", allow_low_downloads = true }\n');
  put(
    join(comp, 'essentials/standard.md'),
    '---\ntitle: The Plexus Standard (PLX)\nversion: v0\ntimestamp: 2025-12-31\norder: 1\n---\n\nProse.\n',
  );
  put(
    join(comp, 'contracts/alpha.md'),
    '---\ncode: PLX-Alpha\nmaturity: standard\nbinds: repo\n---\n\n## § 1 One\n\n> - A repo MUST alpha.\n',
  );
  put(
    join(comp, 'approaches/beta.md'),
    '---\ncode: PLX-Beta\nmaturity: standard\nbinds: host\n---\n\n## § 1 One\n\n> - A host MUST beta.\n',
  );
  put(
    join(comp, 'approaches/gamma.md'),
    '---\ncode: PLX-Gamma\nmaturity: candidate\nbinds: host\n---\n\nProse only.\n',
  );
  for (const r of VERSIONED_REPOS) {
    commit(up(r), 'initial');
    git(up(r), 'tag', '-a', '0.1.0', '-m', 'Plexus 0.1.0');
    withOrigin(up(r), r);
  }
  // Since the last version: alpha's requirement moved, delta is new, beta is as it was.
  put(
    join(comp, 'contracts/alpha.md'),
    '---\ncode: PLX-Alpha\nmaturity: standard\nbinds: repo\n---\n\n## § 1 One\n\n> - A repo MUST alpha twice.\n',
  );
  put(
    join(comp, 'approaches/delta.md'),
    '---\ncode: PLX-Delta\nmaturity: standard\nbinds: app\n---\n\n## § 1 One\n\n> - An app MUST delta.\n',
  );
  commit(comp, 'alpha moves, delta arrives');
  git(comp, 'push', '--quiet', 'origin', 'main');

  // Tenant acme: web (develop) with one app, platform (main), each with an origin.
  const tweb = join(WS, 'acme/web');
  const tplat = join(WS, 'acme/platform');
  git(WS, 'init', '--quiet', tweb);
  git(tweb, 'checkout', '--quiet', '-b', 'develop');
  put(join(tweb, 'PLEXUS.md'), MARKER.trimEnd());
  put(join(tweb, '.copier-answers.yml'), '_commit: 0.1.0\n_src_path: gh:plexus-ms/template-repo-turbo\n');
  put(join(tweb, 'apps/site/.copier-answers.yml'), '_commit: 0.1.0\n_src_path: gh:plexus-ms/template-app-nextjs\n');
  put(
    join(tweb, '.github/workflows/ci.yml'),
    `jobs:\n  changes:\n    uses: ${TOOLING_REF}changes.yml@0.1.0\n  pipeline:\n    uses: ${TOOLING_REF}pipeline.yml@0.1.0\n`,
  );
  put(join(tweb, 'pnpm-workspace.yaml'), 'packages: ["apps/*"]\n');
  put(join(tweb, 'package.json'), '{"name": "web"}\n');
  put(join(tweb, 'template-owned.txt'), 'generated\n');
  put(join(tweb, 'apps/site/template-owned.txt'), 'generated\n');
  commit(tweb, 'initial');
  withOrigin(tweb, 'acme-web');

  git(WS, 'init', '--quiet', tplat);
  put(join(tplat, 'PLEXUS.md'), MARKER);
  put(join(tplat, '.copier-answers.yml'), '_commit: 0.1.0\n_src_path: gh:plexus-ms/template-repo-operations\n');
  put(join(tplat, '.github/workflows/apps.yml'), `jobs:\n  apps:\n    uses: ${TOOLING_REF}deploy.yml@0.1.0\n`);
  put(join(tplat, 'template-owned.txt'), 'generated\n');
  commit(tplat, 'initial');
  withOrigin(tplat, 'acme-platform');

  process.env.FAKE_LOG = FAKE_LOG();
  process.env.FAKE_FORGE = FORGE();
  writeFileSync(FAKE_LOG(), '');
}

// ── running ──────────────────────────────────────────────────────────────────
interface Run {
  result?: ShipResult;
  error?: string;
  /** Everything narrated on stderr. */
  out: string;
}

async function run(options: Options, args: Partial<ShipOptions> = {}): Promise<Run> {
  const stderr = new PassThrough();
  let out = '';
  stderr.on('data', (c: Buffer) => {
    out += c;
  });
  const io = { ...realIo(), stdout: new PassThrough(), stderr };
  const ctx = new Context(options, io);
  try {
    const result = await ship(ctx, {
      workspace: WS,
      today: '2026-01-02',
      wait: { interval: 1, timeout: 1500 },
      ...args,
    });
    return { result, out };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), out };
  }
}

interface UpdateRun {
  result?: Summary;
  error?: string;
  out: string;
}

/** `update` run from inside a tenant repo, like its CI or a developer would. */
async function runUpdate(options: Options, args: UpdateOptions): Promise<UpdateRun> {
  const stderr = new PassThrough();
  let out = '';
  stderr.on('data', (c: Buffer) => {
    out += c;
  });
  const io = { ...realIo(), stdout: new PassThrough(), stderr };
  const ctx = new Context(options, io);
  try {
    // The clock: two months past the fixture's epoch, so a release without a
    // date of its own is older than the interval and the version is taken.
    const outcome = await coloured(() => update(ctx, { today: '2026-03-01', ...args }));
    return { result: summarize([outcome], ctx.dryRun), out };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), out };
  }
}

/** `update --recursive` over the workspace (or `dir`), on the clock `runUpdate` uses. */
async function runRecursive(options: Options, args: Partial<RecursiveOptions> = {}): Promise<UpdateRun> {
  const stderr = new PassThrough();
  let out = '';
  stderr.on('data', (c: Buffer) => {
    out += c;
  });
  const io = { ...realIo(), stdout: new PassThrough(), stderr };
  const ctx = new Context(options, io);
  try {
    const outcomes = await coloured(() => updateRecursive(ctx, { dir: WS, today: '2026-03-01', ...args }));
    return { result: summarize(outcomes, ctx.dryRun, args.to), out };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), out };
  }
}

/** A version as a repo sees it: a published release of the compendium, cut on `date`. */
const versionCut = (v: string, date?: string) => releaseOf('compendium', v, date);

/** A release of a versioned repo on the fake forge, as ship would have created it. */
const releaseOf = (r: string, v: string, date?: string) => {
  mkdirSync(join(FORGE(), r), { recursive: true });
  writeFileSync(join(FORGE(), r, `release-${v}`), 'true\n');
  if (date) writeFileSync(join(FORGE(), r, `date-${v}`), `${date}T00:00:00Z\n`);
};

const tagged = (r: string, v: string) => {
  try {
    git(up(r), 'rev-parse', '-q', '--verify', `refs/tags/${v}`);
    return true;
  } catch {
    return false;
  }
};
const remoteTagged = (r: string, v: string) => {
  try {
    git(remote(r), 'rev-parse', '-q', '--verify', `refs/tags/${v}`);
    return true;
  } catch {
    return false;
  }
};
const released = (r: string, v: string) => existsSync(join(FORGE(), r, `release-${v}`));
const allTagged = (v: string) => VERSIONED_REPOS.every((r) => tagged(r, v) && remoteTagged(r, v));
const allReleased = (v: string) => VERSIONED_REPOS.every((r) => released(r, v));
const noneTagged = (v: string) => VERSIONED_REPOS.every((r) => !tagged(r, v));
const has = (text: string, needle: string | RegExp) =>
  typeof needle === 'string' ? text.includes(needle) : needle.test(text);
/** The notes ship gave a repo's release of a version. */
const notesOf = (r: string, v: string) => read(join(FORGE(), r, `notes-${v}`));
/** A file as the consumer's origin has it on the version branch. */
const onVersion = (r: string, v: string, file: string) => git(remote(r), 'show', `plexus/${v}:${file}`);
const pull = (r: string, v: string, suffix = '') => read(join(FORGE(), r, `pr-plexus-${v}${suffix}`)).trim();
const consumersUntouched = () => {
  for (const r of ['acme/web', 'acme/platform']) {
    assert.equal(git(join(WS, r), 'status', '--porcelain'), '', `${r} checkout clean`);
    assert.match(read(join(WS, r, 'template-owned.txt')), /^generated$/m, `${r} checkout not updated`);
  }
};

/** The newborn tests ship ran, in order: `<template> KEEP=… TURBO_TEMPLATE=… TURBO_REF=… TMPDIR=…`. */
const verifies = () =>
  fakeLog()
    .filter((l) => l.startsWith('verify['))
    .map((l) => l.replace(/^verify\[([^\]]+)\]/, '$1'));
/** Every newborn test's scratch directory is gone. */
const newbornsRemoved = () => {
  for (const v of verifies()) {
    const dir = /TMPDIR=(\S+)$/.exec(v)?.[1] ?? '';
    assert.ok(dir && !existsSync(dir), `scratch of ${v} removed`);
  }
};

// ── scenarios ────────────────────────────────────────────────────────────────
test('dry run previews both phases and the consumers in scratch clones, and changes nothing', async () => {
  fixture('dry');
  const { result, error, out } = await run({ dryRun: true, yes: true });
  assert.equal(error, undefined, out);
  assert.ok(noneTagged('0.2.0'), 'no 0.2.0 tag anywhere');
  assert.ok(!allReleased('0.2.0') && !released('tooling', '0.2.0'), 'no release created');
  assert.match(read(join(up('tooling'), 'ansible/host/galaxy.yml')), /^version: 0\.1\.0/, 'galaxy.yml untouched');
  assert.match(read(join(up('compendium'), 'essentials/standard.md')), /^version: v0$/m, 'standard.md untouched');
  assert.ok(has(out, '→ phase: tooling'), 'phase one announced');
  assert.ok(
    has(out, '→ phase: template-repo-turbo, template-app-nextjs, template-repo-operations, compendium'),
    'phase two',
  );
  assert.ok(
    has(out, '⏳ [dry-run] would wait for @plexus-ms/cli@0.2.0, @plexus-ms/cli-ci@0.2.0, @plexus-ms/lib@0.2.0 on npm'),
    'the wait is a step of the preview',
  );
  assert.ok(!fakeLog().some((l) => l.startsWith('npm ')), 'registry not polled');
  assert.ok(has(out, 'tooling: packages/cli/package.json: @plexus-ms/cli → 0.2.0'), 'preview lists package bumps');
  assert.ok(has(out, 'template-repo-turbo: template/mise.toml: plx pin → 0.2.0'));
  assert.ok(!has(out, '@plexus-ms/config'), 'the config is a library on its own version line: no pin of it is written');
  assert.ok(has(out, 'compendium: mise.toml: plx pin → 0.2.0'));
  assert.ok(!has(out, 'contracts/alpha.md'), 'no module page is written');
  assert.ok(has(out, `[dry-run] $ (cd ${up('tooling')} && gh release create 0.2.0 --verify-tag`), 'release step');
  assert.ok(
    has(out, `gh release create 0.2.0 --verify-tag --title 0.2.0 --notes 'Plexus 0.2.0: the commits since 0.1.0.`),
    'the preview shows the notes',
  );
  assert.ok(has(out, '- `alpha moves, delta arrives`'), 'from the commits since the last version');
  consumersUntouched();
  assert.match(read(join(WS, 'acme/web/.github/workflows/ci.yml')), /@0\.1\.0/, 'consumer workflow refs untouched');
  assert.throws(() => onVersion('acme-web', '0.2.0', 'template-owned.txt'), 'no version branch pushed');
  const runs = copierRuns();
  assert.equal(runs.length, 3, 'copier ran for 3 sites');
  assert.equal(
    fakeLog().filter((l) => l.startsWith(`mise exec copier@${COPIER_VERSION} -- copier update`)).length,
    3,
    'copier ran at the version plx pins',
  );
  assert.equal(
    fakeLog().filter((l) => l.startsWith('mise exec copier@') && / ignored=\/\S+\/acme\/(web|platform)$/.test(l))
      .length,
    3,
    "copier ran with the clone's mise config ignored",
  );
  assert.ok(
    runs.every((l) => !l.startsWith(`${WS}/`)),
    'copier ran outside the workspace (scratch clones)',
  );
  assert.ok(
    runs.some((l) => has(l, ` ${up('template-repo-turbo')} `) && has(l, '--vcs-ref main')),
    'copier read the local template at main',
  );
  assert.ok(runs.some((l) => has(l, ` ${up('template-app-nextjs')} `) && has(l, '--vcs-ref main')));
  assert.equal(runs.filter((l) => has(l, '--defaults')).length, 3, 'copier took defaults (never prompts in a preview)');
  assert.equal(runs.filter((l) => has(l, '--skip-tasks')).length, 3, 'template tasks skipped in the clones');
  assert.ok(has(out, 'M template-owned.txt'), 'preview shows the template-owned change');
  assert.ok(
    has(out, /\[dry-run\] \$ \(cd \S+\/acme\/web && mise exec -- pnpm install/),
    'preview announces the lockfile refresh in the clone',
  );
  assert.ok(!has(out, 'marker:'), 'the marker carries no version, so nothing syncs it');
  assert.ok(has(out, 'acme/platform: apps.yml workflow refs → @0.2.0'), 'preview lists the ref bumps');
  assert.deepEqual(
    verifies().map((v) => v.replace(/ TMPDIR=.*/, '')),
    [
      'template-repo-turbo KEEP=1 TURBO_TEMPLATE= TURBO_REF=',
      `template-app-nextjs KEEP=1 TURBO_TEMPLATE=${up('template-repo-turbo')} TURBO_REF=HEAD`,
      'template-repo-operations KEEP=1 TURBO_TEMPLATE= TURBO_REF=',
    ],
    'the dry run tries every template as a newborn, the app around the Turborepo template being cut',
  );
  assert.ok(has(out, '✓ template-app-nextjs: one, two'), 'and the doctor over each newborn');
  newbornsRemoved();
  assert.ok(has(out, '(preview) acme/web: would commit, push plexus/0.2.0 and open a pull request against develop'));
  assert.ok(has(out, '(preview) acme/platform: would commit, push plexus/0.2.0 and open a pull request against main'));
  assert.ok(!fakeLog().some((l) => has(l, 'pr create')), 'no pull request opened');
  assert.deepEqual(result, {
    version: '0.2.0',
    preview: true,
    clean: ['acme/platform', 'acme/web', 'acme/web/apps/site'],
    conflicted: [],
    failed: [],
    skipped: [],
    resting: [],
    pulls: [],
    mergeable: [],
    released: true,
  });
});

test('happy path: tooling first, the npm wait, the rest, and no pull request in any consumer', async () => {
  fixture('happy');
  process.env.FAKE_NPM_POLLS = '4';
  const { result, error, out } = await run({ yes: true });
  delete process.env.FAKE_NPM_POLLS;
  assert.equal(error, undefined, out);
  assert.ok(allTagged('0.2.0'), 'all five repos tagged 0.2.0 locally and on origin');
  assert.ok(allReleased('0.2.0'), 'a release on every versioned repo');
  assert.equal(verifies().length, 3, 'every template passed as a newborn first');
  assert.ok(out.indexOf('✓ template-repo-operations: one, two') < out.indexOf('→ phase: tooling'), 'before phase one');
  newbornsRemoved();

  // Phase one: tooling's bookkeeping, tag, release.
  const prim = up('tooling');
  assert.match(read(join(prim, 'ansible/host/galaxy.yml')), /^version: 0\.2\.0 /);
  for (const p of ['cli', 'cli-ci', 'lib'])
    assert.match(read(join(prim, `packages/${p}/package.json`)), /"version": "0\.2\.0"/, `${p} at the Plexus version`);
  assert.match(read(join(prim, 'package.json')), /"@plexus-ms\/config": "\^0\.0\.1"/, 'the config range left alone');
  assert.match(read(join(prim, '.github/workflows/pipeline.yml')), /ci\.yml@0\.2\.0/);
  assert.deepEqual(
    JSON.parse(read(join(prim, 'packages/lib/src/standard-index.json'))),
    // Put together, not written out: this repo's own citation check reads this file.
    { version: '0.2.0', citable: ['Alpha', 'Beta', 'Delta'].map((m) => ['§', '1', `PLX-${m}`].join(' ')) },
    'the citable index read from the compendium',
  );
  assert.equal(git(prim, 'log', '-1', '--format=%s'), 'chore: Plexus 0.2.0 bookkeeping');
  assert.equal(
    git(prim, 'rev-parse', '0.2.0^{commit}'),
    git(prim, 'rev-parse', 'main'),
    'tag on the bookkeeping commit',
  );
  assert.equal(git(prim, 'rev-parse', 'main'), git(remote('tooling'), 'rev-parse', 'main'), 'bookkeeping pushed');

  // The order: tooling released, the registry polled until it answers, only then the templates.
  const log = fakeLog();
  const at = (needle: string) => log.findIndex((l) => has(l, needle));
  const primRelease = at('gh[tooling] release create 0.2.0');
  const firstPoll = at('npm view @plexus-ms/cli@0.2.0 version');
  const templateRelease = at('gh[template-repo-turbo] release create 0.2.0');
  assert.ok(primRelease >= 0 && primRelease < firstPoll && firstPoll < templateRelease, `order in:\n${log.join('\n')}`);
  assert.ok(
    log.filter((l) => has(l, 'npm view @plexus-ms/cli@0.2.0')).length >= 2,
    'polled more than once, until the publish',
  );
  assert.ok(has(out, '✓ @plexus-ms/cli@0.2.0, @plexus-ms/cli-ci@0.2.0, @plexus-ms/lib@0.2.0 on npm'));
  assert.ok(has(out, '→ phase: tooling\n'), 'phase one narrated');

  // Phase two: the templates and the compendium.
  const map = read(join(up('compendium'), 'essentials/standard.md'));
  assert.match(map, /^version: 0\.2\.0$/m);
  assert.match(map, /^timestamp: 2026-01-02$/m);
  for (const page of ['contracts/alpha.md', 'approaches/beta.md', 'approaches/delta.md', 'approaches/gamma.md'])
    assert.doesNotMatch(read(join(up('compendium'), page)), /^changed:/m, `${page}: no stamp`);
  assert.match(read(join(up('compendium'), 'mise.toml')), /version = "0\.2\.0"/, "the compendium's plx pin");
  const reqs = read(join(up('template-repo-operations'), 'template/requirements.yml'));
  assert.match(reqs, /^ {4}version: 0\.2\.0$/m, 'collection pin bumped');
  assert.match(reqs, /^ {4}version: 9\.9\.9$/m, 'the other collection keeps its version');
  assert.match(read(join(up('template-repo-operations'), 'template/mise.toml.jinja')), /version = "0\.2\.0"/);
  assert.match(read(join(up('template-repo-turbo'), 'template/mise.toml')), /version = "0\.2\.0"/);
  assert.match(
    read(join(up('template-repo-turbo'), 'template/package.json.jinja')),
    /"@plexus-ms\/config": "\^0\.0\.1"/,
    'the config is not a pin of the version: the manifest keeps its range',
  );
  assert.match(
    read(join(up('template-repo-turbo'), 'template/pnpm-workspace.yaml')),
    /"@plexus-ms\/config": 0\.0\.1$/m,
    'and so does the catalog entry',
  );
  assert.match(
    read(join(up('template-repo-turbo'), 'template/.github/workflows/ci.yml.jinja')),
    /changes\.yml@0\.2\.0/,
  );

  // The compendium is released last, like the others: one step, no draft, nothing uploaded.
  assert.ok(templateRelease < at('gh[compendium] release create 0.2.0'), `order in:\n${log.join('\n')}`);
  assert.ok(!log.some((l) => has(l, '--draft') || has(l, 'release upload')), 'no draft, no asset');
  // Every release lists the subjects of the commits since the previous version, the bookkeeping last, each
  // a code span, so that nothing in a subject is live on the forge.
  assert.equal(
    notesOf('compendium', '0.2.0'),
    'Plexus 0.2.0: the commits since 0.1.0.\n\n- `alpha moves, delta arrives`\n- `chore: Plexus 0.2.0 bookkeeping`\n',
  );
  assert.equal(
    notesOf('template-app-nextjs', '0.2.0'),
    'Plexus 0.2.0: the commits since 0.1.0.\n\n',
    'a repo with no commit of its own has no subject but its tag',
  );

  // And there it ends: ship looks for no consumer and opens no pull request.
  consumersUntouched();
  assert.equal(copierRuns().length, 0, 'copier never ran');
  assert.ok(!fakeLog().some((l) => has(l, 'gh[acme-')), 'the forge was never asked about a consumer');
  assert.throws(() => onVersion('acme-web', '0.2.0', 'template-owned.txt'), 'no version branch on a consumer');
  assert.throws(() => onVersion('acme-platform', '0.2.0', 'template-owned.txt'));
  assert.ok(has(out, '• Plexus 0.2.0 is cut; every repo takes it itself, by its step and a schedule (plx update)'));
  assert.deepEqual(result, {
    version: '0.2.0',
    preview: false,
    clean: [],
    conflicted: [],
    failed: [],
    skipped: [],
    resting: [],
    pulls: [],
    mergeable: [],
    released: true,
  });
});

// ── the operator's loop over update: --recursive ────────────────────────────
test('update --recursive: every repo under the directory takes the version in a worktree of its branch, one pull request each', async () => {
  fixture('recursive');
  const shipped = await run({ yes: true });
  assert.equal(shipped.error, undefined, shipped.out);
  const { result, error, out } = await runRecursive({ yes: true });
  assert.equal(error, undefined, out);
  consumersUntouched();
  assert.deepEqual(
    copierRuns().map((l) => l.split(' ')[0]?.replace(/^.*\/acme\//, 'acme/')),
    ['acme/platform', 'acme/web', 'acme/web/apps/site'],
    'copier ran in the worktrees, repos in tree order, a repo root before its app',
  );
  assert.ok(
    copierRuns().every((l) => has(l, '--vcs-ref 0.2.0') && has(l, '--skip-tasks') && !l.startsWith(`${WS}/`)),
    'the published version, tasks skipped, outside the checkouts',
  );
  assert.equal(copierRuns().filter((l) => has(l, '--defaults')).length, 3, 'unattended run lets copier take defaults');
  assert.equal(
    fakeLog().filter((l) => l.startsWith('mise exec copier@') && / ignored=\/\S+\/acme\/(web|platform)$/.test(l))
      .length,
    3,
    "copier ran with the worktree's mise config ignored",
  );
  for (const [r, f] of [
    ['acme-web', 'template-owned.txt'],
    ['acme-web', 'apps/site/template-owned.txt'],
    ['acme-platform', 'template-owned.txt'],
  ] as const)
    assert.match(onVersion(r, '0.2.0', f), /updated from 0\.2\.0/, `${r}:${f}`);
  assert.equal(onVersion('acme-web', '0.2.0', 'PLEXUS.md'), MARKER.trimEnd(), 'the marker is not written');
  assert.equal(onVersion('acme-platform', '0.2.0', 'PLEXUS.md'), MARKER.trimEnd());
  const ci = onVersion('acme-web', '0.2.0', '.github/workflows/ci.yml');
  assert.match(ci, /changes\.yml@0\.2\.0/);
  assert.match(ci, /pipeline\.yml@0\.2\.0/);
  assert.match(onVersion('acme-platform', '0.2.0', '.github/workflows/apps.yml'), /deploy\.yml@0\.2\.0/);
  assert.equal(git(remote('acme-web'), 'log', '-1', '--format=%s', 'plexus/0.2.0'), 'chore: Plexus 0.2.0');
  assert.equal(
    git(remote('acme-web'), 'rev-list', '--count', 'develop..plexus/0.2.0'),
    '1',
    'one commit on the branch',
  );
  assert.equal(
    git(remote('acme-web'), 'rev-parse', 'develop'),
    git(join(WS, 'acme/web'), 'rev-parse', 'develop'),
    'develop untouched',
  );
  assert.equal(fakeLog().filter((l) => l.startsWith('mise exec -- pnpm install')).length, 1, 'lockfile refreshed once');
  assert.ok(
    fakeLog().some((l) => l.startsWith('mise exec -- pnpm install --no-frozen-lockfile')),
    'the refresh is never frozen, though pnpm freezes by default under CI',
  );
  assert.equal(pull('acme-web', '0.2.0'), 'https://forge/acme-web/pull/1');
  assert.equal(pull('acme-web', '0.2.0', '.base'), 'develop');
  assert.equal(pull('acme-platform', '0.2.0', '.base'), 'main');
  assert.match(pull('acme-web', '0.2.0', '.body'), /Plexus 0\.2\.0 .*`copier update` at the root, `apps\/site`/);
  assert.match(pull('acme-web', '0.2.0', '.body'), /^Nothing needs a hand: every site merged clean\.$/m);
  assert.equal(pull('acme-web', '0.2.0', '.draft'), 'false', 'ready for review');
  assert.ok(has(out, '--force-with-lease=refs/heads/plexus/0.2.0: origin'), 'the push only creates the branch');
  assert.match(pull('acme-web', '0.2.0', '.body'), /Opened by `plx update`: 0\.2\.0, the oldest version not taken/);
  assert.ok(has(out, 'acme/web: pull request opened: https://forge/acme-web/pull/1'));
  for (const r of ['acme/web', 'acme/platform'])
    assert.equal(git(join(WS, r), 'worktree', 'list').split('\n').length, 1, `${r}: worktree removed`);
  assert.deepEqual(result, {
    version: '0.2.0',
    preview: false,
    clean: ['acme/platform', 'acme/web', 'acme/web/apps/site'],
    conflicted: [],
    failed: [],
    skipped: [],
    resting: [],
    pulls: ['https://forge/acme-platform/pull/1', 'https://forge/acme-web/pull/1'],
    mergeable: ['https://forge/acme-platform/pull/1', 'https://forge/acme-web/pull/1'],
  });
});

test('update --recursive: a directory of tenant repos and no upstream checkout; a repo inside its interval rests until asked', async () => {
  fixture('recursive-tenant');
  versionCut('0.2.0', '2026-02-25');
  const acme = join(WS, 'acme');
  // The platform repo's answers set three days; the web repo's say nothing, which is a week.
  put(
    join(acme, 'platform/.copier-answers.yml'),
    '_commit: 0.1.0\n_src_path: gh:plexus-ms/template-repo-operations\nupdate_max_age: 3\n',
  );
  commit(join(acme, 'platform'), 'three days at most');
  git(join(acme, 'platform'), 'push', '--quiet', 'origin', 'main');
  const { result, error, out } = await runRecursive({ yes: true }, { dir: acme });
  assert.equal(error, undefined, out);
  assert.ok(!fakeLog().some((l) => has(l, `${WS}/plexus-ms`)), 'nothing read from an upstream checkout');
  assert.equal(fakeLog().filter((l) => has(l, ' auth status')).length, 1, 'the login is checked once for both repos');
  assert.equal(
    fakeLog().filter((l) => has(l, ' api repos/plexus-ms/compendium/releases')).length,
    1,
    'the versions are listed once for both repos',
  );
  assert.ok(has(out, '• web: rests — 1 newer version, the oldest (0.2.0) cut 4 days ago; the interval is 7 days'), out);
  assert.ok(
    has(out, '• platform: takes 0.2.0 — 0.2.0, the oldest version not taken, was cut 4 days ago (interval: 3 days'),
    out,
  );
  assert.deepEqual(result?.resting, [
    { path: 'web', reason: '1 newer version, the oldest (0.2.0) cut 4 days ago; the interval is 7 days' },
  ]);
  assert.deepEqual(result?.clean, ['platform']);
  assert.deepEqual(result?.pulls, ['https://forge/acme-platform/pull/1']);
  assert.throws(() => onVersion('acme-web', '0.2.0', 'template-owned.txt'), 'the resting repo has no version branch');

  // Asked, the resting repo takes it; the other has its branch on origin and is left alone.
  const now = await runRecursive({ yes: true }, { dir: acme, now: true });
  assert.equal(now.error, undefined, now.out);
  assert.ok(has(now.out, '• web: takes 0.2.0 — asked for (--now)'), now.out);
  assert.ok(
    has(
      now.out,
      'platform: plexus/0.2.0 is on origin (https://forge/acme-platform/pull/1); no conflict marker remains',
    ),
  );
  assert.deepEqual(now.result?.resting, []);
  assert.deepEqual(now.result?.pulls, ['https://forge/acme-platform/pull/1', 'https://forge/acme-web/pull/1']);
});

test('update --recursive: a second run finds the version branches on origin and moves nothing', async () => {
  fixture('rerun');
  const shipped = await run({ yes: true });
  assert.equal(shipped.error, undefined, shipped.out);
  const first = await runRecursive({ yes: true });
  assert.equal(first.error, undefined, first.out);
  const tip = git(remote('acme-web'), 'rev-parse', 'plexus/0.2.0');
  const second = await runRecursive({ yes: true }, { now: true });
  assert.equal(second.error, undefined, second.out);
  assert.equal(fakeLog().filter((l) => has(l, 'pr create')).length, 2, 'two repos, two pull requests in all');
  assert.ok(
    has(second.out, 'acme/web: plexus/0.2.0 is on origin (https://forge/acme-web/pull/1); no conflict marker remains'),
  );
  assert.ok(!fakeLog().some((l) => has(l, 'pr ready')), 'a ready one with no marker stays ready');
  assert.match(pull('acme-web', '0.2.0', '.body'), /^Nothing needs a hand/, 'the body rewritten to the present state');
  const patched = fakeLog().filter((l) => has(l, '--method PATCH')).length;
  await runRecursive({ yes: true }, { now: true });
  assert.equal(fakeLog().filter((l) => has(l, '--method PATCH')).length, patched + 2, 'the body is written each run');
  assert.ok(!fakeLog().some((l) => has(l, 'pr view')), 'and never read');
  assert.equal(git(remote('acme-web'), 'rev-parse', 'plexus/0.2.0'), tip, 'the branch is where it was');
  assert.equal(copierRuns().length, 3, 'copier not run again');
  assert.deepEqual(second.result?.pulls, ['https://forge/acme-platform/pull/1', 'https://forge/acme-web/pull/1']);
});

test('update --recursive: the state of the checkouts does not matter', async () => {
  fixture('checkouts');
  put(join(WS, 'acme/web/notes.txt'), 'scratch\n'); // untracked
  put(join(WS, 'acme/platform/template-owned.txt'), 'generated\nedited\n'); // tracked modification
  git(join(WS, 'acme/web'), 'checkout', '--quiet', '-b', 'feature/x'); // wrong branch
  versionCut('0.2.0');
  const { result, error, out } = await runRecursive({ yes: true });
  assert.equal(error, undefined, out);
  assert.match(onVersion('acme-web', '0.2.0', 'template-owned.txt'), /updated from/, 'origin updated from develop');
  assert.match(onVersion('acme-platform', '0.2.0', 'template-owned.txt'), /updated from/);
  assert.equal(git(join(WS, 'acme/web'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/x', 'checkout left alone');
  assert.match(read(join(WS, 'acme/platform/template-owned.txt')), /edited/, 'local edit left alone');
  assert.deepEqual(result?.skipped, []);
});

test('a versioned repo behind origin blocks the release', async () => {
  fixture('behind');
  const side = join(TMP, 'side');
  rmSync(side, { recursive: true, force: true });
  git(WS, 'clone', '--quiet', remote('tooling'), side);
  put(join(side, 'elsewhere'), 'x\n');
  commit(side, 'landed elsewhere');
  git(side, 'push', '--quiet', 'origin', 'main');
  const { error } = await run({ yes: true });
  assert.match(error ?? '', /tooling is 1 commit\(s\) behind origin\/main/);
  assert.ok(noneTagged('0.2.0'));
});

test('a logged-out gh and a mutable release both stop the version before anything is written', async () => {
  fixture('forge');
  process.env.FAKE_GH_LOGGED_OUT = '1';
  const out = await run({ yes: true });
  delete process.env.FAKE_GH_LOGGED_OUT;
  assert.match(out.error ?? '', /gh is not logged in/);
  assert.ok(noneTagged('0.2.0'));

  mkdirSync(join(FORGE(), 'compendium'), { recursive: true });
  writeFileSync(join(FORGE(), 'compendium', 'release-0.1.0'), 'false\n');
  const mutable = await run({ yes: true });
  assert.match(mutable.error ?? '', /compendium: its newest GitHub release is not immutable/);
  assert.ok(noneTagged('0.2.0'));
});

test('a release created mutable stops the run after tooling, with the recovery named', async () => {
  fixture('mutable');
  process.env.FAKE_GH_MUTABLE = '1';
  const { error } = await run({ yes: true });
  delete process.env.FAKE_GH_MUTABLE;
  assert.match(error ?? '', /tooling: release 0\.2\.0 was created mutable/);
  assert.match(error ?? '', /never delete one/);
  assert.match(error ?? '', /re-run with --to 0\.2\.0/);
  assert.ok(tagged('tooling', '0.2.0') && released('tooling', '0.2.0'));
  assert.ok(!tagged('template-repo-turbo', '0.2.0'), 'phase two not started');
});

test('a registry that never answers stops the run resumably; the re-run skips what exists', async () => {
  fixture('npm');
  process.env.FAKE_NPM_NEVER = '1';
  const first = await run({ yes: true });
  delete process.env.FAKE_NPM_NEVER;
  assert.match(
    first.error ?? '',
    /@plexus-ms\/cli, @plexus-ms\/cli-ci, @plexus-ms\/lib not on npm at 0\.2\.0 after \d+ min/,
  );
  assert.match(first.error ?? '', /re-run with --to 0\.2\.0/);
  assert.ok(tagged('tooling', '0.2.0') && remoteTagged('tooling', '0.2.0') && released('tooling', '0.2.0'));
  assert.ok(!tagged('compendium', '0.2.0'), 'phase two not started');
  consumersUntouched();
  const second = await run({ yes: true }, { to: '0.2.0' });
  assert.equal(second.error, undefined, second.out);
  assert.ok(has(second.out, '• tooling: already tagged 0.2.0'));
  assert.ok(has(second.out, '• tooling: release 0.2.0 exists'), 'release never re-created');
  assert.equal(fakeLog().filter((l) => has(l, 'gh[tooling] release create')).length, 1);
  assert.ok(allTagged('0.2.0') && allReleased('0.2.0'));
});

test('a re-run whose compendium moved since tooling was tagged refuses, and adds no commit after the tag', async () => {
  fixture('rerun-index');
  process.env.FAKE_NPM_NEVER = '1';
  const first = await run({ yes: true });
  delete process.env.FAKE_NPM_NEVER;
  assert.match(first.error ?? '', /re-run with --to 0\.2\.0/);
  assert.ok(tagged('tooling', '0.2.0') && !tagged('compendium', '0.2.0'), 'stopped between the phases');
  // A fix in the compendium between the runs adds a section the published index does not have.
  const comp = up('compendium');
  put(join(comp, 'contracts/alpha.md'), `${read(join(comp, 'contracts/alpha.md'))}\n## § 2 Two\n\nProse.\n`);
  commit(comp, 'alpha gains a section');
  git(comp, 'push', '--quiet', 'origin', 'main');

  const second = await run({ yes: true }, { to: '0.2.0' });
  assert.match(second.error ?? '', /the citable index tooling carries at 0\.2\.0 differs from the compendium/);
  assert.ok(has(second.error ?? '', `+ ${['§', '2', 'PLX-Alpha'].join(' ')}`), second.error);
  assert.match(second.error ?? '', /revert the compendium|cut a new version/);
  const prim = up('tooling');
  assert.equal(git(prim, 'rev-parse', '0.2.0^{commit}'), git(prim, 'rev-parse', 'main'), 'no commit after the tag');
  assert.equal(
    git(prim, 'log', '--format=%s', '--grep', 'bookkeeping').split('\n').length,
    1,
    'one bookkeeping commit',
  );
  assert.ok(!tagged('compendium', '0.2.0'), 'phase two not started');

  // Reverted, the re-run finishes the version with the index that was published.
  git(comp, 'revert', '--no-edit', 'HEAD');
  git(comp, 'push', '--quiet', 'origin', 'main');
  const third = await run({ yes: true }, { to: '0.2.0' });
  assert.equal(third.error, undefined, third.out);
  assert.ok(allTagged('0.2.0') && allReleased('0.2.0'));
  assert.equal(
    git(prim, 'rev-parse', '0.2.0^{commit}'),
    git(prim, 'rev-parse', 'main'),
    'still no commit after the tag',
  );
});

test('a versioned repo that fails plx requirements stops the version before anything is written', async () => {
  fixture('requirements');
  const comp = up('compendium');
  put(join(comp, 'approaches/gamma.md'), `${read(join(comp, 'approaches/gamma.md'))}Measured on ${'2026-01-01'}.\n`);
  commit(comp, 'a dated sentence');
  git(comp, 'push', '--quiet', 'origin', 'main');
  const web = up('template-repo-turbo');
  put(join(web, 'notes.md'), `See ${['§', '9', 'PLX-Alpha'].join(' ')}.\n`);
  commit(web, 'a stale citation');
  git(web, 'push', '--quiet', 'origin', 'main');

  const refused = await run({ yes: true });
  assert.match(refused.error ?? '', /plx requirements fails in 2 versioned repos/);
  assert.match(refused.error ?? '', /^ {2}template-repo-turbo: 1 defect$/m);
  assert.match(refused.error ?? '', /^ {2}compendium: 1 defect$/m);
  assert.ok(
    has(
      refused.error ?? '',
      `    to record them as known: plx requirements ${up('template-repo-turbo')} --write-baseline --compendium ${up('compendium')}`,
    ),
    refused.error,
  );
  assert.ok(
    has(refused.error ?? '', `    to record them as known: plx requirements ${up('compendium')} --write-baseline\n`),
    'the compendium checks against itself',
  );
  assert.ok(
    VERSIONED_REPOS.every((r) => !tagged(r, '0.2.0')),
    'nothing tagged',
  );
  assert.equal(git(up('tooling'), 'log', '-1', '--format=%s'), 'initial', 'no bookkeeping');

  // The dry run refuses the same way.
  const dry = await run({ dryRun: true });
  assert.match(dry.error ?? '', /plx requirements fails in 2 versioned repos/);
});

test('a template whose newborn test fails stops the version before anything is written or tagged', async () => {
  fixture('newborn-check');
  process.env.FAKE_NEWBORN_CHECK_FAIL = 'template-repo-operations';
  const refused = await run({ yes: true });
  const dry = await run({ dryRun: true });
  delete process.env.FAKE_NEWBORN_CHECK_FAIL;
  assert.match(refused.error ?? '', /^1 template fails as a newborn repo:$/m);
  assert.match(refused.error ?? '', /^ {2}template-repo-operations:\n {4}✗ its newborn test fails at two: check$/m);
  assert.ok(has(refused.error ?? '', "      │ Error: the newborn's check fails on purpose\n"), refused.error);
  assert.ok(!has(refused.error ?? '', '[check] ERROR task failed'), "mise's chain of failed tasks is not quoted");
  assert.ok(has(refused.error ?? '', '    ✓ plx doctor passes one, two'), 'what the test left is examined too');
  assert.ok(
    has(refused.error ?? '', `    to reproduce: (cd ${up('template-repo-operations')} && KEEP=1 mise run verify)`),
    refused.error,
  );
  assert.ok(!has(refused.error ?? '', 'template-repo-turbo:'), 'the passing templates are not named');
  assert.ok(has(refused.out, '✓ template-repo-turbo: one, two'));
  assert.ok(noneTagged('0.2.0'), 'nothing tagged');
  assert.equal(git(up('tooling'), 'log', '-1', '--format=%s'), 'initial', 'no bookkeeping');
  assert.ok(!fakeLog().some((l) => has(l, 'release create')), 'no release');
  newbornsRemoved();
  // The dry run refuses the same way: it is meant to show everything that would stop the real run.
  assert.match(dry.error ?? '', /template-repo-operations:\n {4}✗ its newborn test fails at two: check/);
});

test('a newborn that fails a doctor check stops the version and names the requirement', async () => {
  fixture('newborn-doctor');
  process.env.FAKE_NEWBORN_DOCTOR_FAIL = 'template-repo-turbo';
  const { error } = await run({ yes: true });
  delete process.env.FAKE_NEWBORN_DOCTOR_FAIL;
  assert.match(error ?? '', /^1 template fails as a newborn repo:$/m);
  assert.ok(
    has(
      error ?? '',
      [
        '  template-repo-turbo:',
        '    ✗ newborn one fails plx doctor: 2 findings',
        '      ✗ PLX-Repo/Verbs: no root mise task `verify`',
        '      ✗ PLX-Repo/SubVerbs: no root mise task `verify`',
        '    ✓ plx doctor passes two',
      ].join('\n'),
    ),
    error,
  );
  assert.ok(!has(error ?? '', 'its newborn test fails'), 'the test itself passed');
  assert.ok(noneTagged('0.2.0'));
  assert.equal(git(up('tooling'), 'log', '-1', '--format=%s'), 'initial', 'no bookkeeping');
  newbornsRemoved();
});

test('under -vv the newborn tests get a scratch directory, and write nothing into a template checkout', async () => {
  fixture('newborn-debug');
  const { error, out } = await run({ dryRun: true, yes: true, verbose: 2 });
  assert.equal(error, undefined, out);
  assert.equal(verifies().length, 3);
  for (const v of verifies()) assert.match(v, /TMPDIR=\/\S+$/, `${v}: an absolute scratch path, not ''`);
  for (const t of ['template-repo-turbo', 'template-app-nextjs', 'template-repo-operations'])
    assert.ok(!existsSync(join(up(t), 'verify.log')), `no log written into ${t}`);
  newbornsRemoved();
});

test("a `kept:` path outside the test's scratch is named, examined by nothing, and left alone", async () => {
  fixture('newborn-kept-outside');
  // In the system's temporary directory, spelled as it names itself, as anything else there would be.
  const elsewhere = mkdtempSync(join(tmpdir(), 'not-made-by-this-run-'));
  put(join(elsewhere, 'precious.txt'), 'keep me\n');
  process.env.FAKE_NEWBORN_KEPT = `template-repo-operations=${elsewhere}`;
  const { error } = await run({ yes: true });
  delete process.env.FAKE_NEWBORN_KEPT;
  assert.ok(existsSync(join(elsewhere, 'precious.txt')), 'nothing outside the scratch is deleted');
  assert.ok(existsSync(WS), 'nor the directory around it');
  assert.ok(
    has(
      error ?? '',
      `    ✗ plx doctor examined no newborn: the newborn test left them outside its scratch directory, in ${elsewhere}, which is left alone`,
    ),
    error,
  );
  assert.ok(noneTagged('0.2.0'));
  newbornsRemoved();
  rmSync(elsewhere, { recursive: true, force: true });
});

test("a `kept:` path that is not there is resolved in the template's checkout and named; the other templates are still examined", async () => {
  fixture('newborn-kept-missing');
  process.env.FAKE_NEWBORN_KEPT = 'template-repo-turbo=gone';
  const { error, out } = await run({ yes: true });
  delete process.env.FAKE_NEWBORN_KEPT;
  assert.match(error ?? '', /^1 template fails as a newborn repo:$/m);
  // Relative, it is read from the template's checkout, which is not the scratch.
  assert.ok(
    has(
      error ?? '',
      `    ✗ plx doctor examined no newborn: the newborn test left them outside its scratch directory, in ${join(up('template-repo-turbo'), 'gone')}, which is left alone`,
    ),
    error,
  );
  assert.ok(!has(error ?? '', 'ENOENT'), error);
  assert.ok(has(out, '✓ template-app-nextjs: one, two') && has(out, '✓ template-repo-operations: one, two'), out);
  newbornsRemoved();
});

test('a `kept:` path inside the scratch that is no directory is named; the template is not examined', async () => {
  fixture('newborn-kept-file');
  process.env.FAKE_NEWBORN_KEPT = 'template-repo-operations=$TMPDIR/verify.log';
  const { error } = await run({ yes: true });
  delete process.env.FAKE_NEWBORN_KEPT;
  assert.match(
    error ?? '',
    /✗ plx doctor examined no newborn: the newborn test named \/\S+\/verify\.log, which is not a directory that can be read/,
  );
  newbornsRemoved();
});

test('a newborn test that hangs is killed after the time limit, with all it started, and refused with its last lines', async () => {
  fixture('newborn-hang');
  const pidFile = join(WS, 'hang.pid');
  process.env.FAKE_NEWBORN_HANG = 'template-repo-operations';
  process.env.FAKE_NEWBORN_HANG_PID = pidFile;
  const started = Date.now();
  const { error, out } = await run({ yes: true }, { newbornLimit: 1500 });
  delete process.env.FAKE_NEWBORN_HANG;
  delete process.env.FAKE_NEWBORN_HANG_PID;
  assert.ok(Date.now() - started < 30_000, 'ship did not wait for the hung test');
  assert.match(out, /^ {4}its output, while it runs: \/\S+\/verify\.log$/m, 'where the log is, while it runs');
  assert.ok(
    has(
      error ?? '',
      [
        '  template-repo-operations:',
        '    ✗ its newborn test did not finish within 1.5 seconds and was killed at one: check; the last lines of its output:',
        '      │ → one: render',
        '      │ → one: check',
        '      │ waiting for a server that never answers',
      ].join('\n'),
    ),
    error,
  );
  const sleeper = Number(read(pidFile));
  let alive = true;
  for (let i = 0; i < 40 && alive; i++) {
    try {
      process.kill(sleeper, 0);
      await new Promise((r) => setTimeout(r, 50));
    } catch {
      alive = false;
    }
  }
  assert.ok(!alive, 'what the test started is killed with it');
  assert.ok(noneTagged('0.2.0'));
  newbornsRemoved();
});

test("a run that stops at the compendium's release leaves the version unseen by any repo; the re-run releases it", async () => {
  fixture('last-release');
  process.env.FAKE_GH_CREATE_FAIL = 'compendium';
  const first = await run({ yes: true });
  delete process.env.FAKE_GH_CREATE_FAIL;
  assert.match(first.error ?? '', /release create failed on purpose/);
  assert.match(first.error ?? '', /re-run with --to 0\.2\.0/);
  assert.ok(remoteTagged('compendium', '0.2.0') && !released('compendium', '0.2.0'));
  assert.ok(released('template-repo-operations', '0.2.0'), 'every other repo is released');
  // To a repo the version is not cut yet.
  const early = await runUpdate({ yes: true }, { repo: join(WS, 'acme/platform') });
  assert.match(early.error ?? '', /no release of plexus-ms\/compendium found/);

  // An edit reaches the compendium's main after its tag: it belongs to the next version.
  const comp = up('compendium');
  const beta = join(comp, 'approaches/beta.md');
  put(beta, read(beta).replace('A host MUST beta.', 'A host MUST beta, twice.'));
  commit(comp, 'beta sharpens its requirement');
  git(comp, 'push', '--quiet', 'origin', 'main');

  // The re-run comes a few days later: the map keeps the date it was stamped with.
  const tried = verifies().length;
  const second = await run({ yes: true }, { to: '0.2.0', today: '2026-01-05' });
  assert.equal(second.error, undefined, second.out);
  assert.equal(verifies().length, tried, 'a template tagged with the version is not tried again');
  assert.match(read(join(comp, 'essentials/standard.md')), /^timestamp: 2026-01-02$/m);
  assert.equal(git(comp, 'log', '--format=%s', '0.2.0..main'), 'beta sharpens its requirement', 'no commit of its own');
  assert.ok(has(second.out, '• compendium: already tagged 0.2.0'));
  assert.ok(allTagged('0.2.0') && allReleased('0.2.0'));
  assert.doesNotMatch(notesOf('compendium', '0.2.0'), /beta sharpens/, 'the notes end at the tag');
  const late = await runUpdate({ yes: true }, { repo: join(WS, 'acme/platform') });
  assert.equal(late.error, undefined, late.out);
  assert.ok(has(late.out, '• platform: takes 0.2.0'), late.out);

  // A third run finds it released and creates nothing; the next version's notes carry the edit.
  const third = await run({ yes: true }, { to: '0.2.0' });
  assert.equal(third.error, undefined, third.out);
  assert.ok(has(third.out, '• compendium: release 0.2.0 exists'));
  assert.equal(fakeLog().filter((l) => has(l, 'gh[compendium] release create')).length, 2, 'one failed, one done');
  const next = await run({ yes: true });
  assert.equal(next.error, undefined, next.out);
  assert.match(notesOf('compendium', '0.3.0'), /^- `beta sharpens its requirement`$/m);
});

test('disagreeing latest tags refuse a derived version; a hand-made tag refuses the bookkeeping it lacks', async () => {
  fixture('skew');
  // The half version's tag carries the index the compendium yields, as ship would have written it.
  const citable = ['Alpha', 'Beta', 'Delta'].map((m) => ['§', '1', `PLX-${m}`].join(' '));
  put(
    join(up('tooling'), 'packages/lib/src/standard-index.json'),
    `${JSON.stringify({ version: '0.2.0', citable }, null, 2)}\n`,
  );
  commit(up('tooling'), 'the index of the half version');
  git(up('tooling'), 'push', '--quiet', 'origin', 'main');
  git(up('tooling'), 'tag', '-a', '0.2.0', '-m', 'half version');
  git(up('tooling'), 'push', '--quiet', 'origin', '0.2.0');
  const first = await run({ yes: true });
  assert.match(first.error ?? '', /latest tags disagree/);
  assert.match(first.error ?? '', /^ {2}template-repo-turbo: 0\.1\.0$/m, "shows each repo's latest tag");
  assert.match(first.error ?? '', /--to 0\.2\.0/, 'names the recovery');
  assert.ok(!tagged('compendium', '0.2.0') && !tagged('compendium', '0.3.0'));

  // The hand-made tag is not on a bookkeeping commit: what ship would write to tooling is refused.
  const head = git(up('tooling'), 'rev-parse', 'main');
  for (const options of [{ yes: true }, { dryRun: true }]) {
    const second = await run(options, { to: '0.2.0' });
    assert.match(second.error ?? '', /^tooling is tagged 0\.2\.0 already, and the bookkeeping would still write:$/m);
    assert.match(second.error ?? '', /^ {2}tooling: ansible\/host\/galaxy\.yml: plexus\.host version → 0\.2\.0$/m);
    assert.match(second.error ?? '', /^ {2}tooling: packages\/lib\/package\.json: @plexus-ms\/lib → 0\.2\.0$/m);
    assert.match(second.error ?? '', /^ {2}tooling: \.github\/workflows\/pipeline\.yml: workflow refs → @0\.2\.0$/m);
    assert.match(second.error ?? '', /re-run with --to 0\.2\.0, or cut a new version \(--to 0\.3\.0\)/);
    assert.equal(git(up('tooling'), 'rev-parse', 'main'), head, 'nothing written to tooling');
    assert.ok(
      VERSIONED_REPOS.every((r) => r === 'tooling' || !tagged(r, '0.2.0')),
      'no other repo tagged',
    );
  }

  // A new version is the way out the message names.
  const third = await run({ yes: true }, { to: '0.3.0' });
  assert.equal(third.error, undefined, third.out);
  assert.ok(allTagged('0.3.0'));
});

test('a commit with an old ref on main after the tag refuses the re-run; matching it by hand lets the re-run finish', async () => {
  fixture('after-tag');
  process.env.FAKE_NPM_NEVER = '1';
  const first = await run({ yes: true });
  delete process.env.FAKE_NPM_NEVER;
  assert.match(first.error ?? '', /re-run with --to 0\.2\.0/);
  const prim = up('tooling');
  put(join(prim, '.github/workflows/extra.yml'), `jobs:\n  ci:\n    uses: ${TOOLING_REF}ci.yml@0.1.0\n`);
  commit(prim, 'a workflow with the old ref');
  git(prim, 'push', '--quiet', 'origin', 'main');
  const head = git(prim, 'rev-parse', 'main');

  for (const options of [{ yes: true }, { dryRun: true }]) {
    const refused = await run(options, { to: '0.2.0' });
    assert.match(refused.error ?? '', /^tooling is tagged 0\.2\.0 already, and the bookkeeping would still write:$/m);
    assert.match(refused.error ?? '', /^ {2}tooling: \.github\/workflows\/extra\.yml: workflow refs → @0\.2\.0$/m);
    assert.equal(refused.error?.split('\n').filter((l) => l.startsWith('  tooling: ')).length, 1, 'only that file');
    assert.equal(git(prim, 'rev-parse', 'main'), head, 'nothing written');
    assert.ok(!tagged('compendium', '0.2.0'), 'phase two not started');
  }

  // Made to match by hand, the re-run has nothing to write to tooling and finishes the version.
  put(join(prim, '.github/workflows/extra.yml'), `jobs:\n  ci:\n    uses: ${TOOLING_REF}ci.yml@0.2.0\n`);
  commit(prim, 'the workflow at the version');
  git(prim, 'push', '--quiet', 'origin', 'main');
  const finished = await run({ yes: true }, { to: '0.2.0' });
  assert.equal(finished.error, undefined, finished.out);
  assert.ok(allTagged('0.2.0') && allReleased('0.2.0'));
  assert.equal(
    git(prim, 'log', '--format=%s', '--grep', 'bookkeeping').split('\n').length,
    1,
    'one bookkeeping commit',
  );
});

test('a push failure mid-release names the recovery, and the re-run finishes the version', async () => {
  fixture('midway');
  // origin keeps answering fetches but rejects every push, like a lost permission would.
  const hook = join(remote('template-repo-turbo'), 'hooks/pre-receive');
  writeFileSync(hook, '#!/bin/sh\necho "rejected by the test" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  const first = await run({ yes: true });
  assert.match(first.error ?? '', /ship stopped during the release; re-run with --to 0\.2\.0/);
  assert.ok(
    tagged('tooling', '0.2.0') && remoteTagged('tooling', '0.2.0') && released('tooling', '0.2.0'),
    'phase one done',
  );
  assert.ok(
    tagged('template-repo-turbo', '0.2.0') &&
      !remoteTagged('template-repo-turbo', '0.2.0') &&
      !released('template-repo-turbo', '0.2.0'),
    'failing repo tagged locally only, no release',
  );
  assert.ok(
    !tagged('template-app-nextjs', '0.2.0') && !tagged('template-repo-operations', '0.2.0'),
    'repos after the failure untouched',
  );
  consumersUntouched();
  rmSync(hook);
  const second = await run({ yes: true });
  assert.match(second.error ?? '', /latest tags disagree/, 'version-less re-run refuses the skew');
  const third = await run({ yes: true }, { to: '0.2.0' });
  assert.equal(third.error, undefined, third.out);
  assert.ok(allTagged('0.2.0') && allReleased('0.2.0'));
  assert.ok(has(third.out, '• template-repo-turbo: already tagged 0.2.0'));
  consumersUntouched();
  assert.ok(!fakeLog().some((l) => has(l, 'pr create')), 'no pull request, before or after');
});

test('update --recursive: a failing site does not stop the others, and the summary says so', async () => {
  fixture('failsite');
  versionCut('0.2.0');
  process.env.FAKE_COPIER_FAIL = 'acme/platform';
  const { result, error, out } = await runRecursive({ yes: true });
  delete process.env.FAKE_COPIER_FAIL;
  assert.equal(error, undefined, out);
  assert.match(onVersion('acme-web', '0.2.0', 'template-owned.txt'), /updated from/);
  assert.match(
    onVersion('acme-platform', '0.2.0', '.github/workflows/apps.yml'),
    /@0\.2\.0/,
    'workflow refs still bumped and proposed for the failed site',
  );
  assert.match(onVersion('acme-platform', '0.2.0', 'template-owned.txt'), /generated/, 'failed site left as it was');
  assert.ok(has(out, '✗ FAILED — copier update exited nonzero: fake copier: failing on purpose'));
  assert.deepEqual(result?.failed, ['acme/platform']);
  assert.deepEqual(result?.mergeable, ['https://forge/acme-web/pull/1'], 'a repo with a failed site is not offered');
  assert.match(pull('acme-platform', '0.2.0', '.body'), /^\*\*Needs a hand\.\*\*/, 'the body opens with it');
  assert.match(pull('acme-platform', '0.2.0', '.body'), /^- `copier update` failed at the root, left as it was/m);
  assert.equal(pull('acme-platform', '0.2.0', '.draft'), 'true', 'a draft');
  assert.equal(pull('acme-web', '0.2.0', '.draft'), 'false');
  assert.deepEqual(result?.clean, ['acme/web', 'acme/web/apps/site']);
});

test('update --recursive: a conflict is committed with its markers and the pull request says so', async () => {
  fixture('conflict');
  versionCut('0.2.0');
  process.env.FAKE_COPIER_CONFLICT = 'acme/web/apps';
  const { result, out } = await runRecursive({ yes: true });
  delete process.env.FAKE_COPIER_CONFLICT;
  assert.ok(has(out, '✗ CONFLICTS'));
  assert.deepEqual(result?.conflicted, ['acme/web/apps/site']);
  assert.deepEqual(result?.clean, ['acme/platform', 'acme/web']);
  assert.match(onVersion('acme-web', '0.2.0', 'apps/site/template-owned.txt'), /^<<<<<<< /m, 'markers in the branch');
  assert.match(pull('acme-web', '0.2.0', '.body'), /^- Conflicts at `apps\/site`, committed with their markers\.$/m);
  assert.match(
    pull('acme-web', '0.2.0', '.body'),
    /^- Files that hold conflict markers: `apps\/site\/template-owned\.txt`\.$/m,
  );
  assert.equal(pull('acme-web', '0.2.0', '.draft'), 'true', 'a draft');
  assert.equal(result?.pulls.length, 2, 'the pull request is opened all the same');
  assert.deepEqual(
    result?.mergeable,
    ['https://forge/acme-platform/pull/1'],
    'only the clean one is offered for merging',
  );
  assert.doesNotMatch(pull('acme-web', '0.2.0', '.body'), /Nothing needs a hand/);
});

test('update --recursive: a conflict at the repo root does not stop its apps', async () => {
  fixture('rootconflict');
  versionCut('0.2.0');
  process.env.FAKE_COPIER_CONFLICT = 'acme/web';
  const { result, out } = await runRecursive({ yes: true });
  delete process.env.FAKE_COPIER_CONFLICT;
  assert.deepEqual(result?.conflicted, ['acme/web', 'acme/web/apps/site'], out);
  assert.deepEqual(result?.failed, []);
  assert.match(
    onVersion('acme-web', '0.2.0', 'apps/site/template-owned.txt'),
    /^<<<<<<< /m,
    'the app was updated after the root conflicted',
  );
  assert.equal(git(remote('acme-web'), 'rev-list', '--count', 'develop..plexus/0.2.0'), '1', 'still one commit');
});

test('update --recursive: a named version is validated, and asks every repo for it without a release list', async () => {
  fixture('prop');
  const bad = await runRecursive({ yes: true }, { to: '1.2' });
  assert.match(bad.error ?? '', /'1\.2' is not plain semver/);
  const { result, error, out } = await runRecursive({ yes: true }, { to: '0.2.0' });
  assert.equal(error, undefined, out);
  assert.ok(noneTagged('0.2.0'), 'update cuts nothing');
  assert.ok(has(out, '• acme/web: takes 0.2.0 — asked for (--to 0.2.0)'), out);
  assert.ok(!fakeLog().some((l) => has(l, '/releases')), 'the forge is not asked for the versions');
  assert.match(onVersion('acme-web', '0.2.0', 'template-owned.txt'), /updated from 0\.2\.0/);
  assert.match(onVersion('acme-web', '0.2.0', '.github/workflows/ci.yml'), /changes\.yml@0\.2\.0/);
  assert.equal(result?.version, '0.2.0');
  assert.equal(result?.pulls.length, 2);
});

test('update --recursive: a repo whose origin lacks the branch the version lands on is skipped, with the reason', async () => {
  fixture('no-branch');
  git(remote('acme-web'), 'update-ref', '-d', 'refs/heads/develop');
  const { result, error, out } = await runRecursive({ yes: true }, { to: '0.2.0' });
  assert.equal(error, undefined, out);
  const reason = 'origin has no branch `develop`, the one the version lands on';
  assert.ok(has(out, `⚠ acme/web: ${reason} — skipped`), out);
  assert.deepEqual(result?.skipped, [{ path: 'acme/web', reason }]);
  assert.deepEqual(result?.failed, []);
  assert.equal(result?.pulls.length, 1, 'the other repo takes the version');
  const alone = await runUpdate({ yes: true }, { repo: join(WS, 'acme/web'), to: '0.2.0' });
  assert.equal(alone.error, undefined, alone.out);
  assert.deepEqual(alone.result?.skipped, [{ path: 'web', reason }]);
});

test('the confirmation aborts cleanly without a terminal', async () => {
  fixture('prompt');
  const { error, out } = await run({});
  assert.match(error ?? '', /cannot ask .* without a terminal; pass --yes/);
  assert.ok(noneTagged('0.2.0'));
  assert.ok(!has(out, 'stopped during the release'), 'no recovery hint (nothing was started)');
});

// ── the tenant-side pull: update ─────────────────────────────────────────────
test('update: a repo takes the newest version itself, in a worktree, and leaves its checkout alone', async () => {
  fixture('update');
  versionCut('0.1.0');
  versionCut('0.2.0');
  const web = join(WS, 'acme/web');
  git(web, 'checkout', '--quiet', '-b', 'feature/x');
  put(join(web, 'notes.txt'), 'scratch\n');
  const { result, error, out } = await runUpdate({ yes: true }, { repo: web });
  assert.equal(error, undefined, out);
  assert.ok(has(out, '→ web: worktree of origin/develop'));
  const runs = copierRuns();
  assert.equal(runs.length, 2, 'copier ran at the root and the app');
  assert.ok(
    runs.every(
      (l) => has(l, '--vcs-ref 0.2.0') && has(l, '--skip-tasks') && has(l, '--defaults') && !l.startsWith(`${WS}/`),
    ),
    `copier updated to the version, outside the checkout:\n${runs.join('\n')}`,
  );
  assert.ok(
    fakeLog().some((l) => l.startsWith('mise exec copier@') && !/ ignored=$/.test(l) && !has(l, `ignored=${WS}`)),
    "the worktree's mise config ignored",
  );
  assert.match(onVersion('acme-web', '0.2.0', 'template-owned.txt'), /updated from 0\.2\.0/);
  assert.match(onVersion('acme-web', '0.2.0', 'apps/site/template-owned.txt'), /updated from 0\.2\.0/);
  assert.equal(onVersion('acme-web', '0.2.0', 'PLEXUS.md'), MARKER.trimEnd(), 'the marker is not written');
  assert.match(onVersion('acme-web', '0.2.0', '.github/workflows/ci.yml'), /pipeline\.yml@0\.2\.0/, 'refs bumped');
  assert.equal(git(remote('acme-web'), 'rev-list', '--count', 'develop..plexus/0.2.0'), '1', 'one commit');
  assert.equal(pull('acme-web', '0.2.0', '.base'), 'develop');
  assert.match(
    pull('acme-web', '0.2.0', '.body'),
    /Opened by `plx update`: 0\.2\.0, the oldest version not taken, was cut 59 days ago \(interval: 7 days; 1 newer version\)\./,
  );
  assert.equal(git(web, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/x', 'checkout still on its branch');
  assert.match(read(join(web, 'template-owned.txt')), /^generated$/m, 'checkout not updated');
  assert.ok(existsSync(join(web, 'notes.txt')), 'local file kept');
  assert.equal(git(web, 'worktree', 'list').split('\n').length, 1, 'worktree removed');
  assert.deepEqual(result, {
    version: '0.2.0',
    preview: false,
    clean: ['web', 'web/apps/site'],
    conflicted: [],
    failed: [],
    skipped: [],
    resting: [],
    pulls: ['https://forge/acme-web/pull/1'],
    mergeable: ['https://forge/acme-web/pull/1'],
  });

  // The next day: the branch is on origin, so nothing moves it.
  const again = await runUpdate({ yes: true }, { repo: web });
  assert.equal(again.error, undefined, again.out);
  assert.ok(
    has(again.out, 'web: plexus/0.2.0 is on origin (https://forge/acme-web/pull/1); no conflict marker remains'),
  );
  assert.equal(copierRuns().length, 2, 'copier not run again');
  assert.deepEqual(again.result?.pulls, ['https://forge/acme-web/pull/1']);
  assert.deepEqual(
    again.result?.mergeable,
    ['https://forge/acme-web/pull/1'],
    'found on origin, no draft, and no marker in it',
  );
  assert.deepEqual(again.result?.clean, []);
});

test('update: a repo already at the version does nothing, and one without a release is told so', async () => {
  fixture('update-current');
  const plat = join(WS, 'acme/platform');
  const none = await runUpdate({ yes: true }, { repo: plat });
  assert.match(none.error ?? '', /no release of plexus-ms\/compendium found/);
  versionCut('0.1.0');
  const { result, error, out } = await runUpdate({ yes: true }, { repo: plat });
  assert.equal(error, undefined, out);
  assert.ok(has(out, '• platform: already at 0.1.0'));
  assert.equal(copierRuns().length, 0);
  assert.throws(() => onVersion('acme-platform', '0.1.0', 'template-owned.txt'), 'no branch pushed');
  assert.deepEqual(result?.pulls, []);
  const notConsumer = await runUpdate({ yes: true }, { repo: up('compendium') });
  assert.match(notConsumer.error ?? '', /not a repo generated from the templates/);
  const bad = await runUpdate({ yes: true }, { repo: plat, to: 'v1' });
  assert.match(bad.error ?? '', /'v1' is not plain semver/);
  const back = await runUpdate({ yes: true }, { repo: plat, to: '0.0.9' });
  assert.match(back.error ?? '', /platform is at 0\.1\.0, past 0\.0\.9/);
});

test('update: the dry run previews in the worktree and pushes nothing', async () => {
  fixture('update-dry');
  versionCut('0.2.0');
  const web = join(WS, 'acme/web');
  const { result, error, out } = await runUpdate({ dryRun: true, yes: true }, { repo: web });
  assert.equal(error, undefined, out);
  assert.equal(copierRuns().filter((l) => has(l, '--vcs-ref 0.2.0')).length, 2, 'copier previewed both sites');
  assert.ok(has(out, 'M template-owned.txt'), 'preview shows the change');
  assert.ok(has(out, '(preview) web: would commit, push plexus/0.2.0 and open a pull request against develop'));
  assert.throws(() => onVersion('acme-web', '0.2.0', 'template-owned.txt'), 'nothing pushed');
  assert.ok(!fakeLog().some((l) => has(l, 'pr create')), 'no pull request');
  assert.equal(git(web, 'status', '--porcelain'), '', 'checkout clean');
  assert.equal(git(web, 'worktree', 'list').split('\n').length, 1, 'worktree removed');
  assert.deepEqual(result?.clean, ['web', 'web/apps/site']);
  assert.equal(result?.preview, true);
});

test("update: after a recursive run opened the version's pull request, the repo's own run finds it", async () => {
  fixture('update-after-recursive');
  versionCut('0.2.0');
  const recursive = await runRecursive({ yes: true });
  assert.equal(recursive.error, undefined, recursive.out);
  const before = copierRuns().length;
  const { result, error, out } = await runUpdate({ yes: true }, { repo: join(WS, 'acme/platform') });
  assert.equal(error, undefined, out);
  assert.ok(has(out, 'platform: plexus/0.2.0 is on origin (https://forge/acme-platform/pull/1)'), out);
  assert.equal(copierRuns().length, before);
  assert.deepEqual(result?.pulls, ['https://forge/acme-platform/pull/1']);
  assert.deepEqual(result?.failed, []);
});

test('update: a conflict is committed with its markers, the pull request opened, the exit nonzero', async () => {
  fixture('update-conflict');
  versionCut('0.2.0');
  process.env.FAKE_COPIER_CONFLICT = 'apps/site';
  const { result, error, out } = await runUpdate({ yes: true }, { repo: join(WS, 'acme/web') });
  delete process.env.FAKE_COPIER_CONFLICT;
  assert.equal(error, undefined, out);
  assert.deepEqual(result?.conflicted, ['web/apps/site']);
  assert.deepEqual(result?.clean, ['web']);
  assert.match(onVersion('acme-web', '0.2.0', 'apps/site/template-owned.txt'), /^<<<<<<< /m);
  assert.match(pull('acme-web', '0.2.0', '.body'), /^- Conflicts at `apps\/site`/m);
  assert.equal(pull('acme-web', '0.2.0', '.draft'), 'true');
});

test('update: a pull request that needs a hand is a draft; later runs follow its markers, never its body, and never move it', async () => {
  fixture('update-hand');
  versionCut('0.2.0');
  const web = join(WS, 'acme/web');
  process.env.FAKE_COPIER_CONFLICT = 'apps/site';
  process.env.FAKE_PNPM_FAIL = '1';
  const first = await runUpdate({ yes: true }, { repo: web });
  delete process.env.FAKE_COPIER_CONFLICT;
  delete process.env.FAKE_PNPM_FAIL;
  assert.equal(first.error, undefined, first.out);
  const url = 'https://forge/acme-web/pull/1';
  assert.ok(has(first.out, `web: draft pull request opened: ${url}`), first.out);
  assert.equal(pull('acme-web', '0.2.0', '.draft'), 'true', 'opened as a draft');
  const body = pull('acme-web', '0.2.0', '.body');
  assert.match(body, /^\*\*Needs a hand\.\*\*/, 'the body opens with what needs a hand');
  assert.match(body, /^- Files that hold conflict markers: `apps\/site\/template-owned\.txt`\.$/m);
  assert.match(body, /^- The lockfile did not refresh: run `pnpm install` after resolving/m);
  assert.deepEqual(first.result?.conflicted, ['web/apps/site']);
  assert.deepEqual(first.result?.failed, ['web/pnpm-lock.yaml']);
  assert.deepEqual(first.result?.mergeable, []);
  const tip = git(remote('acme-web'), 'rev-parse', 'plexus/0.2.0');

  // Somebody edits the body to say it is clean: nothing follows from it.
  writeFileSync(join(FORGE(), 'acme-web', 'pr-plexus-0.2.0.body'), 'Nothing needs a hand: every site merged clean.');
  const second = await runUpdate({ yes: true }, { repo: web });
  assert.equal(second.error, undefined, second.out);
  assert.ok(
    has(second.out, `web: plexus/0.2.0 is on origin (${url}); 1 file still holds conflict markers`),
    second.out,
  );
  assert.equal(pull('acme-web', '0.2.0', '.draft'), 'true', 'still a draft');
  assert.match(
    pull('acme-web', '0.2.0', '.body'),
    /^- Files that hold conflict markers: `apps\/site\/template-owned\.txt`\.$/m,
  );
  assert.doesNotMatch(pull('acme-web', '0.2.0', '.body'), /pnpm install/, 'the lockfile is not checked again');
  assert.deepEqual(second.result?.conflicted, ['web/apps/site/template-owned.txt'], 'still needs a human');
  assert.deepEqual(second.result?.mergeable, []);
  assert.equal(git(remote('acme-web'), 'rev-parse', 'plexus/0.2.0'), tip, 'the branch is where it was');
  assert.equal(copierRuns().length, 2, 'copier not run again');

  // Somebody resolves the conflict on the branch.
  const human = join(WS, 'human');
  git(WS, 'clone', '--quiet', '--branch', 'plexus/0.2.0', remote('acme-web'), human);
  put(join(human, 'apps/site/template-owned.txt'), 'resolved\n');
  commit(human, 'resolve');
  git(human, 'push', '--quiet', 'origin', 'plexus/0.2.0');
  const resolved = git(remote('acme-web'), 'rev-parse', 'plexus/0.2.0');
  const refs = git(web, 'for-each-ref');
  const preview = await runUpdate({ dryRun: true, yes: true }, { repo: web });
  assert.equal(preview.error, undefined, preview.out);
  assert.equal(git(web, 'for-each-ref'), refs, "a dry run writes no ref in the repo's checkout");
  assert.ok(has(preview.out, 'no conflict marker remains'), 'it read the resolved branch all the same');
  assert.equal(pull('acme-web', '0.2.0', '.draft'), 'true', 'a dry run changes nothing');
  assert.deepEqual(preview.result?.mergeable, [], 'still a draft, so not ready to merge');
  const third = await runUpdate({ yes: true }, { repo: web });
  assert.equal(third.error, undefined, third.out);
  assert.ok(has(third.out, `web: plexus/0.2.0 is on origin (${url}); no conflict marker remains — ready for review`));
  assert.equal(pull('acme-web', '0.2.0', '.draft'), 'false', 'marked ready');
  assert.match(pull('acme-web', '0.2.0', '.body'), /^Nothing needs a hand/);
  assert.ok(fakeLog().some((l) => l === `gh[acme-web] pr ready ${url}`));
  assert.deepEqual(third.result?.conflicted, []);
  assert.deepEqual(third.result?.mergeable, [url]);
  assert.equal(git(remote('acme-web'), 'rev-parse', 'plexus/0.2.0'), resolved, "the human's commit, untouched");

  // A bad merge brings markers back: a draft again.
  put(join(human, 'template-owned.txt'), `x\n${'>'.repeat(7)} theirs\n`);
  commit(human, 'oops');
  git(human, 'push', '--quiet', 'origin', 'plexus/0.2.0');
  const fourth = await runUpdate({ yes: true }, { repo: web });
  assert.equal(fourth.error, undefined, fourth.out);
  assert.ok(has(fourth.out, '1 file still holds conflict markers — a draft again'), fourth.out);
  assert.equal(pull('acme-web', '0.2.0', '.draft'), 'true');
  assert.ok(fakeLog().some((l) => l === `gh[acme-web] pr ready ${url} --undo`));
  assert.deepEqual(fourth.result?.conflicted, ['web/template-owned.txt']);
});

test('update: a pending minor rests inside the interval; past it the newest is taken, the versions skipped in one pull', async () => {
  fixture('update-rest');
  versionCut('0.1.0', '2026-01-01');
  versionCut('0.2.0', '2026-02-25');
  versionCut('0.3.0', '2026-02-27');
  const web = join(WS, 'acme/web');
  const rest = await runUpdate({ yes: true }, { repo: web });
  assert.equal(rest.error, undefined, rest.out);
  assert.ok(
    has(
      rest.out,
      '• web: rests — 2 newer versions, the oldest (0.2.0) cut 4 days ago; the interval is 7 days (plx update --now takes 0.3.0)',
    ),
    rest.out,
  );
  assert.equal(copierRuns().length, 0, 'copier not run');
  assert.equal(git(web, 'worktree', 'list').split('\n').length, 1, 'no worktree made');
  assert.ok(!fakeLog().some((l) => has(l, 'pr create')), 'no pull request');
  assert.deepEqual(rest.result?.resting, [
    { path: 'web', reason: '2 newer versions, the oldest (0.2.0) cut 4 days ago; the interval is 7 days' },
  ]);
  assert.deepEqual(rest.result?.pulls, []);

  // Three days on, the oldest version not taken is a week old: the newest is taken, over the one between.
  const due = await runUpdate({ yes: true }, { repo: web, today: '2026-03-04' });
  assert.equal(due.error, undefined, due.out);
  assert.ok(has(due.out, '• web: takes 0.3.0 — 0.2.0, the oldest version not taken, was cut 7 days ago'), due.out);
  assert.match(onVersion('acme-web', '0.3.0', 'template-owned.txt'), /updated from 0\.3\.0/);
  assert.throws(() => onVersion('acme-web', '0.2.0', 'template-owned.txt'), 'the version between is jumped');
  assert.equal(git(remote('acme-web'), 'rev-list', '--count', 'develop..plexus/0.3.0'), '1', 'one commit');
  assert.match(pull('acme-web', '0.3.0', '.body'), /interval: 7 days; 2 newer versions/);
  assert.deepEqual(due.result?.resting, []);
});

test('update: a version branch on origin with no pull request gets one from a later run; a closed one stays closed', async () => {
  fixture('update-dead-end');
  versionCut('0.2.0');
  const web = join(WS, 'acme/web');
  process.env.FAKE_COPIER_CONFLICT = 'apps/site';
  process.env.FAKE_GH_PR_CREATE_FAIL = '1';
  const first = await runUpdate({ yes: true }, { repo: web, reviewers: ['carol'] });
  delete process.env.FAKE_COPIER_CONFLICT;
  delete process.env.FAKE_GH_PR_CREATE_FAIL;
  assert.equal(first.error, undefined, first.out);
  assert.ok(has(first.out, '✗ FAILED — pull request: fake gh: pr create failed on purpose'), first.out);
  assert.ok(first.result?.failed.includes('web'), 'the run needs a human');
  assert.throws(() => pull('acme-web', '0.2.0'), 'no pull request');
  const tip = git(remote('acme-web'), 'rev-parse', 'plexus/0.2.0');

  const second = await runUpdate({ yes: true }, { repo: web, reviewers: ['carol'] });
  assert.equal(second.error, undefined, second.out);
  assert.ok(has(second.out, 'web: plexus/0.2.0 is on origin with no pull request — opening it as a draft'), second.out);
  assert.equal(pull('acme-web', '0.2.0'), 'https://forge/acme-web/pull/1');
  assert.equal(pull('acme-web', '0.2.0', '.draft'), 'true', 'a draft, by the detector');
  assert.match(
    pull('acme-web', '0.2.0', '.body'),
    /^- Files that hold conflict markers: `apps\/site\/template-owned\.txt`\.$/m,
  );
  assert.match(pull('acme-web', '0.2.0', '.body'), /a later run found the branch on origin with no pull request/);
  assert.equal(pull('acme-web', '0.2.0', '.reviewers'), 'carol', 'with the review request');
  assert.deepEqual(second.result?.pulls, ['https://forge/acme-web/pull/1']);
  assert.deepEqual(second.result?.conflicted, ['web/apps/site/template-owned.txt']);
  assert.equal(git(remote('acme-web'), 'rev-parse', 'plexus/0.2.0'), tip, 'the branch is where it was');

  // A human closes it: that is their decision, and it stays closed.
  writeFileSync(join(FORGE(), 'acme-web', 'pr-plexus-0.2.0.state'), 'CLOSED\n');
  const third = await runUpdate({ yes: true }, { repo: web });
  assert.equal(third.error, undefined, third.out);
  assert.ok(has(third.out, 'its pull request closed (https://forge/acme-web/pull/1) — nothing to do'), third.out);
  const webCreates = () => fakeLog().filter((l) => has(l, 'gh[acme-web] pr create')).length;
  assert.equal(webCreates(), 2, 'not opened again');
  assert.deepEqual(third.result?.pulls, []);
  assert.deepEqual(third.result?.failed, []);

  // A forge that cannot be asked is a failure, never "no pull request".
  process.env.FAKE_GH_PR_LIST_FAIL = '1';
  const unasked = await runUpdate({ yes: true }, { repo: web });
  const many = await runRecursive({ yes: true }, { dir: join(WS, 'acme'), to: '0.2.0' });
  delete process.env.FAKE_GH_PR_LIST_FAIL;
  assert.match(unasked.error ?? '', /fake gh: HTTP 502 on purpose|gh pr list/, unasked.out);
  assert.ok(many.result?.failed.includes('web'), many.out);
  assert.equal(webCreates(), 2, 'nothing opened on a failed list');
  assert.ok(many.result?.failed.includes('platform'), 'the repo that opened one could not list it, and says so');
});

test('update: the review is asked of the users pr_reviewers names, or --reviewer instead, once, draft or not', async () => {
  fixture('update-reviewers');
  versionCut('0.2.0');
  const plat = join(WS, 'acme/platform');
  put(
    join(plat, '.copier-answers.yml'),
    '_commit: 0.1.0\n_src_path: gh:plexus-ms/template-repo-operations\npr_reviewers: alice, bob\n',
  );
  commit(plat, 'reviewers');
  git(plat, 'push', '--quiet', 'origin', 'main');
  const requests = () => fakeLog().filter((l) => has(l, '/requested_reviewers'));

  const answered = await runUpdate({ yes: true }, { repo: plat });
  assert.equal(answered.error, undefined, answered.out);
  assert.equal(pull('acme-platform', '0.2.0', '.reviewers'), 'alice\nbob', 'the answer names them');
  assert.equal(requests().length, 1);
  assert.ok(requests()[0]?.includes('api repos/{owner}/{repo}/pulls/1/requested_reviewers --method POST'));

  // A later run, which marks nothing ready here, asks nobody again; nor would marking it ready.
  await runUpdate({ yes: true }, { repo: plat });
  assert.equal(requests().length, 1, 'requested once');

  // --reviewer overrides the answer, on a draft as on any other; a recursive run passes it through.
  process.env.FAKE_COPIER_CONFLICT = '/web';
  const asked = await runRecursive({ yes: true }, { dir: join(WS, 'acme'), reviewers: ['carol'] });
  delete process.env.FAKE_COPIER_CONFLICT;
  assert.equal(asked.error, undefined, asked.out);
  assert.equal(pull('acme-web', '0.2.0', '.draft'), 'true');
  assert.equal(pull('acme-web', '0.2.0', '.reviewers'), 'carol', 'requested on the draft');
  assert.equal(requests().length, 2, 'the platform repo, found on origin, is not asked again');

  // An answer that names a team is refused before anything is made.
  const bad = join(WS, 'acme/platform');
  put(
    join(bad, '.copier-answers.yml'),
    '_commit: 0.1.0\n_src_path: gh:plexus-ms/template-repo-operations\npr_reviewers: acme/ops\n',
  );
  commit(bad, 'a team');
  git(bad, 'push', '--quiet', 'origin', 'main');
  const team = await runUpdate({ yes: true }, { repo: bad, to: '0.2.0' });
  assert.match(team.error ?? '', /the answer pr_reviewers names `acme\/ops`, a team; only users are requested/);
});

test("update: the pull request's author is left out of the review request, and the run says so", async () => {
  fixture('update-review-author');
  versionCut('0.2.0');
  process.env.FAKE_GH_USER = 'alice';
  const { result, error, out } = await runUpdate(
    { yes: true },
    { repo: join(WS, 'acme/platform'), reviewers: ['Alice', 'bob'] },
  );
  const alone = await runUpdate({ yes: true }, { repo: join(WS, 'acme/web'), reviewers: ['alice'] });
  delete process.env.FAKE_GH_USER;
  assert.equal(error, undefined, out);
  assert.ok(has(out, '• platform: alice opened the pull request and is not asked to review it'), out);
  assert.equal(pull('acme-platform', '0.2.0', '.reviewers'), 'bob');
  assert.deepEqual(result?.failed, []);
  assert.equal(alone.error, undefined, alone.out);
  assert.throws(() => pull('acme-web', '0.2.0', '.reviewers'), 'nobody left to ask, no request');
  assert.ok(!fakeLog().some((l) => has(l, 'gh[acme-web] api') && has(l, 'requested_reviewers')));
});

test('update: a refused review request leaves the pull request open and the run nonzero', async () => {
  fixture('update-review-refused');
  versionCut('0.2.0');
  process.env.FAKE_GH_REVIEW_FAIL = '1';
  const { result, error, out } = await runUpdate(
    { yes: true },
    { repo: join(WS, 'acme/platform'), reviewers: ['dave'] },
  );
  delete process.env.FAKE_GH_REVIEW_FAIL;
  assert.equal(error, undefined, out);
  assert.ok(has(out, '✗ FAILED — platform: review request from dave: fake gh: a reviewer is not a collaborator'), out);
  assert.deepEqual(result?.pulls, ['https://forge/acme-platform/pull/1']);
  assert.deepEqual(result?.mergeable, ['https://forge/acme-platform/pull/1'], 'the pull request itself is fine');
  assert.deepEqual(result?.failed, ['platform (review request)']);
});

test('update: asking takes the version whatever its age, by --now or by naming it', async () => {
  fixture('update-asked');
  versionCut('0.2.0', '2026-02-28');
  const web = join(WS, 'acme/web');
  const rest = await runUpdate({ yes: true }, { repo: web });
  assert.ok(has(rest.out, '• web: rests — 1 newer version, the oldest (0.2.0) cut 1 day ago'), rest.out);
  const now = await runUpdate({ yes: true }, { repo: web, now: true });
  assert.equal(now.error, undefined, now.out);
  assert.ok(has(now.out, '• web: takes 0.2.0 — asked for (--now)'), now.out);
  assert.match(pull('acme-web', '0.2.0', '.body'), /Opened by `plx update`: asked for \(--now\)\./);

  const plat = join(WS, 'acme/platform');
  const listings = fakeLog().filter((l) => has(l, '/releases')).length;
  const named = await runUpdate({ yes: true }, { repo: plat, to: '0.2.0' });
  assert.equal(named.error, undefined, named.out);
  assert.equal(
    fakeLog().filter((l) => has(l, '/releases')).length,
    listings,
    'a named version asks the forge for none',
  );
  assert.match(pull('acme-platform', '0.2.0', '.body'), /asked for \(--to 0\.2\.0\)/);
});

test('update: the interval is the answer of the repo template, a week by default, zero takes every version, and the option overrides both', async () => {
  fixture('update-age');
  versionCut('0.2.0', '2026-02-25');
  // The platform repo's answers set three days: four days is past it.
  const plat = join(WS, 'acme/platform');
  put(
    join(plat, '.copier-answers.yml'),
    '_commit: 0.1.0\n_src_path: gh:plexus-ms/template-repo-operations\nupdate_max_age: 3\n',
  );
  commit(plat, 'three days at most');
  git(plat, 'push', '--quiet', 'origin', 'main');
  const short = await runUpdate({ yes: true }, { repo: plat });
  assert.equal(short.error, undefined, short.out);
  assert.ok(has(short.out, 'was cut 4 days ago (interval: 3 days; 1 newer version)'), short.out);

  // The web repo's say nothing: a week, so it rests; zero is the eager repo.
  const web = join(WS, 'acme/web');
  const rest = await runUpdate({ yes: true }, { repo: web });
  assert.ok(has(rest.out, 'the interval is 7 days'), rest.out);
  const long = await runUpdate({ yes: true }, { repo: web, maxAge: 90, today: '2026-04-15' });
  assert.ok(has(long.out, 'cut 49 days ago; the interval is 90 days'), long.out);
  // The repo is judged by what origin has on the branch the version lands on.
  put(
    join(web, '.copier-answers.yml'),
    '_commit: 0.1.0\n_src_path: gh:plexus-ms/template-repo-turbo\nupdate_max_age: soon\n',
  );
  const local = await runUpdate({ yes: true }, { repo: web });
  assert.ok(has(local.out, 'the interval is 7 days'), 'an edit in the checkout is not what origin says');
  commit(web, 'soon');
  git(web, 'push', '--quiet', 'origin', 'develop');
  const bad = await runUpdate({ yes: true }, { repo: web });
  assert.match(bad.error ?? '', /the answer update_max_age is 'soon', not a whole number of days/);

  const eager = await runUpdate({ yes: true }, { repo: web, maxAge: 0 });
  assert.equal(eager.error, undefined, eager.out);
  assert.ok(
    has(eager.out, '• web: takes 0.2.0 — an interval of zero takes every version (1 newer version)'),
    eager.out,
  );
});

test('update: a pending patch is taken at once; a pending major is named, and taken only when asked', async () => {
  fixture('update-step');
  versionCut('0.1.1', '2026-02-28');
  const plat = join(WS, 'acme/platform');
  const fix = await runUpdate({ yes: true }, { repo: plat });
  assert.equal(fix.error, undefined, fix.out);
  assert.ok(has(fix.out, '• platform: takes 0.1.1 — 0.1.1 is a hotfix, taken at once (1 newer version)'), fix.out);
  assert.match(pull('acme-platform', '0.1.1', '.body'), /Opened by `plx update`: 0\.1\.1 is a hotfix, taken at once/);

  // A major arrives. The web repo takes the hotfix of its own major and names the major beside it.
  versionCut('1.0.0', '2026-02-01');
  const web = join(WS, 'acme/web');
  const both = await runUpdate({ yes: true }, { repo: web });
  assert.equal(both.error, undefined, both.out);
  assert.ok(has(both.out, '• web: 1.0.0 is a new major, taken only when asked (plx update --now takes it)'), both.out);
  assert.ok(has(both.out, '• web: takes 0.1.1 — 0.1.1 is a hotfix'), both.out);
  assert.throws(() => onVersion('acme-web', '1.0.0', 'template-owned.txt'), 'the major is not taken');

  // The platform repo, once on the hotfix, has only the major ahead: it rests, a month on as well.
  put(join(plat, '.copier-answers.yml'), '_commit: 0.1.1\n_src_path: gh:plexus-ms/template-repo-operations\n');
  commit(plat, 'Plexus 0.1.1');
  git(plat, 'push', '--quiet', 'origin', 'main');
  const rest = await runUpdate({ yes: true }, { repo: plat, today: '2026-04-01' });
  assert.equal(rest.error, undefined, rest.out);
  assert.ok(
    has(rest.out, '• platform: rests — 1.0.0 is a new major, taken only when asked (plx update --now takes 1.0.0)'),
    rest.out,
  );
  assert.equal(rest.out.split('1.0.0 is a new major').length - 1, 1, `said once:\n${rest.out}`);
  assert.throws(() => onVersion('acme-platform', '1.0.0', 'template-owned.txt'));
  const asked = await runUpdate({ yes: true }, { repo: plat, now: true });
  assert.equal(asked.error, undefined, asked.out);
  assert.ok(has(asked.out, '• platform: takes 1.0.0 — asked for (--now)'), asked.out);
  assert.match(onVersion('acme-platform', '1.0.0', 'template-owned.txt'), /updated from 1\.0\.0/);
});

test('ship to update, end to end: a minor rests inside the interval, a patch cut after it arrives at once with it', async () => {
  fixture('e2e-step');
  const minor = await run({ yes: true });
  assert.equal(minor.error, undefined, minor.out);
  // The day after the version: well inside the week.
  const quiet = await runRecursive({ yes: true }, { today: '2026-01-02' });
  assert.equal(quiet.error, undefined, quiet.out);
  assert.deepEqual(
    quiet.result?.resting.map((r) => r.path),
    ['acme/platform', 'acme/web'],
  );
  // A hotfix is cut as a patch, on every repo.
  const patch = await run({ yes: true }, { to: '0.2.1' });
  assert.equal(patch.error, undefined, patch.out);
  assert.ok(allTagged('0.2.1') && allReleased('0.2.1'));
  const { result, error, out } = await runRecursive({ yes: true }, { today: '2026-01-02' });
  assert.equal(error, undefined, out);
  assert.ok(has(out, '• acme/web: takes 0.2.1 — 0.2.1 is a hotfix, taken at once (2 newer versions)'), out);
  assert.match(onVersion('acme-web', '0.2.1', 'template-owned.txt'), /updated from 0\.2\.1/);
  assert.throws(() => onVersion('acme-web', '0.2.0', 'template-owned.txt'), 'the minor arrives in the same pull');
  assert.deepEqual(result?.pulls, ['https://forge/acme-platform/pull/1', 'https://forge/acme-web/pull/1']);
});
