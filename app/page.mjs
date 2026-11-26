const el = id => document.getElementById(id);
const categories = ['missing', 'empty', 'damaged'];
const numberFormat = new Intl.NumberFormat('zh-CN');
let selected = [];
let sourceLabel = '';
let lastReport = null;

function status(text, error = false) {
  el('status').textContent = text;
  el('status').dataset.error = String(error);
}

function buildMap(report) {
  const grid = el('frame-map');
  grid.replaceChildren();
  const bins = Math.min(48, report.expected);
  const cursors = { missing: 0, empty: 0, damaged: 0 };
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
    const state = bad === 0 ? 'ready' : categories.find(key => hit[key] === length) || 'mixed';
    const bin = document.createElement('span');
    bin.className = 'bin ' + state;
    bin.title = '帧 ' + first + (first === last ? '' : ' 至 ' + last) + ' · 需补 ' + bad + ' / ' + length;
    grid.append(bin);
  }
}

function show(report) {
  el('results').hidden = false;
  el('ready').textContent = numberFormat.format(report.ready);
  el('expected').textContent = numberFormat.format(report.expected);
  el('scope').textContent = sourceLabel + ' · 帧 ' + report.first + ' 至 ' + report.last + ' · 步长 ' + report.step;
  for (const category of categories) {
    el(category).textContent = formatSpans(report[category], report.step);
    el(category + '-count').textContent = numberFormat.format(report[category + '_count']) + ' 帧';
  }
  if (report.png_checked === 0) {
    el('damaged').textContent = report.check_png ? '没有可检查的 PNG' : '未启用';
    el('damaged-count').textContent = '';
  }
  el('rerender').textContent = formatSpans(report.rerender, report.step);
  el('details').hidden = !report.details.length;
  el('issues').replaceChildren(...report.details.slice(0, 50).map(issue => {
    const li = document.createElement('li');
    li.textContent = issue.name + ' · ' + issue.reason;
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
    const entries = selected.map(file => ({
      name: file.name,
      size: () => file.size,
      blocks: async function* () {
        const blockSize = 128 * 1024;
        for (let at = 0; at < file.size; at += blockSize) {
          yield new Uint8Array(await file.slice(at, at + blockSize).arrayBuffer());
        }
      },
    }));
    const options = {
      pattern: el('pattern').value,
      first: el('first').valueAsNumber,
      last: el('last').valueAsNumber,
      step: el('step').valueAsNumber,
      checkPng: el('check-png').checked,
      ...parseSize(el('size').value),
    };
    let nextUpdate = 0;
    const report = await scanSequence(engine, entries, options, (count, name) => {
      if (performance.now() >= nextUpdate) {
        status('已检查 ' + count + ' 个匹配文件 · ' + name);
        nextUpdate = performance.now() + 100;
      }
    });
    show(report);
    status(report.expected === report.missing_count ? '未找到匹配文件，请核对模板和帧段。' : '检查完成。');
  } catch (error) {
    status(error.message, true);
  } finally {
    el('controls').disabled = false;
  }
}

function setSource(label, files) {
  selected = files;
  sourceLabel = label;
  el('source').textContent = label + ' · ' + files.length + ' 个文件';
}

const demo = JSON.parse(el('demo-data').textContent).map(({ name, data }) => {
  const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
  return new File([bytes], name, { type: 'image/png' });
});

function useDemo() {
  setSource('Blender 故障示例', demo);
  el('settings').reset();
  return run();
}

el('choose').addEventListener('click', () => {
  el('folder').value = '';
  el('folder').click();
});
el('folder').addEventListener('change', event => {
  const all = Array.from(event.target.files);
  if (all.length === 0) {
    setSource('空目录', []);
  } else {
    const direct = all.filter(file => file.webkitRelativePath.split('/').length <= 2);
    setSource(all[0].webkitRelativePath.split('/')[0] || '本地目录', direct);
  }
  invalidate();
  status('已选择目录，请核对命名模板和计划帧段，再开始检查。');
});
el('settings').addEventListener('input', event => {
  if (event.target.id !== 'folder') invalidate();
});
el('settings').addEventListener('submit', event => { event.preventDefault(); run(); });
el('use-demo').addEventListener('click', useDemo);
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
await useDemo();
