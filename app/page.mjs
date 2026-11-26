const el = id => document.getElementById(id);
const categories = ['missing', 'empty', 'damaged', 'unverified'];
const numberFormat = new Intl.NumberFormat('zh-CN');
let selected = [];
let overlays = [];
let sourceLabel = '';
let lastReport = null;
let origin = null;

function status(text, error = false) {
  el('status').textContent = text;
  el('status').dataset.error = String(error);
}

function buildMap(report) {
  const grid = el('frame-map');
  grid.replaceChildren();
  const bins = Math.min(48, report.expected);
  const cursors = Object.fromEntries(categories.map(key => [key, 0]));
  for (let i = 0; i < bins; i++) {
    const first = report.first + Math.floor(i * report.expected / bins) * report.step;
    const last = report.first + (Math.floor((i + 1) * report.expected / bins) - 1) * report.step;
    const length = (last - first) / report.step + 1;
    const hit = {};
    for (const category of categories) {
      const spans = report[category];
      let pos = cursors[category];
      while (pos < spans.length && spans[pos].last < first) pos++;
      cursors[category] = pos;
      let count = 0;
      while (pos < spans.length && spans[pos].first <= last) {
        count += (Math.min(last, spans[pos].last) - Math.max(first, spans[pos].first)) / report.step + 1;
        pos++;
      }
      hit[category] = count;
    }
    const bad = hit.missing + hit.empty + hit.damaged;
    const state = bad + hit.unverified === 0 ? 'ready' : categories.find(key => hit[key] === length) || 'mixed';
    const bin = document.createElement('span');
    bin.className = 'bin ' + state;
    bin.title = '帧 ' + first + (first === last ? '' : ' 至 ' + last) + ' · 需补 ' + bad + ' / ' + length +
      (hit.unverified ? ' · 待复核 ' + hit.unverified : '');
    grid.append(bin);
  }
}

function show(report) {
  el('results').hidden = false;
  el('ready').textContent = numberFormat.format(report.ready);
  el('expected').textContent = numberFormat.format(report.expected);
  el('scope').textContent = sourceLabel + ' · 帧 ' + report.first + ' 至 ' + report.last + ' · 步长 ' + report.step +
    (overlays.length ? ' · 补帧目录提供 ' + report.ready_from_overlay + ' 帧' : '') +
    (report.required_exr_channels.length ? ' · 必需通道 ' + report.required_exr_channels.length + ' 项' : '') +
    (!report.check_png && !report.check_exr ? ' · 仅清点非空文件' : '');
  for (const category of categories) {
    el(category).textContent = formatSpans(report[category], report.step);
    el(category + '-count').textContent = numberFormat.format(report[category + '_count']) + ' 帧';
  }
  if (report.png_checked + report.exr_checked === 0) {
    el('damaged').textContent = report.check_png || report.check_exr ? '没有可检查的 PNG 或 EXR' : '未启用';
    el('damaged-count').textContent = '';
  }
  el('review-row').hidden = !report.unverified_count;
  el('rerender').textContent = formatSpans(report.rerender, report.step);
  el('details').hidden = !report.details.length;
  el('issues').replaceChildren(...report.details.slice(0, 50).map(issue => {
    const li = document.createElement('li');
    li.textContent = (issue.kind === 'unverified' ? '待复核 · ' : '') + issue.name + ' · ' + issue.reason;
    return li;
  }));
  if (report.details.length > 50) {
    const li = document.createElement('li');
    li.textContent = '这里只列前 50 项，完整诊断可导出 JSON。';
    el('issues').append(li);
  }
  buildMap(report);
  el('export').disabled = false;
  lastReport = report;
}

function invalidate() {
  lastReport = null;
  el('results').hidden = true;
  el('export').disabled = true;
  status('参数已修改，点击“检查帧序列”更新结果。');
}

