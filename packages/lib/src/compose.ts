// The one reader of an app's compose file (§ 2 PLX-App), for every verb that
// looks into one: the deploy verb reads the app service's healthcheck from it
// before it reaches a host, and doctor runs the compose checks of PLX-App
// over it. It reads what compose would read as far as plain YAML goes, with
// anchors and merge keys resolved, and `${…}` interpolation left as written.
// A service that `extends` another service of the same file is read merged
// with it, through a chain of such services (`resolveExtends`); services that
// extend each other in a cycle are an error naming them, as compose refuses
// them. Not read: the files an `include` names, whose presence is recorded so
// that a reader can say what it did not read, and a service an `extends`
// takes from another file (`file:`), where the chain stops and the service is
// read as written. Where the merge differs from compose's: a list both sides
// give is de-duplicated by value as written, where compose first normalizes
// it (so `.env` and `./.env` are two entries to both, while `"3000"` and
// `3000` are one port to both), and volumes and devices are not merged by
// their target in the container, as compose merges them.
import { parse } from 'yaml';
import { UsageError } from './version.ts';

/** A YAML mapping, every key of which may be absent or of any type. */
export type Mapping = Record<string, unknown>;

export interface Compose {
  /** The services by name, same-file `extends` merged in; an entry that is not a mapping is left out. */
  services: Record<string, Mapping>;
  /** The file has a top-level `include`, whose files are not read. */
  includes?: true;
}

/**
 * The app service: the one the deploy verb reads the live image and the
 * health status from (§ 6 PLX-Delivery), named `web` by convention.
 */
export const APP_SERVICE = 'web';

export const isMapping = (value: unknown): value is Mapping =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * A compose file from its text. A file that is not YAML compose could read
 * (duplicate keys among them) is a usage error naming the file.
 */
export function parseCompose(text: string, path: string): Compose {
  let doc: unknown;
  try {
    doc = parse(text, { merge: true });
  } catch (error) {
    throw new UsageError(`${path}: not valid YAML: ${(error as Error).message.split('\n')[0]?.replace(/:$/, '')}`);
  }
  const declared = isMapping(doc) && isMapping(doc.services) ? doc.services : {};
  const written: Record<string, Mapping> = {};
  for (const [name, service] of Object.entries(declared)) if (isMapping(service)) written[name] = service;
  const services = resolveExtends(written, path);
  return { services, ...(isMapping(doc) && doc.include != null ? { includes: true as const } : {}) };
}

/**
 * The deploy verb's placeholder for the image ref (§ 3 PLX-App), in any
 * spelling `${PLEXUS_DEPLOYMENT_IMAGE…}`: the verb pins every one of them to
 * the same ref, so two spellings name the same image.
 */
export const IMAGE_PLACEHOLDER = /\$\{PLEXUS_DEPLOYMENT_IMAGE(:[^}]*)?\}/g;

/** An image as the deploy verb will run it: every spelling of the placeholder as one. */
export const normalImage = (image: string): string => image.replace(IMAGE_PLACEHOLDER, '${PLEXUS_DEPLOYMENT_IMAGE}');

/** Lists compose concatenates when a service extends another, dropping duplicates; any other list of the service replaces the base's. */
const CONCATENATED = new Set([
  'ports',
  'expose',
  'env_file',
  'volumes',
  'devices',
  'dns',
  'secrets',
  'configs',
  'tmpfs',
]);

/** The service of this file a service extends, if it names one: `extends: <name>` or `{ service: <name> }` without `file:`. */
function baseOf(service: Mapping): string | undefined {
  const ext = service.extends;
  const ref = isMapping(ext) ? (ext.file == null ? ext.service : undefined) : ext;
  return typeof ref === 'string' ? ref : undefined;
}

/** A list entry's identity for de-duplication: a scalar by its text, a mapping or list by its whole value. */
const identity = (value: unknown): string =>
  value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);

