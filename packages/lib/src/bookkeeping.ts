// What a repo taking a version writes besides copier's update: the workflow
// refs moved to the version. Pure functions from a file's text to its new
// text; the marker carries no version (§ 1.4 PLX) and is the repo's own: the
// templates render it at birth only, and an update leaves it out. The
// bookkeeping of cutting a version, every other pin the version owns, lives
// in `@plexus-ms/dev`.
export const WORKFLOW_REF = 'plexus-ms/tooling/.github/workflows/';

/** Every `uses: plexus-ms/tooling/.github/workflows/<file>@<ref>` pinned to the version. */
export const bumpWorkflowRefs = (text: string, version: string): string =>
  text.replace(/(plexus-ms\/tooling\/\.github\/workflows\/[A-Za-z0-9._-]+)@v?[0-9.]+/g, `$1@${version}`);
