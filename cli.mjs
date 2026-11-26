#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { opendir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import * as engine from './dist/engine.mjs';
import { formatSpans, parseSize, scanSequence } from './app/scan.mjs';

const usage = '用法：node cli.mjs <目录> <命名模板> <起始帧> <结束帧> [--step 整数] [--size 宽x高] [--fast] [--json]\n' +
  '示例：node cli.mjs examples/interrupted "shot_####.png" 1 8\n' +
  '默认读取 PNG 各块并核对 CRC。--fast 仅按文件存在和大小检查。\n' +
  '退出码 0 表示齐全，1 表示需要补渲染，2 表示参数或读取出错。';

function parseInteger(text) {
  if (typeof text !== 'string' || !/^-?\d+$/.test(text)) throw new Error('需要整数帧号或步长。');
  return Number(text);
}

async function* filesIn(directory) {
  for await (const item of await opendir(directory)) {
    if (!item.isFile()) continue;
    const path = join(directory, item.name);
    yield {
      name: item.name,
      size: async () => (await stat(path)).size,
      blocks: () => createReadStream(path, { highWaterMark: 128 * 1024 }),
    };
  }
}

async function main(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log(usage);
    return 0;
  }
  if (args.length < 4) throw new Error(usage);
  const [directory, pattern, first, last, ...flags] = args;
  const options = { pattern, first: parseInteger(first), last: parseInteger(last), step: 1, checkPng: true };
  let json = false;
  for (let i = 0; i < flags.length; i++) {
    switch (flags[i]) {
      case '--step': options.step = parseInteger(flags[++i]); break;
      case '--size': {
        const size = flags[++i];
        if (!size) throw new Error('--size 需要宽x高。');
        Object.assign(options, parseSize(size));
        break;
      }
      case '--fast': options.checkPng = false; break;
      case '--json': json = true; break;
      default: throw new Error('未知参数 ' + flags[i] + '\n' + usage);
    }
  }
  const result = await scanSequence(engine, filesIn(resolve(directory)), options);
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('可用 ' + result.ready + ' / ' + result.expected + ' 帧');
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
