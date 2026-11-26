import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as engine from '../dist/engine.mjs';
import { scanSequence } from '../app/scan.mjs';
import { filesIn } from '../app/directory.mjs';

const files = await Promise.all([1, 2, 3, 4].map(n => readFile('examples/exr/shot_000' + n + '.exr')));
const [flat, multipart, cut, tile] = files;
function verdict(data, width = 43, height = 37, stride = 131072) {
  const feed = engine.newExrProbe(width, height);
  for (let at = 0; at < data.length; at += stride) {
    const result = feed(data.subarray(at, at + stride), false);
    if (result) return JSON.parse(result);
  }
  const result = feed(new Uint8Array(), true);
  return result ? JSON.parse(result) : { state: 0 };
}

// Locate fields in these known-good fixtures independently of the audited parser.
function header(data, offset = 8) {
  const fields = new Map();
  while (data[offset]) {
    const nameEnd = data.indexOf(0, offset);
    const name = data.toString('ascii', offset, nameEnd);
    const typeEnd = data.indexOf(0, nameEnd + 1);
    const size = data.readInt32LE(typeEnd + 1);
    fields.set(name, { type: nameEnd + 1, size: typeEnd + 1, data: typeEnd + 5 });
    offset = typeEnd + 5 + size;
  }
  return { fields, end: offset + 1 };
}

const one = header(flat);
test('Blender flat and three-part EXR pass across a variety of slice sizes', () => {
  for (const bytes of [flat, multipart]) {
    for (const stride of [1, 3, 7, 8, 12, 127, 4096]) assert.equal(verdict(bytes, 43, 37, stride).state, 0);
  }
  assert.match(verdict(multipart, 44, 37).reason, /43×37.*44×37/);
});

test('every proper prefix of the complete flat sample is incomplete', () => {
  for (let n = 0; n < flat.length; n++) assert.equal(verdict(flat.subarray(0, n)).state, 2, 'prefix ' + n);
  assert.equal(verdict(cut).state, 2);
});

test('bad required attribute types, negative field sizes, pixel types and sample strides are rejected', () => {
  const chan = one.fields.get('channels').data;
  const record = flat.indexOf(0, chan) + 1;
  for (const [at, update] of [
    [one.fields.get('dataWindow').type, b => b.writeUInt8(88, 0)],
    [one.fields.get('dataWindow').size, b => b.writeInt32LE(-1, 0)],
    [record, b => b.writeInt32LE(9, 0)],
    [record + 8, b => b.writeInt32LE(0, 0)],
    [one.fields.get('pixelAspectRatio').data, b => b.writeFloatLE(NaN, 0)],
  ]) {
    const changed = Buffer.from(flat);
    update(changed.subarray(at));
    assert.equal(verdict(changed).state, 2);
  }
});

test('offsets are checked as 64-bit positions against the table and chunk extents', () => {
  const table = one.end;
  const first = Number(flat.readBigUInt64LE(table));
  for (const edit of [
    b => b.writeBigUInt64LE(0n, table),
    b => b.writeBigUInt64LE(12n, table),
    b => b.writeBigUInt64LE(0x100000080n, table),
    b => b.writeBigUInt64LE(BigInt(first), table + 8),
    b => b.writeInt32LE(999, first),
    b => b.writeInt32LE(-1, first + 4),
    b => b.writeInt32LE(100000, first + 4),
  ]) {
    const changed = Buffer.from(flat); edit(changed);
    assert.equal(verdict(changed).state, 2);
  }
});

test('a block belonging to the wrong EXR part is identified', () => {
  const a = header(multipart), b = header(multipart, a.end), c = header(multipart, b.end);
  assert.equal(multipart[c.end], 0);
  const changed = Buffer.from(multipart);
  const first = Number(changed.readBigUInt64LE(c.end + 1));
  assert.equal(changed.readInt32LE(first), 0);
  changed.writeInt32LE(2, first);
  assert.match(verdict(changed).reason, /分部编号/);
});

