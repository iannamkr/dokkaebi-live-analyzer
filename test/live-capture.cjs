const assert = require('assert');
const path = require('path');
const { _electron:electron } = require('C:/Users/iannam/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

(async()=>{
  const root=path.resolve(__dirname,'..');
  const app=await electron.launch({
    executablePath:path.join(root,'node_modules','electron','dist','electron.exe'),
    args:[root],
    env:{...process.env,DOKKAEBI_ANALYZER_ALLOW_MULTI:'1'}
  });
  const window=await app.firstWindow();
  await app.evaluate(async({BrowserWindow},file)=>{
    global.__liveTarget=new BrowserWindow({width:1748,height:984,useContentSize:true,frame:false,show:true});
    await global.__liveTarget.loadFile(file);
  },path.join(__dirname,'live-target.html'));
  await window.bringToFront();
  await window.locator('#choose-source').click();
  await window.locator('#source-dialog[open]').waitFor();
  const target=window.locator('.source-card',{hasText:'도깨비의 세계 실시간 테스트'});
  await target.waitFor({timeout:10000});
  await target.click();
  await window.locator('#capture-label').filter({hasText:'실시간 연결'}).waitFor({timeout:10000});
  assert.equal(await window.locator('#toggle-analysis').isEnabled(),false);
  await window.locator('#build-name').filter({hasText:'확인 필요'}).waitFor({timeout:10000});
  assert.equal(await window.locator('.deck-slot').count(),0,'사용자 확인 전에는 자동 후보를 확정하면 안 됩니다.');
  await window.locator('#confirm-slots').click();
  await window.locator('#slot-dialog[open]').waitFor();
  assert.equal(await window.locator('[data-slot-key]').count(),9);
  assert.equal(await window.locator('[data-breakthrough-key]').count(),9);
  assert.equal(await window.locator('[data-order-position]').count(),9);
  assert.equal(await window.locator('.slot-capture').count(),9);
  assert.equal(await window.locator('[data-slot-key]').evaluateAll(nodes=>nodes.every(node=>Boolean(node.value))),true);
  await window.screenshot({path:path.join(root,'test-output','slot-confirmation.png'),fullPage:true});
  await window.locator('#apply-slots').click();
  await window.locator('#slot-dialog').waitFor({state:'hidden'});
  assert.equal(await window.locator('.deck-slot').count(),9);
  assert.equal(await window.locator('#detect-confidence').textContent(),'확인됨');
  assert.equal(await window.locator('#toggle-analysis').isEnabled(),true);
  await window.waitForTimeout(1500);
  const fps=await window.locator('#frame-rate').textContent();
  assert.match(fps,/관측 (1[5-9]|[2-9]\d) fps/);
  await window.screenshot({path:path.join(root,'test-output','live-capture.png'),fullPage:true});
  await window.evaluate(()=>{
    state.running=false;
    cancelAnimationFrame(state.loopId);
    const required=['s063','s056','s017'];
    const fillers=state.catalog.skills.filter(value=>!value.ultimate&&!required.includes(value.id)).slice(0,5).map(value=>value.id);
    const ids=[...required,...fillers,'s018'];
    state.build={schema:'dosul-detected-v1',name:'효과 연계 검증',skills:ids,signature:ids.join('|')};
    state.currentOrder=[...ids];
    state.breakthroughStages=new Map([['s017',6]]);
    state.skillKeys=new Map(ids.map((id,index)=>[id,index===8?'R':String(index+1)]));
    const base=Date.now()-22000;
    state.events=[
      {type:'cast',skillId:'s063',at:base+1000,evidence:'visual'},
      {type:'cast',skillId:'s018',at:base+5000,evidence:'visual'},
      {type:'cast',skillId:'s056',at:base+7000,evidence:'visual'},
      {type:'cast',skillId:'s017',at:base+9000,evidence:'sequence'},
      {type:'cast',skillId:'s017',at:base+20000,evidence:'visual'},
      {type:'basic',key:'Space',at:base+4500,evidence:'visual'}
    ];
    state.startedAt=base;
    renderBuild();
    renderReport();
    document.querySelector('#finish-measurement').disabled=false;
  });
  assert.ok(await window.locator('#effect-timeline .effect-row').count()>=2,'실시간 효과 타임라인에 강화·약화 행이 표시되어야 합니다.');
  assert.match(await window.locator('#live-condition-rates').textContent(),/폭주.*화상/);
  await window.locator('#finish-measurement').click();
  await window.locator('#result-dialog[open]').waitFor();
  assert.equal(await window.locator('.recommend-card').count(),9);
  assert.ok(await window.locator('#recommendation-reasons .effect-chip').count()>0);
  assert.match(await window.locator('#result-summary').textContent(),/평타 1회/);
  assert.ok(await window.locator('.effect-timing-card').count()>0);
  assert.ok(await window.locator('.condition-result-card').count()>=2,'측정 완료 화면에 조건 성공률이 표시되어야 합니다.');
  assert.match(await window.locator('#condition-result-findings').textContent(),/난타.*감전/);
  assert.ok(await window.locator('#result-effect-timeline .effect-row').count()>=2);
  assert.ok(await window.locator('.action-card').count()>=3);
  await window.screenshot({path:path.join(root,'test-output','measurement-result.png'),fullPage:true});
  await app.close();
  console.log('live capture, effect display and measurement result passed',fps);
})().catch(error=>{console.error(error);process.exit(1)});
