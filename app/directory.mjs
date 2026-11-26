import { constants, createReadStream } from 'node:fs';
import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';

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
