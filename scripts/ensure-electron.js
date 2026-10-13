'use strict';

// postinstall safety net. On some Node versions Electron's own install script
// downloads the binary but exits before unpacking it, leaving `npm start`
// failing with "Electron failed to install correctly". This checks for the
// binary and, if it is missing, unpacks it with the operating system's tools.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const electronDir = path.dirname(require.resolve('electron/package.json'));
const distDir = path.join(electronDir, 'dist');
const binary = {
  win32: 'electron.exe',
  darwin: 'Electron.app/Contents/MacOS/Electron',
  linux: 'electron',
}[process.platform];

async function main() {
  if (!binary) return;
  if (fs.existsSync(path.join(distDir, binary)) && fs.existsSync(path.join(electronDir, 'path.txt'))) return;

  console.log('Electron binary is missing; unpacking it manually...');
  const { version } = require('electron/package.json');
  const { downloadArtifact } = require(require.resolve('@electron/get', { paths: [electronDir] }));
  const zipPath = await downloadArtifact({
    version,
    artifactName: 'electron',
    platform: process.platform,
    arch: process.arch,
    checksums: require('electron/checksums.json'),
  });

  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });
  if (process.platform === 'win32') {
    // Windows ships bsdtar, which reads zip files. Use the full path so a GNU tar earlier on PATH is not picked up.
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    execFileSync(tar, ['-xf', zipPath, '-C', distDir], { stdio: 'inherit' });
  } else {
    execFileSync('unzip', ['-q', zipPath, '-d', distDir], { stdio: 'inherit' });
  }
  fs.writeFileSync(path.join(electronDir, 'path.txt'), binary);
  console.log(`Electron ${version} is ready.`);
}

main().catch((error) => {
  // Never fail the whole install over this; `npm start` will report the problem.
  console.warn(`Could not repair the Electron install: ${error.message}`);
});
