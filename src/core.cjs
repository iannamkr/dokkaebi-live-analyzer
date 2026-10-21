function cleanBuild(raw, catalog) {
  if (!raw || !Array.isArray(raw.skills)) throw new Error('도깨비 스킬 빌더의 빌드 파일이 아닙니다.');
  if (!['dosul-build-v1', 'dosul-build-v2', 'dosul-build-v3', 'dosul-live-v1'].includes(raw.schema)) {
    throw new Error('지원하지 않는 빌드 형식입니다.');
  }
  const byId = new Map(catalog.skills.map(skill => [skill.id, skill]));
  const ids = raw.skills.filter((id, index, list) => typeof id === 'string' && byId.has(id) && list.indexOf(id) === index);
  if (!ids.length || ids.length > 9 || ids.length !== raw.skills.length) throw new Error('빌드의 도술 목록이 올바르지 않습니다.');
  const baseSlots = Array.isArray(raw.baseSlots) ? raw.baseSlots.filter(id => ids.includes(id) && !byId.get(id).ultimate).slice(0, 5) : ids.filter(id => !byId.get(id).ultimate).slice(0, 5);
  const disabled = raw.executionPolicy && Array.isArray(raw.executionPolicy.disabled)
    ? raw.executionPolicy.disabled.filter(id => ids.includes(id))
    : Array.isArray(raw.autoOff) ? raw.autoOff.filter(id => ids.includes(id)) : [];
  return {
    schema: 'dosul-live-v1',
    name: String(raw.name || '실전 분석 빌드').slice(0, 80),
    skills: ids,
    baseSlots,
    executionPolicy: { disabled },
    receivedAt: new Date().toISOString()
  };
}

function encodeBuild(build) {
  return Buffer.from(JSON.stringify(build), 'utf8').toString('base64url');
}

