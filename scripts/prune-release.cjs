const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');

const projectRoot = path.resolve(__dirname, '..');
const releaseDir = path.resolve(projectRoot, 'release');
const installerName = `도깨비-실전-분석기-Setup-${pkg.version}.exe`;

if (path.dirname(releaseDir) !== projectRoot || path.basename(releaseDir) !== 'release') {
  throw new Error(`정리할 release 경로가 올바르지 않습니다: ${releaseDir}`);
}
if (!fs.existsSync(releaseDir)) throw new Error('release 폴더가 없습니다.');
if (!fs.existsSync(path.join(releaseDir, installerName))) {
  throw new Error(`최신 설치 파일을 찾을 수 없습니다: ${installerName}`);
}

for (const name of fs.readdirSync(releaseDir)) {
  if (name === installerName) continue;
  const target = path.resolve(releaseDir, name);
  if (path.dirname(target) !== releaseDir) throw new Error(`정리 범위를 벗어난 경로입니다: ${target}`);
  fs.rmSync(target, { recursive: true, force: true });
}

console.log(`release 폴더에 최신 설치 파일만 남겼습니다: ${installerName}`);
