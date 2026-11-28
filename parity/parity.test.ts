// The parity ring: proof that the engine renders and updates as copier does,
// for the three Plexus templates. It is scaffolding for the cutover: it stands
// as long as both copier and the engine do, and the cutover deletes it with
// copier (the one path is `parity/`, with the `parity` task in `mise.toml` and
// its entry in `verify`'s `depends`, which are the only other lines that name it).
// It is outside `@plexus-ms/cli-template` because the engine knows no Plexus template.
//
// The criterion, and the end of this ring's work: byte parity for the three real
// templates. What differs from copier on purpose is not compared: the merge rules
// the engine's `merge.ts` states for itself (a file the template removes and the
// user edited, a file the user deleted, a binary file changed on both sides)
// are the engine's own spec ring's, and the replays below edit only files that
// both renders hold, so that they do not reach those rules.
// One more departure follows from them: a born-once file that a version of a template adds
// is written by the engine into a site that lacks it, as a birth, and copier's update-time
// `_exclude` never writes it. The replays of the app template therefore start at 0.123.0,
// the first version that renders its born-once source files; 0.119.0 has no `src/` yet.
//
// Three checks, over the template repos as cloned for the run (below), against the
// engine on `templates/`:
//
//   rendering          every shape of SHAPES below: the engine's tree is byte-identical
//                      to what `copier copy` writes, in paths, bytes, executable bits and
//                      empty directories, and the answers the engine resolves are the ones
//                      copier recorded.
//   updates            every pair of REPLAYS: a consumer rendered at a past tag by copier,
//                      with local edits, taken to the head by `copier update`, and the same
//                      consumer taken there by `plx-template merge`; the two directories are
//                      byte-identical.
//   same version       the template sources of both places are the same files, but for the
//                      few that differ by design (DEPARTURES), whose rendering the first
//                      check covers; and the manifests agree where they decide bytes or
//                      commands: copier's `_skip_if_exists` and `_exclude` on update are the
//                      files tooling renders born-once, and copier's `_tasks` as a copy runs
//                      them are tooling's birth commands (copierManifest states the mapping
//                      of the two spellings). This reaches what no shape renders, a branch
//                      of a template that no answer here takes. It is what fails when a
//                      change to the files, the born-once set or the birth commands is made
//                      in one place only during the double maintenance.
//
// What the same-version check does not compare is the rest of the two manifests:
// choices, validators, help texts, defaults and a question's `when`. A change to one of
// those in one place only is caught only where a shape's bytes or resolved answers show it.
//
// Where the template repos come from. The ring compares with the template repos as
// they are now, so each run clones them: from GitHub (`GITHUB` in harness.ts), where
// they are public, in the run on the forge and by default on a machine; or from
// `PLX_PARITY_TEMPLATE_REPOS`, a directory (or a URL prefix) holding the three
// `template-*` repos, as a developer's checkouts at `~/dev/plexus-ms`. A clone takes
// the head of the branch that is checked out (GitHub's is the default branch), so
// uncommitted work in a checkout is not seen, and a branch that is not the default one
// is what is compared. A clone that
// fails, for lack of network or of the repo, is an error naming the repo and the place;
// the run then fails, and no test passes without having read the template repos.
// A tooling change that has no counterpart in the template repos yet fails here until
// the template repo has it: both are changed, in either order, before both are green.
//
// Why it is not cached. The template repos are not files of this repo, so no turbo
// input could name them: the ring is a mise task of its own (`parity`, a dependency of
// `verify`) that runs `node --test` directly and is never a turbo task, so a green run
// can never be replayed over a changed template repo.
//
// The old side of a replay is rendered by copier from the tag. The old versions of the
// templates exist only in the template repos, in copier's format, and a conversion of
// them to the engine's would be code of its own whose correctness the ring would then
// have to assume. Copier's render of the old tag is also what a consumer actually holds.
// It is normalised as the rendering check's trees are (below), and the policy of each of
// its paths is the policy the new render gives that path, `merge` for a path the new
// render lacks: the policies are the engine's decision, and an old copier tag has none.
// The consequence the policy carries is the one that matters: PLEXUS.md is born-once in
// the new render, so the engine keeps its body, as copier's `_skip_if_exists` and its
// update-time `_exclude` do, whatever the old tag did with it.
// The new render and the merge of an update run through the real `plx-template` command
// (render and merge), so that the directory rules of its source are not written a second
// time; the old side is the copier directory, with the policies file written beside it.
//
// What the comparison filters, and nothing else:
//   - `.copier-answers.yml`, which the engine has no counterpart of. Its answers are
//     compared in the rendering check (the profile spelled `stateless-app` and
//     `stateful-app` in copier, `stateless` and `stateful` in the engine);
//   - the frontmatter of PLEXUS.md and the blank line after it, which copier's template
//     writes and `plx` writes for the engine (stripCopierMarker);
//   - in a replay, the labels of conflict markers: copier's `before updating` and
//     `after updating`, the engine's `current` and `new render` (unifyConflictLabels);
//   - `.git`, which a replay needs for copier and which is removed before comparing;
//   - of a file's mode, only the executable bit is compared, the one bit the engine carries;
//   - in the same-version check, a copier template file named `.gitignore` is the port's
//     `.gitignore.jinja` (npm leaves the former out of a package), and copier's own
//     template of its answers file is skipped (portedPath).
// The answers the engine is given are the ones copier is given, with the profile
// values mapped and, for the app template, `tenant` passed as a given answer where
// copier reads it from the enclosing repo's answers file (copierJob).
// Each helper that decides something is pinned by helpers.test.ts. The glue that only
// moves files (siteOf, copierCopy, copyNormalised) is exercised by every replay.
//
// Every replay checks that it was not vacuous: the template changed at least one file,
// at least one file of the consumer's merged cleanly and at least one conflicted,
// and the marker's body, which the consumer edited, was kept.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { type Answers, readTree, render, type Tree } from '../packages/cli-template/src/index.ts';
import { ANSWERS_FILE, parseAnswers } from '../packages/lib/src/copier.ts';
import {
  cloneTemplateRepos,
  copier,
  GIT_CONFIG,
  GITHUB,
  isolatedEnv,
  OVERRIDE,
  run,
  TEMPLATE_REPOS,
  type TemplateName,
} from './harness.ts';
import {
  consumerEdits,
  copierAnswersAsEngine,
  copierJob,
  copierManifest,
  diffTrees,
  MARKER,
  normaliseCopierTree,
  portedPath,
  stripCopierMarker,
  unifyTree,
} from './helpers.ts';

