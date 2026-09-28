import { spawnSync } from 'node:child_process';
import { mkdir, copyFile, writeFile, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const target = process.argv[2] || ({ linux: 'deb', darwin: 'mac', win32: 'win' })[process.platform];
const expected = { deb: 'linux', mac: 'darwin', win: 'win32' }[target];
if (process.platform !== expected) throw new Error(`Package ${target} on ${expected}; native Wails builds require that operating system.`);
function run(command, args, cwd = root) { const r = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env }); if (r.error) throw r.error; if (r.status !== 0) throw new Error(`${command} failed (${r.status})`); }
run(process.execPath, [join(root, 'scripts/wails.mjs'), 'build', ...(target === 'win' ? ['-nsis'] : [])]);
const release = join(root, 'release');
await mkdir(release, { recursive: true });
if (target === 'deb') {
  const stage = await mkdtemp(join(tmpdir(), 'ssh-studio-deb-'));
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  for (const p of ['DEBIAN', 'usr/bin', 'usr/share/applications', 'usr/share/icons/hicolor/256x256/apps']) await mkdir(join(stage, p), { recursive: true });
  await copyFile(join(root, 'server/build/bin/ssh-studio'), join(stage, 'usr/bin/ssh-studio'));
  await copyFile(join(root, 'src/renderer/public/icon.png'), join(stage, 'usr/share/icons/hicolor/256x256/apps/ssh-studio.png'));
  await writeFile(join(stage, 'DEBIAN/control'), `Package: ssh-studio\nVersion: ${pkg.version}\nArchitecture: ${arch}\nMaintainer: ${pkg.author.name} <${pkg.author.email}>\nDepends: libgtk-3-0, libwebkit2gtk-4.1-0\nSection: devel\nPriority: optional\nDescription: SSH client, file editor and terminal\n`);
  await writeFile(join(stage, 'usr/share/applications/ssh-studio.desktop'), '[Desktop Entry]\nType=Application\nName=SSH Studio\nExec=ssh-studio\nIcon=ssh-studio\nTerminal=false\nCategories=Development;Network;\n');
  run('dpkg-deb', ['--root-owner-group', '--build', stage, join(release, `ssh-studio-${pkg.version}-${arch}.deb`)]);
} else if (target === 'mac') {
  const app = join(root, 'server/build/bin/ssh-studio.app');
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, join(release, `ssh-studio-${pkg.version}-${process.arch}.zip`)]);
  run('hdiutil', ['create', '-volname', 'SSH Studio', '-srcfolder', app, '-ov', '-format', 'UDZO', join(release, `ssh-studio-${pkg.version}-${process.arch}.dmg`)]);
} else {
  const bin = join(root, 'server/build/bin');
  const installers = (await readdir(bin)).filter(name => name.endsWith('-installer.exe'));
  if (installers.length !== 1) throw new Error(`Expected one Windows installer, found ${installers.length}`);
  await copyFile(join(bin, installers[0]), join(release, `ssh-studio-${pkg.version}-${process.arch}-installer.exe`));
}
