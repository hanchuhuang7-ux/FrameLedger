import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import * as engine from '../dist/engine.mjs';

test('equally good copies prefer the primary; a valid copy beats a bad primary', () => {
  const result = JSON.parse(engine.auditCopies(1, 4, 1,
    [1, 1, 2, 2, 3, 3], [0, 0, 1, 0, 2, 1], [1, 0, 0, 1, 0, 1]));
  assert.deepEqual(result.selected, [1, 3, 4]);
  assert.equal(result.report.ready, 2);
  assert.deepEqual(result.report.rerender, [{ first: 3, last: 4 }]);
  assert.ok(JSON.parse(engine.auditCopies(1, 2, 1, [1, 1], [1, 2], [0, 0])).error);
});

test('the CLI audits repaired images in a separate directory without copying them back', async t => {
  const repair = await mkdtemp(join(tmpdir(), 'frameledger-repair-'));
  t.after(() => rm(repair, { recursive: true, force: true }));
  for (const frame of [3, 5, 7]) {
    await copyFile('examples/interrupted/shot_0001.png', join(repair, 'shot_000' + frame + '.png'));
  }
  const run = spawnSync(process.execPath, ['cli.mjs', 'examples/interrupted', 'shot_####.png', '1', '8',
    '--overlay', repair, '--json'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.ready_from_overlay, 3);
  assert.equal(result.extra_copies, 2);
  assert.deepEqual(result.details, []);
});
