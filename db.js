import { normalizeTx } from './core.js';

// Même nom de base que l'ancienne version : les données existantes sont migrées sur place.
const DB_NAME = 'BudgetFCFA_DB_V3';
const DB_VERSION = 2;
let db;

const wrap = (req) => new Promise((res, rej) => {
  req.onsuccess = () => res(req.result);
  req.onerror = () => rej(req.error);
});
const done = (tx) => new Promise((res, rej) => {
  tx.oncomplete = () => res();
  tx.onerror = () => rej(tx.error);
  tx.onabort = () => rej(tx.error);
});

export function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d = req.result;
      const up = req.transaction;
      if (!d.objectStoreNames.contains('transactions')) {
        d.createObjectStore('transactions', { keyPath: 'id', autoIncrement: true });
      }
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
      if (e.oldVersion < 2) {
        const quarantine = [];
        const store = up.objectStore('transactions');
        store.openCursor().onsuccess = (ev) => {
          const c = ev.target.result;
          if (!c) {
            if (quarantine.length) up.objectStore('meta').put(quarantine, 'quarantine');
            return;
          }
          const t = normalizeTx(c.value);
          if (t) c.update(t);
          else { quarantine.push(c.value); c.delete(); } // Conservé, jamais perdu en silence.
          c.continue();
        };
      }
    };
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('blocked'));
  });
}

const store = (name, mode = 'readonly') => db.transaction(name, mode).objectStore(name);
export const allTx = () => wrap(store('transactions').getAll());
export const putTx = (t) => wrap(store('transactions', 'readwrite').put(t));
export const deleteTx = (id) => wrap(store('transactions', 'readwrite').delete(id));
export const getMeta = (k) => wrap(store('meta').get(k));
export const setMeta = (k, v) => wrap(store('meta', 'readwrite').put(v, k));
export const delMeta = (k) => wrap(store('meta', 'readwrite').delete(k));

// Tout ou rien : un import interrompu ne laisse pas une demi-restauration.
export function bulkImport(list, metaValues = {}) {
  const tx = db.transaction(['transactions', 'meta'], 'readwrite');
  for (const t of list) tx.objectStore('transactions').add(t);
  for (const [k, v] of Object.entries(metaValues)) tx.objectStore('meta').put(v, k);
  return done(tx);
}

export function eraseData(includeLock = false) {
  const tx = db.transaction(['transactions', 'meta'], 'readwrite');
  tx.objectStore('transactions').clear();
  const meta = tx.objectStore('meta');
  ['opening', 'openingDone', 'budgets', 'lastBackup', 'quarantine', 'lastAccount'].forEach((k) => meta.delete(k));
  if (includeLock) { meta.delete('lock'); meta.delete('lockFails'); }
  return done(tx);
}
