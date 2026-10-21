const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'data.json'), 'utf8'));
const expectedFamilies = ['절명','연타','강타','척살','저격','주술','파멸','강인','기동','헌신','기만','제압'];
const normalize = value => String(value || '').replace(/\s+/g, '');
const find = (name, family) => {
  const value = catalog.skills.find(skill => skill.name === name && (!family || skill.family === family));
  assert.ok(value, `${family ? `${family}/` : ''}${name} 도술이 있어야 합니다.`);
  return value;
};

assert.equal(catalog.meta.checkedAt, '2026-10-21');
assert.equal(catalog.meta.baselineDate, '2026-10-21');
assert.deepEqual(Object.keys(catalog.families), expectedFamilies);
assert.deepEqual(Object.keys(catalog.familyReference), expectedFamilies);
assert.equal(catalog.meta.systemPatch.pvpMultiplier, 0.45);
assert.equal(catalog.meta.systemPatch.damageReductionCap, 0.75);
assert.equal(catalog.meta.systemPatch.shieldStatBasis, 'caster');
assert.equal(catalog.meta.systemPatch.swordShieldBasicRangeMeters, 2);
assert.equal(catalog.meta.systemPatch.pveEntries, 110);
assert.equal(catalog.meta.systemPatch.pvpEntries, 110);
assert.equal(catalog.meta.systemPatch.awakeningEntries, 32);
assert.ok(catalog.sources.some(source => source.id === 'balance-20261021' && source.url === catalog.meta.systemPatch.source));

assert.equal(catalog.skills.length, 105);
assert.equal(new Set(catalog.skills.map(skill => skill.id)).size, 105, '도술 id는 중복되면 안 됩니다.');
assert.deepEqual(catalog.skills.map(skill => skill.id), Array.from({length:105}, (_, index) => `s${String(index + 1).padStart(3, '0')}`));
assert.equal(catalog.skills.filter(skill => skill.ultimate).length, 12, '각 계열에 궁극기가 하나씩 있어야 합니다.');
for (const family of expectedFamilies) {
  const members = catalog.skills.filter(skill => skill.family === family);
  assert.ok(members.length > 0, `${family} 계열 도술이 있어야 합니다.`);
  assert.equal(members.filter(skill => skill.ultimate).length, 1, `${family} 계열 궁극기는 하나여야 합니다.`);
  assert.ok(String(catalog.families[family]).trim(), `${family} 신식 설명이 있어야 합니다.`);
  assert.ok(Array.isArray(catalog.familyReference[family]) && catalog.familyReference[family].length > 0, `${family} 신식 단계 자료가 있어야 합니다.`);
}

const policyCounts = { timed:0, instant:0, persistent:0 };
for (const skill of catalog.skills) {
  assert.equal(skill.cooldown, skill.basic.cooldown, `${skill.name}의 표시/감지 대기시간이 같아야 합니다.`);
  assert.equal(skill.cooldown, skill.referenceNumbers.cd, `${skill.name}의 대기시간이 현행 수치와 같아야 합니다.`);
  assert.equal(skill.motion.actionMs, Number(skill.referenceNumbers.m || 0));
  assert.equal(skill.motion.damageMs, Number(skill.referenceNumbers.dm || 0));
  assert.equal(skill.motion.chargeMs, Number(skill.referenceNumbers.cm || 0));
  assert.equal(skill.motion.checkedAt, '2026-10-21');
  assert.ok(Array.isArray(skill.referenceProgression.effects));
  assert.ok(Array.isArray(skill.referenceProgression.hit));
  assert.equal(skill.crosscheck.checkedAt, '2026-10-21');

  const directEffects = [...skill.buffs, ...skill.debuffs];
  assert.equal(new Set(directEffects.map(normalize)).size, directEffects.length, `${skill.name}의 직접 효과가 중복되면 안 됩니다.`);
  assert.deepEqual(Object.keys(skill.timingEffects).sort(), directEffects.slice().sort(), `${skill.name}의 직접 효과와 시간 정책은 1:1이어야 합니다.`);
  for (const effect of directEffects) {
    const timing = skill.timingEffects[effect];
    assert.ok(['timed','instant','persistent'].includes(timing.policy), `${skill.name}/${effect} 정책이 유효해야 합니다.`);
    policyCounts[timing.policy] += 1;
    if (timing.policy === 'timed') assert.ok(Number.isFinite(timing.duration) && timing.duration > 0, `${skill.name}/${effect} 지속시간이 필요합니다.`);
    else assert.equal(timing.duration, null, `${skill.name}/${effect}는 고정 지속시간을 만들면 안 됩니다.`);
    assert.ok(['start','hit'].includes(timing.application), `${skill.name}/${effect} 적용 시점이 필요합니다.`);
    assert.equal(timing.checked, '2026-10-21');
  }

  const pairs = skill.conditions.map(condition => `${normalize(condition.effect)}|${normalize(condition.result)}`);
  assert.equal(new Set(pairs).size, pairs.length, `${skill.name}의 조건 효과가 중복되면 안 됩니다.`);
}
assert.deepEqual(policyCounts, {timed:99, instant:6, persistent:5});

