const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const fmt = value => Number(value || 0).toLocaleString('ko-KR');
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

const state = {
  catalog: null,
  byId: new Map(),
  build: null,
  stream: null,
  source: null,
  running: false,
  events: [],
  slotStates: new Map(),
  basicState: null,
  slotMap: new Map(),
  skillKeys: new Map(),
  pendingSlots: [],
  currentOrder: [],
  breakthroughStages: new Map(),
  sequenceCursor: null,
  lastVisualCast: null,
  templateFeatures: new Map(),
  detectionConfidence: 0,
  loopId: 0,
  frames: 0,
  fpsSince: performance.now(),
  fps: 0,
  startedAt: 0,
  lastUi: 0,
  lastMap: 0,
  lastFrameAt: 0,
  ocr: { total: null, dps: null, rows: [], updatedAt: 0 },
  ocrBusy: false,
  ocrWorker: null,
  lastOcr: 0,
  appVersion: '',
  history: [],
  historySelected: new Set(),
  historyRecordId: null,
  historyDetailId: null,
  regions: {
    hotbar: { x: .746, y: .735, w: .238, h: .205 },
    meter: { x: .785, y: .055, w: .193, h: .305 }
  }
};

const api = window.desktopAPI || {
  listSources: async () => [],
  getCatalog: () => fetch('../assets/data.json').then(response=>response.json()),
  setAlwaysOnTop: async () => false,
  listHistory: async () => [],
  saveHistory: async record => record,
  updateHistory: async () => null,
  deleteHistory: async () => false,
  getAppVersion: async () => '',
  openExternal: url => window.open(url, '_blank'),
  optimizeSequence: () => ({order:[],rows:[],casts:0,durationMs:0}),
  analyzeEffectState: () => ({windows:[],attempts:[],conditions:[],activeEffects:[]}),
  advanceSlotDetector: (previous,feature,now) => ({state:{...(previous||{}),feature,luma:feature.luma,at:now},cast:false})
};

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2600);
}

function iconUrl(id) { return `../assets/icons/${id}.png`; }
function skill(id) { return state.byId.get(id); }
function skillAtStage(id) {
  const source=skill(id)||{},stage=Number(state.breakthroughStages.get(id)||0);
  const next={...source,breakthroughStage:stage,buffs:[...(source.buffs||[])],debuffs:[...(source.debuffs||[])],conditions:[...(source.conditions||[])]};
  for(const effect of source.breakthroughEffects||[]){
    if(stage<Number(effect.stage||0))continue;
    if(effect.kind==='buff'&&!next.buffs.includes(effect.effect))next.buffs.push(effect.effect);
    if(effect.kind==='debuff'&&!next.debuffs.includes(effect.effect))next.debuffs.push(effect.effect);
    if(effect.kind==='condition')next.conditions.push({effect:effect.effect,result:effect.result,scope:effect.scope||'enemy',minBreakthrough:Number(effect.stage||0)});
  }
  return next;
}
function disabledSet() { return new Set(); }
function effectsFor(id) {
  const value=skillAtStage(id);
  return {buffs:[...new Set(value.buffs||[])],debuffs:[...new Set(value.debuffs||[])],conditions:(value.conditions||[]).filter(item=>item?.effect)};
}
function effectChips(id, includeConditions=true) {
  const effects=effectsFor(id),items=[];
  effects.buffs.forEach(name=>items.push(`<span class="effect-chip buff">강화 · ${escapeHtml(name)}</span>`));
  effects.debuffs.forEach(name=>items.push(`<span class="effect-chip debuff">약화 · ${escapeHtml(name)}</span>`));
  if(includeConditions)effects.conditions.forEach(value=>items.push(`<span class="effect-chip condition">조건 · ${escapeHtml(value.effect)}</span>`));
  return items.length?`<div class="effect-stack">${items.join('')}</div>`:'—';
}

function effectAnalysis(endedAt=Date.now()) {
  if(!state.build)return {windows:[],attempts:[],conditions:[],activeEffects:[]};
  return api.analyzeEffectState({skills:state.build.skills.map(id=>skillAtStage(id)),events:state.events,startedAt:state.startedAt,endedAt});
}

function setDetectedBuild(skills, keys, confidence) {
  const signature = skills.join('|');
  if (state.build?.signature === signature) return;
  state.historyRecordId = null;
  state.build = { schema:'dosul-detected-v1', name:'현재 게임 슬롯', skills, signature };
  state.skillKeys = new Map(skills.map((id, index) => [id, keys[index]]));
  state.detectionConfidence = confidence;
  state.pendingSlots = skills.map((id, index) => ({ id, key:keys[index], score:confidence }));
  state.events = [];
  state.slotStates.clear();
  state.sequenceCursor = null;
  state.lastVisualCast = null;
  renderBuild();
  updateReadyState();
  toast('확인한 스킬 슬롯 9개를 적용했습니다.');
}

function slotOptions(key, selectedId='') {
  const ultimate = key === 'R';
  const options = state.catalog.skills
    .filter(candidate => Boolean(candidate.ultimate) === ultimate)
    .sort((a,b) => a.family.localeCompare(b.family,'ko') || a.name.localeCompare(b.name,'ko'))
    .map(candidate => `<option value="${candidate.id}" ${candidate.id===selectedId?'selected':''}>${escapeHtml(candidate.family)} · ${escapeHtml(candidate.name)}</option>`)
    .join('');
  return `<option value="">직접 선택</option>${options}`;
}

function openSlotConfirmation() {
  if (!state.catalog || !state.stream) return;
  const current = displaySlotKeys().map(key => {
    const confirmed = state.build?.skills.find(id => state.skillKeys.get(id) === key);
    const candidate = state.pendingSlots.find(item => item.key === key);
    return { key, id:confirmed || candidate?.id || '', preview:candidate?.preview || '' };
  });
  $('#slot-confirm-list').innerHTML = current.map(({key,id,preview}) => `<label class="slot-confirm-row"><strong>${key}</strong><img class="slot-capture" src="${preview || (id?iconUrl(id):'../assets/icon-512.png')}" alt="실제 슬롯"><img data-slot-icon="${key}" src="${id?iconUrl(id):'../assets/icon-512.png'}" alt="선택 도술"><select data-slot-key="${key}">${slotOptions(key,id)}</select><select class="breakthrough-select" data-breakthrough-key="${key}" title="돌파 단계">${Array.from({length:11},(_,stage)=>`<option value="${stage}" ${stage===Number(state.breakthroughStages.get(id)||0)?'selected':''}>돌파 ${stage}</option>`).join('')}</select></label>`).join('');
  renderOrderInputs(state.currentOrder.length===9 ? state.currentOrder : current.map(item=>item.id));
  $$('[data-slot-key]').forEach(select => select.onchange = () => {
    const image = $(`[data-slot-icon="${select.dataset.slotKey}"]`);
    image.src = select.value ? iconUrl(select.value) : '../assets/icon-512.png';
    renderOrderInputs($$('[data-slot-key]').map(item=>item.value));
    $('#slot-validation').textContent = '';
  });
  $('#slot-validation').textContent = '';
  $('#slot-dialog').showModal();
}

function renderOrderInputs(ids) {
  const unique=ids.filter(Boolean).filter((id,index,list)=>list.indexOf(id)===index);
  const previous=$$('[data-order-position]').map(select=>select.value);
  const selected=previous.length===9&&previous.every(id=>unique.includes(id))?previous:unique;
  $('#order-confirm-list').innerHTML=Array.from({length:9},(_,index)=>{
    const id=selected[index]||unique[index]||'';
    const options=unique.map(candidate=>`<option value="${candidate}" ${candidate===id?'selected':''}>${escapeHtml(skill(candidate)?.family||'')} · ${escapeHtml(skill(candidate)?.name||candidate)}</option>`).join('');
    return `<label class="order-confirm-row"><strong>${index+1}</strong><select data-order-position="${index}"><option value="">순서 선택</option>${options}</select></label>`;
  }).join('');
}

function applyConfirmedSlots() {
  const entries = $$('[data-slot-key]').map(select => ({ key:select.dataset.slotKey, id:select.value }));
  if (entries.some(entry => !entry.id)) { $('#slot-validation').textContent='9개 슬롯을 모두 선택해 주세요.'; return; }
  if (new Set(entries.map(entry=>entry.id)).size !== 9) { $('#slot-validation').textContent='같은 도술을 두 슬롯에 선택할 수 없습니다.'; return; }
  if (entries.some(entry => Boolean(skill(entry.id)?.ultimate) !== (entry.key==='R'))) { $('#slot-validation').textContent='R에는 궁극기, 나머지 슬롯에는 일반 도술을 선택해 주세요.'; return; }
  const byKey = new Map(entries.map(entry=>[entry.key,entry.id]));
  const stageByKey=new Map($$('[data-breakthrough-key]').map(select=>[select.dataset.breakthroughKey,Number(select.value||0)]));
  const orderedKeys = displaySlotKeys();
  const ids = orderedKeys.map(key=>byKey.get(key));
  const orderIds=$$('[data-order-position]').map(select=>select.value);
  if(orderIds.some(id=>!id)||new Set(orderIds).size!==9||orderIds.some(id=>!ids.includes(id))){$('#slot-validation').textContent='자동 사용 순서에도 선택한 9개 도술을 한 번씩 배치해 주세요.';return;}
  state.historyRecordId=null;
  state.events=[];
  state.currentOrder=orderIds;
  state.breakthroughStages=new Map(entries.map(entry=>[entry.id,stageByKey.get(entry.key)||0]));
  state.sequenceCursor=null;
  state.lastVisualCast=null;
  state.slotMap = new Map(slotDefinitions().map((position,index)=>[index,{index,key:position.key,id:byKey.get(position.key),score:1}]));
  setDetectedBuild(ids,orderedKeys,1);
  state.startedAt=Date.now();
  $('#slot-dialog').close();
  $('#detect-confidence').textContent = '확인됨';
  $('#analysis-state').textContent = '실시간 분석 중';
  $('#analysis-subtitle').textContent = '확인한 슬롯 구성으로 사용과 피해를 측정합니다.';
  $('#reset-session').disabled = false;
  $('#finish-measurement').disabled = true;
  toast('확인한 스킬 슬롯으로 분석을 시작했습니다.');
}

