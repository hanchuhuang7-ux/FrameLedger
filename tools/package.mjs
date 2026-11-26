import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = name => readFile(join(root, name), 'utf8');
const engine = await read('_build/js/release/build/frameledger.js');
const [shared, page, script, license, notice] = await Promise.all([
  read('app/scan.mjs'), read('app/page.html'), read('app/page.mjs'), read('LICENSE'), read('third-party/MoonBit-core-LICENSE.txt'),
]);
const dir = resolve(root, 'examples/interrupted');
const demo = await Promise.all((await readdir(dir)).sort().map(async name => ({
  name, data: (await readFile(join(dir, name))).toString('base64'),
})));
const moduleUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const parts = {
  ENGINE: moduleUrl(engine), SHARED: moduleUrl(shared), PAGE_JS: script,
  DEMO: JSON.stringify(demo), NOTICE: license + '\nIncludes compiled portions of MoonBit Core, copyright International Digital Economy Academy and contributors.\n' + notice,
};
const html = page.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
  if (!(key in parts)) throw new Error('Unknown template key ' + key);
  return parts[key];
});
await mkdir(join(root, 'dist'), { recursive: true });
await writeFile(join(root, 'dist/engine.mjs'), engine);
await writeFile(join(root, 'dist/FrameLedger.html'), html);
