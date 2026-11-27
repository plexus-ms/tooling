// The spec ring's harness: fixture templates and trees as small object
// literals, and a listing of a tree that `assert.deepEqual` compares, so that
// each test stays one call of `render` or `merge`. Not shipped (excluded in
// tsconfig).
//
// A listing maps each path to its text when the entry is a file of mode 0o644
// whose bytes are UTF-8; any other entry is spelled out with its mode, and with
// its bytes as numbers where they are not UTF-8.
import { REGULAR, type Tree } from '../index.ts';
import { FILES, MANIFEST } from '../manifest.ts';

export type Listed =
  | string
  | { readonly text: string; readonly mode: number }
  | { readonly bytes: readonly number[]; readonly mode: number };

export type Listing = Readonly<Record<string, Listed>>;

const FILE = REGULAR | 0o644;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** A tree from its listing. */
export function tree(listing: Listing): Tree {
  return new Map(
    Object.entries(listing).map(([path, listed]) => {
      if (typeof listed === 'string') return [path, { bytes: new TextEncoder().encode(listed), mode: FILE }];
      const bytes = 'text' in listed ? new TextEncoder().encode(listed.text) : Uint8Array.from(listed.bytes);
      return [path, { bytes, mode: listed.mode }];
    }),
  );
}

/** A template: its manifest, and `files` below the files directory. */
export function template(manifest: string, files: Listing = {}): Tree {
  return tree({
    [MANIFEST]: manifest,
    ...Object.fromEntries(Object.entries(files).map(([path, listed]) => [`${FILES}${path}`, listed])),
  });
}

/** The listing of a tree. */
export function listing(tree: Tree): Listing {
  return Object.fromEntries(
    [...tree].map(([path, { bytes, mode }]) => {
      let text: string;
      try {
        text = utf8.decode(bytes);
      } catch {
        return [path, { bytes: [...bytes], mode }];
      }
      return [path, mode === FILE ? text : { text, mode }];
    }),
  );
}
