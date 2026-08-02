import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'resources', 'server');
const staging = `${output}.tmp`;
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const version = process.env.SERVER_VERSION || packageJson.version;
const commit = process.env.GITHUB_SHA || (await execFileAsync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root })).stdout.trim();
const buildTime = new Date().toISOString();
const targets = [
  ['linux', 'amd64'], ['linux', 'arm64'], ['darwin', 'amd64'], ['darwin', 'arm64'],
];
const targetArgument = process.argv.find((argument) => argument.startsWith('--targets='));
const targetSelector = targetArgument?.slice('--targets='.length) || process.env.SERVER_TARGETS || 'linux-amd64';
const selectedTargets = targetSelector === 'all'
  ? targets
  : targets.filter(([goos, goarch]) => targetSelector.split(',').includes(`${goos}-${goarch}`));

if (selectedTargets.length === 0) {
  throw new Error(`No supported server target selected: ${targetSelector}`);
}

await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
const artifacts = [];
for (const [goos, goarch] of selectedTargets) {
  const platform = `${goos}-${goarch}`;
  const file = join(staging, `ssh-studio-server-${platform}`);
  await execFileAsync('go', ['build', '-trimpath', '-ldflags', `-s -w -X main.version=${version} -X main.commit=${commit} -X main.buildTime=${buildTime}`, '-o', file, './cmd/ssh-studio-server'], {
    cwd: join(root, 'server'), env: { ...process.env, CGO_ENABLED: '0', GOOS: goos, GOARCH: goarch },
  });
  const content = await readFile(file);
  artifacts.push({ file: basename(file), platform, version, size: (await stat(file)).size, sha256: createHash('sha256').update(content).digest('hex') });
}
await writeFile(join(staging, 'manifest.json'), `${JSON.stringify({ version, generatedAt: buildTime, artifacts }, null, 2)}\n`);
await rm(output, { recursive: true, force: true });
await rename(staging, output);
console.log(`Built ${artifacts.length} SSH Studio server artifacts in ${output}`);
