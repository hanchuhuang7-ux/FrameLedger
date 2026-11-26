import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as engine from '../dist/engine.mjs';
import { scanSequence } from '../app/scan.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const picture = await readFile(new URL('../examples/interrupted/shot_0001.png', import.meta.url));
const settings = { pattern: 'shot_####.png', first: 1, last: 8, step: 1, checkPng: true };
const single = n => ({ first: n, last: n });

function cli(...args) {
  return spawnSync(process.execPath, ['cli.mjs', ...args], { cwd: root, encoding: 'utf8' });
}

function check(bytes, stride = 128 * 1024) {
  const probe = engine.newPngProbe();
  for (let offset = 0; offset < bytes.length; offset += stride) {
    const error = probe(bytes.subarray(offset, offset + stride), false);
    if (error) return error;
  }
  return probe(new Uint8Array(0), true);
}

function pngChunk(type, data) {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  result.write(type, 4, 4, 'ascii');
  data.copy(result, 8);
  let crc = -1;
  for (const byte of result.subarray(4, -4)) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  result.writeUInt32BE((~crc) >>> 0, result.length - 4);
  return result;
}

test('a real Blender PNG validates at every block boundary used by the hosts', () => {
  for (const stride of [1, 2, 3, 4, 7, 8, 12, 13, 33, 1024, 131072]) {
    assert.equal(check(picture, stride), '');
  }
});

test('intact endpoints do not hide a flipped IDAT payload bit', () => {
  const changed = Buffer.from(picture);
  const typeAt = changed.indexOf('IDAT', 33, 'ascii');
  assert.ok(typeAt > 0);
  changed[typeAt + 5] ^= 1;
  assert.match(check(changed, 11), /CRC/);
});

test('a checksum-correct IHDR still needs legal dimensions, colour and methods', () => {
  for (const [at, value, message] of [[0, 128, /尺寸/], [8, 3, /位深/], [9, 5, /色型/], [11, 1, /过滤/], [12, 3, /隔行/]]) {
    const header = Buffer.from(picture.subarray(16, 29));
    header[at] = value;
    const image = Buffer.concat([picture.subarray(0, 8), pngChunk('IHDR', header), picture.subarray(33)]);
    assert.match(check(image, 1), message);
  }
});

test('the shot size contract catches otherwise intact PNGs at the CLI', () => {
  const args = ['examples/interrupted', 'shot_####.png', '1', '1'];
  assert.equal(cli(...args, '--size', '64x48').status, 0);
  const wrong = cli(...args, '--size', '128x96', '--json');
  assert.equal(wrong.status, 1);
  assert.match(JSON.parse(wrong.stdout).details[0].reason, /64×48.*128×96/);
  assert.equal(cli(...args, '--size', '64x48', '--fast').status, 2);
  assert.equal(cli(...args, '--size', '20x0').status, 2);
});

test('truncated files, invalid signatures, overlong chunks and trailing data are diagnosed', () => {
  assert.match(check(picture.subarray(0, -5)), /IEND/);
  assert.match(check(Buffer.from('not a png')), /签名/);
  assert.match(check(Buffer.concat([picture.subarray(0, 8), Buffer.from([128])])), /长度/);
  assert.match(check(Buffer.concat([picture, Buffer.from([0])])), /额外/);
});

test('chunk order is checked independently of correct CRC values', () => {
  const sig = picture.subarray(0, 8);
  const header = picture.subarray(8, 33);
  const data = pngChunk('IDAT', Buffer.from([1]));
  const gap = pngChunk('tEXt', Buffer.from('key\0value'));
  const end = pngChunk('IEND', Buffer.alloc(0));
  assert.match(check(Buffer.concat([sig, data, end])), /IHDR/);
  assert.match(check(Buffer.concat([sig, header, header])), /重复/);
  assert.match(check(Buffer.concat([sig, header, end])), /图像数据/);
  assert.match(check(Buffer.concat([sig, header, data, gap, data, end])), /连续/);
});