function renderBuild() {
  const host = $('#deck-slots');
  if (!state.build) {
    host.className = 'deck-slots empty-deck';
    host.innerHTML = '<p>게임 창을 연결하면 현재 슬롯의 도술을 자동으로 인식합니다.</p>';
    $('#build-name').textContent = state.stream ? '스킬 슬롯 감지 중' : '게임 창 연결 대기';
    $('#build-status').textContent = '일반 도술 8개와 궁극기 1개를 자동으로 찾습니다.';
    $('#detect-confidence').textContent = state.stream ? '감지 중' : '대기';
    $('#detect-step').classList.remove('ready');
    $('#active-effects').innerHTML='<p>강화·약화 효과 발동을 기다리고 있습니다.</p>';
    $('#live-condition-rates').innerHTML='';
    $('#effect-timeline').className='effect-timeline empty-effect-timeline';
    $('#effect-timeline').innerHTML='<p>지속시간이 확인된 강화·약화 효과가 발동하면 표시합니다.</p>';
    return;
  }
  host.className = 'deck-slots';
  host.innerHTML = state.build.skills.map((id, index) => {
    const s = skill(id);
    const key = state.skillKeys.get(id) || (s.ultimate ? 'R' : String(index + 1));
    const effects=effectsFor(id),effectCount=effects.buffs.length+effects.debuffs.length;
    const stage=Number(state.breakthroughStages.get(id)||0);
    return `<article class="deck-slot" data-skill="${id}" title="${escapeHtml([...effects.buffs,...effects.debuffs].join(' · '))}"><small>${escapeHtml(key)}</small><img src="${iconUrl(id)}" alt=""><div><b>${escapeHtml(s.name)}</b><span>${escapeHtml(s.family)}${stage?` · 돌파 ${stage}`:''}${s.ultimate?' · 궁극기':''}${effectCount?` · 효과 ${effectCount}`:''}</span></div></article>`;
  }).join('');
  $('#build-name').textContent = '스킬 슬롯 9개 감지 완료';
  $('#build-status').textContent = '게임 화면을 기준으로 사용과 피해를 측정합니다.';
  $('#detect-confidence').textContent = state.detectionConfidence >= 1 ? '확인됨' : '확인 필요';
  $('#detect-step').classList.add('ready');
  renderEfficiency(emptyReport());
}

function emptyReport() {
  return { casts:0, rows:(state.build?.skills || []).map(id => ({id,name:skill(id).name,family:skill(id).family,count:0,inferredCount:0,meanInterval:null,cooldown:Number(skill(id).cooldown || skill(id).basic?.cooldown || 0),utilization:null})) };
}

function report() {
  if (!state.build) return emptyReport();
  const casts = state.events.filter(event => event.type === 'cast' && state.build.skills.includes(event.skillId));
  const times = Object.fromEntries(state.build.skills.map(id => [id, []]));
  const inferred=Object.fromEntries(state.build.skills.map(id=>[id,0]));
  for (const event of casts) {
    times[event.skillId].push(event.at);
    if(event.evidence==='sequence')inferred[event.skillId]+=1;
  }
  const rows = state.build.skills.map(id => {
    const s = skill(id), values = times[id], intervals = values.slice(1).map((at,i)=>(at-values[i])/1000);
    const meanInterval = intervals.length ? intervals.reduce((a,b)=>a+b,0)/intervals.length : null;
    const cooldown = Number(s.cooldown || s.basic?.cooldown || 0);
    return { id, name:s.name, family:s.family, count:values.length, inferredCount:inferred[id], meanInterval, cooldown, utilization:meanInterval&&cooldown?Math.min(100,cooldown/meanInterval*100):null };
  });
  return { casts:casts.length, rows };
}

function effectKey(value){return String(value||'').replace(/\s+/g,'').toLowerCase();}
function formatTimelineSecond(value){const seconds=Math.max(0,Math.round(value/1000));return seconds>=60?`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`:`${seconds}초`;}

function effectTimelineMarkup(analysis,start,end,live=false){
  const duration=Math.max(1000,end-start),groups=new Map();
  for(const window of analysis.windows||[]){
    if(window.end<start||window.start>end)continue;
    const key=effectKey(window.effect);
    if(!groups.has(key))groups.set(key,{effect:window.effect,kind:window.kind,windows:[],attempts:[]});
    groups.get(key).windows.push(window);
  }
  for(const attempt of analysis.attempts||[]){
    if(attempt.at<start||attempt.at>end)continue;
    const key=effectKey(attempt.effect);
    if(!groups.has(key))groups.set(key,{effect:attempt.effect,kind:'debuff',windows:[],attempts:[]});
    groups.get(key).attempts.push(attempt);
  }
  if(!groups.size)return '<p class="empty-effect-result">판정 가능한 강화·약화 발동 기록이 아직 없습니다.</p>';
  const rows=[...groups.values()].sort((a,b)=>(a.kind==='buff'?0:1)-(b.kind==='buff'?0:1)||a.effect.localeCompare(b.effect,'ko')).map(group=>{
    const producers=[...new Set(group.windows.map(value=>value.producerName).filter(Boolean))];
    const windows=group.windows.map(window=>{
      const from=Math.max(start,window.start),to=Math.min(end,window.end),left=(from-start)/duration*100,width=Math.max(.3,(to-from)/duration*100),remaining=Math.max(0,window.end-end);
      const title=`${window.effect} · ${window.producerName} · ${window.duration}초${window.evidence==='sequence'?' · 순서 복원':' · 직접 감지'}`;
      return `<span class="effect-window ${window.kind==='debuff'?'debuff':''} ${window.evidence==='sequence'?'recovered':''}" style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%" title="${escapeHtml(title)}">${remaining>0?`${(remaining/1000).toFixed(1)}초`:''}</span>`;
    }).join('');
    const attempts=group.attempts.map(attempt=>{const left=(attempt.at-start)/duration*100,title=`${attempt.consumerName} × ${attempt.effect} · ${attempt.status==='success'?`성공${attempt.remainingMs!=null?` · ${(attempt.remainingMs/1000).toFixed(1)}초 남음`:''}`:attempt.status==='miss'?'실패':'판정 불가'}${attempt.evidence==='sequence'?' · 순서 복원':' · 직접 감지'}`;return `<span class="condition-marker ${attempt.status}" style="left:${left.toFixed(3)}%" title="${escapeHtml(title)}">${attempt.status==='success'?'✓':attempt.status==='miss'?'!':'?'}</span>`;}).join('');
    return `<div class="effect-row"><div class="effect-row-label"><i class="${group.kind==='debuff'?'debuff':''}"></i><div><b>${escapeHtml(group.effect)}</b><small>${group.kind==='buff'?'내 강화':'적 약화'}${producers.length?` · ${escapeHtml(producers.join('·'))}`:''}</small></div></div><div class="effect-row-track">${windows}${attempts}</div></div>`;
  }).join('');
  const axis=live?'<span>-30초</span><span>-20초</span><span>-10초</span><span>현재</span>':`<span>0초</span><span>${formatTimelineSecond(duration/3)}</span><span>${formatTimelineSecond(duration*2/3)}</span><span>${formatTimelineSecond(duration)}</span>`;
  return `${rows}<div class="effect-axis">${axis}</div>`;
}

function renderLiveEffects(analysis,now=Date.now()){
  const active=analysis.activeEffects||[];
  $('#active-effects').innerHTML=active.length?active.map(value=>{const remaining=Math.max(0,value.end-now),progress=Math.max(0,Math.min(100,remaining/(value.duration*1000)*100));return `<article class="active-effect ${value.kind}"><b>${value.kind==='buff'?'강화':'약화'} · ${escapeHtml(value.effect)}</b><small>${(remaining/1000).toFixed(1)}초 남음 · ${escapeHtml(value.producerName)}${value.evidence==='sequence'?' · 순서 복원':''}</small><div class="effect-countdown"><i style="width:${progress.toFixed(1)}%"></i></div></article>`;}).join(''):'<p>현재 유지 중인 지속시간 확인 효과가 없습니다.</p>';
  const conditions=(analysis.conditions||[]).filter(value=>value.total||value.unknown);
  $('#live-condition-rates').innerHTML=conditions.map(value=>`<div class="live-condition-rate ${value.missed?'miss':''}"><b>${escapeHtml(value.consumerName)} × ${escapeHtml(value.effect)}</b><span>${value.total?`${value.covered}/${value.total}회 · ${Math.round(value.rate)}%`:`판정 불가 ${value.unknown}회`}</span></div>`).join('');
}

