const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { _electron:electron } = require('C:/Users/iannam/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

(async()=>{
  const root=path.resolve(__dirname,'..');
  const historyDirectory=path.join(root,'test-output',`live-history-${process.pid}`);
  fs.mkdirSync(historyDirectory,{recursive:true});
  const historyFile=path.join(historyDirectory,'history.json');
  const app=await electron.launch({
    executablePath:path.join(root,'node_modules','electron','dist','electron.exe'),
    args:[root],
    env:{...process.env,DOKKAEBI_ANALYZER_ALLOW_MULTI:'1',DOKKAEBI_ANALYZER_HISTORY_FILE:historyFile}
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
  await window.waitForFunction(async()=>((await window.desktopAPI.listHistory()).length===1));
  await window.locator('#continue-measurement').click();
  await window.evaluate(()=>{state.running=false;cancelAnimationFrame(state.loopId);state.events.push({type:'basic',key:'Space',at:Date.now(),evidence:'visual'});});
  await window.locator('#finish-measurement').click();
  await window.locator('#result-dialog[open]').waitFor();
  await window.waitForFunction(async()=>((await window.desktopAPI.listHistory()).length===1));
  await window.locator('#result-dialog button[value="cancel"]').last().click();
  await window.locator('#history-tab').click();
  await window.locator('#history-view:not([hidden])').waitFor();
  assert.equal(await window.locator('#history-body tr[data-history-id]').count(),1,'추가 측정은 같은 히스토리 행을 갱신해야 합니다.');
  await window.locator('#history-body tr[data-history-id] td:nth-child(3)').evaluate(element=>element.click());
  await window.locator('#history-detail-dialog[open]').waitFor();
  assert.equal(await window.locator('#history-detail-order .history-order-skill').count(),9);
  assert.ok(await window.locator('#history-detail-efficiency tr').count()>=9);
  assert.match(await window.locator('#history-detail-conditions').textContent(),/난타.*감전/);
  await window.screenshot({path:path.join(root,'test-output','history-detail.png'),fullPage:true});
  await window.locator('#history-detail-dialog button[value="cancel"]').last().click();
  await window.evaluate(async()=>{
    const [original]=await window.desktopAPI.listHistory();
    const copy=JSON.parse(JSON.stringify(original));
    copy.id='comparison-missing-damage';copy.title='피해 측정기 미표시 비교';copy.createdAt+=1;copy.updatedAt+=1;
    copy.measurement.ocr.dps=null;copy.measurement.ocr.rows=[];copy.result.basicShare=12;
    await window.desktopAPI.saveHistory(copy);await loadHistory();
  });
  assert.equal(await window.locator('#history-body tr[data-history-id]').count(),2);
  assert.match(await window.locator('#history-body').textContent(),/측정기 미표시/);
  await window.locator('.history-select').nth(0).evaluate(element=>element.click());
  await window.locator('.history-select').nth(1).evaluate(element=>element.click());
  await window.locator('#compare-history').click();
  assert.equal(await window.locator('#history-compare-panel').isVisible(),true);
  assert.match(await window.locator('#compare-body').textContent(),/비교 불가/,'한쪽 실측값이 없으면 비교 불가로 표시해야 합니다.');
  await window.screenshot({path:path.join(root,'test-output','history-table.png'),fullPage:true});
  await app.close();
  fs.rmSync(historyDirectory,{recursive:true,force:true});
  console.log('live capture, effect display and measurement result passed',fps);
})().catch(error=>{console.error(error);process.exit(1)});
