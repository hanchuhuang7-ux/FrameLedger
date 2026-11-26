export function parseSize(text) {
  if (!text) return {};
  const match = /^([1-9]\d*)\s*[x×X]\s*([1-9]\d*)$/.exec(text.trim());
  if (!match) throw new Error('请输入像素尺寸，例如 1920x1080。');
  return { width: Number(match[1]), height: Number(match[2]) };
}

export function checkOptions(engine, { pattern, first, last, step, width, height, checkPng }) {
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
  if (width != null || height != null) {
    if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 2147483647)) {
      throw new Error('预期宽高须同时为正整数。');
    }
    if (!checkPng || !pattern.toLowerCase().endsWith('.png')) {
      throw new Error('尺寸检查需要启用 PNG 校验，并选择 PNG 命名模板。');
    }
  }
}

async function inspectPng(engine, entry, expectedSize, options) {
  const feed = engine.newPngProbeForSize(options.width ?? 0, options.height ?? 0);
  let bytesRead = 0;
  for await (const block of entry.blocks()) {
    bytesRead += block.byteLength;
    const issue = feed(block, false);
    if (issue) return issue;
  }
  if (bytesRead !== expectedSize) throw new Error('读取期间文件长度发生变化，请重新检查。');
  return feed(new Uint8Array(0), true);
}

export async function scanSequence(engine, entries, options, onProgress = () => {}) {
  checkOptions(engine, options);
  const { pattern, first, last, step, checkPng } = options;
  const match = engine.makeMatcher(pattern);
  const frames = [];
  const states = [];
  const sources = [];
  const problems = new Map();
  let visited = 0;
  let pngChecked = 0;
  for await (const entry of entries) {
    visited++;
    const frame = match(entry.name);
    if (frame < first || frame > last || (frame - first) % step !== 0) continue;
    onProgress(frames.length, entry.name);
    let size, reason = '';
    try {
      size = await entry.size();
      if (size > 0 && checkPng && entry.name.toLowerCase().endsWith('.png')) {
        reason = await inspectPng(engine, entry, size, options);
        pngChecked++;
      }
    } catch (error) {
      throw new Error('无法完成读取 ' + entry.name + '。' + error.message);
    }
    frames.push(frame);
    states.push(size === 0 ? 1 : reason ? 2 : 0);
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
      if (sources[index]) issue.source = sources[index];
      details.push(issue);
    }
  }
  details.sort((a, b) => a.frame - b.frame);
  return { pattern, check_png: !!checkPng, png_checked: pngChecked, expected_width: options.width ?? null,
    expected_height: options.height ?? null, directory_files: visited, extra_copies: frames.length - result.selected.length,
    ready_from_overlay: overlayReady, ...report, details };
}

export function formatSpans(spans, step) {
  if (!spans.length) return '无';
  return spans.map(({ first, last }) => {
    if (first === last) return String(first);
    return first + '–' + last + (step === 1 ? '' : '（每 ' + step + ' 帧）');
  }).join('、');
}