async function run() {
  el('controls').disabled = true;
  el('results').hidden = true;
  lastReport = null;
  el('export').disabled = true;
  status('正在读取文件…');
  try {
    const entries = [selected, ...overlays.map(layer => layer.files)].flatMap((files, source) => files.map(file => ({
      name: file.name,
      source,
      size: () => file.size,
      blocks: async function* () {
        const blockSize = 128 * 1024;
        for (let at = 0; at < file.size; at += blockSize) {
          yield new Uint8Array(await file.slice(at, at + blockSize).arrayBuffer());
        }
      },
    })));
    const options = {
      pattern: el('pattern').value,
      first: el('first').valueAsNumber,
      last: el('last').valueAsNumber,
      step: el('step').valueAsNumber,
      checkPng: el('check-png').checked,
      exrChannels: el('exr-channels').value.split(/\r?\n/).map(name => name.trim()).filter(Boolean),
      ...parseSize(el('size').value),
      origin,
    };
    let nextUpdate = 0;
    const report = await scanSequence(engine, entries, options, (count, name) => {
      if (performance.now() >= nextUpdate) {
        status('已检查 ' + count + ' 个匹配文件 · ' + name);
        nextUpdate = performance.now() + 100;
      }
    });
    show(report);
    if (report.unverified_count) {
      status('检查完成。请单独复核 ' + report.unverified_count + ' 帧，自动补帧清单只包含已确认的问题。');
    } else {
      status(report.expected === report.missing_count ? '未找到匹配文件，请核对模板和帧段。' : '检查完成。');
    }
  } catch (error) {
    status(error.message, true);
  } finally {
    el('controls').disabled = false;
  }
}

function setSource(label, files) {
  selected = files;
  overlays = [];
  sourceLabel = label;
  el('source').textContent = label + ' · ' + files.length + ' 个文件';
}

function readFolder(fileList) {
  const files = Array.from(fileList);
  return {
    label: files[0]?.webkitRelativePath.split('/')[0] || '空目录',
    files: files.filter(file => file.webkitRelativePath.split('/').length <= 2),
  };
}

const demos = JSON.parse(el('demo-data').textContent);

function useDemo(key) {
  origin = null;
  const demo = demos[key];
  const files = demo.files.map(({ name, data }) => new File([Uint8Array.from(atob(data), c => c.charCodeAt(0))], name));
  setSource(demo.label, files);
  el('settings').reset();
  el('pattern').value = demo.pattern;
  el('last').value = demo.last;
  return run();
}

el('choose').addEventListener('click', () => {
  el('folder').value = '';
  el('folder').click();
});
el('folder').addEventListener('change', event => {
  const folder = readFolder(event.target.files);
  setSource(folder.label, folder.files);
  invalidate();
  status('已选择目录，请核对命名模板和计划帧段，再开始检查。');
});
el('add-overlay').addEventListener('click', () => {
  el('overlay-folder').value = '';
  el('overlay-folder').click();
});
el('overlay-folder').addEventListener('change', event => {
  overlays.push(readFolder(event.target.files));
  el('source').textContent = [sourceLabel, ...overlays.map(layer => layer.label)].join(' + ');
  invalidate();
  status('补帧目录已添加，点击“检查帧序列”查看合并后的结果。');
});
el('settings').addEventListener('input', event => {
  if (event.target.type === 'file') return;
  origin = null;
  invalidate();
});
el('import-job').addEventListener('click', () => {
  el('job-file').value = '';
  el('job-file').click();
});
el('job-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const job = readJob(engine, await file.text());
    for (const field of ['pattern', 'first', 'last', 'step']) el(field).value = job[field];
    el('size').value = job.width ? job.width + 'x' + job.height : '';
    el('check-png').checked = true;
    el('exr-channels').value = (job.exrChannels ?? []).join('\n');
    origin = job.origin ?? null;
    invalidate();
    status('已导入 ' + file.name + '，点击“检查帧序列”核对所选目录。');
  } catch (error) {
    status(error.message, true);
  }
});
el('settings').addEventListener('submit', event => { event.preventDefault(); run(); });
el('use-demo').addEventListener('click', () => useDemo('png'));
el('exr-demo').addEventListener('click', () => useDemo('exr'));
el('export').addEventListener('click', () => {
  if (!lastReport) return;
  const blob = new Blob([JSON.stringify(lastReport, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'frameledger-report.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
});
await useDemo('exr');
