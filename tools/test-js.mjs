import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const tests = (await readdir('tests')).filter(name => name.endsWith('.test.mjs')).sort();
if (!tests.length) throw new Error('No integration tests found');
const run = spawnSync(process.execPath, ['--test', ...tests.map(name => 'tests/' + name)], { stdio: 'inherit' });
if (run.error) throw run.error;
process.exitCode = run.status ?? 1;
