const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { _electron: electron } = require('C:/Users/iannam/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const executablePath = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
  const app = await electron.launch({
    executablePath,
    args: [root],
    env: { ...process.env, DOKKAEBI_ANALYZER_DEMO: '1', DOKKAEBI_ANALYZER_ALLOW_MULTI:'1', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await window.waitForSelector('.deck-slot');
  assert.equal(await window.title(), '도깨비 실전 분석기');
  assert.ok(await window.locator('.deck-slot').count() >= 7);
  assert.equal(await window.locator('#choose-source').isVisible(), true);
  const framePath = path.resolve(root, '..', 'live-analyzer-evidence', 'frame-35.png');
  const frame = fs.readFileSync(framePath).toString('base64');
  const ocr = await window.evaluate(async value => {
    const image = new Image();
    await new Promise((resolve, reject) => { image.onload=resolve; image.onerror=reject; image.src=`data:image/png;base64,${value}`; });
    const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;canvas.getContext('2d').drawImage(image,0,0);
    state.running=true;
    await readDamageMeter(canvas);
    state.running=false;
    return state.ocr;
  }, frame);
  console.log('ocr', JSON.stringify(ocr));
  assert.ok(ocr.total > 100000, `OCR total damage was ${ocr.total}`);
  assert.ok(ocr.dps > 1000, `OCR DPS was ${ocr.dps}`);
  const out = path.join(root, 'test-output');
  fs.mkdirSync(out, { recursive: true });
  await window.screenshot({ path: path.join(out, 'app-shell.png'), fullPage: true });
  await app.close();
  console.log('electron smoke passed');
})().catch(error => { console.error(error); process.exit(1); });
