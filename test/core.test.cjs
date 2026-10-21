const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { cleanBuild, encodeBuild, decodeBuild, expectedOrder, sequenceReport, cooldownTransition, advanceSlotDetector, analyzeEffectTiming, analyzeEffectState, optimizeSequence } = require('../src/core.cjs');

const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'data.json'), 'utf8'));
const ids = catalog.skills.slice(0, 9).map(skill => skill.id);
const raw = { schema:'dosul-live-v1', name:'검증 빌드', skills:ids, baseSlots:ids.slice(0,5), executionPolicy:{disabled:[ids[3]]} };
const build = cleanBuild(raw, catalog);

assert.deepStrictEqual(build.skills, ids);
assert.deepStrictEqual(expectedOrder(build), ids.filter(id => id !== ids[3]));
assert.deepStrictEqual(decodeBuild(encodeBuild(build)).skills, ids);

const base = Date.now() - 5000;
const order = expectedOrder(build);
const events = order.slice(0, 4).map((skillId, index) => ({ type:'cast', skillId, at:base + index * 1000 }));
let result = sequenceReport(events, build, catalog, base + 5000);
assert.equal(result.casts, 4);
assert.equal(result.matchRate, 100);
assert.equal(result.breaks, 0);

const broken = [...events, { type:'cast', skillId:order[6], at:base + 4500 }];
result = sequenceReport(broken, build, catalog, base + 6000);
assert.equal(result.breaks, 1);
assert.equal(result.lastBreak.actual, order[6]);

assert.equal(cooldownTransition({luma:.72,diff:.01},{luma:.48,diff:.2}), true);
assert.equal(cooldownTransition({luma:.72,diff:.01},{luma:.69,diff:.02}), false);

const ready = { luma:.72, chroma:.62, values:Array(32).fill(.8) };
const cooling = { luma:.48, chroma:.18, values:Array(32).fill(.35) };
let detector = null;
let detectedCasts = 0;
let tick = 1000;
for (let index=0; index<7; index+=1) {
  const value=advanceSlotDetector(detector,ready,tick,22);
  detector=value.state;detectedCasts+=Number(value.cast);tick+=50;
}
for (let index=0; index<8; index+=1) {
  const value=advanceSlotDetector(detector,cooling,tick,22);
  detector=value.state;detectedCasts+=Number(value.cast);tick+=50;
}
tick += 22000;
for (let index=0; index<3; index+=1) {
  const value=advanceSlotDetector(detector,ready,tick,22);
  detector=value.state;detectedCasts+=Number(value.cast);tick+=50;
}
for (let index=0; index<8; index+=1) {
  const value=advanceSlotDetector(detector,cooling,tick,22);
  detector=value.state;detectedCasts+=Number(value.cast);tick+=50;
}
assert.equal(detectedCasts,2,'긴 재사용 도술도 준비 상태로 돌아온 뒤 다시 발동되어야 합니다.');

let orangeDetector=null,orangeCasts=0,orangeTick=1000;
const orangeReady={luma:.55,chroma:.68,values:Array(32).fill(.82)};
const orangeCooldown={luma:.54,chroma:.22,values:Array(32).fill(.42)};
for(let index=0;index<7;index+=1){const value=advanceSlotDetector(orangeDetector,orangeReady,orangeTick,11);orangeDetector=value.state;orangeCasts+=Number(value.cast);orangeTick+=50;}
for(let index=0;index<3;index+=1){const value=advanceSlotDetector(orangeDetector,orangeCooldown,orangeTick,11);orangeDetector=value.state;orangeCasts+=Number(value.cast);orangeTick+=50;}
assert.equal(orangeCasts,1,'밝기 변화가 작아도 채도가 감소하면 난타 같은 주황색 슬롯의 발동을 감지해야 합니다.');

