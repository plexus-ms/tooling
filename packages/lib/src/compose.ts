// The one reader of an app's compose file (§ 2 PLX-App), for every verb that
// looks into one: the deploy verb reads the app service's healthcheck from it
// before it reaches a host, and doctor runs the compose checks of PLX-App
// over it. It reads what compose would read as far as plain YAML goes:
// anchors and merge keys resolve, `extends` and `include` are not followed,
// and `${…}` interpolation is left as written.
import { parse } from 'yaml';
import { UsageError } from './version.ts';

/** A YAML mapping, every key of which may be absent or of any type. */
export type Mapping = Record<string, unknown>;

export interface Compose {
  /** The services by name; an entry that is not a mapping is left out. */
  services: Record<string, Mapping>;
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
  const services: Record<string, Mapping> = {};
  for (const [name, service] of Object.entries(declared)) if (isMapping(service)) services[name] = service;
  return { services };
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
