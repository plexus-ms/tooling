import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ExecError, orAbsent, realIo, TimeoutError } from './io.ts';

const TMP = mkdtempSync(join(tmpdir(), 'plx-io-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Until `done` holds, or two seconds have gone by. */
async function until(done: () => boolean): Promise<boolean> {
  for (let i = 0; i < 40 && !done(); i++) await new Promise((r) => setTimeout(r, 50));
  return done();
}

const exit = (code: number, stderr: string) => Promise.reject(new ExecError('tool', code, stderr));

test('orAbsent: an exit it accepts is undefined, any other failure stays an error', async () => {
  assert.equal(await orAbsent(Promise.resolve('out')), 'out');
  assert.equal(await orAbsent(exit(1, 'no such path')), undefined);
  const notFound = (e: ExecError) => /404/.test(e.stderr);
  assert.equal(await orAbsent(exit(22, 'error: 404'), notFound), undefined);
  await assert.rejects(orAbsent(exit(22, 'error: 401'), notFound), /401/);
  await assert.rejects(orAbsent(Promise.reject(new Error('spawn tool ENOENT'))), /ENOENT/);
});

test('a process past its time limit is killed with everything it started, and the exec says so', async () => {
  const pidFile = join(TMP, 'sleeper');
  const started = Date.now();
  await assert.rejects(
    realIo().exec('sh', ['-c', `sleep 30 & echo $! > ${pidFile}; wait`], { timeout: 300 }),
    (e: Error) => {
      assert.ok(e instanceof TimeoutError && e instanceof ExecError);
      assert.match(e.message, /did not finish within 300 ms and was killed/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 5000, 'it did not wait for the sleep');
  const sleeper = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(await until(() => !alive(sleeper)), 'the process it started in the background is gone too');
});

test('SIGTERM runs what onInterrupt registered, kills a time-limited process group, and still ends the process', async () => {
  const scratch = join(TMP, 'scratch');
  mkdirSync(scratch);
  const pidFile = join(TMP, 'interrupted-sleeper');
  const io = new URL('./io.ts', import.meta.url).pathname;
  const script = `
    import { rmSync } from 'node:fs';
    import { onInterrupt, realIo } from ${JSON.stringify(io)};
    onInterrupt(() => rmSync(${JSON.stringify(scratch)}, { recursive: true, force: true }));
    realIo().exec('sh', ['-c', 'sleep 30 & echo $! > ${pidFile}; wait'], { timeout: 60000 }).catch(() => {});
    console.log('ready');
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((ready) => child.stdout.once('data', () => ready()));
  assert.ok(await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== ''));
  const sleeper = Number(readFileSync(pidFile, 'utf8'));
  const ended = new Promise<NodeJS.Signals | null>((r) => child.on('exit', (_code, signal) => r(signal)));
  child.kill('SIGTERM');
  assert.equal(await ended, 'SIGTERM', 'the process ends by the signal, as it would have without');
  assert.ok(!existsSync(scratch), 'the cleanup ran');
  assert.ok(await until(() => !alive(sleeper)), 'the time-limited process group is killed');
});
