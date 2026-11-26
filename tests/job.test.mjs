import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as engine from '../dist/engine.mjs';
import { readJob } from '../app/scan.mjs';

const job = JSON.parse(await readFile('examples/shot.json', 'utf8'));
test('job mode obtains inclusive frames, step and resolution from the portable file', () => {
  const result = spawnSync(process.execPath, ['cli.mjs', 'examples/interrupted', '--job', 'examples/shot.json', '--json'],
    { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.expected_width, 64);
  assert.equal(report.expected, 8);
  assert.equal(report.ready, 5);
});

test('job import validates the version, whole ranges, dimensions and optional scene identity', () => {
  assert.equal(readJob(engine, '\ufeff' + JSON.stringify(job)).step, 1);
  for (const patch of [{ format: 'unknown' }, { last: '8' }, { step: 0 }, { width: -1 },
    { origin: { scene: 'Scene', blend_sha256: 'invalid' } }]) {
    assert.throws(() => readJob(engine, JSON.stringify({ ...job, ...patch })));
  }
});

test('an incomplete audit exports UTF-8 JSON and cannot replace its input job', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'frameledger-job-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const jobPath = join(dir, 'shot.json'), out = join(dir, 'audit.json');
  const original = JSON.stringify(job);
  await writeFile(jobPath, original);
  const args = ['cli.mjs', 'examples/interrupted', '--job', jobPath, '--output'];
  const written = spawnSync(process.execPath, [...args, out], { encoding: 'utf8' });
  assert.equal(written.status, 1, written.stderr);
  const report = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(report.format, 'frameledger.report.v1');
  assert.equal(report.rerender.length, 3);
  const protectedJob = spawnSync(process.execPath, [...args, jobPath], { encoding: 'utf8' });
  assert.equal(protectedJob.status, 2);
  assert.equal(await readFile(jobPath, 'utf8'), original);
});
