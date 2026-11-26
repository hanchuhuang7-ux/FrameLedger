export function parseSize(text) {
  if (!text) return {};
  const match = /^([1-9]\d*)\s*[x×X]\s*([1-9]\d*)$/.exec(text.trim());
  if (!match) throw new Error('请输入像素尺寸，例如 1920x1080。');
  return { width: Number(match[1]), height: Number(match[2]) };
}

export function checkOptions(engine, { pattern, first, last, step, width, height, checkPng, checkExr = checkPng, exrChannels = [] }) {
  if (typeof pattern !== 'string') throw new Error('请输入命名模板。');
  const patternIssue = engine.patternError(pattern);
  if (patternIssue) throw new Error(patternIssue);
  for (const number of [first, last, step]) {
    if (!Number.isInteger(number) || number !== (number | 0)) {
      throw new Error('帧号和步长须为范围内的整数。');
    }
  }
  const rangeIssue = engine.rangeError(first, last, step);
  if (rangeIssue) throw new Error(rangeIssue);
  if (!Array.isArray(exrChannels) || exrChannels.length > 4096 ||
      exrChannels.some(name => typeof name !== 'string' || !name.length || name.length > 1024 || name.includes('\0'))) {
    throw new Error('EXR 必需通道应为有效名称列表。');
  }
  if (exrChannels.length && !(checkExr && pattern.toLowerCase().endsWith('.exr'))) {
    throw new Error('核对必需通道需要启用 EXR 结构检查。');
  }
  if (width != null || height != null) {
    if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 2147483647)) {
      throw new Error('预期宽高须同时为正整数。');
    }
    const name = pattern.toLowerCase();
    if (!(name.endsWith('.png') && checkPng) && !(name.endsWith('.exr') && checkExr)) {
      throw new Error('尺寸检查需要启用 PNG 或 EXR 的文件结构检查。');
    }
  }
}

export function readJob(engine, text) {
  const job = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (job?.format !== 'frameledger.job.v1') throw new Error('请选择 FrameLedger v1 镜头设置文件。');
  const options = { pattern: job.pattern, first: job.first, last: job.last, step: job.step, checkPng: true };
  if (job.required_exr_channels !== undefined) options.exrChannels = job.required_exr_channels;
  if (job.width != null || job.height != null) Object.assign(options, { width: job.width, height: job.height });
  if (job.origin != null) {
    if (typeof job.origin.scene !== 'string' || !job.origin.scene || typeof job.origin.blend_sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(job.origin.blend_sha256)) throw new Error('镜头设置内的 Blender 场景标识无效。');
    options.origin = { scene: job.origin.scene, blend_sha256: job.origin.blend_sha256 };
  }
  checkOptions(engine, options);
  return options;
}

async function inspectImage(feed, entry, expectedSize) {
  let bytesRead = 0;
  for await (const block of entry.blocks(expectedSize)) {
    bytesRead += block.byteLength;
    const issue = feed(block, false);
    if (issue) return issue;
  }
  if (bytesRead !== expectedSize) throw new Error('读取期间文件长度发生变化，请重新检查。');
  return feed(new Uint8Array(0), true);
}

function temporarilyUnreadable(error) {
  return ['ENOENT', 'ESTALE', 'EBUSY', 'EACCES', 'EPERM', 'ELOOP'].includes(error?.code) ||
    ['NotReadableError', 'NotFoundError', 'NotAllowedError'].includes(error?.name);
}

async function inspectEntry(engine, entry, options) {
  const before = entry.snapshot ? await entry.snapshot() : { size: await entry.size() };
  const size = before.size;
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('文件长度超出当前平台可处理的范围。');
  const name = entry.name.toLowerCase();
  const png = name.endsWith('.png') && options.checkPng;
  const exr = name.endsWith('.exr') && (options.checkExr ?? options.checkPng);
  const format = size > 0 && (png || exr) ? (png ? 'png' : 'exr') : null;
  let state = size === 0 ? 1 : 0, reason = '', readFailure;
  if (format) {
    const width = options.width ?? 0, height = options.height ?? 0;
    try {
      const feed = png ? engine.newPngProbeForSize(width, height) :
        engine.newExrProbeForChannels(width, height, options.exrChannels ?? []);
      const diagnostic = await inspectImage(feed, entry, size);
      if (diagnostic) {
        if (png) { state = 2; reason = diagnostic; }
        else ({ state, reason } = JSON.parse(diagnostic));
      }
    } catch (error) { readFailure = error; }
  }
  if (entry.snapshot && (png || exr)) {
    const after = await entry.snapshot();
    if (after.size !== size || after.revision !== before.revision) {
      return { state: 3, reason: '读取期间文件被写入或替换，请等写入结束后重新检查。', format };
    }
  }
  if (readFailure) throw readFailure;
  return { state, reason, format };
}

export async function scanSequence(engine, entries, options, onProgress = () => {}) {
  checkOptions(engine, options);
  const { pattern, first, last, step, checkPng, checkExr = checkPng } = options;
  const match = engine.makeMatcher(pattern);
  const frames = [];
  const states = [];
  const sources = [];
  const problems = new Map();
  let visited = 0;
  let pngChecked = 0;
  let exrChecked = 0;
  for await (const entry of entries) {
    visited++;
    const frame = match(entry.name);
    if (frame < first || frame > last || (frame - first) % step !== 0) continue;
    onProgress(frames.length, entry.name);
    let finding;
    try {
      finding = await inspectEntry(engine, entry, options);
    } catch (error) {
      if (!temporarilyUnreadable(error)) throw new Error('无法完成读取 ' + entry.name + '。' + error.message);
      finding = { state: 3, reason: '此文件在检查时无法读取，请确认文件仍可访问后复核。' };
    }
    const { state, reason, format } = finding;
    if (format === 'png') pngChecked++;
    if (format === 'exr') exrChecked++;
    frames.push(frame);
    states.push(state);
    sources.push(entry.source ?? 0);
    if (reason) problems.set(frames.length - 1, { frame, name: entry.name, reason });
  }
  const result = JSON.parse(engine.auditCopies(first, last, step, frames, states, sources));
  if (result.error) throw new Error(result.error);
  const report = result.report;
  const details = [];
  let overlayReady = 0;
  for (const index of result.selected) {
    if (sources[index] && states[index] === 0) overlayReady++;
    if (problems.has(index)) {
      const issue = problems.get(index);
      if (states[index] === 3) issue.kind = 'unverified';
      if (sources[index]) issue.source = sources[index];
      details.push(issue);
    }
  }
  details.sort((a, b) => a.frame - b.frame);
  return { format: report.unverified_count || options.exrChannels?.length ? 'frameledger.report.v2' : 'frameledger.report.v1',
    pattern, check_png: !!checkPng, png_checked: pngChecked, check_exr: !!checkExr, exr_checked: exrChecked, expected_width: options.width ?? null,
    expected_height: options.height ?? null, required_exr_channels: [...new Set(options.exrChannels ?? [])],
    origin: options.origin ?? null, directory_files: visited, extra_copies: frames.length - result.selected.length,
    ready_from_overlay: overlayReady, ...report, details };
}

export function formatSpans(spans, step) {
  if (!spans.length) return '无';
  return spans.map(({ first, last }) => {
    if (first === last) return String(first);
    return first + '–' + last + (step === 1 ? '' : '（每 ' + step + ' 帧）');
  }).join('、');
}