function decodeBuild(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function expectedOrder(build) {
  const disabled = new Set(build.executionPolicy?.disabled || []);
  return build.skills.filter(id => !disabled.has(id));
}

function sequenceReport(events, build, catalog, now = Date.now()) {
  const order = expectedOrder(build);
  const byId = new Map(catalog.skills.map(skill => [skill.id, skill]));
  const casts = events.filter(event => event.type === 'cast' && order.includes(event.skillId));
  let matched = 0;
  let breaks = 0;
  let cursor = 0;
  let lastBreak = null;
  for (const event of casts) {
    const expected = order[cursor];
    if (event.skillId === expected) {
      matched += 1;
      cursor = (cursor + 1) % order.length;
    } else {
      breaks += 1;
      lastBreak = { expected, actual: event.skillId, at: event.at };
      const found = order.indexOf(event.skillId);
      cursor = found >= 0 ? (found + 1) % order.length : cursor;
    }
  }
  const counts = Object.fromEntries(build.skills.map(id => [id, 0]));
  const inferredCounts = Object.fromEntries(build.skills.map(id => [id, 0]));
  const times = Object.fromEntries(build.skills.map(id => [id, []]));
  for (const event of casts) {
    counts[event.skillId] = (counts[event.skillId] || 0) + 1;
    if (event.evidence === 'sequence') inferredCounts[event.skillId] = (inferredCounts[event.skillId] || 0) + 1;
    times[event.skillId]?.push(event.at);
  }
  const rows = build.skills.map(id => {
    const skill = byId.get(id);
    const values = times[id] || [];
    const intervals = values.slice(1).map((value, index) => (value - values[index]) / 1000);
    const meanInterval = intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : null;
    const cooldown = Number(skill?.cooldown || skill?.basic?.cooldown || 0);
    const utilization = meanInterval && cooldown ? Math.min(100, cooldown / meanInterval * 100) : null;
    const coefficient = Number(skill?.referenceNumbers?.total || 0);
    return { id, name: skill?.name || id, family: skill?.family || '', count: counts[id] || 0, inferredCount:inferredCounts[id] || 0, meanInterval, cooldown, utilization, coefficient };
  });
  const total = matched + breaks;
  return {
    casts: casts.length,
    matched,
    breaks,
    matchRate: total ? matched / total * 100 : 0,
    lastBreak,
    nextExpected: order[cursor] || null,
    rows,
    elapsed: events.length ? Math.max(0, now - events[0].at) : 0
  };
}

function cooldownTransition(previous, current, threshold = 0.13) {
  if (!previous || !current) return false;
  const drop = previous.luma - current.luma;
  const change = current.diff - previous.diff;
  return drop > threshold || (change > 0.16 && current.luma < previous.luma - 0.05);
}

function featureDistance(a, b) {
  if (!a?.values || !b?.values || a.values.length !== b.values.length) return 1;
  let total = 0;
  for (let index = 0; index < a.values.length; index += 1) total += Math.abs(a.values[index] - b.values[index]);
  return total / a.values.length;
}

function advanceSlotDetector(previous, feature, now, cooldownSeconds = 0) {
  const chroma = Number.isFinite(feature?.chroma) ? feature.chroma : 0;
  const current = previous ? { ...previous } : {
    phase:'learning', readyFeature:feature, readyLuma:feature.luma,
    readyChroma:chroma, stableFrames:0, recoveryFrames:0, lastCast:0
  };
  const frameDistance = previous ? featureDistance(previous.feature, feature) : 0;
  current.feature = feature;
  current.luma = feature.luma;
  current.chroma = chroma;
  current.diff = frameDistance;
  current.at = now;

  if (current.phase === 'learning') {
    if (feature.luma >= current.readyLuma - 0.015 || chroma >= current.readyChroma - 0.025) {
      if (feature.luma + chroma > current.readyLuma + current.readyChroma) {
        current.readyFeature = feature;
        current.readyLuma = feature.luma;
        current.readyChroma = chroma;
      }
      current.stableFrames = frameDistance < 0.045 ? current.stableFrames + 1 : 0;
    } else current.stableFrames = 0;
    if (current.stableFrames >= 5) current.phase = 'ready';
    return { state:current, cast:false };
  }

  const fromReady = featureDistance(current.readyFeature, feature);
  const lumaDrop = current.readyLuma - feature.luma;
  const chromaDrop = current.readyChroma - chroma;
  if (current.phase === 'ready') {
    const cooldownStarted = (lumaDrop > 0.045 && fromReady > 0.05) || (lumaDrop > 0.025 && fromReady > 0.16) || (chromaDrop > 0.055 && fromReady > 0.04);
    if (now - current.lastCast > 650 && cooldownStarted) {
      current.phase = 'cooldown';
      current.lastCast = now;
      current.recoveryFrames = 0;
      return { state:current, cast:true };
    }
    if (frameDistance < 0.04 && (feature.luma >= current.readyLuma - 0.025 || chroma >= current.readyChroma - 0.025)) {
      current.readyFeature = feature;
      current.readyLuma = Math.max(current.readyLuma * 0.98 + feature.luma * 0.02, feature.luma);
      current.readyChroma = Math.max(current.readyChroma * 0.98 + chroma * 0.02, chroma);
    }
    return { state:current, cast:false };
  }

  const elapsed = now - current.lastCast;
  const expectedMs = Math.max(1000, Number(cooldownSeconds || 0) * 1000);
  const looksReady = feature.luma >= current.readyLuma - 0.035 || chroma >= current.readyChroma - 0.045;
  current.recoveryFrames = looksReady ? current.recoveryFrames + 1 : 0;
  if (current.recoveryFrames >= 2 || (elapsed > Math.max(expectedMs * 1.35, 5000) && feature.luma >= current.readyLuma - 0.065)) {
    current.phase = 'ready';
    current.recoveryFrames = 0;
    current.readyFeature = feature;
    current.readyLuma = feature.luma;
    current.readyChroma = chroma;
  }
  return { state:current, cast:false };
}

function effectNames(skill) {
  const unique = values => [...new Set((values || []).filter(Boolean).map(String))];
  return {
    buffs: unique(skill?.buffs),
    debuffs: unique(skill?.debuffs),
    timings: Object.entries(skill?.timingEffects || {}).map(([name,value]) => ({ name, duration:Number(value?.duration || 0), application:String(value?.application || '') })),
    conditions: (skill?.conditions || []).filter(value => value && value.effect).map(value => ({
      effect:String(value.effect),
      result:String(value.result || '조건 효과'),
      scope:String(value.scope || ''),
      minBreakthrough:Number(value.minBreakthrough || 0)
    }))
  };
}

function normalizeEffect(value) { return String(value || '').replace(/\s+/g,'').toLowerCase(); }
function isStateCondition(value){return /(감전|화상|파쇄|기세|낙인|출혈|충격|관통|파열|원소|질풍|빙결|속박|기절|마비|중독|수면|경직)/.test(String(value||''));}

function analyzeEffectState({ skills = [], events = [], startedAt = 0, endedAt = 0 }) {
  const ids=new Set(skills.map(value=>value.id));
  const casts=events.filter(event=>event?.type==='cast'&&ids.has(event.skillId)).sort((a,b)=>a.at-b.at);
  const now=endedAt||casts.at(-1)?.at||startedAt||0;
  const definitions=[];
  for(const value of skills){
    const effects=effectNames(value),buffs=new Set(effects.buffs.map(normalizeEffect)),debuffs=new Set(effects.debuffs.map(normalizeEffect));
    const timingByName=new Map(effects.timings.map(item=>[normalizeEffect(item.name),item]));
    const names=[...new Set([...effects.buffs,...effects.debuffs,...effects.timings.map(item=>item.name)])];
    for(const name of names){
      const key=normalizeEffect(name),timing=timingByName.get(key);
      definitions.push({effect:name,key,kind:debuffs.has(key)?'debuff':buffs.has(key)?'buff':'effect',producerId:value.id,producerName:value.name,duration:Number(timing?.duration||0),application:timing?.application||''});
    }
  }
  const windows=[];
  for(const definition of definitions.filter(value=>value.duration>0)){
    for(const event of casts.filter(value=>value.skillId===definition.producerId)){
      windows.push({...definition,start:event.at,end:event.at+definition.duration*1000,evidence:event.evidence||'visual'});
    }
  }
  windows.sort((a,b)=>a.start-b.start);
  const attempts=[];
  for(const consumer of skills){
    for(const condition of effectNames(consumer).conditions){
      if(!isStateCondition(condition.effect))continue;
      const key=normalizeEffect(condition.effect),matching=definitions.filter(value=>value.key===key),known=matching.some(value=>value.duration>0);
      for(const event of casts.filter(value=>value.skillId===consumer.id)){
        const active=known?windows.filter(value=>value.key===key&&event.at>=value.start&&event.at<=value.end).sort((a,b)=>b.end-a.end)[0]:null;
        attempts.push({consumerId:consumer.id,consumerName:consumer.name,effect:condition.effect,result:condition.result,at:event.at,evidence:event.evidence||'visual',status:!matching.length?'missing-producer':!known?'unknown-duration':active?'success':'miss',remainingMs:active?Math.max(0,active.end-event.at):null,producerId:active?.producerId||matching[0]?.producerId||null,producerName:active?.producerName||matching[0]?.producerName||null});
      }
    }
  }
  const grouped=new Map();
  for(const attempt of attempts){
    const key=`${attempt.consumerId}|${normalizeEffect(attempt.effect)}`;
    if(!grouped.has(key))grouped.set(key,{consumerId:attempt.consumerId,consumerName:attempt.consumerName,effect:attempt.effect,result:attempt.result,producerId:attempt.producerId,producerName:attempt.producerName,total:0,covered:0,missed:0,unknown:0,direct:0,recovered:0,remainingTotalMs:0,knownDuration:false,duration:null});
    const row=grouped.get(key);
    if(attempt.status==='success'||attempt.status==='miss'){
      row.total+=1;row.knownDuration=true;
      if(attempt.status==='success'){row.covered+=1;row.remainingTotalMs+=Number(attempt.remainingMs||0);}else row.missed+=1;
      if(attempt.evidence==='sequence')row.recovered+=1;else row.direct+=1;
    }else row.unknown+=1;
  }
  const conditions=[...grouped.values()].map(row=>{
    const definition=definitions.find(value=>value.key===normalizeEffect(row.effect)&&value.producerId===row.producerId)||definitions.find(value=>value.key===normalizeEffect(row.effect));
    return {...row,duration:definition?.duration||null,rate:row.total?row.covered/row.total*100:null,meanRemainingMs:row.covered?row.remainingTotalMs/row.covered:null};
  });
  const activeByEffect=new Map();
  for(const window of windows.filter(value=>now>=value.start&&now<=value.end)){
    const key=`${window.kind}|${window.key}`,previous=activeByEffect.get(key);
    if(!previous||window.end>previous.end)activeByEffect.set(key,window);
  }
  return { windows, attempts, conditions, activeEffects:[...activeByEffect.values()].sort((a,b)=>a.end-b.end) };
}

function analyzeEffectTiming({ skills = [], events = [], startedAt = 0, endedAt = 0 }) {
  const ids=new Set(skills.map(value=>value.id));
  const casts=events.filter(event=>event?.type==='cast'&&ids.has(event.skillId)).sort((a,b)=>a.at-b.at);
  const start=startedAt||casts[0]?.at||0,end=Math.max(start+1,endedAt||casts.at(-1)?.at||start+1),period=end-start;
  const consumers=new Map();
  for(const value of skills)for(const condition of value.conditions||[]){const key=normalizeEffect(condition?.effect);if(key){if(!consumers.has(key))consumers.set(key,[]);consumers.get(key).push(value.id);}}
  const rows=[];
  for(const value of skills){
    const effects=effectNames(value),knownByName=new Map(effects.timings.map(item=>[normalizeEffect(item.name),item]));
    const names=[...new Set([...effects.buffs,...effects.debuffs,...effects.timings.map(item=>item.name)])];
    const producerCasts=casts.filter(event=>event.skillId===value.id);
    for(const name of names){
      const timing=knownByName.get(normalizeEffect(name)),duration=Number(timing?.duration||0),durationMs=duration*1000;
      if(!duration){rows.push({skillId:value.id,skillName:value.name,effect:name,known:false,casts:producerCasts.length,activation:'cast-confirmed'});continue;}
      const windows=producerCasts.map(event=>({start:event.at,end:event.at+durationMs}));
      const clipped=windows.map(item=>({start:Math.max(start,item.start),end:Math.min(end,item.end)})).filter(item=>item.end>item.start).sort((a,b)=>a.start-b.start);
      let activeMs=0,cursorEnd=0;
      for(const item of clipped){if(item.start>=cursorEnd)activeMs+=item.end-item.start;else if(item.end>cursorEnd)activeMs+=item.end-cursorEnd;cursorEnd=Math.max(cursorEnd,item.end);}
      let overlaps=0;for(let index=1;index<windows.length;index+=1)if(windows[index].start<windows[index-1].end)overlaps+=1;
      const consumerIds=consumers.get(normalizeEffect(name))||[],consumerCasts=casts.filter(event=>consumerIds.includes(event.skillId));
      const coveredConsumers=consumerCasts.filter(event=>windows.some(window=>event.at>=window.start&&event.at<=window.end)).length;
      const followDelays=[];
      for(const window of windows){const next=casts.find(event=>event.at>window.start&&event.skillId!==value.id);if(next&&next.at<=window.end)followDelays.push((next.at-window.start)/1000);}
      rows.push({skillId:value.id,skillName:value.name,effect:name,known:true,duration,application:timing.application,casts:producerCasts.length,activation:'cast-confirmed',coverage:Math.min(100,activeMs/period*100),overlaps,consumerCasts:consumerCasts.length,coveredConsumers,missedConsumers:consumerCasts.length-coveredConsumers,meanFollowDelay:followDelays.length?followDelays.reduce((a,b)=>a+b,0)/followDelays.length:null});
    }
  }
  return rows;
}

function optimizeSequence({ skills, events = [], damageRows = [], startedAt = 0, endedAt = 0, currentOrder = [] }) {
  if (!Array.isArray(skills) || !skills.length) return { order:[], rows:[], casts:0, durationMs:0 };
  const ids = new Set(skills.map(skill => skill.id));
  const casts = events.filter(event => event?.type === 'cast' && ids.has(event.skillId)).sort((a,b)=>a.at-b.at);
  const firstAt = casts[0]?.at || 0;
  const lastAt = casts[casts.length-1]?.at || firstAt;
  const basicAttacks=events.filter(event=>event?.type==='basic').length;
  const measurementMs=Math.max(0,(endedAt||lastAt)-(startedAt||firstAt));
  const damageById = new Map(damageRows.map(row => [row.skillId, Number(row.damage || 0)]));
  const perSkill = new Map(skills.map(skill => [skill.id, { count:0, times:[] }]));
  for (const event of casts) {
    const value = perSkill.get(event.skillId);
    value.count += 1;
    value.times.push(event.at);
  }
  const effectTiming=analyzeEffectTiming({skills,events,startedAt,endedAt});
  const effectState=analyzeEffectState({skills,events,startedAt,endedAt});
  const rawRows = skills.map(skill => {
    const observed = perSkill.get(skill.id);
    const intervals = observed.times.slice(1).map((at,index)=>(at-observed.times[index])/1000);
    const meanInterval = intervals.length ? intervals.reduce((a,b)=>a+b,0)/intervals.length : null;
    const cooldown = Number(skill.cooldown || skill.basic?.cooldown || 0);
    const utilization = meanInterval && cooldown ? Math.min(100,cooldown/meanInterval*100) : null;
    const damage = damageById.get(skill.id) || 0;
    const damagePerUse = observed.count ? damage/observed.count : 0;
    const effects = effectNames(skill);
    return { id:skill.id, name:skill.name, family:skill.family, ultimate:Boolean(skill.ultimate), breakthroughStage:Number(skill.breakthroughStage||0), count:observed.count, meanInterval, cooldown, utilization, damage, damagePerUse, effects, timing:effectTiming.filter(item=>item.skillId===skill.id) };
  });
  const maxDamagePerUse = Math.max(1, ...rawRows.map(row=>row.damagePerUse));
  for (const row of rawRows) {
    const opener = row.effects.debuffs.length*32 + row.effects.buffs.length*22;
    const measuredDamage = row.damagePerUse/maxDamagePerUse*42;
    const cooldownGain = Math.min(18,row.cooldown*.8);
    const delayGain = row.utilization == null ? 0 : Math.max(0,80-row.utilization)*.35;
    row.score = opener + measuredDamage + cooldownGain + delayGain - (row.ultimate?1000:0);
    row.reasons = [];
    if (row.effects.debuffs.length) row.reasons.push(`약화 ${row.effects.debuffs.join('·')}를 후속 도술보다 먼저 부여`);
    if (row.effects.buffs.length) row.reasons.push(`강화 ${row.effects.buffs.join('·')}를 먼저 확보`);
    if (row.damagePerUse > 0) row.reasons.push(`관측 1회당 피해 ${Math.round(row.damagePerUse).toLocaleString('ko-KR')}`);
    if (row.utilization != null && row.utilization < 70) row.reasons.push(`재사용 활용 ${Math.round(row.utilization)}%로 앞당길 여지`);
    for(const timing of row.timing.filter(item=>item.known)){
      row.reasons.push(`${timing.effect} 발동 확정 · ${timing.duration}초 · 측정 유지율 ${Math.round(timing.coverage)}%${timing.meanFollowDelay!=null?` · 후속 평균 ${timing.meanFollowDelay.toFixed(1)}초`:''}`);
      if(timing.overlaps)row.reasons.push(`${timing.effect}가 남은 상태에서 ${timing.overlaps}회 재사용`);
      if(timing.missedConsumers)row.reasons.push(`${timing.effect} 조건 도술 ${timing.missedConsumers}회가 지속시간 밖에서 발동`);
    }
    const unknown=row.timing.filter(item=>!item.known).map(item=>item.effect);
    if(unknown.length)row.reasons.push(`발동은 확정·지속시간 미확인: ${unknown.join('·')} (시간 효율만 계산 제외)`);
    if (!row.reasons.length) row.reasons.push(row.count ? `실제 ${row.count}회 사용 기록 반영` : '실측 표본 부족으로 기본 재사용 시간 반영');
  }
  const normal = rawRows.filter(row=>!row.ultimate).sort((a,b)=>b.score-a.score);
  const ultimates = rawRows.filter(row=>row.ultimate).sort((a,b)=>b.damagePerUse-a.damagePerUse);
  const validCurrent=Array.isArray(currentOrder)&&currentOrder.length===rawRows.length&&new Set(currentOrder).size===rawRows.length&&currentOrder.every(id=>ids.has(id));
  const ordered = validCurrent ? currentOrder.map(id=>rawRows.find(row=>row.id===id)) : [...normal,...ultimates];
  const relationships=[];
  const globalBuffers=ordered.filter(row=>row.effects.buffs.some(name=>/(주는 피해 증가|공격력 증가|치명타 피해 증가|치명타 적중 증가|재사용 대기시간 감소)/.test(name)));
  for(const buffer of [...globalBuffers].reverse()){
    const from=ordered.indexOf(buffer);if(from>0){ordered.splice(from,1);ordered.unshift(buffer);relationships.push({effect:buffer.effects.buffs.join('·'),consumerId:null,consumerName:'후속 전체 도술',producerId:buffer.id,producerName:buffer.name,covered:0,missed:null,total:0,duration:null,durationKnown:false,action:'move-global-buff-first'});}
  }
  for (const consumer of [...ordered]) {
    for (const condition of consumer.effects.conditions) {
      const target=normalizeEffect(condition.effect);
      const producer = ordered.find(row => row.id !== consumer.id && ([...row.effects.buffs,...row.effects.debuffs,...row.effects.timings.map(item=>item.name)].some(name=>normalizeEffect(name)===target)));
      if (!producer) {if(isStateCondition(condition.effect))relationships.push({effect:condition.effect,consumerId:consumer.id,consumerName:consumer.name,producerId:null,producerName:null,covered:0,missed:null,total:0,action:'producer-missing'});continue;}
      const producerIndex=ordered.indexOf(producer),consumerIndex=ordered.indexOf(consumer);
      const timing=producer.timing.find(item=>normalizeEffect(item.effect)===target&&item.known);
      const measured=effectState.conditions.find(item=>item.consumerId===consumer.id&&normalizeEffect(item.effect)===target);
      const hasMeasuredMiss=Boolean(measured?.missed);
      const needsMove=Boolean(measured?.knownDuration&&hasMeasuredMiss&&(producerIndex>consumerIndex||consumerIndex-producerIndex>1));
      if (needsMove) {
        ordered.splice(ordered.indexOf(consumer),1);
        ordered.splice(ordered.indexOf(producer)+1,0,consumer);
      }
      consumer.reasons.unshift(`${condition.effect}${timing?` ${timing.duration}초 안에`: ' 이후'} ${condition.result} 조건 활용`);
      relationships.push({effect:condition.effect,consumerId:consumer.id,consumerName:consumer.name,producerId:producer.id,producerName:producer.name,covered:measured?.covered||0,missed:measured?.knownDuration?measured.missed:null,total:measured?.total||0,rate:measured?.rate??null,meanRemainingMs:measured?.meanRemainingMs??null,duration:measured?.duration||timing?.duration||null,durationKnown:Boolean(measured?.knownDuration),action:needsMove?'move-consumer-after-producer':hasMeasuredMiss?'condition-failed':'keep'});
    }
  }
  const finalOrder=ordered.map(row=>row.id),basis=validCurrent?currentOrder:finalOrder;
  const moves=finalOrder.map((id,index)=>({id,name:rawRows.find(row=>row.id===id)?.name||id,from:basis.indexOf(id)+1,to:index+1})).filter(move=>move.from&&move.from!==move.to);
  return { order:finalOrder, rows:ordered, casts:casts.length, durationMs:measurementMs||Math.max(0,lastAt-firstAt), effectTiming, effectState, conditionTiming:effectState.conditions, relationships, moves, keptCurrentOrder:validCurrent, basicAttacks, basicShare:(basicAttacks+casts.length)?basicAttacks/(basicAttacks+casts.length)*100:0, basicPerMinute:measurementMs?basicAttacks/(measurementMs/60000):0 };
}

module.exports = { cleanBuild, encodeBuild, decodeBuild, expectedOrder, sequenceReport, cooldownTransition, featureDistance, advanceSlotDetector, effectNames, analyzeEffectTiming, analyzeEffectState, optimizeSequence };
