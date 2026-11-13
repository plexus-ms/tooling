// The module manifest: what a version is, as data, for a repo that has no
// compendium checkout. `plx-dev ship` builds it from the compendium once the version's
// `changed` stamps are written and attaches it to the compendium's release of
// the version as `modules.json`; tenant tooling reads it from there.
//
// It carries the version's number and date and the module catalogue (catalog.ts)
// as the compendium's pages declare it at that version. `changed` is cumulative,
// so the newest version's manifest alone answers "has a module I declare changed
// since my marker" (§ 1.4 PLX); the dates of the versions in between are the
// forge's release list. A manifest read back is the same catalogue
// `readCatalog` builds from the checkout it was written from.
import type { Catalog, Module } from './catalog.ts';
import { isPlexusVersion } from './version.ts';

/** The name of the asset on the compendium's release. */
export const MANIFEST_FILE = 'modules.json';
/** The version of the manifest's own shape; a reader refuses one it does not know. */
export const MANIFEST_SCHEMA = 1;

export interface ModuleManifest {
  schema: typeof MANIFEST_SCHEMA;
  version: string;
  /** The day the version was cut, `YYYY-MM-DD`. */
  date: string;
  /** The module catalogue at this version, by code. */
  modules: Module[];
}

export function buildManifest(catalog: Catalog, version: string, date: string): ModuleManifest {
  const modules = [...catalog.values()].sort((a, b) => a.code.localeCompare(b.code));
  return { schema: MANIFEST_SCHEMA, version, date, modules };
}

export const renderManifest = (manifest: ModuleManifest): string => `${JSON.stringify(manifest, null, 2)}\n`;

/** The catalogue a manifest carries, as `readCatalog` would have built it. */
export const catalogOf = (manifest: ModuleManifest): Catalog => new Map(manifest.modules.map((m) => [m.code, m]));

const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string');

/** A manifest from its text; anything that is not one is refused with what is wrong. */
export function parseManifest(text: string): ModuleManifest {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('the module manifest is not JSON');
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data))
    throw new Error('the module manifest is not an object');
  const { schema, version, date, modules } = data as Record<string, unknown>;
  if (schema !== MANIFEST_SCHEMA)
    throw new Error(`the module manifest has schema ${JSON.stringify(schema)}; this plx reads ${MANIFEST_SCHEMA}`);
  if (typeof version !== 'string' || !isPlexusVersion(version))
    throw new Error(`the module manifest names '${String(version)}', not a version`);
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new Error(`the module manifest is dated '${String(date)}', not YYYY-MM-DD`);
  if (!Array.isArray(modules)) throw new Error('the module manifest lists no modules');
  return { schema: MANIFEST_SCHEMA, version, date, modules: modules.map(parseEntry) };
}

function parseEntry(entry: unknown): Module {
  const m = (entry ?? {}) as Record<string, unknown>;
  const where = `the module manifest's module ${typeof m.code === 'string' ? m.code : JSON.stringify(entry)}`;
  if (typeof m.code !== 'string' || m.code === '') throw new Error(`${where} has no code`);
  if (m.kind !== 'contract' && m.kind !== 'approach') throw new Error(`${where} is neither contract nor approach`);
  if (typeof m.maturity !== 'string' || typeof m.binds !== 'string')
    throw new Error(`${where} lacks maturity or binds`);
  if (!strings(m.depends) || !strings(m.consumes)) throw new Error(`${where} lacks depends or consumes`);
  if (m.changed !== undefined && typeof m.changed !== 'string')
    throw new Error(`${where} has a changed that is no version`);
  return {
    code: m.code,
    kind: m.kind,
    maturity: m.maturity,
    binds: m.binds,
    changed: m.changed,
    depends: m.depends,
    consumes: m.consumes,
  };
}