function renderEffectTimeline(analysis,now=Date.now()){
  const start=now-30000,host=$('#effect-timeline');
  host.className='effect-timeline';
  host.innerHTML=effectTimelineMarkup(analysis,start,now,true);
}

function renderReport() {
  const r = report();
  const now=Date.now(),effects=effectAnalysis(now);
  $('#metric-match').textContent = `${state.slotMap.size}/9`;
  $('#metric-match-sub').textContent = state.build ? '사용자가 실제 슬롯 확인' : state.pendingSlots.length===9 ? '자동 후보 확인 필요' : '스킬 슬롯 감지 중';
  $('#metric-casts').textContent = `${r.casts}회`;
  const elapsed = state.startedAt ? Math.floor((Date.now()-state.startedAt)/1000) : 0;
  $('#metric-casts-sub').textContent = `${String(Math.floor(elapsed/60)).padStart(2,'0')}:${String(elapsed%60).padStart(2,'0')}`;
  const basics=state.events.filter(event=>event.type==='basic').length,totalActions=basics+r.casts;
  $('#metric-basic').textContent=`${basics}회`;
  $('#metric-basic-sub').textContent=`전체 행동의 ${totalActions?Math.round(basics/totalActions*100):0}%`;
  const delayed = r.rows.filter(row => row.count >= 2 && row.utilization != null && row.utilization < 70);
  $('#metric-breaks').textContent = `${delayed.length}개`;
  $('#metric-breaks-sub').textContent = delayed.length ? delayed.map(row => row.name).slice(0,2).join(', ') : '지연 없음';
  $('#metric-dps').textContent = state.ocr.dps == null ? '—' : fmt(state.ocr.dps);
  $('#metric-dps-sub').textContent = state.ocr.dps == null ? '피해 측정기 인식 대기' : `누적 ${fmt(state.ocr.total)}`;
  $('#timeline-now').textContent = $('#metric-casts-sub').textContent;
  renderFindings(r,effects);
  renderLiveEffects(effects,now);
  renderEffectTimeline(effects,now);
  renderTimeline();
  renderEfficiency(r);
}

function renderFindings(r,effects=effectAnalysis()) {
  const list = [];
  if (!r.casts) list.push({kind:'neutral',icon:'◎',title:'실전 사용 감지 중',body:'스킬 아이콘의 준비 상태가 재사용 대기 상태로 바뀌는 순간을 사용으로 기록합니다.'});
  if (state.build) list.push({kind:'good',icon:'✓',title:'스킬 슬롯 사용자 확인 완료',body:'직접 확인한 일반 도술 8개와 궁극기 1개를 기준으로 분석합니다.'});
  const recovered=state.events.filter(event=>event.type==='cast'&&event.evidence==='sequence').length;
  if(recovered)list.push({kind:'warn',icon:'↺',title:`감지 누락 ${recovered}회 자동 복원`,body:'확정한 사용 순서와 재사용 시간을 기준으로 직접 감지되지 않은 발동을 복원해 효율 계산에 포함했습니다.'});
  const delayed = r.rows.filter(row => row.count >= 2 && row.utilization != null && row.utilization < 70).sort((a,b)=>a.utilization-b.utilization)[0];
  if (delayed) list.push({kind:'warn',icon:'△',title:`${delayed.name} 재사용 지연`,body:`기본 재사용 ${delayed.cooldown.toFixed(1)}초보다 실제 평균 사용 간격 ${delayed.meanInterval.toFixed(1)}초가 깁니다.`});
  const missed=(effects.conditions||[]).filter(value=>value.missed>0).sort((a,b)=>b.missed-a.missed)[0];
  if(missed)list.push({kind:'warn',icon:'!',title:`${missed.consumerName} · ${missed.effect} 조건 ${missed.missed}회 실패`,body:`판정 가능 ${missed.total}회 중 ${missed.covered}회 충족했습니다. 측정 완료 후 실패 시점을 확인하세요.`});
  if (state.ocr.dps != null) list.push({kind:'good',icon:'↗',title:`실측 초당 피해 ${fmt(state.ocr.dps)}`,body:'게임 내 피해 측정기 값을 읽었습니다. 도술별 행은 아이콘과 함께 계속 갱신합니다.'});
  $('#findings').innerHTML = list.slice(0,4).map(item=>`<article class="finding ${item.kind}"><i>${item.icon}</i><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.body)}</p></div></article>`).join('');
}

function renderTimeline() {
  const host = $('#timeline');
  const cutoff = Date.now() - 30000;
  const recent = state.events.filter(event => event.type==='cast' && event.at >= cutoff);
  if (!recent.length) { host.className='timeline empty-timeline'; host.innerHTML='<p>스킬 사용을 감지하면 시간순으로 표시합니다.</p>'; return; }
  host.className='timeline';
  host.innerHTML = `<div class="timeline-track">${recent.map(event=>{const left=Math.max(0,Math.min(100,(event.at-cutoff)/300)),value=skill(event.skillId),effects=effectsFor(event.skillId),effectText=[...effects.buffs.map(name=>`강화 ${name}`),...effects.debuffs.map(name=>`약화 ${name}`)].join(', '),source=event.evidence==='sequence'?'순서로 복원':'슬롯 직접 감지';return `<div class="timeline-event ${event.evidence==='sequence'?'inferred':''}" style="left:${left}%" title="${escapeHtml(value?.name||event.skillId)} · ${source}${effectText?' · '+escapeHtml(effectText):''}"><img src="${iconUrl(event.skillId)}" alt=""><span>${event.evidence==='sequence'?'복원 ':''}-${((Date.now()-event.at)/1000).toFixed(1)}초</span></div>`}).join('')}</div><div class="timeline-axis"><span>-30초</span><span>-20초</span><span>-10초</span><span>현재</span></div>`;
}

function renderEfficiency(r) {
  if (!state.build) return;
  const knownShares=state.ocr.rows.filter(value=>value.share!=null),knownShare=knownShares.reduce((sum,value)=>sum+Number(value.share||0),0);
  $('#damage-coverage').textContent=state.ocr.dps==null?'피해 측정기 OCR 대기 중입니다.':`피해 측정기 실측 ${knownShares.length}/${state.build.skills.length}개 · 실측 점유율 합계 ${knownShare.toFixed(1)}% · 화면에 없는 도술은 집계 제외`;
  $('#efficiency-body').innerHTML = r.rows.map(row => {
    const off = disabledSet().has(row.id);
    const verdict = off ? ['OFF',''] : row.count < 2 ? ['관측 중',''] : row.utilization >= 85 ? ['원활','good'] : row.utilization >= 65 ? ['지연','warn'] : ['낭비 큼','warn'];
    const actual=state.ocr.rows.find(value=>value.skillId===row.id);
    const unmeasured='<span class="unmeasured" title="게임 피해 측정기 화면에 해당 도술 행이 표시되지 않아 실측할 수 없습니다. 0을 의미하지 않습니다.">측정기 미표시</span>';
    return `<tr><td><div class="skill-cell"><img src="${iconUrl(row.id)}" alt=""><div><b>${escapeHtml(row.name)}</b><small>${off?'자동 사용 제외':'실시간 관측'}</small></div></div></td><td>${escapeHtml(row.family)}</td><td>${effectChips(row.id)}</td><td>${row.count}회${row.inferredCount?`<small class="inferred-count">복원 ${row.inferredCount}</small>`:''}</td><td>${actual?fmt(actual.damage):unmeasured}</td><td>${actual&&actual.share!=null?actual.share.toFixed(1)+'%':unmeasured}</td><td>${row.meanInterval?row.meanInterval.toFixed(1)+'초':'—'}</td><td>${row.cooldown?row.cooldown.toFixed(1)+'초':'—'}</td><td>${row.utilization==null?'—':`<div class="bar"><i style="width:${Math.round(row.utilization)}%"></i></div> ${Math.round(row.utilization)}%`}</td><td><span class="judgement ${verdict[1]}">${verdict[0]}</span></td></tr>`;
  }).join('');
}

