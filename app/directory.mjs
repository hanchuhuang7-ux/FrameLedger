import { constants, createReadStream } from 'node:fs';
import { lstat, opendir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

export async function* filesIn(directory, source = 0) {
  for await (const item of await opendir(directory)) {
    if (!item.isFile()) continue;
    const path = join(directory, item.name);
    yield {
      name: item.name,
      source,
      snapshot: async () => {
        const info = await lstat(path, { bigint: true });
        if (!info.isFile()) throw Object.assign(new Error('文件条目已被替换。'), { code: 'ESTALE' });
        const revision = [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join('/');
        return { size: Number(info.size), revision };
      },
      blocks: size => createReadStream(path, {
        highWaterMark: 128 * 1024, end: size - 1, flags: constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      }),
    };
  }
}

export async function* deliveryFiles(roots, subdirectory) {
  for (const [source, root] of roots.entries()) {
    const base = await realpath(root);
    if (!(await stat(base)).isDirectory()) throw new Error('交付根目录无效。');
    let directory = base;
    if (subdirectory !== '.') {
      try {
        directory = await realpath(join(base, subdirectory));
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      const path = relative(base, directory);
      if (path === '..' || path.startsWith('..' + sep) || isAbsolute(path)) {
        throw new Error('交付子目录解析到了所选根目录之外。');
      }
    }
    yield* filesIn(directory, source);
  }
}
