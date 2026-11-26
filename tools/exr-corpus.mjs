import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newExrProbeForChannels } from '../dist/engine.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const [blender, parent = tmpdir()] = process.argv.slice(2);
if (!blender) throw new Error('Usage: node tools/exr-corpus.mjs <Blender executable> [work directory]');
await mkdir(resolve(parent), { recursive: true });
const root = await mkdtemp(join(resolve(parent), 'frameledger-exr-'));
const render = spawnSync(blender, ['--background', '--factory-startup', '--disable-autoexec', '--threads', '2',
  '--python-exit-code', '7', '--python', join(repo, 'tests/blender/exr_cases.py'), '--', root],
  { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000 });
if (render.error) throw render.error;
assert.equal(render.status, 0, (render.stdout + render.stderr).slice(-3000));
const corpus = JSON.parse(await readFile(join(root, 'corpus.json'), 'utf8'));

function inspect(bytes, size, stride, required = []) {
  const probe = newExrProbeForChannels(...size, required);
  for (let at = 0; at < bytes.length; at += stride) {
    const value = probe(bytes.subarray(at, at + stride), false);
    if (value) return JSON.parse(value);
  }
  const value = probe(new Uint8Array(), true);
  return value ? JSON.parse(value) : { state: 0 };
}

let supported = 0, cutDetected = 0, sizeMismatch = 0;
const review = [];
for (const sample of corpus.cases) {
  const bytes = await readFile(join(root, 'generated', sample.name));
  const inspectable = !['tiled', 'deep'].includes(sample.layout);
  for (const stride of [1, 13, 4096, 131072]) {
    const result = inspect(bytes, sample.dimensions, stride);
    assert.equal(result.state, inspectable ? 0 : 3, sample.name + ' ' + (result.reason || ''));
  }
  if (inspectable) {
    supported++;
    if (['multipart', 'interleaved'].includes(sample.layout)) {
      assert.equal(inspect(bytes, sample.dimensions, 11, ['ViewLayer.Depth.Z', 'ViewLayer.Normal.X']).state, 0);
    }
    for (const cut of [1, 17]) assert.equal(inspect(bytes.subarray(0, -cut), sample.dimensions, 31).state, 2, sample.name);
    cutDetected += 2;
    assert.equal(inspect(bytes, [sample.dimensions[0] + 1, sample.dimensions[1]], 17).state, 2);
    sizeMismatch++;
  } else {
    review.push(sample.layout);
  }
}
const summary = { blender: corpus.blender, reference_openexr: corpus.openexr, reference_decoded: corpus.cases.length,
  supported_files_passed: supported, blender_codec_options: new Set(corpus.cases.filter(x => x.codec).map(x => x.codec)).size,
  truncated_variants_detected: cutDetected, wrong_sizes_detected: sizeMismatch, review_only: review };
await writeFile(join(root, 'verification.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2), '\n' + root);