function renderRecommendation(result) {
  $('#result-summary').textContent = `도술 ${result.casts}회 · 평타 ${result.basicAttacks||0}회(전체 행동의 ${Math.round(result.basicShare||0)}%, 분당 ${(result.basicPerMinute||0).toFixed(1)}회) · 관측 ${Math.round(result.durationMs/1000)}초${state.ocr.dps!=null?` · 초당 피해 ${fmt(state.ocr.dps)}`:''}를 반영했습니다.`;
  $('#recommended-order').innerHTML = result.rows.map((row,index)=>{const before=state.currentOrder.indexOf(row.id),movement=before>=0&&before!==index?` · ${before+1}→${index+1}`:'';return `<article class="recommend-card"><strong>${index+1}</strong><img src="${iconUrl(row.id)}" alt=""><b>${escapeHtml(row.name)}</b><small>${escapeHtml(row.family)}${row.breakthroughStage?` · 돌파 ${row.breakthroughStage}`:''}${row.ultimate?' · 궁극기':''}${movement}</small></article>`}).join('');
  $('#recommendation-reasons').innerHTML = result.rows.map((row,index)=>`<article class="reason-card"><strong>${index+1}. ${escapeHtml(row.name)}</strong>${effectChips(row.id)}<p>${escapeHtml(row.reasons.join(' · '))}</p></article>`).join('');
  renderActionPlan(result);
  const conditions=result.conditionTiming||[];
  $('#condition-result-findings').innerHTML=conditions.length?conditions.map(item=>{
    const unknown=!item.total,tone=unknown?'unknown':item.missed?'miss':'good',remaining=item.meanRemainingMs!=null?` · 성공 시 평균 ${(item.meanRemainingMs/1000).toFixed(1)}초 남음`:'';
    return `<article class="condition-result-card ${tone}"><strong>${escapeHtml(item.consumerName)} × ${escapeHtml(item.effect)}</strong><b>${item.total?`${item.covered}/${item.total}회 · ${Math.round(item.rate)}%`:`판정 불가 ${item.unknown}회`}</b><p>${item.total?`실패 ${item.missed}회${remaining} · 직접 감지 ${item.direct}회 · 순서 복원 ${item.recovered}회`:'검증된 지속시간 또는 부여 도술이 없어 성공률에서 제외했습니다.'}</p></article>`;
  }).join(''):'<p class="empty-effect-result">현재 덱에는 시간 판정이 필요한 조건부 도술이 없습니다.</p>';
  const resultStart=state.startedAt||Math.min(...(result.effectState?.windows||[]).map(value=>value.start),Date.now()),resultEnd=result.finishedAt||Date.now();
  $('#result-effect-timeline').innerHTML=effectTimelineMarkup(result.effectState||{windows:[],attempts:[]},resultStart,resultEnd,false);
  const timed=(result.effectTiming||[]).filter(item=>item.casts>0);
  $('#effect-timing-findings').innerHTML=timed.length?timed.map(item=>{
    if(!item.known)return `<article class="effect-timing-card unknown"><strong>${escapeHtml(item.skillName)} → ${escapeHtml(item.effect)}</strong><b>${item.casts}회 발동 확정</b><p>지속시간이 없어 시간 연계 판정만 제외했습니다.</p></article>`;
    const ok=item.consumerCasts?item.coveredConsumers:item.casts,total=item.consumerCasts||item.casts;
    return `<article class="effect-timing-card ${item.missedConsumers?'miss':'good'}"><strong>${escapeHtml(item.skillName)} → ${escapeHtml(item.effect)} ${item.duration}초</strong><b>${item.consumerCasts?`조건 적중 ${ok}/${total}회`:`${item.casts}회 발동 확정`}</b><p>측정 기간 유지율 ${Math.round(item.coverage)}%${item.overlaps?` · 중복 ${item.overlaps}회`:''}</p></article>`;
  }).join(''):'<p class="empty-effect-result">발동한 강화·약화 효과가 아직 없습니다.</p>';
}

function renderActionPlan(result){
  const relations=result.relationships||[],changes=relations.filter(item=>item.action==='move-consumer-after-producer'||item.action==='move-global-buff-first'),misses=relations.filter(item=>Number(item.missed)>0).sort((a,b)=>b.missed-a.missed),missing=relations.filter(item=>item.action==='producer-missing');
  const cards=[];
  if(changes.length){
    cards.push({tone:'priority',label:'1. 순서를 이렇게 바꾸세요',title:changes.map(item=>item.action==='move-global-buff-first'?`${item.producerName} → 1번`:`${item.producerName} → ${item.consumerName}`).join(' · '),body:changes.map(item=>item.action==='move-global-buff-first'?`전역 공격 강화를 받도록 ${item.producerName}을(를) 가장 앞으로 이동`:`${item.consumerName}을(를) ${item.producerName} 바로 뒤로 이동${item.durationKnown?'':` (${item.effect} 지속시간 미확인이므로 즉시 소비)`}`).join(' / ')});
  }else{
    cards.push({tone:'good',label:'1. 순서 변경',title:'현재 순서 유지',body:'측정에서 확인된 강화·약화 연계 때문에 옮길 도술이 없습니다.'});
  }
  if(misses.length){
    const worst=misses[0];cards.push({tone:'warn',label:'2. 가장 먼저 줄일 손실',title:`${worst.effect} 조건 ${worst.missed}회 놓침`,body:`${worst.producerName} 후 ${worst.duration?worst.duration+'초 안에 ':''}${worst.consumerName}을 사용하세요. 재측정 목표는 0회입니다.`});
  }else if(relations.some(item=>item.total>0)){
    const checked=relations.filter(item=>item.total>0).reduce((sum,item)=>sum+item.total,0);cards.push({tone:'good',label:'2. 효과 연계',title:`관측 ${checked}회에서 조건 누락 없음`,body:'현재 배치에서 조건부 피해 증가가 정상적으로 연계됩니다.'});
  }else{
    cards.push({tone:'neutral',label:'2. 효과 연계',title:'판정할 조건 표본 부족',body:'추가 측정 후 지속시간 안의 후속 도술 적중률을 다시 확인하세요.'});
  }
  cards.push({tone:'neutral',label:'3. 평타 활용',title:`${result.basicAttacks||0}회 · 분당 ${(result.basicPerMinute||0).toFixed(1)}회 · 행동 비중 ${Math.round(result.basicShare||0)}%`,body:(result.basicShare||0)<5?'스킬 연속 사용이 주력입니다. 평타 피해 점유율이 크지 않다면 순서를 바꿀 이유가 없습니다.':'평타가 스킬 사이 빈 구간에 충분히 발동했습니다.'});
  if(missing.length)cards.push({tone:'warn',label:'덱 구성 확인',title:`${missing.map(item=>item.effect).join('·')} 부여 도술 없음`,body:`${missing.map(item=>item.consumerName).join('·')}의 조건 효과를 활용하려면 해당 약화 부여 도술을 덱에 넣으세요.`});
  $('#action-plan').innerHTML=cards.map(card=>`<article class="action-card ${card.tone}"><small>${escapeHtml(card.label)}</small><strong>${escapeHtml(card.title)}</strong><p>${escapeHtml(card.body)}</p></article>`).join('');
}