test('the CLI reports the three deliberately different Blender fixture faults', () => {
  const run = cli('examples/interrupted', 'shot_####.png', '1', '8', '--json');
  assert.equal(run.status, 1, run.stderr);
  const r = JSON.parse(run.stdout);
  assert.equal(r.ready, 5);
  assert.equal(r.png_checked, 6);
  assert.deepEqual(r.missing, [single(3)]);
  assert.deepEqual(r.empty, [single(5)]);
  assert.deepEqual(r.damaged, [single(7)]);
  assert.deepEqual(r.rerender, [single(3), single(5), single(7)]);
  assert.match(r.details[0].reason, /IEND/);
});

test('CLI limits inspection to the requested grid and supports explicit metadata-only mode', () => {
  assert.equal(cli('examples/interrupted', 'shot_####.png', '2', '8', '--step', '2').status, 0);
  const r = JSON.parse(cli('examples/interrupted', 'shot_####.png', '1', '8', '--fast', '--json').stdout);
  assert.equal(r.ready, 6);
  assert.equal(r.damaged_count, 0);
  assert.equal(r.check_png, false);
  assert.equal(r.png_checked, 0);
});

test('bad input and unreadable directories are operational errors', () => {
  for (const values of [
    ['examples/interrupted', '#.png', '4294967297', '4294967298'],
    ['examples/interrupted', 'shot_####.png', '1', '8', '--step', '0'],
    ['examples/interrupted', 'shot.png', '1', '8'],
    ['examples/interrupted/absent', '#.png', '1', '8'],
  ]) assert.equal(cli(...values).status, 2);
});

test('a read failure is reported and never presented as a completed scan', async () => {
  const inaccessible = { name: 'shot_0001.png', size: () => 25, blocks: async function* () { throw new Error('I/O'); } };
  await assert.rejects(scanSequence(engine, [inaccessible], settings), /shot_0001.png/);
  const changed = { name: 'shot_0001.png', size: () => picture.length + 5, blocks: async function* () { yield picture; } };
  await assert.rejects(scanSequence(engine, [changed], settings), /文件长度发生变化/);
});

test('unrelated files, out-of-range frames and other formats need no PNG reads', async () => {
  const forbidden = () => { throw new Error('unexpected read'); };
  const unrelated = { name: 'shot_0001_L.png', size: forbidden, blocks: forbidden };
  const wrongFrame = { name: 'shot_0012.png', size: forbidden, blocks: forbidden };
  const exr = { name: 'shot_0001.exr', size: () => 88, blocks: forbidden };
  const r = await scanSequence(engine, [unrelated, wrongFrame, exr], { ...settings, pattern: 'shot_####.exr' });
  assert.equal(r.ready, 1);
  assert.equal(r.missing_count, 7);
});

test('sparse intervals agree with an independent enumerating oracle on 600 seeded windows', () => {
  let seed = 43129;
  const rand = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  for (let trial = 0; trial < 600; trial++) {
    const first = rand(35) - 20, last = first + rand(32), step = 1 + rand(7);
    const frames = [], states = [], observed = new Map();
    for (let i = last + 2; i >= first - 2; i--) {
      if (rand(5) > 1) {
        const state = rand(3);
        frames.push(i); states.push(state); observed.set(i, state);
      }
    }
    const r = JSON.parse(engine.auditFrames(first, last, step, frames, states));
    const wanted = { missing: [], empty: [], damaged: [], rerender: [] };
    let ready = 0;
    for (let i = first; i <= last; i += step) {
      const state = observed.get(i);
      if (state === 0) { ready++; continue; }
      wanted[state === undefined ? 'missing' : state === 1 ? 'empty' : 'damaged'].push(i);
      wanted.rerender.push(i);
    }
    assert.equal(r.ready, ready);
    for (const key of Object.keys(wanted)) {
      const expanded = [];
      for (const span of r[key]) for (let i = span.first; i <= span.last; i += step) expanded.push(i);
      assert.deepEqual(expanded, wanted[key]);
    }
  }
});
