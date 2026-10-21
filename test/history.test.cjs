const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHistoryStore, RECORD_SCHEMA } = require('../src/history.cjs');

const directory = path.join(__dirname, '..', 'test-output', `history-${process.pid}`);
fs.mkdirSync(directory, {recursive:true});
const file = path.join(directory, 'measurement-history-v1.json');
const temporary = `${file}.old.tmp`;
fs.writeFileSync(temporary, 'unused');
const store = createHistoryStore(file);
assert.equal(fs.existsSync(temporary), false, '비정상 종료로 남은 임시 파일을 시작할 때 정리해야 합니다.');
assert.deepEqual(store.list(), []);

function record(id, updatedAt, dps = null) {
  return {
    schema: RECORD_SCHEMA,
    id,
    createdAt: updatedAt,
    updatedAt,
    title: `빌드 ${id}`,
    favorite: false,
    note: '',
    build: { skills: ['s001'], currentOrder: ['s001'], skillSnapshots: [{ id:'s001', name:'시험', family:'연타' }] },
    measurement: { startedAt:updatedAt-1000, endedAt:updatedAt, durationMs:1000, events:[], ocr:{dps,rows:[]} },
    result: { rows:[], conditionTiming:[], basicShare:0 }
  };
}

store.save(record('one', 1000, 1234));
assert.equal(store.list().length, 1);
assert.equal(store.list()[0].measurement.ocr.dps, 1234);

const updated = record('one', 2000, 2345);
updated.title = '추가 측정';
store.save(updated);
assert.equal(store.list().length, 1, '추가 측정은 같은 기록을 갱신해야 합니다.');
assert.equal(store.list()[0].createdAt, 1000, '최초 측정 시각은 유지해야 합니다.');
assert.equal(store.list()[0].measurement.ocr.dps, 2345);

store.save(record('two', 3000));
assert.deepEqual(store.list().map(item=>item.id), ['two','one'], '최근 수정 기록이 위에 와야 합니다.');
store.update('two', { title:'수정된 이름', note:'실측 비교용', favorite:true, result:{forbidden:true} });
const two=store.list().find(item=>item.id==='two');
assert.equal(two.title, '수정된 이름');
assert.equal(two.favorite, true);
assert.equal(two.result.forbidden, undefined, '사용자 편집은 측정 결과를 바꾸면 안 됩니다.');

assert.equal(store.remove('one'), true);
assert.equal(store.remove('missing'), false);
assert.deepEqual(store.list().map(item=>item.id), ['two']);

for(let index=0;index<100;index+=1)store.save(record(`bulk-${index}`,4000+index));
assert.equal(store.list().length,101,'100개 측정 이력도 자동 삭제 없이 모두 보존해야 합니다.');
const reopened=createHistoryStore(file);
assert.equal(reopened.list().length,101,'앱을 다시 실행해도 모든 측정 이력을 복원해야 합니다.');

fs.rmSync(directory, {recursive:true,force:true});
console.log('history persistence passed');
