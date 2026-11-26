#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { mkdtemp, opendir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve, join } from 'node:path';
import * as engine from './dist/engine.mjs';
import { formatSpans, parseSize, readJob, scanSequence } from './app/scan.mjs';

const usage = '用法：node cli.mjs <目录> <命名模板> <起始帧> <结束帧> [--step 整数] [--size 宽x高] [--overlay 补帧目录] [--fast] [--json]\n' +
  '示例：node cli.mjs examples/interrupted "shot_####.png" 1 8\n' +
  '读取 Blender 镜头设置：node cli.mjs <目录> --job <镜头.json> [--overlay 补帧目录] [--output 报告.json] [--json]\n' +
  '默认读取 PNG 各块并核对 CRC。--fast 仅按文件存在和大小检查。\n' +
  '退出码 0 表示齐全，1 表示需要补渲染，2 表示参数或读取出错。';

function parseInteger(text) {
  if (typeof text !== 'string' || !/^-?\d+$/.test(text)) throw new Error('需要整数帧号或步长。');
  return Number(text);
}

async function* filesIn(directory, source) {
  for await (const item of await opendir(directory)) {
    if (!item.isFile()) continue;
    const path = join(directory, item.name);
    yield {
      name: item.name,
      source,
      size: async () => (await stat(path)).size,
      blocks: () => createReadStream(path, { highWaterMark: 128 * 1024 }),
    };
  }
}

async function* combinedFiles(directories) {
  for (const [source, directory] of directories.entries()) {
    yield* filesIn(directory, source);
  }
}

async function saveReport(path, report, jobPath) {
  const target = resolve(path);
  if (extname(target).toLowerCase() !== '.json') throw new Error('报告文件需要 .json 扩展名。');
  if (jobPath) {
    const [source, destination] = await Promise.all([
      realpath(jobPath), realpath(target).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return target;
      }),
    ]);
    const same = process.platform === 'win32' ? source.toLowerCase() === destination.toLowerCase() : source === destination;
    if (same) throw new Error('镜头设置和报告需要分别保存。');
  }
  const temp = await mkdtemp(join(dirname(target), '.frameledger-report-'));
  try {
    const pending = join(temp, 'report.json');
    await writeFile(pending, JSON.stringify(report, null, 2) + '\n', 'utf8');
    await rename(pending, target);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function main(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log(usage);
    return 0;
  }
  const [directory, pattern, first, last] = args;
  const fromJob = pattern === '--job';
  if (args.length < (fromJob ? 3 : 4)) throw new Error(usage);
  const options = fromJob ? readJob(engine, await readFile(first, 'utf8')) :
    { pattern, first: parseInteger(first), last: parseInteger(last), step: 1, checkPng: true };
  const flags = args.slice(fromJob ? 3 : 4);
  let json = false;
  let output;
  const directories = new Set([resolve(directory)]);
  for (let i = 0; i < flags.length; i++) {
    if (fromJob && ['--step', '--size'].includes(flags[i])) throw new Error('镜头设置已指定帧段与尺寸。');
    switch (flags[i]) {
      case '--step': options.step = parseInteger(flags[++i]); break;
      case '--size': {
        const size = flags[++i];
        if (!size) throw new Error('--size 需要宽x高。');
        Object.assign(options, parseSize(size));
        break;
      }
      case '--fast': options.checkPng = false; break;
      case '--output':
        output = flags[++i];
        if (!output || output.startsWith('--')) throw new Error('--output 需要报告路径。');
        break;
      case '--overlay': {
        const overlay = flags[++i];
        if (!overlay || overlay.startsWith('--')) throw new Error('--overlay 需要补帧目录。');
        directories.add(resolve(overlay));
        break;
      }
      case '--json': json = true; break;
      default: throw new Error('未知参数 ' + flags[i] + '\n' + usage);
    }
  }
  const result = await scanSequence(engine, combinedFiles([...directories]), options);
  if (output) await saveReport(output, result, fromJob ? first : null);
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('可用 ' + result.ready + ' / ' + result.expected + ' 帧');
    if (directories.size > 1) console.log('由补帧目录提供 ' + result.ready_from_overlay + ' 帧');
    for (const [label, key] of [['缺帧', 'missing'], ['空文件', 'empty'], ['PNG 损坏', 'damaged'], ['补渲染', 'rerender']]) {
      const summary = key === 'damaged' && result.png_checked === 0
        ? (result.check_png ? '没有可检查的 PNG' : '未启用')
        : formatSpans(result[key], result.step);
      console.log(label + '  ' + summary);
    }
    for (const { name, reason } of result.details) console.log(name + '  ' + reason);
  }
  return result.rerender.length > 0 ? 1 : 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
