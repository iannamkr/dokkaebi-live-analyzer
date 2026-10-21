const assert = require('node:assert/strict');
const {
  classifyEffects,
  conditionResult,
  conditionTriggers,
  extractPatchEffects,
  parsePatchData,
  syncCatalog
} = require('../scripts/sync-kkaebigg.cjs');

const classified = classifyEffects([
  { t:'강화', n:'자신에게 원소', l:['원소 효과를 얻습니다.'] },
  { t:'강화', n:'자신에게 원소', l:['중복 표기'] },
  { t:'약화', n:'감전', l:['감전 효과를 부여합니다.'] },
  { t:'강화', n:'추가 피해 (감전)', l:['감전 대상 공격 시 추가 피해를 줍니다.'] },
  { t:'강화', n:'추가 효과', l:['대상에게 적용된 화상 · 마비 상태에 따라 발동합니다.'] }
]);
assert.deepEqual(classified.buffs, ['원소']);
assert.deepEqual(classified.debuffs, ['감전']);
assert.deepEqual(classified.conditions.map(value => value.effect), ['감전','화상','마비']);
assert.equal(classified.conditions[0].result, '추가 피해');
assert.equal(classified.conditions[0].scope, 'enemy');
assert.equal(classified.conditions[0].resultScope, 'self');
assert.equal(conditionResult('감전 (추가 피해)', '감전'), '추가 피해');
assert.deepEqual(conditionTriggers({ n:'화상', l:['화상 효과를 부여합니다.'] }), [], '직접 부여 효과는 조건으로 오인하면 안 됩니다.');

assert.deepEqual(extractPatchEffects({v:[
  '자신에게 공격력 증가 [10초]\n',
  ['마비 [1초]', 'up'],
  '\n은신 [지속]'
]}), [
  {name:'공격력 증가',duration:10,policy:'timed'},
  {name:'마비',duration:1,policy:'timed'},
  {name:'은신',duration:null,policy:'persistent'}
]);

const embedded = {pve:[{s:0,n:'시험 도술',v:['감전 [3초]']}],pvp:[1,2],awaken:[1]};
assert.deepEqual(parsePatchData(`<html><script type="application/json" id="sp-data">${JSON.stringify(embedded)}</script></html>`), embedded);
assert.throws(() => parsePatchData('<html></html>'), /sp-data/);

const catalog = {
  meta:{}, sources:[], families:{}, familyReference:{},
  skills:[{
    id:'s001', name:'시험 도술', family:'시험', cooldown:9,
    basic:{cooldown:9}, buffs:[], debuffs:[], conditions:[], timingEffects:{},
    referenceDetail:{}, referenceProgression:{}, crosscheck:{}
  }]
};
const snapshot = {
  styles:[{n:'시험',aw:'시험 신식',aws:['시험 신식']}],
  skills:[{
    id:0, st:0, n:'시험 도술', d:'현행 설명',
    num:{cd:7,m:120,dm:80,cm:0},
    hit:[
      {t:'약화',n:'감전',l:['감전 효과를 부여합니다.']},
      {t:'강화',n:'추가 피해 (감전)',l:['감전 대상 공격 시 추가 피해']}
    ], ef:['효과'], ak:{n:'각성'}
  }]
};
const result = syncCatalog(catalog, snapshot, embedded);
const synced = result.catalog.skills[0];
assert.equal(synced.cooldown, 7);
assert.equal(synced.basic.cooldown, 7);
assert.deepEqual(synced.motion.actionMs, 120);
assert.deepEqual(synced.debuffs, ['감전']);
assert.equal(synced.conditions[0].effect, '감전');
assert.equal(synced.timingEffects['감전'].duration, 3);
assert.equal(synced.timingEffects['감전'].policy, 'timed');
assert.equal(result.stats.skills, 1);
assert.equal(result.stats.cooldowns, 1);
assert.equal(result.stats.timedEffects, 1);
assert.deepEqual(result.stats.unknownTimedEffects, []);
assert.equal(result.catalog.meta.systemPatch.pvpEntries, 2);
assert.throws(() => syncCatalog({ ...catalog, skills:[] }, snapshot, embedded), /도술 수 불일치/);

console.log('kkaebigg synchronization parser tests passed');
