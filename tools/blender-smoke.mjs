import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const [binary, parent = tmpdir(), format = 'png'] = process.argv.slice(2);
if (!binary || !['png', 'exr'].includes(format)) {
  throw new Error('Usage: node tools/blender-smoke.mjs <Blender executable> [work directory] [png|exr]');
}
const extension = '.' + format;
await mkdir(resolve(parent), { recursive: true });
const root = await mkdtemp(join(resolve(parent), 'frameledger-smoke-'));
const here = name => join(root, name);
const source = name => join(repo, name);
const scene = here('shot.blend'), fixture = source('tests/blender/fixture.py');
const base = ['--background', '--disable-autoexec'];
const py = ['--threads', '2', '--python-exit-code', '7', '--python'];

function run(program, args, code = 0) {
  const result = spawnSync(program, args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (result.error) throw result.error;
  const log = result.stdout + '\n' + result.stderr;
  assert.equal(result.status, code, log.slice(-3000));
  return log;
}

function record(log, marker) {
  const line = log.split(/\r?\n/).find(entry => entry.startsWith(marker + ' '));
  assert.ok(line, 'Missing ' + marker + '\n' + log.slice(-800));
  return JSON.parse(line.slice(marker.length + 1));
}

function interruptAfterNinthFrame() {
  return new Promise((accept, reject) => {
    const child = spawn(binary, [...base, scene, ...py, fixture, '--', 'interrupt', root], {
      cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let checkpoint = false, timedOut = false, log = '';
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 40000);
    const collect = block => {
      log = (log + block.toString()).slice(-20000);
      if (!checkpoint && log.includes('FRAMELEDGER_CHECKPOINT 1017')) {
        checkpoint = true;
        child.kill('SIGKILL');
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (checkpoint && !timedOut && (signal || code !== 0)) accept();
      else reject(new Error('The interruption was not observed.\n' + log.slice(-2000)));
    });
  });
}

const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
async function snapshot(directory) {
  const files = (await readdir(directory)).filter(name => name.endsWith(extension)).sort();
  return Promise.all(files.map(async name => [name, await digest(join(directory, name))]));
}

// Compare published files with an ordinary sibling created by the same process.
// Windows' native ACL export is UTF-16LE and contains name / SDDL pairs.
async function checkWindowsOutputAccess(directory, targets, label) {
  const probe = join(directory, '.frameledger-access-probe');
  await writeFile(probe, '', { flag: 'wx' });
  try {
    const dump = here('access-' + label + '.txt');
    run('icacls.exe', [join(directory, '*'), '/save', dump, '/Q']);
    const lines = (await readFile(dump)).toString('utf16le').replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/);
    const rules = new Map();
    for (let i = 0; i + 1 < lines.length; i += 2) rules.set(basename(lines[i]), lines[i + 1]);
    const standard = rules.get(basename(probe));
    assert.ok(standard, 'Missing inherited ACL for access probe');
    for (const name of targets) assert.equal(rules.get(name), standard, 'Directory inheritance: ' + name);
  } finally { await unlink(probe); }
}

const settings = here('shot.json'), beforePath = here('before.json'), stage = here('repaired');
run(binary, [...base, '--factory-startup', ...py, fixture, '--', 'create', root, format]);
const sceneHash = await digest(scene);
run(binary, [...base, scene, ...py, source('blender/shot_settings.py'), '--', settings]);
await interruptAfterNinthFrame();
const original = here('original');
const beforeHashes = await snapshot(original);
assert.equal(beforeHashes.length, 9);
const audit = [source('cli.mjs'), original, '--job', settings];
run(process.execPath, [...audit, '--output', beforePath], 1);
const before = JSON.parse(await readFile(beforePath, 'utf8'));
assert.equal(before.ready, 9);
assert.equal(before.expected, 31);
assert.deepEqual(before.rerender, [{ first: 1019, last: 1061 }]);
const repair = [...base, scene, ...py, source('blender/repair.py'), '--'];
let reviewWithheld = null;
if (format === 'exr') {
  assert.equal(before.exr_checked, 9);
  assert.equal(before.expected_width, 96);
  const samples = here('supplement'), heldStage = here('partially-reviewed');
  await mkdir(samples);
  const name = frame => 'sh010_v2_' + frame + '_beauty.exr';
  const good = await readFile(join(original, name(1017)));
  await writeFile(join(samples, name(1019)), good.subarray(0, -17));
  await copyFile(source('examples/exr/shot_0004.exr'), join(samples, name(1021)));
  const mixed = here('mixed.json');
  run(process.execPath, [...audit, '--overlay', samples, '--output', mixed], 1);
  const assessed = JSON.parse(await readFile(mixed, 'utf8'));
  assert.equal(assessed.format, 'frameledger.report.v2');
  assert.deepEqual([assessed.damaged_count, assessed.missing_count, assessed.unverified_count], [1, 20, 1]);
  const held = record(run(binary, [...repair, mixed, heldStage]), 'FRAMELEDGER_REPAIR');
  assert.equal(held.unverified, 1);
  assert.equal(held.rendered, 21);
  assert.ok(!(await readdir(heldStage)).includes(name(1021)));
  reviewWithheld = 1021;
  const legacy = here('legacy-report.json');
  await writeFile(legacy, JSON.stringify({ ...before, expected_width: null, expected_height: null }));
  assert.equal(record(run(binary, [...repair, legacy, stage, '--dry-run']), 'FRAMELEDGER_REPAIR').planned, 22);
}
const apply = (...flags) => record(run(binary, [...repair, beforePath, stage, ...flags]), 'FRAMELEDGER_REPAIR');
assert.equal(apply('--dry-run').rendered, 0);
const recovered = apply();
assert.equal(recovered.rendered, 22);
if (process.platform === 'win32') {
  const receiptDir = join(stage, '.frameledger-receipts');
  await checkWindowsOutputAccess(stage, (await readdir(stage)).filter(n => n.endsWith(extension) || n.endsWith('.json')), 'frames');
  await checkWindowsOutputAccess(receiptDir, await readdir(receiptDir), 'receipts');
}
const retry = apply();
assert.equal(retry.retained, 22);
assert.equal(retry.rendered, 0);
const final = JSON.parse(run(process.execPath, [...audit, '--overlay', stage, '--json']));
assert.equal(final.ready, 31);
assert.equal(final.ready_from_overlay, 22);
assert.deepEqual(final.rerender, []);
assert.deepEqual(await snapshot(original), beforeHashes);
assert.equal(await digest(scene), sceneHash);

const invalid = { ...before, origin: { ...before.origin, blend_sha256: '0'.repeat(64) } };
await writeFile(here('invalid.json'), JSON.stringify(invalid));
assert.match(run(binary, [...repair, here('invalid.json'), stage, '--dry-run'], 7), /saved Blender scene/);
await writeFile(here('invalid.json'), JSON.stringify({ ...before, rerender: [] }));
assert.match(run(binary, [...repair, here('invalid.json'), stage, '--dry-run'], 7), /disagree/);
assert.match(run(binary, [...repair, beforePath, original], 7), /separate/);
await mkdir(here('reference'));
run(binary, [...base, scene, '--threads', '2', '-o', here('reference/sh010_v2_###_beauty'), '-a']);
const pixels = record(run(binary, [...base, scene, ...py, fixture, '--', 'compare', root, format]), 'FRAMELEDGER_PIXELS');
assert.equal(pixels.frames, 31);
assert.deepEqual(pixels.mismatches, []);
assert.ok(pixels.different_images >= 20, 'The reference scene must have visibly distinct frames.');
if (format === 'exr') {
  assert.equal(pixels.channels_per_frame, 8);
  assert.equal(pixels.part_names.length, 3);
}
const summary = { blender: pixels.blender, format, expected: final.expected, ready_at_interruption: before.ready,
  first_missing: before.rerender[0].first, last_missing: before.rerender[0].last, step: before.step,
  repaired: recovered.rendered, retained_on_retry: retry.retained, ready_after: final.ready,
  primary_sha256_unchanged: beforeHashes.length, scene_sha256_unchanged: true,
  pixel_identical_to_uninterrupted: pixels.frames, distinct_reference_images: pixels.different_images,
  windows_directory_access_verified: process.platform === 'win32' ? true : null,
  ...(format === 'exr' ? { channels_per_frame: pixels.channels_per_frame, part_names: pixels.part_names,
    frame_channel_comparisons: pixels.frames * pixels.channels_per_frame, unverified_frame_withheld: reviewWithheld } : {}) };
await writeFile(here('verification.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2), '\n' + root);
