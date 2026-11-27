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

test('render offers the Python string methods templates call', () => {
  assert.equal(
    renderString(`{% for r in s.split(',') %}"{{ r.strip() }}"{% if not loop.last %}, {% endif %}{% endfor %}`, {
      s: 'alice, bob ,carol',
    }),
    '"alice", "bob", "carol"',
  );
  assert.equal(renderString("{{ s.startswith('ab') }} {{ s.startswith('b') }}", { s: 'abc' }), 'True False');
});

test('render keeps a raw block verbatim, with whitespace control on either tag', () => {
  assert.equal(renderString('{% raw %}${{ x }}{% endraw %}', {}), '${{ x }}');
  assert.equal(renderString('a\n{% raw %}${{ x }}\n{%- endraw %}\nb', {}), 'a\n${{ x }}\nb');
  assert.equal(renderString('a {%- raw -%}  ${{ x }}  {%- endraw -%}  b', {}), 'a${{ x }}b');
  assert.equal(
    renderString("{% raw %}${{ vars.S || '{% endraw %}{{ s }}{% raw %}' }}{% endraw %}", { s: 'github' }),
    "${{ vars.S || 'github' }}",
  );
});

test('render carries line endings as they are', () => {
  assert.equal(renderString('a\r\n{{ x }}\r\n', { x: 1 }), 'a\r\n1\r\n');
  assert.equal(renderString('a\rb\r', {}), 'a\rb\r');
});