const ROOT = join(import.meta.dirname, '..');
const TEMPLATES = join(ROOT, 'templates');
const PLX_TEMPLATE = join(ROOT, 'packages', 'cli-template', 'src', 'bin.ts');
const TENANT = 'acme';

interface Shape {
  readonly template: TemplateName;
  readonly name: string;
  readonly answers: Answers;
  /** Why the shape exists: the question and value, or the combination, that no other shape takes. */
  readonly reason: string;
}

const T = { tenant: TENANT };

// The questions that change the tree or its contents, each in every value it can take
// (a choice, a bool both ways, a text empty and filled), the combinations that gate each
// other (`when`), and the one validator's edge.
const SHAPES: readonly Shape[] = [
  // repo-turbo: publishes_packages, package_registry, private_packages_scope, ci_strategy,
  // ci_registry, ci_overlay, alerts_email, display_versions, pr_reviewers, update_max_age.
  {
    template: 'repo-turbo',
    name: 'defaults',
    answers: { ...T },
    reason: 'every default: github, ghcr, no overlay, no display versions, no packages',
  },
  {
    template: 'repo-turbo',
    name: 'publishes-npm',
    answers: { ...T, publishes_packages: true },
    reason: 'publishes_packages true: the package tree, changesets, trunk workflows; package_registry npm',
  },
  {
    template: 'repo-turbo',
    name: 'publishes-github',
    answers: {
      ...T,
      publishes_packages: true,
      package_registry: 'github',
      private_packages_scope: '@acme-corp',
      pr_reviewers: 'alice, bob',
    },
    reason: 'package_registry github, a scope in the packages tree, reviewers listed',
  },
  {
    template: 'repo-turbo',
    name: 'publishes-hybrid',
    answers: { ...T, publishes_packages: true, ci_strategy: 'hybrid', ci_overlay: 'netbird', display_versions: true },
    reason:
      'questions that `when` skips when packages are published: ci_registry, ci_overlay, alerts_email, display_versions leave no trace',
  },
  {
    template: 'repo-turbo',
    name: 'on-prem',
    answers: { ...T, ci_strategy: 'on-prem' },
    reason: 'ci_strategy on-prem, and ci_registry defaulting to own from it',
  },
  {
    template: 'repo-turbo',
    name: 'hybrid',
    answers: { ...T, ci_strategy: 'hybrid' },
    reason: 'ci_strategy hybrid with alerts_email empty',
  },
  {
    template: 'repo-turbo',
    name: 'hybrid-alerts',
    answers: { ...T, ci_strategy: 'hybrid', alerts_email: 'ops@acme.example' },
    reason: 'alerts_email filled',
  },
  {
    template: 'repo-turbo',
    name: 'github-own-registry',
    answers: { ...T, ci_registry: 'own' },
    reason: 'ci_registry own under ci_strategy github, against its ghcr default',
  },
  {
    template: 'repo-turbo',
    name: 'on-prem-ghcr',
    answers: { ...T, ci_strategy: 'on-prem', ci_registry: 'ghcr' },
    reason: 'ci_registry ghcr under a strategy whose default is own',
  },
  { template: 'repo-turbo', name: 'netbird', answers: { ...T, ci_overlay: 'netbird' }, reason: 'ci_overlay netbird' },
  {
    template: 'repo-turbo',
    name: 'display-versions',
    answers: { ...T, display_versions: true },
    reason: "display_versions true: the release workflow's display-version steps",
  },
  {
    template: 'repo-turbo',
    name: 'scope',
    answers: { ...T, private_packages_scope: '@a0._-b' },
    reason:
      "private_packages_scope filled in a repo that deploys apps, at the validator's edge: every character class it accepts",
  },
  {
    template: 'repo-turbo',
    name: 'everything',
    answers: {
      ...T,
      ci_strategy: 'hybrid',
      ci_registry: 'own',
      ci_overlay: 'netbird',
      alerts_email: 'ops@acme.example',
      display_versions: true,
      private_packages_scope: '@acme-corp',
      pr_reviewers: 'alice',
      update_max_age: 0,
    },
    reason: "all of the above at once, and update_max_age 0, the validator's lowest value",
  },
  {
    template: 'repo-turbo',
    name: 'publishes-npm-scope',
    answers: { ...T, publishes_packages: true, private_packages_scope: '@acme-corp' },
    reason:
      'packages published to npm with a private scope: the release workflow then reads packages (`packages: read`)',
  },
  // repo-operations: github_org, infrastructure, ci_strategy, ci_registry, ci_overlay,
  // alerts_email, pr_reviewers, update_max_age.
  {
    template: 'repo-operations',
    name: 'defaults',
    answers: { ...T },
    reason: 'every default, github_org following the tenant',
  },
  {
    template: 'repo-operations',
    name: 'infrastructure',
    answers: { ...T, infrastructure: true },
    reason: "infrastructure true: the infrastructure layer's playbook, inventory and requirements",
  },
  {
    template: 'repo-operations',
    name: 'on-prem',
    answers: { ...T, ci_strategy: 'on-prem' },
    reason: 'ci_strategy on-prem, ci_registry defaulting to own, so the housekeeping workflow exists',
  },
  {
    template: 'repo-operations',
    name: 'hybrid',
    answers: { ...T, ci_strategy: 'hybrid' },
    reason: 'ci_strategy hybrid with alerts_email empty',
  },
  {
    template: 'repo-operations',
    name: 'hybrid-alerts',
    answers: { ...T, ci_strategy: 'hybrid', alerts_email: 'ops@acme.example' },
    reason: 'alerts_email filled',
  },
  {
    template: 'repo-operations',
    name: 'github-own-registry',
    answers: { ...T, ci_registry: 'own' },
    reason: 'ci_registry own under github: the housekeeping workflow without a strategy that needs it',
  },
  {
    template: 'repo-operations',
    name: 'on-prem-ghcr',
    answers: { ...T, ci_strategy: 'on-prem', ci_registry: 'ghcr' },
    reason: 'ci_registry ghcr under on-prem: no housekeeping workflow',
  },
  {
    template: 'repo-operations',
    name: 'netbird',
    answers: { ...T, ci_overlay: 'netbird' },
    reason: 'ci_overlay netbird in the deploy workflow',
  },
  {
    template: 'repo-operations',
    name: 'organisation',
    answers: { ...T, github_org: 'acme-gh', pr_reviewers: 'alice,bob , carol', update_max_age: 14 },
    reason: 'github_org apart from the tenant, a reviewer list with stray spaces, another update_max_age',
  },
  {
    template: 'repo-operations',
    name: 'everything',
    answers: {
      ...T,
      infrastructure: true,
      ci_strategy: 'hybrid',
      ci_registry: 'own',
      ci_overlay: 'netbird',
      alerts_email: 'ops@acme.example',
      pr_reviewers: 'alice',
      update_max_age: 0,
    },
    reason: 'all of the above at once',
  },
  {
    template: 'repo-operations',
    name: 'hybrid-ghcr',
    answers: { ...T, ci_strategy: 'hybrid', ci_registry: 'ghcr' },
    reason:
      'hybrid with the forge registry: the housekeeping workflow without a registry of its own (`registry: none`)',
  },
  // app-nextjs: name, profile; tenant is the enclosing repo's answer.
  {
    template: 'app-nextjs',
    name: 'stateless',
    answers: { ...T, name: '@acme/web' },
    reason: 'the default profile, stateless, and a scoped package name',
  },
  {
    template: 'app-nextjs',
    name: 'stateful',
    answers: { ...T, name: '@acme/api', profile: 'stateful' },
    reason: "profile stateful: the migrate service, the scripts and the marker's second paragraph",
  },
  {
    template: 'app-nextjs',
    name: 'plain-name',
    answers: { tenant: 'other-tenant', name: 'web' },
    reason: "a package name without a scope, and a tenant that is not the others'",
  },
];