function historyId() {
  return globalThis.crypto?.randomUUID?.() || `measurement-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatHistoryDate(value) {
  const date=new Date(Number(value||0));
  if(Number.isNaN(date.getTime()))return '—';
  return `${date.toLocaleDateString('ko-KR',{year:'numeric',month:'2-digit',day:'2-digit'})}<br><small>${date.toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'})}</small>`;
}

function formatDuration(ms) {
  const seconds=Math.max(0,Math.round(Number(ms||0)/1000)),minutes=Math.floor(seconds/60),rest=seconds%60;
  return minutes?`${minutes}분 ${rest}초`:`${rest}초`;
}

function recordSkillMap(record) {
  return new Map((record?.build?.skillSnapshots||[]).map(value=>[value.id,value]));
}

function recordSkill(record,id) {
  return recordSkillMap(record).get(id)||skill(id)||{id,name:id,family:'—'};
}

function defaultHistoryTitle() {
  const families=[...new Set((state.build?.skills||[]).map(id=>skill(id)).filter(value=>value&&!value.ultimate).map(value=>value.family))];
  return families.length?`${families.slice(0,2).join('·')} 빌드`:'실전 측정';
}

function conditionSummary(record) {
  const conditions=record?.result?.conditionTiming||[];
  const covered=conditions.reduce((sum,value)=>sum+Number(value.covered||0),0);
  const total=conditions.reduce((sum,value)=>sum+Number(value.total||0),0);
  return {covered,total,rate:total?covered/total*100:null};
}

function delayedRows(record) {
  return (record?.result?.rows||[]).filter(row=>row.count>=2&&row.utilization!=null&&row.utilization<70);
}

function cooldownUtilization(record) {
  const values=(record?.result?.rows||[]).map(row=>Number(row.utilization)).filter(Number.isFinite);
  return values.length?values.reduce((sum,value)=>sum+value,0)/values.length:null;
}

function createHistoryRecord(result,endedAt) {
  const previous=state.history.find(item=>item.id===state.historyRecordId);
  const breakthroughStages=Object.fromEntries(state.breakthroughStages.entries());
  return {
    schema:'dokkaebi-measurement-v1',
    id:state.historyRecordId||historyId(),
    createdAt:previous?.createdAt||endedAt,
    updatedAt:endedAt,
    title:previous?.title||defaultHistoryTitle(),
    favorite:Boolean(previous?.favorite),
    note:previous?.note||'',
    appVersion:state.appVersion,
    build:{
      name:state.build.name,
      signature:state.build.signature,
      skills:[...state.build.skills],
      currentOrder:[...state.currentOrder],
      breakthroughStages,
      skillSnapshots:state.build.skills.map(id=>skillAtStage(id))
    },
    measurement:{
      startedAt:state.startedAt,
      endedAt,
      durationMs:result.durationMs,
      events:state.events.map(value=>({...value})),
      ocr:{total:state.ocr.total,dps:state.ocr.dps,rows:state.ocr.rows.map(value=>({...value})),updatedAt:state.ocr.updatedAt}
    },
    result:JSON.parse(JSON.stringify(result))
  };
}

async function saveMeasurementHistory(result,endedAt) {
  const saved=await api.saveHistory(createHistoryRecord(result,endedAt));
  if(!saved)return;
  state.historyRecordId=saved.id;
  await loadHistory();
  toast(state.history.filter(item=>item.id===saved.id).length?'측정 결과를 히스토리에 저장했습니다.':'측정 결과를 저장했습니다.');
}

function switchAppView(name) {
  const history=name==='history';
  $('#live-view').hidden=history;
  $('#history-view').hidden=!history;
  $('#live-tab').classList.toggle('active',!history);
  $('#history-tab').classList.toggle('active',history);
  if(history)loadHistory();
}

function historySkillStrip(record) {
  const order=record.build?.currentOrder?.length?record.build.currentOrder:record.build?.skills||[];
  return `<div class="history-skill-strip">${order.map((id,index)=>{const value=recordSkill(record,id);return `<span class="history-skill" title="${escapeHtml(value.name)}"><img src="${iconUrl(id)}" alt=""><small>${index+1}</small></span>`;}).join('')}</div>`;
}

function measuredOrMissing(value,suffix='') {
  return value==null?'<span class="unmeasured">측정기 미표시</span>':`<span class="measured-value">${fmt(value)}${suffix}</span>`;
}

function renderHistory() {
  const query=$('#history-search').value.trim().toLocaleLowerCase('ko'),favorites=$('#history-favorites').checked;
  const records=state.history.filter(record=>{
    if(favorites&&!record.favorite)return false;
    const names=(record.build?.skillSnapshots||[]).map(value=>value.name).join(' ');
    return !query||`${record.title} ${record.note||''} ${names}`.toLocaleLowerCase('ko').includes(query);
  });
  $('#history-count').textContent=state.history.length;
  const body=$('#history-body');
  if(!records.length){body.innerHTML=`<tr><td colspan="11" class="empty-cell">${state.history.length?'검색 조건에 맞는 측정이 없습니다.':'완료한 측정이 아직 없습니다.'}</td></tr>`;return;}
  body.innerHTML=records.map(record=>{
    const condition=conditionSummary(record),delayed=delayedRows(record),selected=state.historySelected.has(record.id),dps=record.measurement?.ocr?.dps;
    return `<tr data-history-id="${escapeHtml(record.id)}" class="${selected?'selected':''}"><td><input class="history-select" type="checkbox" aria-label="비교 선택" ${selected?'checked':''}></td><td>${formatHistoryDate(record.measurement?.endedAt||record.updatedAt)}</td><td class="history-title-cell"><b>${escapeHtml(record.title)}</b><small>${record.favorite?'★ 즐겨찾기':`앱 ${escapeHtml(record.appVersion||'—')}`}</small></td><td>${historySkillStrip(record)}</td><td>${formatDuration(record.measurement?.durationMs)}</td><td>${measuredOrMissing(dps)}</td><td><span class="measured-value">${Math.round(Number(record.result?.basicShare||0))}%</span></td><td>${condition.rate==null?'<span class="history-muted">판정 불가</span>':`<span class="measured-value">${Math.round(condition.rate)}%</span><small class="history-muted"> ${condition.covered}/${condition.total}회</small>`}</td><td>${delayed.length?escapeHtml(delayed.slice(0,2).map(value=>value.name).join(', ')):'없음'}</td><td class="history-note">${escapeHtml(record.note||'—')}</td><td><button type="button" class="favorite-button ${record.favorite?'active':''}" aria-label="즐겨찾기">★</button></td></tr>`;
  }).join('');
  body.querySelectorAll('[data-history-id]').forEach(row=>{
    const id=row.dataset.historyId;
    row.onclick=event=>{if(event.target.closest('input,button'))return;openHistoryDetail(id);};
    row.querySelector('.history-select').onchange=event=>selectHistory(id,event.target.checked);
    row.querySelector('.favorite-button').onclick=()=>toggleHistoryFavorite(id);
  });
}

function selectHistory(id,checked) {
  if(checked&&state.historySelected.size>=2){toast('비교할 측정은 두 개까지 선택할 수 있습니다.');renderHistory();return;}
  if(checked)state.historySelected.add(id);else state.historySelected.delete(id);
  const count=state.historySelected.size;
  $('#compare-count').textContent=count;
  $('#compare-history').disabled=count!==2;
  if(count!==2)$('#history-compare-panel').hidden=true;
  renderHistory();
}

async function toggleHistoryFavorite(id) {
  const record=state.history.find(item=>item.id===id);if(!record)return;
  await api.updateHistory(id,{favorite:!record.favorite});
  await loadHistory();
}

async function loadHistory() {
  try{
    state.history=await api.listHistory();
    const valid=new Set(state.history.map(item=>item.id));
    state.historySelected=new Set([...state.historySelected].filter(id=>valid.has(id)));
    $('#compare-count').textContent=state.historySelected.size;
    $('#compare-history').disabled=state.historySelected.size!==2;
    renderHistory();
  }catch(error){toast(`히스토리를 불러오지 못했습니다: ${error.message}`);}
}

function detailUnmeasured() {
  return '<span class="unmeasured">측정기 미표시</span>';
}

function openHistoryDetail(id) {
  const record=state.history.find(item=>item.id===id);if(!record)return;
  state.historyDetailId=id;
  const condition=conditionSummary(record),dps=record.measurement?.ocr?.dps;
  $('#history-detail-title').textContent=record.title;
  $('#history-detail-summary').textContent=`${new Date(record.measurement.endedAt).toLocaleString('ko-KR')} · ${formatDuration(record.measurement.durationMs)} · 도술 ${record.result.casts||0}회 · 평타 ${record.result.basicAttacks||0}회${dps!=null?` · 실측 DPS ${fmt(dps)}`:' · DPS 측정기 미표시'}`;
  const order=record.build.currentOrder?.length?record.build.currentOrder:record.build.skills;
  $('#history-detail-order').innerHTML=order.map((skillId,index)=>{const value=recordSkill(record,skillId),stage=Number(record.build.breakthroughStages?.[skillId]||0);return `<div class="history-order-skill"><strong>${index+1}</strong><img src="${iconUrl(skillId)}" alt=""><div><b>${escapeHtml(value.name)}</b><small>${escapeHtml(value.family)}${stage?` · 돌파 ${stage}`:''}${value.ultimate?' · 궁극기':''}</small></div></div>`;}).join('');
  $('#history-detail-effects').innerHTML=effectTimelineMarkup(record.result.effectState||{windows:[],attempts:[]},record.measurement.startedAt,record.measurement.endedAt,false);
  const damageRows=record.measurement.ocr?.rows||[];
  $('#history-detail-efficiency').innerHTML=(record.result.rows||[]).map(row=>{const actual=damageRows.find(value=>value.skillId===row.id),verdict=row.count<2?['관측 중','']:row.utilization>=85?['원활','good']:row.utilization>=65?['지연','warn']:['낭비 큼','warn'];return `<tr><td><div class="skill-cell"><img src="${iconUrl(row.id)}" alt=""><div><b>${escapeHtml(row.name)}</b><small>${escapeHtml(row.family)}</small></div></div></td><td>${row.count}회${row.inferredCount?`<small class="inferred-count">복원 ${row.inferredCount}</small>`:''}</td><td>${actual?fmt(actual.damage):detailUnmeasured()}</td><td>${actual&&actual.share!=null?`${actual.share.toFixed(1)}%`:detailUnmeasured()}</td><td>${row.meanInterval?`${row.meanInterval.toFixed(1)}초`:'—'}</td><td>${row.utilization==null?'—':`${Math.round(row.utilization)}%`}</td><td><span class="judgement ${verdict[1]}">${verdict[0]}</span></td></tr>`;}).join('');
  const conditions=record.result.conditionTiming||[];
  $('#history-detail-conditions').innerHTML=conditions.length?conditions.map(item=>`<tr><td><b>${escapeHtml(item.consumerName)} × ${escapeHtml(item.effect)}</b></td><td>${item.total?`${item.covered}회`:'판정 불가'}</td><td>${item.total?`${item.missed}회`:'—'}</td><td>${item.total?`${Math.round(item.rate)}%`:'비교 불가'}</td><td>${item.meanRemainingMs!=null?`${(item.meanRemainingMs/1000).toFixed(1)}초`:'—'}</td><td>직접 ${item.direct||0}회 · 순서 복원 ${item.recovered||0}회</td></tr>`).join(''):'<tr><td colspan="6" class="empty-cell">시간 판정이 필요한 조건부 도술이 없습니다.</td></tr>';
  $('#history-detail-recommendation').innerHTML=(record.result.rows||[]).map((row,index)=>{const before=(record.build.currentOrder||[]).indexOf(row.id);return `<tr><td><b>${index+1}</b></td><td><div class="skill-cell"><img src="${iconUrl(row.id)}" alt=""><b>${escapeHtml(row.name)}</b></div></td><td>${escapeHtml(row.family)}</td><td>${before<0?'—':before===index?'유지':`${before+1} → ${index+1}`}</td><td>${escapeHtml((row.reasons||[]).join(' · '))}</td></tr>`;}).join('');
  $('#history-detail-name').value=record.title;
  $('#history-detail-note').value=record.note||'';
  $('#history-detail-favorite').checked=Boolean(record.favorite);
  $('#history-detail-dialog').showModal();
}

async function saveHistoryDetail() {
  const id=state.historyDetailId;if(!id)return;
  const title=$('#history-detail-name').value.trim();
  if(!title){toast('빌드 이름을 입력하세요.');return;}
  await api.updateHistory(id,{title,note:$('#history-detail-note').value,favorite:$('#history-detail-favorite').checked});
  $('#history-detail-dialog').close();
  await loadHistory();
  toast('측정 기록을 수정했습니다.');
}

async function deleteHistoryDetail() {
  const id=state.historyDetailId;if(!id)return;
  if(!confirm('이 측정 기록을 삭제할까요?'))return;
  await api.deleteHistory(id);
  state.historySelected.delete(id);
  if(state.historyRecordId===id)state.historyRecordId=null;
  $('#history-detail-dialog').close();
  await loadHistory();
  toast('측정 기록을 삭제했습니다.');
}

function comparisonDifference(a,b,type) {
  if(a==null||b==null)return '<span class="compare-unavailable">비교 불가</span>';
  const difference=b-a;
  if(Math.abs(difference)<.05)return '<span class="compare-unavailable">차이 없음</span>';
  let text='';
  if(type==='dps')text=`${difference>0?'+':''}${fmt(Math.round(difference))} (${a?`${difference/a*100>0?'+':''}${(difference/a*100).toFixed(1)}%`:'기준 없음'})`;
  else if(type==='count')text=`${difference>0?'+':''}${Math.round(difference)}개`;
  else text=`${difference>0?'+':''}${difference.toFixed(1)}%p`;
  const improvement=type==='count'?difference<0:difference>0;
  return `<span class="${improvement?'compare-positive':'compare-negative'}">${escapeHtml(text)}</span>`;
}

function showHistoryComparison() {
  const records=[...state.historySelected].map(id=>state.history.find(item=>item.id===id)).filter(Boolean);
  if(records.length!==2)return;
  const [a,b]=records,conditionA=conditionSummary(a).rate,conditionB=conditionSummary(b).rate;
  const metrics=[
    {label:'실측 DPS',a:a.measurement.ocr?.dps,b:b.measurement.ocr?.dps,format:value=>value==null?'측정기 미표시':fmt(value),type:'dps'},
    {label:'평타 행동 비중',a:Number(a.result.basicShare||0),b:Number(b.result.basicShare||0),format:value=>`${Math.round(value)}%`,type:'rate'},
    {label:'조건 적중률',a:conditionA,b:conditionB,format:value=>value==null?'비교 불가':`${Math.round(value)}%`,type:'rate'},
    {label:'평균 재사용 활용',a:cooldownUtilization(a),b:cooldownUtilization(b),format:value=>value==null?'비교 불가':`${Math.round(value)}%`,type:'rate'},
    {label:'지연 도술',a:delayedRows(a).length,b:delayedRows(b).length,format:value=>`${value}개`,type:'count'},
    {label:'측정 시간',a:a.measurement.durationMs,b:b.measurement.durationMs,format:formatDuration,type:'duration'}
  ];
  $('#compare-head').innerHTML=`<tr><th>항목</th><th>${escapeHtml(a.title)}</th><th>${escapeHtml(b.title)}</th><th>비교 결과</th></tr>`;
  $('#compare-body').innerHTML=metrics.map(metric=>`<tr><td><b>${metric.label}</b></td><td class="compare-value">${metric.format(metric.a)}</td><td class="compare-value">${metric.format(metric.b)}</td><td>${metric.type==='duration'?'<span class="compare-unavailable">측정 구간 참고</span>':comparisonDifference(metric.a,metric.b,metric.type)}</td></tr>`).join('');
  $('#history-compare-panel').hidden=false;
  $('#history-compare-panel').scrollIntoView({behavior:'smooth',block:'start'});
}

async function finishMeasurement() {
  if (!state.build || !state.events.some(event=>event.type==='cast')) { toast('추천하려면 먼저 스킬 사용 기록이 필요합니다.'); return; }
  state.running=false;
  cancelAnimationFrame(state.loopId);
  $('#toggle-analysis').textContent='분석 계속';
  $('#analysis-state').textContent='측정 완료';
  $('#analysis-subtitle').textContent='관측 데이터로 추천 순서를 계산했습니다.';
  const endedAt=Date.now();
  const result=api.optimizeSequence({skills:state.build.skills.map(id=>skillAtStage(id)),events:state.events,damageRows:state.ocr.rows,startedAt:state.startedAt,endedAt,currentOrder:state.currentOrder});
  result.finishedAt=endedAt;
  if(state.startedAt)result.durationMs=Math.max(0,Date.now()-state.startedAt);
  renderRecommendation(result);
  $('#result-dialog').showModal();
  try{await saveMeasurementHistory(result,endedAt);}catch(error){toast(`측정 기록을 저장하지 못했습니다: ${error.message}`);}
}

function continueMeasurement() {
  $('#result-dialog').close();
  if (!state.stream || state.running) return;
  state.running=true;
  $('#toggle-analysis').textContent='일시 정지';
  $('#analysis-state').textContent='실시간 분석 중';
  $('#analysis-subtitle').textContent='기존 기록에 이어 추가로 측정합니다.';
  state.loopId=requestAnimationFrame(observeFrame);
}

function updateReadyState() {
  const connected = Boolean(state.stream);
  $('#toggle-analysis').disabled = !(connected && state.build);
  $('#analysis-step').classList.toggle('ready', Boolean(state.build && connected));
  if (!connected) return;
  if (!state.build) {
    $('#analysis-state').textContent = '스킬 슬롯 감지 중';
    $('#analysis-subtitle').textContent = '현재 게임 화면에서 도술 아이콘을 찾고 있습니다.';
  } else if (state.running) {
    $('#analysis-state').textContent = '실시간 분석 중';
    $('#analysis-subtitle').textContent = '사용 간격과 피해 측정기 값을 계속 갱신합니다.';
  }
}

async function listSources() {
  const host = $('#source-list');
  host.innerHTML = '<p>열려 있는 창을 확인하고 있습니다…</p>';
  try {
    const sources = await api.listSources();
    sources.sort((a,b)=>Number(/도깨비|Dokkaebi/i.test(b.name))-Number(/도깨비|Dokkaebi/i.test(a.name)));
    host.innerHTML = sources.map(source => `<button type="button" class="source-card ${/도깨비|Dokkaebi/i.test(source.name)?'recommended':''}" data-source="${escapeHtml(source.id)}"><img src="${source.thumbnail}" alt=""><span>${escapeHtml(source.name)}</span></button>`).join('') || '<p>선택할 수 있는 창이 없습니다.</p>';
    host.querySelectorAll('[data-source]').forEach((button,index)=>button.onclick=()=>startCapture(sources[index]));
  } catch (error) { host.innerHTML = `<p>${escapeHtml(error.message)}</p>`; }
}

async function openSourceDialog() {
  await listSources();
  $('#source-dialog').showModal();
}

async function startCapture(source) {
  stopCapture();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio:false,
      video:{ mandatory:{ chromeMediaSource:'desktop', chromeMediaSourceId:source.id, maxFrameRate:30 } }
    });
    state.stream = stream;
    state.source = source;
    const video = $('#preview');
    video.srcObject = stream;
    await video.play();
    $('#source-dialog').close();
    $('#preview-empty').hidden = true;
    $('#source-name').textContent = source.name;
    $('#window-step').classList.add('ready');
    $('#capture-state')?.classList.add('live');
    $('.capture-state').classList.add('live');
    $('#capture-label').textContent = '실시간 연결';
    $('#resolution').textContent = `${video.videoWidth} × ${video.videoHeight}`;
    $('#recalibrate').disabled = false;
    updateOutlines();
    state.running = true;
    state.startedAt = 0;
    state.events = [];
    state.slotMap.clear();
    state.basicState = null;
    state.skillKeys.clear();
    state.pendingSlots = [];
    state.currentOrder = [];
    state.historyRecordId = null;
    state.sequenceCursor = null;
    state.lastVisualCast = null;
    state.build = null;
    $('#confirm-slots').disabled = false;
    renderBuild();
    $('#toggle-analysis').textContent = '일시 정지';
    $('#reset-session').disabled = true;
    cancelAnimationFrame(state.loopId);
    state.loopId = requestAnimationFrame(observeFrame);
    updateReadyState();
    toast(`${source.name} 창을 연결했습니다.`);
    stream.getVideoTracks()[0].addEventListener('ended', () => { stopCapture(); updateReadyState(); });
  } catch (error) { toast(`게임 창을 연결하지 못했습니다: ${error.message}`); }
}

