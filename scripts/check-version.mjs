import { readFileSync } from 'node:fs';
const read = path => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
const version = read('package.json').version;
const lock = read('package-lock.json');
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a stable semantic version');
if ([lock.version, lock.packages[''].version, read('server/wails.json').info.productVersion].some(v => v !== version)) {
  throw new Error('Package, lockfile and Wails versions must match');
}
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${version}`) {
  throw new Error('Release tag must match the app version');
}
console.log(`Validated version ${version}`);
