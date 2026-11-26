import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as engine from '../dist/engine.mjs';
import { readPlan, scanDelivery } from '../app/scan.mjs';

const planPath = 'examples/stereo-job.json';
const raw = JSON.parse(await readFile(planPath, 'utf8'));
const cli = (root, plan, ...args) => spawnSync(process.execPath,
  ['cli.mjs', root, '--job', plan, '--json', ...args], { encoding: 'utf8' });
const one = frame => ({ first: frame, last: frame });
const pair = (...values) => values.map(one);

test('real stereo delivery deduplicates the same failed frame without substituting eyes', () => {
  const check = cli('examples/delivery', planPath);
  assert.equal(check.status, 1, check.stderr);
  const r = JSON.parse(check.stdout);
  assert.equal(r.format, 'frameledger.delivery-report.v1');
  assert.deepEqual([r.ready, r.expected, r.rerender_count], [5, 8, 3]);
  assert.deepEqual(r.rerender, pair(3, 5, 7));
  assert.deepEqual(r.outputs.map(x => x.report.rerender), [pair(3, 5), pair(5, 7)]);
  assert.deepEqual(r.outputs.map(x => x.report.ready), [6, 6]);
  const left = cli('examples/delivery', planPath, '--only', '左眼');
  assert.equal(left.status, 1);
  assert.deepEqual(JSON.parse(left.stdout), r.outputs[0].report);
  assert.equal(cli('examples/delivery', planPath, '--only', 'absent').status, 2);
});

test('overlays fill only their matching subgroup and missing declared subdirectories are counted', async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'frameledger-delivery-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  await mkdir(join(scratch, 'left'));
  for (const frame of [3, 5]) {
    await copyFile('examples/delivery/left/eye_0001.png', join(scratch, 'left', 'eye_000' + frame + '.png'));
  }
  const merged = JSON.parse(cli('examples/delivery', planPath, '--overlay', scratch).stdout);
  assert.equal(merged.ready, 6);
  assert.deepEqual(merged.rerender, pair(5, 7));
  assert.equal(merged.outputs[0].report.ready_from_overlay, 2);
  assert.equal(merged.outputs[1].report.ready_from_overlay, 0);
  assert.equal(JSON.parse(cli(scratch, planPath).stdout).outputs[1].report.missing_count, 8);
  assert.equal(cli(join(scratch, 'no-root'), planPath).status, 2);
  const exportPath = join(scratch, 'right.json');
  const saved = cli('examples/delivery', planPath, '--only', '右眼', '--output', exportPath);
  assert.deepEqual(JSON.parse(await readFile(exportPath, 'utf8')), JSON.parse(saved.stdout));
});

test('confirmed and uncertain outcomes can belong to different outputs at the same index', async () => {
  const png = await readFile('examples/interrupted/shot_0001.png');
  const tile = await readFile('examples/exr/shot_0004.exr');
  const job = { ...raw, first: 1, last: 2, outputs: [
    { id: 'A', directory: 'a', pattern: 'f#.png' }, { id: 'B', directory: 'b', pattern: 'f#.exr' }] };
  const plan = readPlan(engine, JSON.stringify(job));
  const entry = (name, bytes) => ({ name, size: () => bytes.length, blocks: async function* () { yield bytes; } });
  const r = await scanDelivery(engine, plan, dir => dir === 'a' ? [entry('f2.png', png)] :
    [entry('f1.exr', tile), entry('f2.exr', tile)]);
  assert.equal(r.ready, 0);
  assert.deepEqual(r.rerender, pair(1));
  assert.deepEqual(r.unverified, [{ first: 1, last: 2 }]);
  assert.deepEqual(r.review_only, pair(2));
  assert.deepEqual(r.outputs[1].report.rerender, []);
});

test('invalid grids, ids and nonportable directories are rejected', () => {
  for (const value of ['../escape', '/tmp', 'C:\\renders', '\\\\server\\share', 'a/../b']) {
    assert.throws(() => readPlan(engine, JSON.stringify({ ...raw, outputs: [{ ...raw.outputs[0], directory: value }] })));
  }
  for (const outputs of [[], [raw.outputs[0], raw.outputs[0]], [{ ...raw.outputs[0], step: 8 }]]) {
    assert.throws(() => readPlan(engine, JSON.stringify({ ...raw, outputs })));
  }
});

test('sparse delivery sweep agrees with per-frame enumeration on 350 seeded shots', () => {
  let seed = 18493;
  const rand = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 10) % max; };
  for (let trial = 0; trial < 350; trial++) {
    const first = rand(30) - 17, step = rand(6) + 1, last = first + rand(50), count = 1 + rand(5);
    const faults = new Set(), uncertain = new Set(), outputs = [];
    for (let group = 0; group < count; group++) {
      const ranges = { rerender: [], unverified: [] };
      for (let f = first; f <= last; f += step) {
        const state = rand(7);
        if (state === 0) { faults.add(f); ranges.rerender.push(one(f)); }
        if (state === 1) { uncertain.add(f); ranges.unverified.push(one(f)); }
      }
      outputs.push(ranges);
    }
    const summary = JSON.parse(engine.combineDelivery(first, last, step, JSON.stringify(outputs)));
    const affected = new Set([...faults, ...uncertain]);
    assert.equal(summary.ready, Math.floor((last - first) / step) + 1 - affected.size);
    assert.equal(summary.rerender_count, faults.size);
    assert.equal(summary.unverified_count, uncertain.size);
    assert.equal(summary.review_only_count, affected.size - faults.size);
    for (const [spans, wanted] of [[summary.rerender, faults], [summary.unverified, uncertain],
      [summary.review_only, new Set([...uncertain].filter(f => !faults.has(f)))]]) {
      const observed = [];
      for (const range of spans) for (let f = range.first; f <= range.last; f += step) observed.push(f);
      assert.deepEqual(observed, [...wanted].sort((a, b) => a - b));
    }
  }
});
