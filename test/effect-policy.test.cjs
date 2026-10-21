const assert = require('node:assert/strict');
const { analyzeEffectState, analyzeEffectTiming, optimizeSequence } = require('../src/core.cjs');

const conditionNames = ['감전','관통','기세','낙인','마비','받는 피해 증가','빙결','속박','수호','약화','원소','정밀','질풍','추적','출혈','충격','파쇄','파열','한기','화상'];
for (const [index, effect] of conditionNames.entries()) {
  const producer = {id:`p${index}`,name:`${effect} 부여`,buffs:[],debuffs:[effect],conditions:[],timingEffects:{[effect]:{duration:2,policy:'timed',application:'hit'}}};
  const consumer = {id:`c${index}`,name:`${effect} 소비`,buffs:[],debuffs:[],conditions:[{effect,result:'추가 효과'}],timingEffects:{}};
  const state = analyzeEffectState({
    skills:[producer,consumer],
    events:[
      {type:'cast',skillId:producer.id,at:1000,evidence:'visual'},
      {type:'cast',skillId:consumer.id,at:3000,evidence:'visual'},
      {type:'cast',skillId:consumer.id,at:3001,evidence:'visual'}
    ],
    startedAt:0,
    endedAt:4000
  });
  assert.equal(state.conditions.length, 1, `${effect} 조건 판정을 건너뛰면 안 됩니다.`);
  assert.equal(state.conditions[0].covered, 1, `${effect} 종료 시각까지는 성공이어야 합니다.`);
  assert.equal(state.conditions[0].missed, 1, `${effect} 종료 뒤에는 실패여야 합니다.`);
  assert.equal(state.conditions[0].unknown, 0, `${effect}는 지속시간 미확인이 아니어야 합니다.`);
}

const policySkills = [
  {id:'instant',name:'즉시 제거',buffs:[],debuffs:['보호막 제거'],conditions:[],timingEffects:{'보호막 제거':{duration:null,policy:'instant',application:'hit'}}},
  {id:'persistent',name:'조건 유지',buffs:['상시 강화'],debuffs:[],conditions:[],timingEffects:{'상시 강화':{duration:null,policy:'persistent',application:'start'}}},
  {id:'unknown',name:'미확인 효과',buffs:['미확인'],debuffs:[],conditions:[],timingEffects:{}},
];
const policyEvents = policySkills.map((skill,index)=>({type:'cast',skillId:skill.id,at:1000+index*100,evidence:'visual'}));
const policyRows = analyzeEffectTiming({skills:policySkills,events:policyEvents,startedAt:0,endedAt:5000});
assert.equal(policyRows.find(row=>row.skillId==='instant').policy, 'instant');
assert.equal(policyRows.find(row=>row.skillId==='persistent').policy, 'persistent');
assert.equal(policyRows.find(row=>row.skillId==='unknown').policy, 'unknown');
const policyOptimization = optimizeSequence({skills:policySkills,events:policyEvents,startedAt:0,endedAt:5000,currentOrder:policySkills.map(skill=>skill.id)});
const instantReason = policyOptimization.rows.find(row=>row.id==='instant').reasons.join(' ');
const persistentReason = policyOptimization.rows.find(row=>row.id==='persistent').reasons.join(' ');
const unknownReason = policyOptimization.rows.find(row=>row.id==='unknown').reasons.join(' ');
assert.doesNotMatch(instantReason, /지속시간 미확인/);
assert.doesNotMatch(persistentReason, /지속시간 미확인/);
assert.match(unknownReason, /지속시간 미확인/);

const unknownProducer = {id:'producer',name:'시간 미확인 부여',buffs:[],debuffs:['감전'],conditions:[],timingEffects:{}};
const conditionConsumer = {id:'consumer',name:'감전 소비',buffs:[],debuffs:[],conditions:[{effect:'감전',result:'추가 피해'}],timingEffects:{}};
const unknownState = analyzeEffectState({skills:[unknownProducer,conditionConsumer],events:[{type:'cast',skillId:'producer',at:1000},{type:'cast',skillId:'consumer',at:1500}],startedAt:0,endedAt:2000});
assert.equal(unknownState.conditions[0].unknown, 1);
assert.equal(unknownState.conditions[0].total, 0, '지속시간을 모르면 성공/실패 분모에 넣으면 안 됩니다.');
const missingState = analyzeEffectState({skills:[conditionConsumer],events:[{type:'cast',skillId:'consumer',at:1500}],startedAt:0,endedAt:2000});
assert.equal(missingState.attempts[0].status, 'missing-producer');
const missingOptimization = optimizeSequence({skills:[conditionConsumer],events:[{type:'cast',skillId:'consumer',at:1500}],currentOrder:['consumer']});
assert.equal(missingOptimization.relationships[0].action, 'producer-missing');

const overlapProducer = {id:'overlap',name:'중복 강화',buffs:['원소'],debuffs:[],conditions:[],timingEffects:{원소:{duration:5,policy:'timed',application:'start'}}};
const overlapRows = analyzeEffectTiming({skills:[overlapProducer],events:[{type:'cast',skillId:'overlap',at:1000},{type:'cast',skillId:'overlap',at:4000}],startedAt:0,endedAt:10000});
assert.equal(overlapRows[0].overlaps, 1);
assert.equal(Math.round(overlapRows[0].coverage), 80, '겹친 구간을 두 번 더하면 안 됩니다.');
const activeState = analyzeEffectState({skills:[overlapProducer],events:[{type:'cast',skillId:'overlap',at:1000},{type:'cast',skillId:'overlap',at:4000}],startedAt:0,endedAt:8000});
assert.equal(activeState.activeEffects.length, 1, '같은 효과가 겹치면 가장 늦게 끝나는 창 하나만 현재 효과로 보여야 합니다.');
assert.equal(activeState.activeEffects[0].end, 9000);

console.log('effect policy tests passed');
