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
  regions: {
    hotbar: { x: .746, y: .735, w: .238, h: .205 },
    meter: { x: .785, y: .055, w: .193, h: .305 }
  }
};

const api = window.desktopAPI || {
  listSources: async () => [],
  getCatalog: () => fetch('../assets/data.json').then(response=>response.json()),
  setAlwaysOnTop: async () => false,
  openExternal: url => window.open(url, '_blank'),
  optimizeSequence: () => ({order:[],rows:[],casts:0,durationMs:0}),
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

function setDetectedBuild(skills, keys, confidence) {
  const signature = skills.join('|');
  if (state.build?.signature === signature) return;
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

function renderReport() {
  const r = report();
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
  renderFindings(r);
  renderTimeline();
  renderEfficiency(r);
}

function renderFindings(r) {
  const list = [];
  if (!r.casts) list.push({kind:'neutral',icon:'◎',title:'실전 사용 감지 중',body:'스킬 아이콘의 준비 상태가 재사용 대기 상태로 바뀌는 순간을 사용으로 기록합니다.'});
  if (state.build) list.push({kind:'good',icon:'✓',title:'스킬 슬롯 사용자 확인 완료',body:'직접 확인한 일반 도술 8개와 궁극기 1개를 기준으로 분석합니다.'});
  const recovered=state.events.filter(event=>event.type==='cast'&&event.evidence==='sequence').length;
  if(recovered)list.push({kind:'warn',icon:'↺',title:`감지 누락 ${recovered}회 자동 복원`,body:'확정한 사용 순서와 재사용 시간을 기준으로 직접 감지되지 않은 발동을 복원해 효율 계산에 포함했습니다.'});
  const delayed = r.rows.filter(row => row.count >= 2 && row.utilization != null && row.utilization < 70).sort((a,b)=>a.utilization-b.utilization)[0];
  if (delayed) list.push({kind:'warn',icon:'△',title:`${delayed.name} 재사용 지연`,body:`기본 재사용 ${delayed.cooldown.toFixed(1)}초보다 실제 평균 사용 간격 ${delayed.meanInterval.toFixed(1)}초가 깁니다.`});
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

function finishMeasurement() {
  if (!state.build || !state.events.some(event=>event.type==='cast')) { toast('추천하려면 먼저 스킬 사용 기록이 필요합니다.'); return; }
  state.running=false;
  cancelAnimationFrame(state.loopId);
  $('#toggle-analysis').textContent='분석 계속';
  $('#analysis-state').textContent='측정 완료';
  $('#analysis-subtitle').textContent='관측 데이터로 추천 순서를 계산했습니다.';
  const endedAt=Date.now();
  const result=api.optimizeSequence({skills:state.build.skills.map(id=>skillAtStage(id)),events:state.events,damageRows:state.ocr.rows,startedAt:state.startedAt,endedAt,currentOrder:state.currentOrder});
  if(state.startedAt)result.durationMs=Math.max(0,Date.now()-state.startedAt);
  renderRecommendation(result);
  $('#result-dialog').showModal();
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
  if(state.events.length>500)state.events.splice(0,state.events.length-500);
  $('#finish-measurement').disabled=false;
  const card=$(`.deck-slot[data-skill="${skillId}"]`);if(card){card.classList.add('just-cast');setTimeout(()=>card.classList.remove('just-cast'),420);}
}

function recordBasicAttack(at=Date.now()){
  const previous=[...state.events].reverse().find(event=>event.type==='basic');
  if(previous&&at-previous.at<350)return;
  state.events.push({type:'basic',key:'Space',at,evidence:'visual'});
  if(state.events.length>500)state.events.splice(0,state.events.length-500);
}

function toggleAnalysis() {
  if(state.running){state.running=false;cancelAnimationFrame(state.loopId);$('#toggle-analysis').textContent='분석 계속';$('#analysis-state').textContent='일시 정지';return;}
  if(!state.stream)return;
  state.running=true;if(!state.startedAt)state.startedAt=Date.now();
  $('#toggle-analysis').textContent='일시 정지';$('#analysis-state').textContent=state.build?'실시간 분석 중':'스킬 슬롯 감지 중';$('#analysis-subtitle').textContent='게임 창을 계속 관측하며 사용 간격과 피해를 측정합니다.';$('#analysis-step').classList.add('active');$('#reset-session').disabled=false;
  state.loopId=requestAnimationFrame(observeFrame);
}

function resetSession() {
  state.events=[];state.slotStates.clear();state.basicState=null;state.sequenceCursor=null;state.lastVisualCast=null;state.startedAt=Date.now();$('#finish-measurement').disabled=true;renderReport();toast('현재 분석 기록을 초기화했습니다.');
}

async function init() {
  state.catalog=await api.getCatalog();
  state.byId=new Map(state.catalog.skills.map(s=>[s.id,s]));
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
window.addEventListener('resize',updateOutlines);
init().catch(error=>toast(`초기화 실패: ${error.message}`));