function stopCapture() {
  if (state.stream) state.stream.getTracks().forEach(track=>track.stop());
  state.stream = null;
  state.running = false;
  cancelAnimationFrame(state.loopId);
}

function updateOutlines() {
  const wrap=$('#preview-wrap'), video=$('#preview');
  if (!video.videoWidth) return;
  const scale=Math.min(wrap.clientWidth/video.videoWidth,wrap.clientHeight/video.videoHeight);
  const shownW=video.videoWidth*scale,shownH=video.videoHeight*scale,left=(wrap.clientWidth-shownW)/2,top=(wrap.clientHeight-shownH)/2;
  for (const [id,region] of [['#hotbar-outline',state.regions.hotbar],['#meter-outline',state.regions.meter]]) {
    const el=$(id); el.style.display='block'; el.style.left=`${left+region.x*shownW}px`;el.style.top=`${top+region.y*shownH}px`;el.style.width=`${region.w*shownW}px`;el.style.height=`${region.h*shownH}px`;
  }
}

function featureFromCanvas(canvas, context, source, size=20) {
  canvas.width=size;canvas.height=size;
  if(context.canvas!==canvas)context=canvas.getContext('2d',{willReadFrequently:true});
  context.clearRect(0,0,size,size);
  context.drawImage(source,0,0,size,size);
  const data=context.getImageData(0,0,size,size).data;
  const values=[], lumas=[], chromas=[];
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const dx=(x+.5)/size-.5,dy=(y+.5)/size-.5;if(dx*dx+dy*dy>.22)continue;
    const i=(y*size+x)*4,r=data[i],g=data[i+1],b=data[i+2],max=Math.max(r,g,b),min=Math.min(r,g,b),chroma=max-min;
    values.push((r+1)/(max+1),(g+1)/(max+1),(b+1)/(max+1),chroma/255);
    lumas.push((r*.2126+g*.7152+b*.0722)/255);
    chromas.push(chroma/255);
  }
  const mean=lumas.reduce((a,b)=>a+b,0)/lumas.length;
  return {values,luma:mean,chroma:chromas.reduce((a,b)=>a+b,0)/chromas.length};
}