interface Replay {
  readonly template: TemplateName;
  /** The tag the consumer was rendered at; it is taken to the template repo's head. */
  readonly from: string;
  readonly answers: Answers;
  readonly reason: string;
}

// Real pairs of past versions: the consumer is at `from`, the repo's current head is the target.
const REPLAYS: readonly Replay[] = [
  {
    template: 'repo-turbo',
    from: '0.119.0',
    answers: { ...T, ci_strategy: 'hybrid', ci_overlay: 'netbird', display_versions: true, update_max_age: 14 },
    reason:
      'a far pair: update.yml became plx-update.yml, .gitignore and pnpm-workspace.yaml became templates, the marker had another frontmatter; in a hybrid repo with overlay and display versions',
  },
  {
    template: 'repo-turbo',
    from: '0.123.0',
    answers: { ...T, publishes_packages: true },
    reason:
      'the pair across which files were renamed to conditional names ({% if publishes_packages %}.changeset{% endif %}), in a repo that publishes packages',
  },
  {
    template: 'repo-turbo',
    from: '0.129.1',
    answers: { ...T },
    reason: 'the last version before the head, a few lines in eight files',
  },
  {
    template: 'repo-operations',
    from: '0.119.0',
    answers: { ...T },
    reason:
      'the same far pair for the operations template: update.yml became plx-update.yml, workflows and mise.toml changed',
  },
  {
    template: 'repo-operations',
    from: '0.119.0',
    answers: { ...T, infrastructure: true, ci_strategy: 'on-prem' },
    reason:
      'the same far pair with the conditional files the defaults do not render: ci.yml (strategy not github) and infrastructure.yml, both changed since',
  },
  {
    template: 'repo-operations',
    from: '0.129.1',
    answers: { ...T, infrastructure: true, ci_strategy: 'hybrid' },
    reason: 'the last version before the head, with infrastructure and hybrid CI',
  },
  {
    template: 'app-nextjs',
    from: '0.123.0',
    answers: { ...T, name: '@acme/web' },
    reason:
      'the oldest version that renders the born-once source files, which the update must leave as the consumer edited them (0.119.0 has no `src/` yet, and a born-once file a version adds is written by the engine where copier does not write it: a rule of the engine, not compared)',
  },
  {
    template: 'app-nextjs',
    from: '0.129.1',
    answers: { ...T, name: '@acme/api', profile: 'stateful' },
    reason: 'the last version before the head, for a stateful app',
  },
];

