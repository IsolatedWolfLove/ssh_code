import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { UninstallerReader } = require('app-builder-lib/out/targets/nsis/nsisUtil.js');

function normalizeName(name) {
  return name.toLowerCase();
}

export async function extractStandaloneUninstaller(projectDir = process.cwd()) {
  const packageJsonPath = path.join(projectDir, 'package.json');
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  const releaseDir = path.join(
    projectDir,
    packageJson.build?.directories?.output ?? 'release',
  );

  const entries = await fs.readdir(releaseDir, { withFileTypes: true });
  const exeNames = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => normalizeName(name).endsWith('.exe'))
    .filter((name) => !normalizeName(name).includes('uninstall'));

  const candidateNames = exeNames.filter((name) => name.includes(packageJson.version));
  const installerNames = candidateNames.length > 0 ? candidateNames : exeNames;

  if (installerNames.length === 0) {
    throw new Error(`No Windows installer found in ${releaseDir}.`);
  }

  const installerStats = await Promise.all(
    installerNames.map(async (name) => ({
      name,
      stat: await fs.stat(path.join(releaseDir, name)),
    })),
  );

  installerStats.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);

  const installerPath = path.join(releaseDir, installerStats[0].name);
  const uninstallerName = `${packageJson.name}-uninstall-${packageJson.version}.exe`;
  const uninstallerPath = path.join(releaseDir, uninstallerName);

  await fs.rm(uninstallerPath, { force: true });
  await UninstallerReader.exec(installerPath, uninstallerPath);

  return {
    installerPath,
    uninstallerPath,
  };
}

async function main() {
  const { installerPath, uninstallerPath } = await extractStandaloneUninstaller();
  console.log(`Installer: ${path.relative(process.cwd(), installerPath)}`);
  console.log(`Standalone uninstaller: ${path.relative(process.cwd(), uninstallerPath)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
