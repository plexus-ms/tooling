#!/usr/bin/env node
// Entry point of `plx-template`: everything is in cli.ts, which is importable
// without a process; this file only turns its result into the exit code.
import { main } from './cli.ts';

process.exitCode = await main(process.argv.slice(2));
