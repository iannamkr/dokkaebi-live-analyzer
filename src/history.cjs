const fs = require('fs');
const path = require('path');

const STORE_SCHEMA = 'dokkaebi-measurement-history-v1';
const RECORD_SCHEMA = 'dokkaebi-measurement-v1';

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function validRecord(value) {
  return Boolean(value && value.schema === RECORD_SCHEMA && typeof value.id === 'string' && value.build && value.measurement && value.result);
}

function normalizeStore(value) {
  const records = Array.isArray(value?.records) ? value.records.filter(validRecord) : [];
  records.sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0));
  return { schema: STORE_SCHEMA, records };
}

function createHistoryStore(filePath) {
  const backup = `${filePath}.backup`;

  function recoverBackup() {
    if (!fs.existsSync(filePath) && fs.existsSync(backup)) fs.renameSync(backup, filePath);
    else if (fs.existsSync(backup)) fs.rmSync(backup, { force: true });
  }

  function cleanupTemporaryFiles() {
    const directory = path.dirname(filePath);
    const prefix = `${path.basename(filePath)}.`;
    try {
      for (const name of fs.readdirSync(directory)) {
        if (name.startsWith(prefix) && name.endsWith('.tmp')) fs.rmSync(path.join(directory, name), { force: true });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  function read() {
    try {
      return normalizeStore(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') return normalizeStore(null);
      throw error;
    }
  }

  function write(store) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const normalized = normalizeStore(store);
    const temporary = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(normalized, null, 2), 'utf8');
    try {
      if (fs.existsSync(filePath)) fs.renameSync(filePath, backup);
      fs.renameSync(temporary, filePath);
      if (fs.existsSync(backup)) fs.rmSync(backup, { force: true });
    } catch (error) {
      if (!fs.existsSync(filePath) && fs.existsSync(backup)) fs.renameSync(backup, filePath);
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
      throw error;
    }
    return clone(normalized);
  }

  function list() {
    return clone(read().records);
  }

  function save(record) {
    if (!validRecord(record)) throw new Error('측정 기록 형식이 올바르지 않습니다.');
    const store = read();
    const index = store.records.findIndex(item => item.id === record.id);
    const previous = index >= 0 ? store.records[index] : null;
    const next = {
      ...clone(record),
      createdAt: Number(previous?.createdAt || record.createdAt || Date.now()),
      updatedAt: Number(record.updatedAt || Date.now())
    };
    if (index >= 0) store.records[index] = next;
    else store.records.push(next);
    return write(store).records.find(item => item.id === next.id);
  }

  function update(id, changes = {}) {
    const store = read();
    const index = store.records.findIndex(item => item.id === id);
    if (index < 0) return null;
    const allowed = {};
    if (typeof changes.title === 'string') allowed.title = changes.title.trim().slice(0, 80);
    if (typeof changes.note === 'string') allowed.note = changes.note.trim().slice(0, 500);
    if (typeof changes.favorite === 'boolean') allowed.favorite = changes.favorite;
    store.records[index] = { ...store.records[index], ...allowed, updatedAt: Date.now() };
    return write(store).records.find(item => item.id === id);
  }

  function remove(id) {
    const store = read();
    const before = store.records.length;
    store.records = store.records.filter(item => item.id !== id);
    if (store.records.length === before) return false;
    write(store);
    return true;
  }

  recoverBackup();
  cleanupTemporaryFiles();
  return { list, save, update, remove, filePath };
}

module.exports = { STORE_SCHEMA, RECORD_SCHEMA, normalizeStore, createHistoryStore };