const conditionEffects = new Set(catalog.skills.flatMap(skill => skill.conditions.map(condition => normalize(condition.effect))));
assert.equal(catalog.skills.reduce((sum, skill) => sum + skill.conditions.length, 0), 39);
assert.equal(conditionEffects.size, 20);
const timedProducers = new Map();
for (const skill of catalog.skills) {
  for (const effect of [...skill.buffs, ...skill.debuffs]) {
    if (skill.timingEffects[effect].policy !== 'timed') continue;
    const key = normalize(effect);
    if (!timedProducers.has(key)) timedProducers.set(key, []);
    timedProducers.get(key).push(skill.name);
  }
}
for (const skill of catalog.skills) for (const condition of skill.conditions) {
  assert.ok(timedProducers.has(normalize(condition.effect)), `${skill.name}/${condition.effect} 조건은 시간값이 있는 부여 도술이 필요합니다.`);
}

const expectedCooldowns = [
  ['약점 베기','절명',12], ['난타','연타',11], ['내려치기','강타',6], ['묵영점정','척살',12],
  ['일점 저격','저격',15], ['신벌의 영역','주술',17], ['번개 폭풍','파멸',10], ['방패 낙하','강인',80],
  ['일섬','기동',11], ['개전의 가호','헌신',90], ['간파의 눈','기만',40], ['지진','제압',22]
];
for (const [name, family, cooldown] of expectedCooldowns) assert.equal(find(name, family).cooldown, cooldown);

assert.deepEqual(find('난타','연타').buffs, []);
assert.deepEqual(find('지진','제압').debuffs, ['속박']);
assert.equal(find('지진','제압').timingEffects['속박'].duration, 2);
assert.deepEqual(find('머리치기','제압').debuffs, ['침묵','이동속도 감소']);
assert.equal(find('머리치기','제압').timingEffects['이동속도 감소'].duration, 4);
assert.deepEqual(find('용맹의 기운','헌신').buffs, ['공격력 증가']);
assert.equal(find('용맹의 기운','헌신').timingEffects['공격력 증가'].duration, 10);
assert.deepEqual(find('부적 던지기','주술').debuffs, ['약화']);
assert.equal(find('부적 던지기','주술').timingEffects['약화'].duration, 10);
assert.deepEqual(find('번개 폭풍','파멸').debuffs, ['감전','마비']);
assert.equal(find('번개 폭풍','파멸').timingEffects['마비'].duration, 1);
assert.deepEqual(find('공간 결계','기만').timingEffects, {
  '받는 피해 감소': {duration:5,policy:'timed',application:'start',source:catalog.meta.systemPatch.source,checked:'2026-10-21'},
  '받는 피해 증가': {duration:5,policy:'timed',application:'hit',source:catalog.meta.systemPatch.source,checked:'2026-10-21'}
});
assert.deepEqual(find('검기 폭발','강타').buffs, ['방어력 증가']);
assert.deepEqual(find('신벌의 영역','주술').debuffs, ['받는 회복 감소']);
assert.equal(find('심장 절단','절명').timingEffects['경직'].policy, 'instant');
assert.equal(find('환상술','기만').timingEffects['보호막 제거'].policy, 'instant');
assert.equal(find('무수불축','척살').timingEffects['피해 증가 (척살)'].policy, 'persistent');

console.log('catalog synchronization tests passed');