test('a same-size beauty file cannot satisfy a depth-and-normal delivery contract', async () => {
  const settings = { pattern: 's#.exr', first: 1, last: 2, step: 1, checkPng: true,
    width: 43, height: 37, exrChannels: ['ViewLayer.Depth.Z', 'ViewLayer.Normal.X'] };
  const entries = [flat, multipart].map((data, i) => ({ name: 's' + (i + 1) + '.exr',
    size: () => data.length, blocks: async function* () { yield data; } }));
  const result = await scanSequence(engine, entries, settings);
  assert.equal(result.format, 'frameledger.report.v2');
  assert.equal(result.ready, 1);
  assert.deepEqual(result.damaged, [{ first: 1, last: 1 }]);
  assert.match(result.details[0].reason, /缺少约定通道.*Depth\.Z/);
  assert.deepEqual(result.required_exr_channels, settings.exrChannels);
  const cli = spawnSync(process.execPath, ['cli.mjs', 'examples/exr', 'shot_####.exr', '1', '2',
    '--require-channel', 'ViewLayer.Depth.Z', '--json'], { encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.equal(JSON.parse(cli.stdout).ready, 1);
  await assert.rejects(scanSequence(engine, [], { ...settings, checkPng: false }), /通道/);
});

test('unknown codecs and supported-looking oversized attributes are explicitly unverified', () => {
  const codec = Buffer.from(flat);
  codec[one.fields.get('compression').data] = 250;
  assert.equal(verdict(codec).state, 3);
  const name = Buffer.from(flat);
  name.writeInt32LE(17 * 1024 * 1024, one.fields.get('channels').size);
  assert.equal(verdict(name).state, 3);
  assert.match(verdict(tile).reason, /tiled/);
});

test('review is independent of rerender, and an acceptable overlay resolves it', async () => {
  const options = { pattern: 's#.exr', first: 1, last: 3, step: 1, checkPng: true };
  const entry = (frame, bytes, source = 0) => ({ name: 's' + frame + '.exr', source,
    size: () => bytes.length, blocks: async function* () { yield bytes; } });
  const base = [entry(1, tile), entry(2, cut), entry(2, tile, 1)];
  const a = await scanSequence(engine, base, options);
  assert.equal(a.format, 'frameledger.report.v2');
  assert.equal(a.unverified_count, 2);
  assert.equal(a.ready, 0);
  assert.deepEqual(a.rerender, [{ first: 3, last: 3 }]);
  assert.ok(a.details.every(issue => issue.kind === 'unverified'));
  const b = await scanSequence(engine, [...base, entry(1, flat, 1), entry(2, multipart, 2)], options);
  assert.equal(b.format, 'frameledger.report.v1');
  assert.equal(b.unverified_count, 0);
  assert.equal(b.ready_from_overlay, 2);
});

test('CLI exit codes distinguish faults, review and an explicitly requested fast scan', () => {
  const run = (...args) => spawnSync(process.execPath, ['cli.mjs', 'examples/exr', ...args, '--json'], { encoding: 'utf8' });
  const mixed = run('--job', 'examples/exr-shot.json');
  assert.equal(mixed.status, 1, mixed.stderr);
  const report = JSON.parse(mixed.stdout);
  assert.deepEqual([report.ready, report.damaged_count, report.unverified_count, report.missing_count], [2, 1, 1, 1]);
  assert.deepEqual(report.rerender, [{ first: 3, last: 3 }, { first: 5, last: 5 }]);
  assert.equal(run('shot_####.exr', '4', '4').status, 3);
  assert.equal(run('shot_####.exr', '1', '2').status, 0);
  const fast = run('shot_####.exr', '3', '4', '--fast');
  assert.equal(fast.status, 0);
  assert.equal(JSON.parse(fast.stdout).exr_checked, 0);
});

test('a same-size replacement takes precedence over a transient truncation verdict', async () => {
  let generation = 0;
  const changing = { name: 's1.exr', snapshot: () => ({ size: cut.length, revision: ++generation }),
    blocks: async function* () { yield cut; } };
  const stable = { name: 's2.exr', snapshot: () => ({ size: flat.length, revision: 'fixed' }),
    blocks: async function* () { yield flat; } };
  const r = await scanSequence(engine, [changing, stable],
    { pattern: 's#.exr', first: 1, last: 2, step: 1, checkPng: true });
  assert.equal(r.ready, 1);
  assert.equal(r.damaged_count, 0);
  assert.equal(r.unverified_count, 1);
  assert.match(r.details[0].reason, /写入或替换/);
  assert.deepEqual(r.rerender, []);
});

test('an inaccessible entry does not suppress the rest of the shot', async () => {
  const vanished = { name: 's1.png', snapshot: () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); } };
  const locked = { name: 's2.png', size: () => 23,
    blocks: async function* () { throw Object.assign(new Error('locked'), { name: 'NotReadableError' }); } };
  const r = await scanSequence(engine, [vanished, locked],
    { pattern: 's#.png', first: 1, last: 3, step: 1, checkPng: true });
  assert.deepEqual(r.unverified, [{ first: 1, last: 2 }]);
  assert.deepEqual(r.rerender, [{ first: 3, last: 3 }]);
});

test('the CLI file adapter detects an actual write between the two snapshots', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'frameledger-live-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 's1.exr');
  await writeFile(path, flat);
  async function* changingDirectory() {
    for await (const entry of filesIn(dir)) {
      yield { ...entry, blocks: async function* (size) {
        yield* entry.blocks(size);
        await appendFile(path, Buffer.from([1]));
      } };
    }
  }
  const result = await scanSequence(engine, changingDirectory(),
    { pattern: 's#.exr', first: 1, last: 1, step: 1, checkPng: true });
  assert.equal(result.unverified_count, 1);
  assert.equal(result.ready, 0);
  assert.deepEqual(result.rerender, []);
  assert.match(result.details[0].reason, /写入/);
});