const optimizerSkills=[
  {id:'producer',name:'약화 선행',family:'시험',cooldown:8,debuffs:['화상'],timingEffects:{'화상':{duration:10,application:'hit'}},conditions:[]},
  {id:'consumer',name:'조건 후속',family:'시험',cooldown:5,buffs:[],debuffs:[],conditions:[{effect:'화상',result:'피해 증가'}]},
  {id:'ultimate',name:'궁극기',family:'시험',ultimate:true,cooldown:30,buffs:[],debuffs:[],conditions:[]}
];
const optimized=optimizeSequence({skills:optimizerSkills,events:[{type:'cast',skillId:'consumer',at:1000},{type:'cast',skillId:'producer',at:2000},{type:'cast',skillId:'ultimate',at:3000}]});
assert.ok(optimized.order.indexOf('producer')<optimized.order.indexOf('consumer'));
assert.equal(optimized.order.at(-1),'ultimate');
const minimalMove=optimizeSequence({skills:optimizerSkills,currentOrder:['consumer','producer','ultimate'],events:[{type:'cast',skillId:'consumer',at:1000},{type:'cast',skillId:'producer',at:2000},{type:'cast',skillId:'ultimate',at:3000}]});
assert.deepStrictEqual(minimalMove.order,['producer','consumer','ultimate'],'현재 순서를 최대한 유지하면서 조건 부여→소비만 바로잡아야 합니다.');
assert.equal(minimalMove.relationships[0].action,'move-consumer-after-producer');
assert.ok(minimalMove.moves.length>0);
const unknownDurationSkills=optimizerSkills.map(value=>value.id==='producer'?{...value,timingEffects:{}}:value);
const unknownDurationMove=optimizeSequence({skills:unknownDurationSkills,currentOrder:['producer','ultimate','consumer'],events:[{type:'cast',skillId:'producer',at:1000},{type:'cast',skillId:'ultimate',at:2000},{type:'cast',skillId:'consumer',at:3000}]});
assert.deepStrictEqual(unknownDurationMove.order,['producer','ultimate','consumer'],'지속시간을 모르면 추정으로 순서를 변경하면 안 됩니다.');
const previousCycleSuccess=optimizeSequence({skills:optimizerSkills,currentOrder:['consumer','producer','ultimate'],events:[{type:'cast',skillId:'producer',at:1000},{type:'cast',skillId:'consumer',at:7000},{type:'cast',skillId:'ultimate',at:8000}],startedAt:0,endedAt:9000});
assert.deepStrictEqual(previousCycleSuccess.order,['consumer','producer','ultimate'],'현재 순서가 반대여도 이전 순환 효과 안에서 조건을 충족했다면 순서를 유지해야 합니다.');
const healthOnly=optimizeSequence({skills:[{id:'health',name:'체력 조건',family:'시험',conditions:[{effect:'대상 체력 50% 이상',result:'피해 증가'}]}],currentOrder:['health'],events:[{type:'cast',skillId:'health',at:1000}]});
assert.equal(healthOnly.relationships.length,0,'대상 체력 조건을 부여 도술이 필요한 상태 이상으로 분류하면 안 됩니다.');
const buffFirst=optimizeSequence({skills:[{id:'hit',name:'공격',family:'시험',conditions:[]},{id:'buff',name:'용맹',family:'시험',buffs:['주는 피해 증가'],conditions:[]}],currentOrder:['hit','buff'],events:[{type:'cast',skillId:'hit',at:1000},{type:'cast',skillId:'buff',at:2000}]});
assert.deepStrictEqual(buffFirst.order,['buff','hit'],'전역 공격 강화는 후속 도술 전체에 적용되도록 맨 앞으로 옮겨야 합니다.');
assert.equal(buffFirst.relationships[0].action,'move-global-buff-first');

const timedSkills=[
  {id:'shock',name:'감전 부여',family:'시험',debuffs:['감전'],timingEffects:{'감전':{duration:10,application:'hit'}},conditions:[]},
  {id:'nanta',name:'난타',family:'시험',buffs:[],debuffs:[],conditions:[{effect:'감전',result:'추가 피해 14.8%',minBreakthrough:6}]}
];
const timedEvents=[
  {type:'cast',skillId:'shock',at:1000,evidence:'visual'},
  {type:'cast',skillId:'nanta',at:7000,evidence:'sequence'},
  {type:'cast',skillId:'nanta',at:13000,evidence:'visual'},
  {type:'basic',at:4000,evidence:'visual'},
  {type:'basic',at:8000,evidence:'visual'}
];
const timing=analyzeEffectTiming({skills:timedSkills,events:timedEvents,startedAt:0,endedAt:15000}).find(row=>row.effect==='감전');
assert.equal(timing.casts,1,'도술이 발동하면 감전도 발동한 것으로 계산해야 합니다.');
assert.equal(timing.coveredConsumers,1,'감전 10초 안의 난타는 조건 적중으로 계산해야 합니다.');
assert.equal(timing.missedConsumers,1,'감전이 종료된 후의 난타는 조건 미적중으로 계산해야 합니다.');
const effectState=analyzeEffectState({skills:timedSkills,events:timedEvents,startedAt:0,endedAt:8000});
assert.equal(effectState.activeEffects[0].effect,'감전','현재 시점에 유지 중인 약화를 반환해야 합니다.');
assert.equal(effectState.conditions[0].covered,1,'조건 성공 횟수를 도술별로 집계해야 합니다.');
assert.equal(effectState.conditions[0].missed,1,'조건 실패 횟수를 도술별로 집계해야 합니다.');
assert.equal(effectState.conditions[0].recovered,1,'순서 복원 발동은 별도 근거 수로 보존해야 합니다.');
assert.equal(effectState.attempts[0].remainingMs,4000,'조건 성공 시 남은 효과 시간을 기록해야 합니다.');
const timedOptimized=optimizeSequence({skills:timedSkills,events:timedEvents,startedAt:1000,endedAt:15000});
assert.equal(timedOptimized.basicAttacks,2);
assert.ok(timedOptimized.basicShare>0);
assert.throws(() => cleanBuild({schema:'unknown',skills:ids},catalog));
assert.throws(() => cleanBuild({schema:'dosul-live-v1',skills:['missing']},catalog));

console.log('core tests passed');
