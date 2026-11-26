import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const [binary, parent = tmpdir()] = process.argv.slice(2);
if (!binary) throw new Error('Usage: node tools/stereo-smoke.mjs <Blender executable> [work directory]');
await mkdir(resolve(parent), { recursive: true });
const temp = await mkdtemp(join(resolve(parent), 'frameledger-stereo-'));
const root = join(temp, 'shot');
const file = path => join(root, path);
const source = path => join(repo, path);
function run(program, args, expectedCode = 0) {
  const result = spawnSync(program, args, { cwd: temp, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (result.error) throw result.error;
  const log = result.stdout + '\n' + result.stderr;
  assert.equal(result.status, expectedCode, log.slice(-3000));
  return result.stdout;
}
function blender(scene, script, args) {
  return run(binary, ['--background', '--disable-autoexec', ...(scene ? [scene] : ['--factory-startup']),
    '--threads', '2', '--python-exit-code', '7', '--python', source(script), '--', ...args]);
}
function record(log, prefix) {
  const line = log.split(/\r?\n/).find(item => item.startsWith(prefix + ' '));
  assert.ok(line, 'Missing ' + prefix);
  return JSON.parse(line.slice(prefix.length + 1));
}
blender(null, 'tests/blender/stereo_fixture.py', ['create', root]);
const config = JSON.parse(await readFile(source('examples/stereo-job.json'), 'utf8'));
for (const group of config.outputs) {
  const descriptor = file(group.directory + '.json');
  blender(file(group.directory + '.blend'), 'blender/shot_settings.py', [descriptor]);
  const shot = JSON.parse(await readFile(descriptor, 'utf8'));
  group.origin = shot.origin;
  assert.equal(shot.pattern, group.pattern);
  assert.equal(shot.width, group.width);
}
const plan = file('pair.json');
await writeFile(plan, JSON.stringify(config));
const args = [source('cli.mjs'), file('interrupted'), '--job', plan, '--json'];
const before = JSON.parse(run(process.execPath, args, 1));
assert.equal(before.ready, 5);
assert.deepEqual(before.rerender.map(r => r.first), [3, 5, 7]);
const counts = [];
for (const group of config.outputs) {
  const report = file(group.directory + '-audit.json');
  run(process.execPath, [...args, '--only', group.id, '--output', report], 1);
  const saved = JSON.parse(await readFile(report, 'utf8'));
  assert.deepEqual(saved.origin, group.origin);
  const stage = file('repairs/' + group.directory);
  const applied = record(blender(file(group.directory + '.blend'), 'blender/repair.py', [report, stage]), 'FRAMELEDGER_REPAIR');
  assert.equal(applied.rendered, 2);
  counts.push(applied.rendered);
}
const after = JSON.parse(run(process.execPath, [...args, '--overlay', file('repairs')]));
assert.equal(after.ready, 8);
assert.ok(after.outputs.every(group => group.report.ready === 8 && group.report.ready_from_overlay === 2));
const pixels = record(blender(null, 'tests/blender/stereo_fixture.py', ['compare', root]), 'STEREO_PIXELS');
assert.equal(pixels.matched, 16);
assert.equal(pixels.distinct_pairs, 8);
const summary = { ...pixels, ready_before: before.ready, ready_after: after.ready, distinct_rerender_frames: before.rerender_count,
  images_rendered_by_eye: counts, expected_pairs: 8 };
await writeFile(file('verification.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2), '\n' + root);
