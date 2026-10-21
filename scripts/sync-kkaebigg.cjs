const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const catalogPath = path.join(root, 'assets', 'data.json');
const checkedAt = '2026-10-21';
const skillSource = 'https://kkaebigg.com/data/skills.json';
const patchSource = 'https://kkaebigg.com/news/skill-balance-20261021/';

const flatten = value => {
  if (!Array.isArray(value)) return String(value ?? '');
  if (value.length === 2 && typeof value[0] === 'string' && ['up', 'down', 'chg', 'del'].includes(value[1])) return value[0];
  return value.map(flatten).join('');
};
const compact = value => String(value || '').replace(/\s+/g, ' ').trim();
const normalize = value => compact(value).replace(/\s+/g, '').toLowerCase();
const stripDirectPrefix = value => compact(value)
  .replace(/^(?:자신과 아군에게|자신에게|아군에게)\s*/, '')
  .replace(/^풀 차지 시\s*/, '');

const stateNames = [
  '받는 피해 증가', '출혈', '화상', '감전', '마비', '빙결', '기절', '속박', '수면', '침묵',
  '약화', '저주', '강화 저주', '파쇄', '파열', '관통', '추적', '충격', '낙인', '한기',
  '기세', '질풍', '정밀', '원소', '수호'
];

function conditionTriggers(hit) {
  const line = compact(hit?.l?.join(' '));
  if (!line) return [];
  const directName = stripDirectPrefix(hit?.n);
  if (stateNames.some(name => normalize(name) === normalize(directName))) return [];
  if (/대상에게 적용된/.test(line)) {
    return stateNames.filter(name => new RegExp(`(?:^|[·,\\s])${name}(?:$|[·,\\s])`).test(line));
  }
  return stateNames.filter(name => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`${escaped}(?:\\s)*(?:대상|보유|상태|상태의)`).test(line);
  });
}

function conditionResult(name, trigger) {
  const match = compact(name).match(/^(.+?)\s*\((.+)\)$/);
  if (!match) return compact(name).replace(trigger, '').replace(/^\s*[-·:]\s*/, '') || '조건 효과';
  const left = compact(match[1]);
  const inside = compact(match[2]);
  return normalize(left) === normalize(trigger) ? inside : left;
}

function classifyEffects(hitEntries) {
  const buffs = [];
  const debuffs = [];
  const conditions = [];
  for (const hit of hitEntries || []) {
    const triggers = conditionTriggers(hit);
    if (triggers.length) {
      for (const trigger of triggers) {
        conditions.push({
          effect: trigger,
          result: conditionResult(hit.n, trigger),
          scope: ['기세', '질풍', '정밀', '원소', '수호'].includes(trigger) ? 'self' : 'enemy',
          source: 'kkaebigg-current',
          reference: true,
          resultScope: hit.t === '약화' ? 'enemy' : 'self'
        });
      }
      continue;
    }
    const name = stripDirectPrefix(hit.n);
    if (!name) continue;
    (hit.t === '약화' ? debuffs : buffs).push(name);
  }
  const unique = values => [...new Set(values)];
  const uniqueConditions = [...new Map(conditions.map(value => [`${normalize(value.effect)}|${normalize(value.result)}`, value])).values()];
  return { buffs: unique(buffs), debuffs: unique(debuffs), conditions: uniqueConditions };
}

function extractPatchEffects(entry) {
  const text = flatten(entry?.v);
  const effects = [];
  for (const line of text.split(/\r?\n/).map(compact).filter(Boolean)) {
    const match = line.match(/^(.+?)\s*\[(지속|\d+(?:\.\d+)?초)\]$/);
    if (!match) continue;
    effects.push({
      name: stripDirectPrefix(match[1]),
      duration: match[2] === '지속' ? null : Number(match[2].replace('초', '')),
      policy: match[2] === '지속' ? 'persistent' : 'timed'
    });
  }
  return effects;
}

function parsePatchData(patchHtml) {
  const patchMatch = String(patchHtml || '').match(/<script[^>]+id="sp-data"[^>]*>([\s\S]*?)<\/script>/);
  if (!patchMatch) throw new Error('10월 21일 패치의 구조화 자료(sp-data)를 찾지 못했습니다.');
  return JSON.parse(patchMatch[1]);
}