// The files whose sources differ between the two places on purpose, each with why. Their
// rendered bytes are the rendering check's.
const DEPARTURES: Readonly<Record<TemplateName, Readonly<Record<string, string>>>> = {
  'repo-turbo': { 'PLEXUS.md.jinja': "the engine's marker has no frontmatter, plx writes it" },
  'repo-operations': { 'PLEXUS.md.jinja': "the engine's marker has no frontmatter, plx writes it" },
  'app-nextjs': {
    'PLEXUS.md.jinja': 'no frontmatter; the profile is stateless or stateful, not stateless-app',
    'docker/compose.yaml.jinja': "the tenant and the profile are plain answers, not copier's answers file and spelling",
    'docker/compose.ci.yaml.jinja': 'the profile is stateless or stateful, not stateless-app',
    'package.json.jinja': 'the name is a plain answer, the profile is stateless or stateful',
  },
};

/** Copier's own file for its answers, which the engine has no counterpart of. */
const COPIER_ONLY = '{{ _copier_conf.answers_file }}.jinja';

const decoder = new TextDecoder();

let work: string;
let env: NodeJS.ProcessEnv;
let clones: Record<TemplateName, string>;
let counter = 0;
const fresh = (...parts: string[]): string => join(work, 'runs', String(counter++), ...parts);

