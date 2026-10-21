const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { _electron: electron } = require('C:/Users/iannam/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const executable = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
  const packagedApp = path.join(root, 'release', 'win-unpacked', 'resources', 'app.asar');
  const app = await electron.launch({
    executablePath: executable,
    args: [packagedApp],
    env: { ...process.env, DOKKAEBI_ANALYZER_DEMO: '1', DOKKAEBI_ANALYZER_ALLOW_MULTI:'1' }
  });
  const window = await app.firstWindow();
  await window.waitForSelector('.deck-slot');
  assert.equal(await window.locator('.deck-slot').count(), 9);
  assert.match(await window.locator('#build-name').textContent(), /감지 완료/);

  const frame = fs.readFileSync(path.resolve(root, '..', 'live-analyzer-evidence', 'frame-35.png')).toString('base64');
  const ocr = await window.evaluate(async value => {
    const image = new Image();
    await new Promise((resolve, reject) => { image.onload=resolve; image.onerror=reject; image.src=`data:image/png;base64,${value}`; });
    const canvas=document.createElement('canvas');
    canvas.width=image.width;canvas.height=image.height;
    canvas.getContext('2d').drawImage(image,0,0);
    state.running=true;
    await readDamageMeter(canvas);
    state.running=false;
    return state.ocr;
  }, frame);
  assert.equal(ocr.total, 1044458);
  assert.equal(ocr.dps, 30145);
  await window.screenshot({ path:path.join(root,'test-output','packaged-app.png'), fullPage:true });
  await app.close();
  console.log('packaged smoke passed');
})().catch(error => { console.error(error); process.exit(1); });
