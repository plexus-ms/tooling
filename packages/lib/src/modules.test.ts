import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

// A module that imports one that imports it back works only while neither
// touches the other at load time; the lib keeps its imports a tree.

const here = new URL('.', import.meta.url);

/** Each module of the lib (tests and test helpers aside) with the lib modules it imports. */
function importGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const file of readdirSync(here).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
    const text = readFileSync(new URL(file, here), 'utf8');
    graph.set(
      file,
      [...text.matchAll(/^(?:import|export)\b[^;]*?\bfrom '\.\/([\w.]+\.ts)'/gms)].map((m) => m[1] ?? ''),
    );
  }
  return graph;
}

test('no module of the lib imports itself through another', () => {
  const graph = importGraph();
  const cycles: string[] = [];
  const visit = (file: string, path: string[]) => {
    if (path.includes(file)) {
      cycles.push([...path.slice(path.indexOf(file)), file].join(' → '));
      return;
    }
    for (const next of graph.get(file) ?? []) visit(next, [...path, file]);
  };
  for (const file of graph.keys()) visit(file, []);
  assert.deepEqual([...new Set(cycles)], []);
});
