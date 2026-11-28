// The template engine, loaded on first use. `@plexus-ms/cli-template` carries a
// wasm template library that it reads by a path relative to its own file, so a
// program that bundles lib keeps the engine out of its bundle and loads it from
// its installation, and a program that never renders (plx-ci) neither bundles
// nor needs it: nothing here is imported until a verb that renders asks.
// Everything else in lib imports the engine's types only, and its values through
// this function.
export const engine = () => import('@plexus-ms/cli-template');