function similarity(a,b) {
  if(!a||!b||a.values.length!==b.values.length)return 0;
  let dot=0,aa=0,bb=0;
  for(let i=0;i<a.values.length;i++){dot+=a.values[i]*b.values[i];aa+=a.values[i]*a.values[i];bb+=b.values[i]*b.values[i];}
  return dot/Math.sqrt(aa*bb||1);
}

async function prepareTemplates() {
  state.templateFeatures.clear();
  const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d',{willReadFrequently:true});
  await Promise.all(state.catalog.skills.map(({id})=>new Promise(resolve=>{
    const image=new Image();image.onload=()=>{state.templateFeatures.set(id,featureFromCanvas(canvas,ctx,image));resolve();};image.onerror=resolve;image.src=iconUrl(id);
  })));
}

function slotDefinitions() {
  return [
    {key:'F1',x:.785,y:.805},{key:'F2',x:.820,y:.805},{key:'F3',x:.855,y:.805},{key:'R',x:.891,y:.805},
    {key:'1',x:.785,y:.875},{key:'2',x:.820,y:.875},{key:'3',x:.855,y:.875},{key:'4',x:.891,y:.875},{key:'5',x:.926,y:.875}
  ];
}

function basicAttackDefinition(){return {key:'Space',x:.926,y:.805};}

function displaySlotKeys() { return ['1','2','3','4','5','F1','F2','F3','R']; }

function mapSlots(observed) {
  if (!state.templateFeatures.size) return;
  const pairs=[];
  observed.forEach((item,index)=>state.catalog.skills.forEach(candidate=>{
    if (Boolean(candidate.ultimate) !== (item.pos.key === 'R')) return;
    pairs.push({index,id:candidate.id,key:item.pos.key,score:similarity(item.feature,state.templateFeatures.get(candidate.id))});
  }));
  pairs.sort((a,b)=>b.score-a.score);
  const usedSlots=new Set(),usedIds=new Set(),next=new Map();
  for(const pair of pairs){
    if(pair.score < .72 || usedSlots.has(pair.index)||usedIds.has(pair.id))continue;
    usedSlots.add(pair.index);usedIds.add(pair.id);next.set(pair.index,pair);
  }
  state.slotMap=next;
  if(next.size!==9){renderReport();return;}
  const ordered=displaySlotKeys().map(key=>[...next.values()].find(pair=>pair.key===key));
  if(ordered.some(value=>!value))return;
  const confidence=ordered.reduce((sum,value)=>sum+value.score,0)/ordered.length;
  const signature=ordered.map(value=>value.id).join('|');
  if(state.pendingSlots.map(value=>value.id).join('|')===signature)return;
  state.pendingSlots=ordered.map(value=>({id:value.id,key:value.key,score:value.score,preview:observed[value.index]?.preview||''}));
  state.detectionConfidence=confidence;
  $('#build-name').textContent='자동 후보 9개 확인 필요';
  $('#build-status').textContent='실제 사용 순서와 비교한 뒤 확인해야 분석을 시작합니다.';
  $('#detect-confidence').textContent='확인 필요';
  $('#confirm-slots').disabled=false;
  renderReport();
}

function cropFeature(source,x,y,sizeRatio=.028){
  const size=Math.round(source.width*sizeRatio),tile=document.createElement('canvas'),tileCtx=tile.getContext('2d',{willReadFrequently:true});
  tile.width=size;tile.height=size;tileCtx.drawImage(source,x*source.width-size/2,y*source.height-size/2,size,size,0,0,size,size);
  const scratch=document.createElement('canvas');return featureFromCanvas(scratch,scratch.getContext('2d',{willReadFrequently:true}),tile);
}

async function getOcrWorker(){
  if(state.ocrWorker)return state.ocrWorker;
  if(!window.Tesseract)return null;
  const base=new URL('../assets/ocr/',location.href).href;
  state.ocrWorker=await window.Tesseract.createWorker('eng',window.Tesseract.OEM.LSTM_ONLY,{workerPath:base+'worker.min.js',corePath:base+'tesseract-core-simd-lstm.wasm.js',langPath:base,logger:()=>{}});
  await state.ocrWorker.setParameters({tessedit_char_whitelist:'0123456789,.%',tessedit_pageseg_mode:window.Tesseract.PSM.SINGLE_LINE});
  return state.ocrWorker;
}

function meterOcrCanvases(full){
  const definitions=[
    {x:.885,y:.104,w:.085,h:.036},
    {x:.905,y:.133,w:.065,h:.025},
    {x:.873,y:.193,w:.103,h:.034},
    {x:.873,y:.229,w:.103,h:.034},
    {x:.873,y:.265,w:.103,h:.034}
  ];
  return definitions.map(d=>{const out=document.createElement('canvas'),ctx=out.getContext('2d',{willReadFrequently:true});out.width=520;out.height=78;ctx.fillStyle='white';ctx.fillRect(0,0,out.width,out.height);ctx.drawImage(full,d.x*full.width,d.y*full.height,d.w*full.width,d.h*full.height,8,6,504,66);const image=ctx.getImageData(0,0,out.width,out.height),p=image.data;for(let i=0;i<p.length;i+=4){const luma=p[i]*.2126+p[i+1]*.7152+p[i+2]*.0722,ink=luma>145?0:255;p[i]=p[i+1]=p[i+2]=ink;p[i+3]=255;}ctx.putImageData(image,0,0);if(d.trimTop){ctx.fillStyle='white';ctx.fillRect(0,0,out.width,d.trimTop);}return out;});
}

function bestMeterSkills(full){
  const used=new Set(),rows=[];
  for(const y of [.211,.247,.283]){
    const observed=cropFeature(full,.814,y,.022),ranked=(state.build?.skills||[]).map(id=>({id,score:similarity(observed,state.templateFeatures.get(id))})).filter(x=>!used.has(x.id)).sort((a,b)=>b.score-a.score),best=ranked[0];
    if(best){used.add(best.id);rows.push(best.id);}
  }
  return rows;
}

function numericParts(line){return (line.match(/\d[\d,.]*%?/g)||[]).map(value=>value.replace(/[,.]+$/,'')).filter(Boolean);}
function parseAmount(value){return Number(String(value||'').replace(/\D/g,''));}

async function readDamageMeter(full){
  if(state.ocrBusy||!state.running||!state.build)return;
  state.ocrBusy=true;
  try{
    const worker=await getOcrWorker();if(!worker)return;
    const images=meterOcrCanvases(full),skills=bestMeterSkills(full),lines=[];for(const image of images){const result=await worker.recognize(image);lines.push(result.data.text.trim());}const parsed=lines.map(numericParts);state.ocr.lastText=lines.join('\n');
    if(parsed[0]?.[0])state.ocr.total=parseAmount(parsed[0][0]);
    if(parsed[1]?.[0])state.ocr.dps=parseAmount(parsed[1][0]);
    const rows=[];
    for(let index=0;index<3;index++){
      const parts=parsed[index+2]||[],damage=parts.find(value=>!value.endsWith('%')&&parseAmount(value)>=1000),share=parts.find(value=>value.endsWith('%'));
      if(skills[index]&&damage){const shareValue=share?parseFloat(share.replace('%','').replace(',','.')):null,rawDamage=parseAmount(damage),shareDamage=state.ocr.total&&shareValue!=null?Math.round(state.ocr.total*shareValue/100):null,finalDamage=shareDamage&&Math.abs(rawDamage-shareDamage)/shareDamage>.2?shareDamage:rawDamage;rows.push({skillId:skills[index],damage:finalDamage,share:shareValue});}
    }
    state.ocr.rows=rows;state.ocr.updatedAt=Date.now();renderReport();
  }catch(error){console.warn('피해 측정기 OCR 실패',error);}finally{state.ocrBusy=false;}
}

