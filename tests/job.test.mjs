import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
