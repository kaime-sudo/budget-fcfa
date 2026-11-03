// Logique pure : aucun accès au DOM ni à IndexedDB, donc testable sous Node.
export const ACCOUNTS = [
  { id: 'especes', label: 'Espèces', group: 'dispo' },
  { id: 'wave', label: 'Wave', group: 'dispo' },
  { id: 'orange', label: 'Orange Money', group: 'dispo' },
  { id: 'mtn', label: 'MTN Money', group: 'dispo' },
  { id: 'moov', label: 'Moov Money', group: 'dispo' },
  { id: 'banque', label: 'Banque', group: 'dispo' },
  { id: 'placement_banque', label: 'Placement bancaire', group: 'place' },
  { id: 'fcp', label: 'FCP', group: 'place' },
  { id: 'brvm', label: 'BRVM', group: 'place' },
  { id: 'placement_autre', label: 'Autre placement', group: 'place' },
  { id: 'projet', label: 'Projet', group: 'projet' },
];
const ACCOUNT_BY_ID = Object.fromEntries(ACCOUNTS.map((a) => [a.id, a]));
export const accountLabel = (id) => ACCOUNT_BY_ID[id]?.label ?? String(id);
export const accountGroup = (id) => ACCOUNT_BY_ID[id]?.group;

export const SAVINGS_CATEGORY = 'Tontine & Épargne';
export const EXPENSE_CATEGORIES = [
  { value: 'Alimentation & Marché', label: 'Alimentation' },
  { value: 'Transport & Carburant', label: 'Transport' },
  { value: 'Logement & Factures (CIE/SODECI)', label: 'Logement, CIE, SODECI' },
  { value: 'Communication & Data', label: 'Crédit et data' },
  { value: 'Santé & Pharmacie', label: 'Santé' },
  { value: 'Scolarité & Formation', label: 'Scolarité' },
  { value: 'Loisirs & Sorties', label: 'Loisirs' },
  { value: SAVINGS_CATEGORY, label: 'Tontine, épargne' },
  { value: 'Divers & Imprévus', label: 'Divers' },
];
export const INCOME_CATEGORIES = [
  { value: 'Apport / Salaire', label: 'Salaire, apport' },
  { value: 'Vente & Activité', label: 'Vente, activité' },
  { value: 'Remboursement', label: 'Remboursement' },
  { value: 'Autre entrée', label: 'Autre' },
];
const CATEGORY_LABELS = Object.fromEntries(
  [...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES].map((c) => [c.value, c.label]),
);
export const categoryLabel = (v) => CATEGORY_LABELS[v] ?? String(v ?? 'Sans catégorie');

export const TYPES = { EXPENSE: 'Dépense', INCOME: 'Entrée', TRANSFER: 'Transfert' };

const LEGACY_MOBILE = { Wave: 'wave', 'Orange Money': 'orange', 'MTN Money': 'mtn', 'Moov Money': 'moov' };
const LEGACY_INVEST = { Banque: 'placement_banque', FCP: 'fcp', BRVM: 'brvm', Autre: 'placement_autre' };

function resolveAccount(account, sub) {
  if (ACCOUNT_BY_ID[account]) return account;
  if (account === 'Espèces') return 'especes';
  if (account === 'Banque') return 'banque';
  if (account === 'Projet') return 'projet';
  if (account === 'Mobile Money') return LEGACY_MOBILE[sub] ?? null;
  if (account === 'Investissement') return LEGACY_INVEST[sub] ?? null;
  return null;
}

export function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

// Accepte l'ancien format (account + subDetail) et le nouveau. Renvoie null si inexploitable.
export function normalizeTx(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!Object.values(TYPES).includes(raw.type)) return null;
  const amount = Math.round(Number(raw.amount));
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  if (!isValidDate(raw.date)) return null;
  const account = resolveAccount(raw.account, raw.subDetail);
  if (!account) return null;
  const tx = {
    type: raw.type, amount, date: raw.date, account,
    note: typeof raw.note === 'string' ? raw.note.slice(0, 200) : '',
    timestamp: Number.isFinite(raw.timestamp) ? raw.timestamp : new Date(`${raw.date}T12:00:00`).getTime(),
  };
  if (raw.id !== undefined) tx.id = raw.id;
  if (raw.type === TYPES.TRANSFER) {
    const to = resolveAccount(raw.toAccount);
    if (!to || to === account) return null;
    tx.toAccount = to;
  } else {
    tx.category = typeof raw.category === 'string' && raw.category
      ? raw.category
      : raw.type === TYPES.INCOME ? 'Apport / Salaire' : 'Divers & Imprévus';
  }
  return tx;
}

export function fingerprint(t) {
  return [t.type, t.amount, t.date, t.account, t.toAccount ?? '', t.category ?? '', t.note ?? '', t.timestamp].join('|');
}

const emptyBalances = () => Object.fromEntries(ACCOUNTS.map((a) => [a.id, 0]));

// Solde = solde de départ + toutes les opérations jusqu'à la date incluse, pas seulement celles du mois.
export function balancesAt(txs, opening = {}, date = '9999-12-31') {
  const b = emptyBalances();
  for (const [id, v] of Object.entries(opening)) if (id in b) b[id] = v;
  for (const t of txs) {
    if (t.date > date) continue;
    if (t.type === TYPES.INCOME) b[t.account] += t.amount;
    else b[t.account] -= t.amount;
    if (t.type === TYPES.TRANSFER) b[t.toAccount] += t.amount;
  }
  return b;
}

export function groupTotals(balances) {
  const totals = { dispo: 0, place: 0, projet: 0 };
  for (const a of ACCOUNTS) totals[a.group] += balances[a.id];
  return totals;
}