function observeFrame(now) {
  if(!state.running||!state.stream)return;
  if(now-state.lastFrameAt<50){state.loopId=requestAnimationFrame(observeFrame);return;}
  state.lastFrameAt=now;
  const video=$('#preview');
  if(video.readyState<2){state.loopId=requestAnimationFrame(observeFrame);return;}
  const full=$('#analysis-canvas'),ctx=full.getContext('2d',{willReadFrequently:true});
  const sampleW=Math.min(960,video.videoWidth),sampleH=Math.round(sampleW*video.videoHeight/video.videoWidth);
  full.width=sampleW;full.height=sampleH;ctx.drawImage(video,0,0,sampleW,sampleH);
  const tile=document.createElement('canvas'),tileCtx=tile.getContext('2d',{willReadFrequently:true}),size=Math.round(sampleW*.028);
  const positions=slotDefinitions(),observed=[];
  for(const pos of positions){tile.width=size;tile.height=size;tileCtx.drawImage(full,pos.x*sampleW-size/2,pos.y*sampleH-size/2,size,size,0,0,size,size);const scratch=document.createElement('canvas'),feature=featureFromCanvas(scratch,scratch.getContext('2d',{willReadFrequently:true}),tile);observed.push({pos,feature,preview:tile.toDataURL('image/png')});}
  if(!state.build&&(now-state.lastMap>2500||!state.slotMap.size)){mapSlots(observed);state.lastMap=now;}
  observed.forEach((item,index)=>{
    const previous=state.slotStates.get(index),map=state.slotMap.get(index),nowMs=Date.now();
    const detected=api.advanceSlotDetector(previous,item.feature,nowMs,map?Number(skill(map.id)?.cooldown||skill(map.id)?.basic?.cooldown||0):0);
    if(detected.cast&&map)recordCast(map.id,item.pos.key);
    state.slotStates.set(index,detected.state);
  });
  if(state.build){
    const pos=basicAttackDefinition();tile.width=size;tile.height=size;tileCtx.drawImage(full,pos.x*sampleW-size/2,pos.y*sampleH-size/2,size,size,0,0,size,size);
    const scratch=document.createElement('canvas'),feature=featureFromCanvas(scratch,scratch.getContext('2d',{willReadFrequently:true}),tile),nowMs=Date.now();
    const detected=api.advanceSlotDetector(state.basicState,feature,nowMs,1.5);state.basicState=detected.state;
    if(detected.cast)recordBasicAttack(nowMs);
  }
  state.frames++;
  if(now-state.fpsSince>=1000){state.fps=Math.round(state.frames*1000/(now-state.fpsSince));state.frames=0;state.fpsSince=now;$('#frame-rate').textContent=`관측 ${state.fps} fps`;}
  if(now-state.lastUi>450){renderReport();state.lastUi=now;}
  if(now-state.lastOcr>3000){state.lastOcr=now;readDamageMeter(full);}
  state.loopId=requestAnimationFrame(observeFrame);
}

function recoverSequenceBefore(skillId, at) {
  const order=state.currentOrder;
  if(order.length!==9)return [];
  const currentIndex=order.indexOf(skillId);
  if(currentIndex<0)return [];
  const previous=state.lastVisualCast;
  if(!previous){state.sequenceCursor=(currentIndex+1)%order.length;return [];}
  const gap=at-previous.at;
  const start=state.sequenceCursor==null?(order.indexOf(previous.skillId)+1)%order.length:state.sequenceCursor;
  const distance=(currentIndex-start+order.length)%order.length;
  const recovered=[];
  if(gap>120&&gap<=30000&&distance>0&&distance<=8){
    for(let offset=0;offset<distance;offset+=1){
      const id=order[(start+offset)%order.length];
      const inferredAt=previous.at+Math.round(gap*(offset+1)/(distance+1));
      recovered.push({type:'cast',skillId:id,key:state.skillKeys.get(id)||'',at:inferredAt,evidence:'sequence',confidence:'guaranteed-order'});
    }
  }
  state.sequenceCursor=(currentIndex+1)%order.length;
  return recovered;
}

function recordCast(skillId,key) {
  const at=Date.now();
  const previousSame=state.events.findLast?.(event=>event.type==='cast'&&event.skillId===skillId);
  if(previousSame&&at-previousSame.at<650)return;
  const recovered=recoverSequenceBefore(skillId,at);
  if(recovered.length)state.events.push(...recovered);
  const event={type:'cast',skillId,key,at,evidence:'visual'};
  state.events.push(event);
  state.lastVisualCast=event;
  $('#finish-measurement').disabled=false;
  const card=$(`.deck-slot[data-skill="${skillId}"]`);if(card){card.classList.add('just-cast');setTimeout(()=>card.classList.remove('just-cast'),420);}
}

function recordBasicAttack(at=Date.now()){
  const previous=[...state.events].reverse().find(event=>event.type==='basic');
  if(previous&&at-previous.at<350)return;
  state.events.push({type:'basic',key:'Space',at,evidence:'visual'});
}

function toggleAnalysis() {
  if(state.running){state.running=false;cancelAnimationFrame(state.loopId);$('#toggle-analysis').textContent='분석 계속';$('#analysis-state').textContent='일시 정지';return;}
  if(!state.stream)return;
  state.running=true;if(!state.startedAt)state.startedAt=Date.now();
  $('#toggle-analysis').textContent='일시 정지';$('#analysis-state').textContent=state.build?'실시간 분석 중':'스킬 슬롯 감지 중';$('#analysis-subtitle').textContent='게임 창을 계속 관측하며 사용 간격과 피해를 측정합니다.';$('#analysis-step').classList.add('active');$('#reset-session').disabled=false;
  state.loopId=requestAnimationFrame(observeFrame);
}

function resetSession() {
  state.events=[];state.slotStates.clear();state.basicState=null;state.sequenceCursor=null;state.lastVisualCast=null;state.startedAt=Date.now();state.historyRecordId=null;$('#finish-measurement').disabled=true;renderReport();toast('현재 분석 기록을 초기화했습니다.');
}

async function init() {
  state.catalog=await api.getCatalog();
  state.byId=new Map(state.catalog.skills.map(s=>[s.id,s]));
  state.appVersion=await api.getAppVersion();
  await loadHistory();
  await prepareTemplates();
  if(new URLSearchParams(location.search).has('demo')){
    const names=['요력','주먹 지르기','대폭발','내려찍기','기습','날카로운 얼음창','붕괴하는 대지','밀쳐내는 화살','휘둘러 내려치기'];
    const ids=names.map(name=>state.catalog.skills.find(s=>s.name===name)?.id).filter(Boolean);
    const normal=ids.filter(id=>!skill(id).ultimate);
    for(const candidate of state.catalog.skills){if(normal.length>=8)break;if(!candidate.ultimate&&!normal.includes(candidate.id))normal.push(candidate.id);}
    const ultimate=ids.find(id=>skill(id).ultimate)||state.catalog.skills.find(s=>s.ultimate)?.id;
    setDetectedBuild([...normal.slice(0,8),ultimate].filter(Boolean),displaySlotKeys(),.96);
  }
  renderBuild();updateReadyState();
}

$('#choose-source').onclick=openSourceDialog;$('#choose-source-empty').onclick=openSourceDialog;
$('#refresh-sources').onclick=listSources;
$('#toggle-analysis').onclick=toggleAnalysis;$('#reset-session').onclick=resetSession;
$('#finish-measurement').onclick=finishMeasurement;$('#continue-measurement').onclick=continueMeasurement;
$('#confirm-slots').onclick=openSlotConfirmation;$('#apply-slots').onclick=applyConfirmedSlots;
$('#always-top').onchange=event=>api.setAlwaysOnTop(event.target.checked);
$('#recalibrate').onclick=()=>{updateOutlines();toast('현재 창 크기에 맞춰 감지 위치를 다시 계산했습니다.');};
$('#live-tab').onclick=()=>switchAppView('live');
$('#history-tab').onclick=()=>switchAppView('history');
$('#history-search').oninput=renderHistory;
$('#history-favorites').onchange=renderHistory;
$('#compare-history').onclick=showHistoryComparison;
$('#close-history-compare').onclick=()=>{$('#history-compare-panel').hidden=true;};
$('#save-history-detail').onclick=saveHistoryDetail;
$('#delete-history-detail').onclick=deleteHistoryDetail;
window.addEventListener('resize',updateOutlines);
init().catch(error=>toast(`초기화 실패: ${error.message}`));
