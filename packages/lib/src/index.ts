// @plexus-ms/lib: the core layer of plx, usable without the CLI.
//
// It holds what a tenant repo and an operator of many repos need, and nothing
// that cuts a version: that is the upstream's, in the unpublished
// `@plexus-ms/dev` (packages/dev), which builds on this package.
//
// A verb here is either a reader returning data, or a pure planner returning
// a Plan (effects.ts) from what was read. The Context (context.ts) reads through
// an injected Io (io.ts) and applies plans, narrating every step; the CLI
// package is an adapter that maps argv onto this. The parsers of Plexus's own
// file shapes (marker.ts, copier.ts) live here, once, for every verb.
// Conventions: compendium/miscellaneous/cli-design.md.

export { type Applied, type ApplyOptions, apply, CROSSOVER_RUNBOOK, type SiteApplied } from './apply.ts';
export { BASELINE_FILE, type Compared, compareBaseline, parseBaseline, renderBaseline } from './baseline.ts';
export { bumpWorkflowRefs, WORKFLOW_REF } from './bookkeeping.ts';
export { bundledTemplatesRoot, loadTemplate, templateDirectory } from './bundled.ts';
export {
  CHANGESET_DIR,
  type Changeset,
  type ChangesetInput,
  changesetPath,
  type DependencyChange,
  type Manifest,
  parseCatalogs,
  planChangeset,
  readChangeset,
  workspaceGlobs,
} from './changeset.ts';
export {
  APP_SERVICE,
  type Compose,
  declaresHealthcheck,
  healthcheckOf,
  type Mapping,
  parseCompose,
} from './compose.ts';
export { filesWithConflictMarkers, hasConflictMarkers, hasUnmergedEntries } from './conflicts.ts';
export { type Consumer, expectedBranch, findConsumers, type Site } from './consumers.ts';
export { Context, type Options } from './context.ts';
export {
  ANSWERS_FILE,
  type Answers,
  COPIER_VERSION,
  copierVia,
  parseAnswers,
  setAnswer,
  TEMPLATE_FILES,
} from './copier.ts';
export {
  type Deploy,
  type DeployOptions,
  defaultAppDir,
  deploy,
  q as shellQuote,
  renderCommitSha,
  renderCompose,
  renderDisplayVersion,
  type Shown,
} from './deploy.ts';
export {
  DEFAULT_ENVIRONMENT,
  type DeployLeg,
  type Deployment,
  type DeployTargets,
  deployLegs,
  deploymentSlug,
  type EnvironmentTargets,
  type InventoryFile,
  parseInventoryFile,
  readDeployTargets,
  readInventory,
  recordsWithoutTarget,
  selectDeployTargets,
  targetsIn,
  type Untargeted,
  untargetedError,
} from './deployTargets.ts';
export {
  type AppFacts,
  CHECKS,
  diagnose,
  type Examination,
  examine,
  type Facts,
  type Finding,
  knownRequirements,
  type MarkerRead,
  type Profile,
  type RepoFacts,
  type Report,
  type UnitReport,
} from './doctor.ts';
export { body, describe, type Plan, run, type Step, write } from './effects.ts';
export { frontmatterField, setFrontmatterField } from './frontmatter.ts';
export {
  type DirEntry,
  detailOf,
  ExecError,
  type ExecOptions,
  type Io,
  onInterrupt,
  orAbsent,
  realIo,
  render,
  TimeoutError,
} from './io.ts';
export {
  type Citable,
  keyOf,
  type LintId,
  lintCitations,
  lintCommitMessage,
  lintDateOrVersion,
  lintIssueIds,
  lintTemplateHeader,
  REQUIREMENT_NAME,
  renderViolation,
  type Violation,
} from './lints.ts';
export {
  type Declaration,
  MARKER_FILE,
  type MarkerConfig,
  parseMarker,
  parseMarkerConfig,
  RESERVED_KEYS,
  reasonGiven,
  setMarkerKeys,
  splitFrontmatter,
} from './marker.ts';
export {
  type Directory,
  type GitFacet,
  isNotable,
  isOperations,
  type Kind,
  shortRemote,
  type TemplateFacet,
  type Unit,
  unitsOf,
} from './model.ts';
export {
  DEFAULT_MAX_AGE,
  MAX_AGE_ANSWER,
  maxAgeOf,
  type Need,
  type NeedInput,
  needOf,
  parseMaxAge,
  type Release,
} from './need.ts';
export { overview, PRUNED, type ScanOptions } from './overview.ts';
export {
  askForReviews,
  needsAHand,
  type OpenedLate,
  openLate,
  type Pull,
  type PullState,
  parseReviewers,
  pullBody,
  pullOf,
  REVIEWERS_ANSWER,
  type Review,
  type Reviewers,
  type Revisited,
  requestReviews,
  reviewersOf,
  revisit,
  versionBranch,
} from './pull.ts';
export { type RecursiveOptions, updateRecursive } from './recursive.ts';
export {
  type CompendiumCheck,
  checkCommitMessage,
  checkCompendium,
  checkRepo,
  extractRequirements,
  lintRepo,
  MAP_PAGE,
  modulePages,
  type PageMode,
  planBaseline,
  type RepoCheck,
  type RepoKind,
  type RepoLint,
  type RepoOptions,
  type RequirementName,
  readCitable,
  requirementName,
  type Scan,
  scanPage,
} from './requirements.ts';
export { findSites, type MarkerSite, siteAnswers } from './sites.ts';
export {
  bundledIndex,
  parseStandardIndex,
  renderStandardIndex,
  STANDARD_INDEX_FILE,
  type StandardIndex,
} from './standardIndex.ts';
export { isClean, mergeLine, renderSummary, type Summary, summarize } from './summary.ts';
export {
  copierIn,
  type SiteResult,
  type SiteUpdate,
  scratchCommit,
  type Take,
  type Taken,
  takeVersion,
} from './take.ts';
export { RENAMED_TEMPLATES, TEMPLATES, templateOf, templateSource } from './templates.ts';
export {
  type Link,
  linksOf,
  mergeWorkspaces,
  newestPnpm,
  planDown,
  planUp,
  pnpmDifference,
  readUmbrella,
  readUmbrellaDown,
  UMBRELLA_MARK,
  UMBRELLA_ROOT_VAR,
  type Umbrella,
  type UmbrellaPackage,
  type UmbrellaRepo,
} from './umbrella.ts';
export { type Known, type Outcome, type UpdateOptions, update } from './update.ts';
export {
  COMPENDIUM,
  compareVersions,
  isPlexusVersion,
  PLX_PIN,
  plxPinOf,
  preflightForge,
  UsageError,
  VERSIONED_REPOS,
} from './version.ts';