// Le solde saisi devient le point de référence, sans créer de fausse opération.
export function openingFromReal(realBalances, txs, date) {
  const moved = balancesAt(txs, {}, date);
  const opening = {};
  for (const a of ACCOUNTS) opening[a.id] = (realBalances[a.id] ?? 0) - moved[a.id];
  return opening;
}

export const inMonth = (txs, month) => txs.filter((t) => t.date.startsWith(month));

// Les transferts internes ne sont ni une entrée ni une dépense.
// Reste = entrées - dépenses - mis de côté.
export function monthSummary(txs, month) {
  let income = 0, expense = 0, saved = 0;
  for (const t of inMonth(txs, month)) {
    if (t.type === TYPES.INCOME) income += t.amount;
    else if (t.type === TYPES.EXPENSE) {
      if (t.category === SAVINGS_CATEGORY) saved += t.amount; else expense += t.amount;
    } else {
      const fromDispo = accountGroup(t.account) === 'dispo';
      const toDispo = accountGroup(t.toAccount) === 'dispo';
      if (fromDispo && !toDispo) saved += t.amount;
      if (!fromDispo && toDispo) saved -= t.amount;
    }
  }
  return { income, expense, saved, left: income - expense - saved };
}

export function spentByCategory(txs, month) {
  const out = {};
  for (const t of inMonth(txs, month)) {
    if (t.type === TYPES.EXPENSE) out[t.category] = (out[t.category] || 0) + t.amount;
  }
  return out;
}

export function budgetState(spent, limit) {
  if (spent > limit) return 'over';
  if (spent >= limit * 0.8) return 'warn';
  return 'ok';
}

export function budgetRows(txs, month, budgets = {}) {
  const spent = spentByCategory(txs, month);
  const rows = Object.entries(budgets)
    .filter(([, limit]) => limit > 0)
    .map(([category, limit]) => {
      const s = spent[category] || 0;
      return { category, limit, spent: s, left: limit - s, ratio: s / limit, state: budgetState(s, limit) };
    });
  return rows.sort((a, b) => b.ratio - a.ratio);
}

export const pad = (n) => String(n).padStart(2, '0');
export const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const monthOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
export function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  return monthOf(new Date(y, m - 1 + delta, 1));
}
export function lastDayOfMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return isoDate(new Date(y, m, 0));
}

// Fenêtre glissante indépendante du mois : elle peut chevaucher deux mois.
export function sevenDays(txs, endDate) {
  const end = parseDate(endDate);
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(end.getFullYear(), end.getMonth(), end.getDate() - i);
    days.push({ date: isoDate(d), amount: 0 });
  }
  const map = Object.fromEntries(days.map((d) => [d.date, d]));
  for (const t of txs) {
    if (t.type === TYPES.EXPENSE && map[t.date]) map[t.date].amount += t.amount;
  }
  return days;
}

export function accountFlows(txs, month) {
  const f = {};
  const add = (id, k, v) => { (f[id] ??= { id, in: 0, out: 0 })[k] += v; };
  for (const t of inMonth(txs, month)) {
    if (t.type === TYPES.INCOME) add(t.account, 'in', t.amount);
    else add(t.account, 'out', t.amount);
    if (t.type === TYPES.TRANSFER) add(t.toAccount, 'in', t.amount);
  }
  return Object.values(f).sort((a, b) => b.in + b.out - a.in - a.out);
}

const NB = ' ';
export function formatNumber(n) {
  const s = Math.abs(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, NB);
  return n < 0 ? `−${s}` : s;
}
export const money = (n) => `${formatNumber(n)}${NB}FCFA`;

// Séparateur « ; » pour Excel français. Le préfixe ' neutralise les formules dans les notes.
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
export function toCsv(txs) {
  const head = 'ID;Type;Date;Montant_FCFA;Compte;Compte_destination;Categorie;Note';
  const rows = [...txs].sort((a, b) => a.date.localeCompare(b.date)).map((t) => [
    t.id, t.type, t.date, t.amount,
    csvCell(accountLabel(t.account)),
    csvCell(t.toAccount ? accountLabel(t.toAccount) : ''),
    csvCell(t.category ?? ''),
    csvCell(t.note ?? ''),
  ].join(';'));
  return `${head}\r\n${rows.join('\r\n')}`;
}

function cleanMap(o, keep) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const out = {};
  for (const [k, v] of Object.entries(o)) if (keep(k, v)) out[k] = v;
  return out;
}

// Analyse un fichier de sauvegarde sans rien écrire. Lève une erreur si le format est inconnu.
export function parseBackup(text, existing = []) {
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : data?.transactions;
  if (!Array.isArray(list)) throw new Error('format');
  const seen = new Set(existing.map(fingerprint));
  const add = [];
  let duplicates = 0, rejected = 0;
  for (const raw of list) {
    const t = normalizeTx(raw);
    if (!t) { rejected++; continue; }
    delete t.id;
    const fp = fingerprint(t);
    if (seen.has(fp)) { duplicates++; continue; }
    seen.add(fp);
    add.push(t);
  }
  const opening = Array.isArray(data) ? null
    : cleanMap(data.opening, (k, v) => k in ACCOUNT_BY_ID && Number.isSafeInteger(v));
  const budgets = Array.isArray(data) ? null
    : cleanMap(data.budgets, (k, v) => Number.isSafeInteger(v) && v > 0);
  return { add, duplicates, rejected, opening, budgets };
}

export function weakPin(pin) {
  if (/^(\d)\1+$/.test(pin)) return true;
  return '01234567890'.includes(pin) || '09876543210'.includes(pin);
}
