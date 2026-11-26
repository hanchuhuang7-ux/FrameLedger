export function checkOptions(engine, { pattern, first, last, step }) {
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
}

async function inspectPng(engine, entry, expectedSize) {
  const feed = engine.newPngProbe();
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
  const details = [];
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
        reason = await inspectPng(engine, entry, size);
        pngChecked++;
      }
    } catch (error) {
      throw new Error('无法完成读取 ' + entry.name + '。' + error.message);
    }
    frames.push(frame);
    states.push(size === 0 ? 1 : reason ? 2 : 0);
    if (reason) details.push({ frame, name: entry.name, reason });
  }
  const report = JSON.parse(engine.auditFrames(first, last, step, frames, states));
  if (report.error) throw new Error(report.error);
  details.sort((a, b) => a.frame - b.frame);
  return { pattern, check_png: !!checkPng, png_checked: pngChecked, directory_files: visited, ...report, details };
}

export function formatSpans(spans, step) {
  if (!spans.length) return '无';
  return spans.map(({ first, last }) => {
    if (first === last) return String(first);
    return first + '–' + last + (step === 1 ? '' : '（每 ' + step + ' 帧）');
  }).join('、');
}
