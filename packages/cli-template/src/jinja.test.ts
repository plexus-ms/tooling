import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderString } from './jinja.ts';

test('render fills in the context and keeps every trailing newline', () => {
  assert.equal(renderString('Hello {{ name }}!\n', { name: 'World' }), 'Hello World!\n');
  assert.equal(renderString('a\n\n', {}), 'a\n\n');
  assert.equal(renderString('', {}), '');
});

test('render escapes nothing', () => {
  assert.equal(renderString('{{ s }}', { s: `<a href="x">&'</a>` }), `<a href="x">&'</a>`);
});

test('render prints booleans, none, lists and maps as Jinja does', () => {
  assert.equal(
    renderString('{{ t }} {{ f }} {{ n }} {{ l }} {{ m }}', { t: true, f: false, n: null, l: [1, 'a'], m: { a: 1 } }),
    "True False None [1, 'a'] {'a': 1}",
  );
});

test('render fails on a variable the context lacks, naming the line', () => {
  assert.throws(() => renderString('a\n{{ missing }}', {}), /undefined value.*:2\)/);
  assert.throws(() => renderString('{% if missing %}x{% endif %}', {}), /undefined value/);
});

test('render lets a template ask whether a variable is defined, or give it a default', () => {
  assert.equal(renderString("{{ 'y' if missing is defined else 'n' }}", {}), 'n');
  assert.equal(renderString("[{{ missing | default('') }}] {{ missing | default('d') }}", {}), '[] d');
  assert.equal(renderString("{{ empty | default('d') }} {{ empty | default('d', true) }}", { empty: '' }), ' d');
});