/** Two lists concatenated, an entry equal to an earlier one dropped. */
function union(base: unknown[], own: unknown[]): unknown[] {
  const seen = new Set<string>();
  return [...base, ...own].filter((entry) => {
    const id = identity(entry);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * Every service merged with the services of the same file it `extends`,
 * through the whole chain, as compose merges them: the service's own keys
 * over its base's (itself merged first); a mapping on both sides (labels in
 * either spelling, healthcheck, environment) merged key by key; ports, env
 * files and the like concatenated without duplicates. An `extends` naming
 * another file, or no service of this file, ends the chain: that service is
 * read as written. A cycle is a usage error naming the services in it.
 */
function resolveExtends(written: Record<string, Mapping>, path: string): Record<string, Mapping> {
  const resolved: Record<string, Mapping> = {};
  const chain: string[] = [];
  const resolve = (name: string): Mapping => {
    const done = resolved[name];
    if (done) return done;
    const service = written[name] ?? {};
    const at = chain.indexOf(name);
    if (at >= 0)
      throw new UsageError(`${path}: services extend each other in a cycle: ${[...chain.slice(at), name].join(' → ')}`);
    const ref = baseOf(service);
    let merged = service;
    if (ref !== undefined && written[ref]) {
      chain.push(name);
      merged = merge(resolve(ref), service);
      chain.pop();
    }
    resolved[name] = merged;
    return merged;
  };
  for (const name of Object.keys(written)) resolve(name);
  return resolved;
}

/** A service over its (resolved) base, as compose merges one level. */
function merge(base: Mapping, service: Mapping): Mapping {
  const { extends: _own, ...own } = service;
  const { extends: _inherited, ...inherited } = base;
  const merged: Mapping = { ...inherited };
  for (const [key, value] of Object.entries(own)) {
    const from = merged[key];
    if (key === 'labels' && from !== undefined) merged[key] = { ...labelsOf(base), ...labelsOf(service) };
    else if (isMapping(from) && isMapping(value)) merged[key] = { ...from, ...value };
    else if (CONCATENATED.has(key) && Array.isArray(from) && Array.isArray(value)) merged[key] = union(from, value);
    else merged[key] = value;
  }
  return merged;
}

/** The app service's healthcheck as the file spells it, if it declares one that is a mapping. */
export function healthcheckOf(compose: Compose): Mapping | undefined {
  const check = compose.services[APP_SERVICE]?.healthcheck;
  return isMapping(check) ? check : undefined;
}

/** Compose's truthy spellings of a boolean, any case, quoted or not: `true`, `yes`, `y`, `on`. */
export const truthy = (value: unknown): boolean =>
  value === true || (typeof value === 'string' && ['true', 'yes', 'y', 'on'].includes(value.toLowerCase()));

/**
 * Whether the healthcheck can ever report healthy (`PLX-App/Healthcheck`):
 * a `test` of its own, a non-empty string or a non-empty list whose first
 * word is not NONE, and not disabled. The deploy waits on it, so anything
 * else cannot be deployed; one that inherits the image's test does not count.
 */
export function declaresHealthcheck(check: Mapping | undefined): check is Mapping {
  if (check === undefined || truthy(check.disable)) return false;
  const { test } = check;
  if (typeof test === 'string') return test.trim() !== '';
  return Array.isArray(test) && test.length > 0 && test[0] !== 'NONE';
}

/** A service's labels, from either spelling compose accepts: a mapping, or a list of `key=value`. */
export function labelsOf(service: Mapping): Record<string, string> {
  const { labels } = service;
  if (isMapping(labels))
    return Object.fromEntries(Object.entries(labels).map(([k, v]) => [k, v == null ? '' : String(v)]));
  if (!Array.isArray(labels)) return {};
  return Object.fromEntries(
    labels.map(String).map((l) => {
      const at = l.indexOf('=');
      return at < 0 ? [l, ''] : [l.slice(0, at), l.slice(at + 1)];
    }),
  );
}