function syncCatalog(catalog, snapshot, patchData) {
  const patchByKey = new Map();
  for (const entry of patchData.pve || []) {
    const key = `${entry.s}|${entry.n}`;
    if (!patchByKey.has(key)) patchByKey.set(key, []);
    patchByKey.get(key).push(entry);
  }

  const stats = {
    skills: 0, cooldowns: 0, numbers: 0, hits: 0, effects: 0, timedEffects: 0,
    missingPatchRows: [], unknownTimedEffects: []
  };

  if (catalog.skills.length !== snapshot.skills.length) {
    throw new Error(`도술 수 불일치: 로컬 ${catalog.skills.length} / 최신 ${snapshot.skills.length}`);
  }

  catalog.skills.forEach((skill, index) => {
  const latest = snapshot.skills[index];
  const expectedId = Number(String(skill.id).replace(/^s/, '')) - 1;
  const family = snapshot.styles[latest.st]?.n;
  if (latest.id !== expectedId || latest.n !== skill.name || family !== skill.family) {
    throw new Error(`도술 정렬 불일치: ${skill.id} ${skill.family} ${skill.name} / 원격 ${latest.id} ${family} ${latest.n}`);
  }

  stats.skills += 1;
  if (Number(skill.cooldown) !== Number(latest.num?.cd)) stats.cooldowns += 1;
  if (JSON.stringify(skill.referenceNumbers) !== JSON.stringify(latest.num)) stats.numbers += 1;
  if (JSON.stringify(skill.referenceProgression?.hit || []) !== JSON.stringify(latest.hit || [])) stats.hits += 1;

  const currentEffects = classifyEffects(latest.hit || []);
  if (JSON.stringify({ buffs: skill.buffs, debuffs: skill.debuffs, conditions: skill.conditions }) !== JSON.stringify(currentEffects)) {
    stats.effects += 1;
  }

  skill.cooldown = latest.num?.cd ?? skill.cooldown;
  if (skill.basic) skill.basic.cooldown = latest.num?.cd ?? skill.basic.cooldown;
  skill.notes = latest.d || skill.notes;
  skill.buffs = currentEffects.buffs;
  skill.debuffs = currentEffects.debuffs;
  skill.conditions = currentEffects.conditions;
  skill.referenceNumbers = latest.num;
  skill.motion = {
    actionMs: Number(latest.num?.m || 0),
    damageMs: Number(latest.num?.dm || 0),
    chargeMs: Number(latest.num?.cm || 0),
    source: skillSource,
    checkedAt
  };
  skill.referenceDetail = {
    ...(skill.referenceDetail || {}),
    buffs: (latest.hit || []).filter(value => value.t !== '약화').map(value => ({ name: value.n, description: compact(value.l?.join(' ')), duration: null })),
    debuffs: (latest.hit || []).filter(value => value.t === '약화').map(value => ({ name: value.n, description: compact(value.l?.join(' ')), duration: null })),
    description: latest.d || '',
    source: 'kkaebigg'
  };
  skill.referenceProgression = {
    ...(skill.referenceProgression || {}),
    effects: latest.ef || [],
    awakening: latest.ak || null,
    source: skillSource,
    hit: latest.hit || []
  };
  skill.crosscheck = {
    ...(skill.crosscheck || {}),
    source: 'kkaebigg',
    checkedAt,
    currentPatch: patchSource
  };

  const patchRows = patchByKey.get(`${latest.st}|${latest.n}`) || [];
  if (!patchRows.length) stats.missingPatchRows.push(`${skill.family}/${skill.name}`);
  const patchEffects = patchRows.flatMap(extractPatchEffects);
  const timings = {};
  for (const [kind, names] of [['buff', skill.buffs], ['debuff', skill.debuffs]]) {
    for (const name of names) {
      let effect = patchEffects.find(value => normalize(value.name) === normalize(name));
      if (!effect && skill.name === '은신' && name === '은신') effect = { name, duration: 10, policy: 'timed' };
      if (effect?.duration > 0) {
        timings[name] = {
          duration: effect.duration,
          policy: 'timed',
          application: kind === 'debuff' ? 'hit' : 'start',
          source: patchSource,
          checked: checkedAt
        };
        stats.timedEffects += 1;
      } else {
        const instant = /(경직|제거)$/.test(name);
        const policy = instant ? 'instant' : effect?.policy || 'persistent';
        timings[name] = {
          duration: null,
          policy,
          application: kind === 'debuff' ? 'hit' : 'start',
          source: effect ? patchSource : skillSource,
          checked: checkedAt
        };
        if (!['instant', 'persistent'].includes(policy)) stats.unknownTimedEffects.push(`${skill.family}/${skill.name}:${name}`);
      }
    }
  }
  skill.timingEffects = timings;
  });

  catalog.families = Object.fromEntries(snapshot.styles.map(value => [value.n, value.aw]));
  catalog.familyReference = Object.fromEntries(snapshot.styles.map(value => [value.n, value.aws || []]));
  catalog.meta.checkedAt = checkedAt;
  catalog.meta.baselineDate = checkedAt;
  catalog.meta.coverage = '2026-10-21 깨비지지 패치 후 도술 105개 수치·기본 효과·대기시간·신식 자료 동기화 완료.';
  catalog.meta.patchNote = '10월 21일 대규모 밸런스 패치 반영: PvE 110항목, PvP 110항목, 신식 32항목. 도술 기본 효과와 명시된 지속시간을 현행 자료로 교체했습니다.';
  catalog.meta.crosscheck = '2026-10-21 깨비지지 도술 105개를 id·이름·계열로 대조하고, 패치 구조화 자료의 변경 후 수치와 효과 지속시간을 반영했습니다.';
  catalog.meta.systemPatch = {
  checkedAt,
  source: patchSource,
  pvpMultiplier: 0.45,
  damageReductionCap: 0.75,
  shieldStatBasis: 'caster',
  swordShieldBasicRangeMeters: 2,
  pveEntries: patchData.pve?.length || 0,
  pvpEntries: patchData.pvp?.length || 0,
  awakeningEntries: patchData.awaken?.length || 0
  };
  if (!catalog.sources.some(value => value.id === 'balance-20261021')) {
    catalog.sources.push({
    id: 'balance-20261021',
    title: '10월 21일 대규모 도술 밸런스 패치',
    url: patchSource,
    type: '깨비지지 패치 정리 · 변경 전후 구조화 자료'
    });
  }
  return { catalog, stats };
}

if (require.main === module) {
  const snapshotPath = process.argv[2] || path.join(root, 'test-output', 'reference', 'skills.json');
  const patchPath = process.argv[3] || path.join(root, 'test-output', 'reference', 'balance.html');
  const write = process.argv.includes('--write');
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  const patchData = parsePatchData(fs.readFileSync(patchPath, 'utf8'));
  const result = syncCatalog(catalog, snapshot, patchData);
  console.log(JSON.stringify(result.stats, null, 2));
  if (write) {
    fs.writeFileSync(catalogPath, `${JSON.stringify(result.catalog, null, 2)}\n`);
    console.log(`갱신 완료: ${catalogPath}`);
  }
}

module.exports = { classifyEffects, conditionResult, conditionTriggers, extractPatchEffects, parsePatchData, syncCatalog };
