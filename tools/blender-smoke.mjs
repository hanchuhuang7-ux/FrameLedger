import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const [binary, parent = tmpdir()] = process.argv.slice(2);
if (!binary) throw new Error('Usage: node tools/blender-smoke.mjs <Blender executable> [work directory]');
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
  const files = (await readdir(directory)).filter(name => name.endsWith('.png')).sort();
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
run(binary, [...base, '--factory-startup', ...py, fixture, '--', 'create', root]);
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
const apply = (...flags) => record(run(binary, [...repair, beforePath, stage, ...flags]), 'FRAMELEDGER_REPAIR');
assert.equal(apply('--dry-run').rendered, 0);
const recovered = apply();
assert.equal(recovered.rendered, 22);
if (process.platform === 'win32') {
  const receiptDir = join(stage, '.frameledger-receipts');
  await checkWindowsOutputAccess(stage, (await readdir(stage)).filter(n => n.endsWith('.png') || n.endsWith('.json')), 'frames');
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
const pixels = record(run(binary, [...base, scene, ...py, fixture, '--', 'compare', root]), 'FRAMELEDGER_PIXELS');
assert.equal(pixels.frames, 31);
assert.deepEqual(pixels.mismatches, []);
assert.ok(pixels.different_images >= 20, 'The reference scene must have visibly distinct frames.');
const summary = { blender: pixels.blender, expected: final.expected, ready_at_interruption: before.ready,
  first_missing: before.rerender[0].first, last_missing: before.rerender[0].last, step: before.step,
  repaired: recovered.rendered, retained_on_retry: retry.retained, ready_after: final.ready,
  primary_sha256_unchanged: beforeHashes.length, scene_sha256_unchanged: true,
  pixel_identical_to_uninterrupted: pixels.frames, distinct_reference_images: pixels.different_images,
  windows_directory_access_verified: process.platform === 'win32' ? true : null };
await writeFile(here('verification.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2), '\n' + root);
