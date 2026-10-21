const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const releaseDir = path.resolve(projectRoot, 'release');
if (path.dirname(releaseDir) !== projectRoot || path.basename(releaseDir) !== 'release') {
  throw new Error(`정리할 release 경로가 올바르지 않습니다: ${releaseDir}`);
}
if (!fs.existsSync(releaseDir)) process.exit(0);

for (const name of fs.readdirSync(releaseDir)) {
  const target = path.resolve(releaseDir, name);
  if (path.dirname(target) !== releaseDir) throw new Error(`정리 범위를 벗어난 경로입니다: ${target}`);
  fs.rmSync(target, { recursive:true, force:true });
}
console.log('이전 release 결과를 정리했습니다.');