before(async (context) => {
  work = realpathSync(mkdtempSync(join(tmpdir(), 'plx-parity-')));
  const configFile = join(work, 'gitconfig');
  writeFileSync(configFile, GIT_CONFIG);
  env = isolatedEnv(configFile);
  const base = process.env[OVERRIDE] || GITHUB;
  try {
    clones = await cloneTemplateRepos(base, join(work, 'repos'), env);
    for (const [name, dir] of Object.entries(clones)) {
      const head = (await run('git', ['-C', dir, 'log', '-1', '--format=%h %s', 'HEAD'], env)).trim();
      context.diagnostic(`${TEMPLATE_REPOS[name as TemplateName]} from ${base} at ${head}`);
    }
  } catch (error) {
    rmSync(work, { recursive: true, force: true });
    throw error;
  }
});

after(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

/** Where copier writes a template for the given site: an app lives two directories below its repo, whose answers it reads the tenant from. */
function siteOf(template: TemplateName, parent: Answers | undefined): { site: string; dst: string } {
  const site = fresh('site');
  mkdirSync(site, { recursive: true });
  if (parent) writeFileSync(join(site, ANSWERS_FILE), `tenant: ${String(parent.tenant)}\n`);
  return { site, dst: template === 'app-nextjs' ? join(site, 'apps', 'web') : site };
}

/** Copier's copy of a template repo's `ref` into `dst`, with every answer given and no task run. */
async function copierCopy(
  template: TemplateName,
  ref: string,
  answers: Answers,
  dst: string,
  site: string,
  givesTenant = false,
): Promise<void> {
  // An old tag of the app template asks for the tenant itself, where the head reads it from the repo's answers.
  const { data, parent } = copierJob(template, answers);
  const dataFile = join(site, '..', 'data.json');
  writeFileSync(dataFile, JSON.stringify(givesTenant ? { ...data, ...parent } : data));
  await copier(
    [
      'copy',
      '--quiet',
      '--defaults',
      '--trust',
      '--skip-tasks',
      '--vcs-ref',
      ref,
      '--data-file',
      dataFile,
      clones[template],
      dst,
    ],
    env,
    work,
  );
}

describe('rendering: the engine renders what copier copies', { concurrency: 6 }, () => {
  for (const shape of SHAPES) {
    it(`${shape.template} / ${shape.name}`, async () => {
      const { template, answers } = shape;
      const { parent } = copierJob(template, answers);
      const { site, dst } = siteOf(template, parent);
      await copierCopy(template, 'HEAD', answers, dst, site);
      const copied = await readTree(dst);
      const { tenant, ...own } = copierAnswersAsEngine(
        parseAnswers(decoder.decode(copied.get(ANSWERS_FILE)?.bytes)).answers,
      );
      // An app's tenant is the enclosing repo's answer: copier records it, the engine is given it.
      const recorded = template === 'app-nextjs' ? own : { ...own, tenant };

      const result = render([await readTree(join(TEMPLATES, template))], answers);
      assert.deepEqual(result.errors, [], `${template} / ${shape.name}: the engine fails to render`);
      const found = diffTrees(normaliseCopierTree(copied), result.tree).map((d) => `${template} / ${shape.name}: ${d}`);
      if (template === 'app-nextjs' && tenant !== answers.tenant) {
        found.push(`${template} / ${shape.name}: copier read the tenant ${tenant}, the shape gives ${answers.tenant}`);
      }
      if (JSON.stringify(sorted(result.answers)) !== JSON.stringify(sorted(recorded))) {
        found.push(
          `${template} / ${shape.name}: the answers differ: copier ${JSON.stringify(sorted(recorded))}, engine ${JSON.stringify(sorted(result.answers))}`,
        );
      }
      assert.deepEqual(found, []);
    });
  }
});

const sorted = (answers: Answers): Answers =>
  Object.fromEntries(Object.entries(answers).sort(([a], [b]) => a.localeCompare(b)));

describe('same version: the template sources are the same files in both places', () => {
  for (const template of Object.keys(TEMPLATE_REPOS) as TemplateName[]) {
    it(template, async () => {
      const copierSide = await readTree(join(clones[template], 'template'));
      const portSide = await readTree(join(TEMPLATES, template, 'files'));
      const departures = DEPARTURES[template];
      const mapped = new Map([...copierSide].filter(([p]) => p !== COPIER_ONLY).map(([p, e]) => [portedPath(p), e]));
      const exempt = (tree: Tree): Tree => new Map([...tree].filter(([p]) => !(p in departures)));
      for (const path of Object.keys(departures)) {
        assert.ok(
          mapped.has(path) && portSide.has(path),
          `${template}: ${path} is listed as a departure but is in only one place`,
        );
      }
      const found = diffTrees(exempt(mapped), exempt(portSide), {
        copier: 'the template repo',
        engine: 'tooling',
      }).map((d) => `${template}: ${d}`);
      assert.deepEqual(found, []);
    });
  }
});

/** A copy of `from`, as the engine would hold it: no `.git`, no answers file, the marker's frontmatter stripped. */
function copyNormalised(from: string, to: string): void {
  cpSync(from, to, { recursive: true, filter: (path) => !/(^|\/)\.git$/.test(path) });
  rmSync(join(to, ANSWERS_FILE), { force: true });
  const marker = join(to, MARKER);
  writeFileSync(marker, stripCopierMarker(readFileSync(marker)));
}

describe('same version: the manifests agree where they decide bytes or commands', () => {
  for (const template of Object.keys(TEMPLATE_REPOS) as TemplateName[]) {
    it(template, async () => {
      const copierManifestOf = copierManifest(readFileSync(join(clones[template], 'copier.yml'), 'utf8'));
      const shape = SHAPES.find((s) => s.template === template);
      assert.ok(shape, `${template}: no shape to render`);
      const result = render([await readTree(join(TEMPLATES, template))], shape.answers);
      assert.deepEqual(result.errors, [], `${template}: the engine fails to render`);
      const bornOnce = [...result.files]
        .filter(([, origin]) => origin.policy === 'born-once')
        .map(([path]) => path)
        .sort();
      assert.deepEqual(
        copierManifestOf.excludedOnUpdate,
        copierManifestOf.skipIfExists,
        `${template}: the template repo's _exclude on update and _skip_if_exists name different files`,
      );
      assert.deepEqual(
        bornOnce,
        copierManifestOf.skipIfExists,
        `${template}: the files tooling renders once (born-once) are not the ones the template repo skips if they exist`,
      );
      assert.deepEqual(
        result.birth.map((b) => [...b.command]),
        copierManifestOf.birth,
        `${template}: the birth commands of tooling are not the tasks a copy of the template repo runs`,
      );
    });
  }
});

describe('updates: the engine takes a consumer to the head as copier does', { concurrency: 6 }, () => {
  for (const replay of REPLAYS) {
    it(`${replay.template} ${replay.from} to the head`, async () => {
      const { template, from, answers } = replay;
      const label = `${template} ${from} to the head`;
      const { parent } = copierJob(template, answers);
      const { site, dst } = siteOf(template, parent);
      await copierCopy(template, from, answers, dst, site, true);

      // The two renders the engine merges: the old one is copier's at the tag, the new one the engine's.
      const oldDir = join(site, '..', 'old');
      const newDir = join(site, '..', 'new');
      copyNormalised(dst, oldDir);
      const answersFile = join(site, '..', 'answers.json');
      writeFileSync(answersFile, JSON.stringify(answers));
      await run(
        process.execPath,
        [PLX_TEMPLATE, 'render', '--answers', answersFile, newDir, join(TEMPLATES, template)],
        env,
      );
      const oldTree = await readTree(oldDir);
      const newTree = await readTree(newDir);
      const newPolicies = JSON.parse(readFileSync(`${newDir}.plx-template.json`, 'utf8')) as {
        version: number;
        files: Record<string, { template: string; policy: string }>;
      };
      writeFileSync(
        `${oldDir}.plx-template.json`,
        JSON.stringify({
          ...newPolicies,
          files: Object.fromEntries(
            [...oldTree.keys()].map((p) => [p, newPolicies.files[p] ?? { template, policy: 'merge' }]),
          ),
        }),
      );

      // The consumer: the old render with local edits, committed because copier updates only a repository.
      const edits = consumerEdits(oldTree, newTree);
      for (const edit of edits) {
        const file = join(dst, edit.path);
        mkdirSync(dirname(file), { recursive: true });
        if (edit.path === MARKER) {
          const original = readFileSync(file, 'utf8');
          const body = decoder.decode(oldTree.get(MARKER)?.bytes);
          writeFileSync(file, original.slice(0, original.length - body.length) + (body === '' ? '\n' : '') + edit.text);
        } else writeFileSync(file, edit.text);
      }
      const engineSide = join(site, '..', 'engine');
      copyNormalised(dst, engineSide);
      await run('git', ['-C', site, 'init', '-q'], env);
      await run('git', ['-C', site, 'add', '-A'], env);
      await run('git', ['-C', site, 'commit', '-q', '-m', 'consumer'], env);

      const dataFile = join(site, '..', 'data.json');
      await copier(
        [
          'update',
          '--quiet',
          '--defaults',
          '--trust',
          '--skip-tasks',
          '--vcs-ref',
          'HEAD',
          '--data-file',
          dataFile,
          dst,
        ],
        env,
        work,
      );
      rmSync(join(site, '.git'), { recursive: true, force: true });
      const copierResult = normaliseCopierTree(await readTree(dst));

      const merged = JSON.parse(
        await run(process.execPath, [PLX_TEMPLATE, 'merge', oldDir, newDir, engineSide], env),
      ) as { report: { path: string; outcome: string }[] };
      const engineResult = await readTree(engineSide);

      const found = diffTrees(unifyTree(copierResult, 'copier'), unifyTree(engineResult, 'engine')).map(
        (d) => `${label}: ${d}`,
      );
      assert.deepEqual(found, []);

      // The replay was not vacuous.
      const outcome = (path: string) => merged.report.find((r) => r.path === path)?.outcome;
      const changed = [...newTree].filter(
        ([path, entry]) => oldTree.has(path) && !Buffer.from(oldTree.get(path)?.bytes ?? []).equals(entry.bytes),
      );
      assert.ok(changed.length > 0, `${label}: the template changed nothing between the two versions`);
      assert.ok(
        edits.some((e) => e.kind === 'merge' && outcome(e.path) === 'clean'),
        `${label}: no edit of the consumer's merged cleanly`,
      );
      assert.ok(
        edits.some((e) => e.kind === 'conflict' && outcome(e.path) === 'conflicted'),
        `${label}: no edit of the consumer's conflicted`,
      );
      const marker = edits.find((e) => e.kind === 'born-once');
      assert.equal(
        decoder.decode(engineResult.get(MARKER)?.bytes),
        marker?.text,
        `${label}: the marker's body was not kept`,
      );
    });
  }
});
