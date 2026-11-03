import {
  ACCOUNTS, EXPENSE_CATEGORIES, INCOME_CATEGORIES, TYPES, SAVINGS_CATEGORY,
  accountLabel, categoryLabel, normalizeTx, balancesAt, groupTotals, openingFromReal,
  inMonth, monthSummary, spentByCategory, budgetRows, budgetState, isoDate, parseDate, monthOf,
  shiftMonth, lastDayOfMonth, sevenDays, accountFlows, formatNumber, money, toCsv, parseBackup, weakPin,
} from './core.js';
import * as db from './db.js';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (n) => `<svg class="i" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const today = () => isoDate(new Date());

const VIEWS = { accueil: 'Mon argent', operations: 'Opérations', budgets: 'Budgets', analyse: 'Analyse', reglages: 'Réglages' };
const state = {
  txs: [], opening: {}, openingDone: false, budgets: {}, lastBackup: null, lastAccount: 'especes', quarantine: [],
  month: monthOf(new Date()), view: 'accueil', filters: { q: '', type: '', account: '', category: '' }, selectedDay: null,
};
let installEvent = null;
let locked = false;
let hiddenAt = 0;

const monthName = (m, opts = { month: 'long', year: 'numeric' }) => new Intl.DateTimeFormat('fr-FR', opts).format(parseDate(`${m}-01`));
const dayName = (s) => new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }).format(parseDate(s));
const shortDay = (s) => new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long' }).format(parseDate(s));
const isCurrent = () => state.month === monthOf(new Date());
const periodEnd = () => (isCurrent() ? today() : lastDayOfMonth(state.month));

function parseAmount(s) {
  const neg = String(s).trim().startsWith('-') || String(s).trim().startsWith('−');
  const digits = String(s).replace(/\D/g, '');
  if (!digits) return null;
  const n = Number(digits);
  return neg ? -n : n;
}
function bindAmount(input) {
  input.addEventListener('input', () => {
    const n = parseAmount(input.value);
    input.value = n === null ? (input.value.trim().startsWith('-') ? '-' : '') : formatNumber(n).replace('−', '-');
    input.removeAttribute('aria-invalid');
  });
}

async function load() {
  state.txs = await db.allTx();
  state.opening = (await db.getMeta('opening')) || {};
  state.openingDone = !!(await db.getMeta('openingDone'));
  state.budgets = (await db.getMeta('budgets')) || {};
  state.lastBackup = (await db.getMeta('lastBackup')) || null;
  state.lastAccount = (await db.getMeta('lastAccount')) || 'especes';
  state.quarantine = (await db.getMeta('quarantine')) || [];
}

/* ---------- Toast ---------- */
let toastTimer;
function toast(msg, action) {
  const el = $('#toast');
  const sheet = $('#sheet');
  if (sheet.open && el.parentElement !== sheet) sheet.append(el);
  else if (!sheet.open && el.parentElement !== document.body) document.body.append(el);
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  el.classList.add('show');
  if (action) $('button', el).onclick = () => { hideToast(); action.run(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action?.sticky ? 60000 : action ? 8000 : 4000);
}
function hideToast() { $('#toast').classList.remove('show'); }

/* ---------- Dialogue, avec le bouton Retour d'Android ---------- */
const sheet = () => $('#sheet');
function openSheet(title, bodyHtml, footHtml, onMount) {
  const d = sheet();
  d.innerHTML = `<form class="sheet-form" novalidate>
    <div class="sheet-head"><h2 id="sheet-title">${esc(title)}</h2>
      <button type="button" class="icon-btn" data-close aria-label="Fermer">${icon('x')}</button></div>
    <div class="sheet-body">${bodyHtml}</div>
    ${footHtml ? `<div class="sheet-foot">${footHtml}</div>` : ''}</form>`;
  $('[data-close]', d).onclick = closeSheet;
  $('form', d).addEventListener('submit', (e) => e.preventDefault());
  if (!d.open) {
    d.showModal();
    history.pushState({ sheet: true }, '');
  }
  onMount?.(d);
}
function closeSheet() {
  const d = sheet();
  if (!d.open) return;
  d.close();
  if (history.state?.sheet) history.back();
}
sheet().addEventListener('cancel', (e) => { e.preventDefault(); closeSheet(); });
window.addEventListener('popstate', () => { if (sheet().open) sheet().close(); });
window.addEventListener('hashchange', () => { route(true); });

/* ---------- Saisie ---------- */
function chips(name, items, selected) {
  return items.map((it) => `<label><input type="radio" name="${name}" value="${esc(it.value)}" ${it.value === selected ? 'checked' : ''}><span>${esc(it.label)}</span></label>`).join('');
}
function accountPicker(name, legend, selected) {
  const dispo = ACCOUNTS.filter((a) => a.group === 'dispo').map((a) => ({ value: a.id, label: a.label }));
  const other = ACCOUNTS.filter((a) => a.group !== 'dispo').map((a) => ({ value: a.id, label: a.label }));
  const open = other.some((a) => a.value === selected);
  return `<fieldset><legend class="legend">${legend}</legend><div class="chips">${chips(name, dispo, selected)}</div>
    <details class="more" ${open ? 'open' : ''}><summary>Placements et projet</summary><div class="chips">${chips(name, other, selected)}</div></details>
    <p class="err" data-err="${name}"></p></fieldset>`;
}
function txFields(type, tx) {
  if (type === TYPES.TRANSFER) {
    return accountPicker('account', 'Depuis', tx.account) + accountPicker('toAccount', 'Vers', tx.toAccount);
  }
  const list = type === TYPES.INCOME ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
  const cats = list.map((c) => ({ value: c.value, label: c.label }));
  if (tx.category && !cats.some((c) => c.value === tx.category)) cats.push({ value: tx.category, label: categoryLabel(tx.category) });
  const selected = type === tx.type ? tx.category : undefined;
  return `${accountPicker('account', type === TYPES.INCOME ? 'Reçu sur' : 'Payé avec', tx.account)}
    <fieldset><legend class="legend">Catégorie</legend><div class="chips">${chips('category', cats, selected)}</div><p class="err" data-err="category"></p></fieldset>`;
}
const SAVE_LABEL = { [TYPES.EXPENSE]: 'Enregistrer la dépense', [TYPES.INCOME]: "Enregistrer l'entrée", [TYPES.TRANSFER]: 'Enregistrer le transfert' };

function openTxForm(existing, presetType = TYPES.EXPENSE) {
  const tx = existing ? { ...existing } : { type: presetType, date: today(), account: state.lastAccount };
  const editing = !!existing;
  const yesterday = isoDate(new Date(Date.now() - 864e5));
  const body = `
    <fieldset><legend class="vh">Type d'opération</legend><div class="seg">
      ${Object.values(TYPES).map((t) => `<label><input type="radio" name="type" value="${t}" ${t === tx.type ? 'checked' : ''}><span>${t}</span></label>`).join('')}
    </div></fieldset>
    <label class="field"><span>Montant</span><div class="amount-wrap">
      <input class="amount-input" name="amount" inputmode="numeric" autocomplete="off" aria-describedby="err-amount" value="${tx.amount ? esc(formatNumber(tx.amount)) : ''}"><span class="unit">FCFA</span></div>
      <p class="err" id="err-amount" data-err="amount"></p></label>
    <div id="tx-fields">${txFields(tx.type, tx)}</div>
    <fieldset><legend class="legend">Date</legend><div class="date-row">
      <button type="button" class="btn compact" data-date="${today()}">Aujourd'hui</button>
      <button type="button" class="btn compact" data-date="${yesterday}">Hier</button>
      <input type="date" name="date" aria-label="Date de l'opération" max="${today()}" value="${esc(tx.date)}"></div>
      <p class="err" data-err="date"></p></fieldset>
    <label class="field"><span>Note (facultatif)</span><input type="text" name="note" maxlength="120" placeholder="Marché d'Adjamé, gbaka…" value="${esc(tx.note)}"></label>`;
  const foot = `${editing ? '<button type="button" class="btn danger" id="tx-del">Supprimer</button>' : ''}<button type="submit" class="btn primary" id="tx-save">${SAVE_LABEL[tx.type]}</button>`;
  openSheet(editing ? "Modifier l'opération" : 'Noter une opération', body, foot, (d) => {
    const form = $('form', d);
    const amount = form.elements.amount;
    bindAmount(amount);
    if (!editing) amount.focus();
    form.addEventListener('change', (e) => {
      if (e.target.name !== 'type') return;
      const account = form.elements.account?.value || tx.account;
      const type = e.target.value;
      $('#tx-fields', d).innerHTML = txFields(type, { ...tx, type: type === tx.type ? type : null, account, category: type === tx.type ? tx.category : undefined });
      $('#tx-save', d).textContent = SAVE_LABEL[type];
    });
    $$('[data-date]', d).forEach((b) => { b.onclick = () => { form.elements.date.value = b.dataset.date; }; });
    if (editing) $('#tx-del', d).onclick = () => removeTx(existing);
    form.addEventListener('submit', () => saveTx(form, existing));
  });
}

async function saveTx(form, existing) {
  const f = form.elements;
  const type = f.type.value;
  const setErr = (k, m) => { const e = $(`[data-err="${k}"]`, form); if (e) e.textContent = m; };
  $$('[data-err]', form).forEach((e) => { e.textContent = ''; });
  const amount = parseAmount(f.amount.value);
  const errors = [];
  if (!amount || amount <= 0) { setErr('amount', 'Saisis un montant supérieur à 0.'); errors.push(f.amount); f.amount.setAttribute('aria-invalid', 'true'); }
  if (!f.account.value) { setErr('account', 'Choisis un compte.'); errors.push($('[name=account]', form)); }
  if (type === TYPES.TRANSFER) {
    if (!f.toAccount.value) { setErr('toAccount', 'Choisis le compte de destination.'); errors.push($('[name=toAccount]', form)); }
    else if (f.toAccount.value === f.account.value) { setErr('toAccount', 'Choisis un compte différent du compte de départ.'); errors.push($('[name=toAccount]', form)); }
  } else if (!f.category.value) { setErr('category', 'Choisis une catégorie.'); errors.push($('[name=category]', form)); }
  if (!f.date.value || f.date.value > today()) { setErr('date', "Choisis une date passée ou celle d'aujourd'hui."); errors.push(f.date); }
  if (errors.length) { errors[0].focus(); return; }

  const raw = { type, amount, date: f.date.value, account: f.account.value, note: f.note.value.trim(), timestamp: existing?.timestamp ?? Date.now() };
  if (existing) raw.id = existing.id;
  if (type === TYPES.TRANSFER) raw.toAccount = f.toAccount.value; else raw.category = f.category.value;
  const tx = normalizeTx(raw);

  const month = tx.date.slice(0, 7);
  const limit = state.budgets[tx.category];
  const before = limit ? budgetState(spentByCategory(state.txs, month)[tx.category] || 0, limit) : null;

  try {
    const id = await db.putTx(tx);
    await db.setMeta('lastAccount', tx.account);
    closeSheet();
    await load();
    navigator.storage?.persist?.().catch(() => {});
    state.month = month;
    render();
    let msg = `${type} de ${money(amount)} ${existing ? 'modifiée' : 'enregistrée'}.`;
    if (type === TYPES.TRANSFER) msg = `Transfert de ${money(amount)} ${existing ? 'modifié' : 'enregistré'}.`;
    if (type === TYPES.INCOME) msg = `Entrée de ${money(amount)} ${existing ? 'modifiée' : 'enregistrée'}.`;
    if (limit && type === TYPES.EXPENSE) {
      const spent = spentByCategory(state.txs, month)[tx.category] || 0;
      const after = budgetState(spent, limit);
      if (after !== before && after === 'over') msg += ` Budget ${categoryLabel(tx.category)} dépassé de ${money(spent - limit)}.`;
      else if (after !== before && after === 'warn') msg += ` Budget ${categoryLabel(tx.category)} : reste ${money(limit - spent)}.`;
    }
    toast(msg, existing ? null : { label: 'Annuler', run: async () => { await db.deleteTx(id); await load(); render(); toast('Opération annulée.'); } });
  } catch (err) {
    setErr('date', `Enregistrement impossible (${err.name}). Vérifie l'espace libre du téléphone.`);
  }
}

async function removeTx(tx) {
  await db.deleteTx(tx.id);
  closeSheet();
  await load();
  render();
  toast('Opération supprimée.', { label: 'Annuler', run: async () => { await db.putTx(tx); await load(); render(); toast('Opération restaurée.'); } });
}

/* ---------- Composants ---------- */
function txRow(t) {
  const isT = t.type === TYPES.TRANSFER;
  const title = isT ? 'Transfert' : categoryLabel(t.category);
  const sub = isT ? `${accountLabel(t.account)} vers ${accountLabel(t.toAccount)}` : accountLabel(t.account);
  const sign = isT ? '' : t.type === TYPES.INCOME ? '+' : '−';
  const cls = isT ? '' : t.type === TYPES.INCOME ? 'pos' : '';
  return `<button type="button" class="row tx" data-tx="${esc(t.id)}">
    <span class="tx-main"><span class="tx-title">${esc(title)}</span><span class="tx-sub">${esc(sub)}${t.note ? `, ${esc(t.note)}` : ''}</span></span>
    <span class="amt num ${cls}">${sign}${esc(formatNumber(t.amount))}</span></button>`;
}
function bindTxRows(root) {
  $$('[data-tx]', root).forEach((b) => {
    b.onclick = () => openTxForm(state.txs.find((t) => String(t.id) === b.dataset.tx));
  });
}
const sortTx = (l) => [...l].sort((a, b) => b.date.localeCompare(a.date) || (b.timestamp || 0) - (a.timestamp || 0));
function applyWidths(root) {
  $$('[data-w]', root).forEach((el) => { el.style.width = `${Math.min(100, Math.max(0, +el.dataset.w))}%`; });
  $$('[data-h]', root).forEach((el) => { el.style.height = `${Math.min(100, Math.max(0, +el.dataset.h))}%`; });
}

/* ---------- Accueil ---------- */
function viewHome(root) {
  const end = periodEnd();
  const balances = balancesAt(state.txs, state.opening, end);
  const g = groupTotals(balances);
  const s = monthSummary(state.txs, state.month);
  const mName = monthName(state.month, { month: 'long' });
  const heroLabel = isCurrent() ? "Disponible aujourd'hui" : `Disponible fin ${monthName(state.month)}`;
  const monthTx = sortTx(inMonth(state.txs, state.month));
  const alerts = budgetRows(state.txs, state.month, state.budgets).filter((r) => r.state !== 'ok');
  const over = alerts.filter((r) => r.state === 'over').length;

  const notices = [];
  if (!state.openingDone) {
    notices.push(`<div class="notice">${icon('alert')}<div><p>Indique ce que tu as déjà sur tes comptes. Sinon, les soldes ne comptent que ce qui est noté ici.</p><button type="button" class="btn compact" data-act="adjust">Renseigner mes soldes</button></div></div>`);
  }
  const old = !state.lastBackup || Date.now() - state.lastBackup > 30 * 864e5;
  if (state.txs.length >= 10 && old) {
    notices.push(`<div class="notice">${icon('alert')}<div><p>${state.lastBackup ? 'Ta dernière sauvegarde date de plus de 30 jours.' : "Tu n'as encore aucune sauvegarde."} Si tu perds le téléphone, tes données sont perdues avec lui.</p><button type="button" class="btn compact" data-act="backup">Sauvegarder</button></div></div>`);
  }
  if (alerts.length) {
    const txt = over
      ? `${over} budget${over > 1 ? 's' : ''} dépassé${over > 1 ? 's' : ''} en ${mName}.`
      : `${alerts.length} budget${alerts.length > 1 ? 's' : ''} presque atteint${alerts.length > 1 ? 's' : ''} en ${mName}.`;
    notices.push(`<div class="notice ${over ? 'over' : ''}">${icon('alert')}<div><p>${txt}</p><a class="btn compact" href="#budgets">Voir les budgets</a></div></div>`);
  }

  const groupHtml = (key, label, total) => {
    const rows = ACCOUNTS.filter((a) => a.group === key && (balances[a.id] !== 0 || (key === 'dispo' && a.id === 'especes')));
    if (!rows.length) return '';
    return `<div class="row-group"><span>${label}</span><span class="num">${esc(money(total))}</span></div>` + rows.map((a) =>
      `<div class="row"><span>${esc(a.label)}</span><span class="amt num ${balances[a.id] < 0 ? 'neg' : ''}">${esc(money(balances[a.id]))}</span></div>`).join('');
  };

  root.innerHTML = `
    <section class="hero" aria-label="Solde">
      <div class="hero-body">
        <p class="hero-label">${esc(heroLabel)}</p>
        <p class="hero-amount">${esc(formatNumber(g.dispo))}<small>FCFA</small></p>
        <div class="hero-sub"><span>Placé<b class="num">${esc(formatNumber(g.place))}</b></span><span>Projet<b class="num">${esc(formatNumber(g.projet))}</b></span></div>
      </div><div class="weave"></div>
    </section>
    <div class="quick">
      <button type="button" class="main" data-new="${TYPES.EXPENSE}">${icon('minus')}Dépense</button>
      <button type="button" data-new="${TYPES.INCOME}">${icon('plus')}Entrée</button>
      <button type="button" data-new="${TYPES.TRANSFER}">${icon('swap')}Transfert</button>
    </div>
    ${notices.join('')}
    <section class="section"><h2>Bilan de ${esc(mName)}</h2>
      <dl class="stats">
        <div><dt>Entrées</dt><dd class="pos">+${esc(money(s.income))}</dd></div>
        <div><dt>Dépenses</dt><dd>−${esc(money(s.expense))}</dd></div>
        <div><dt>Mis de côté</dt><dd>${esc(money(s.saved))}</dd></div>
        <div class="left"><dt>Reste du mois</dt><dd class="${s.left < 0 ? 'neg' : ''}">${esc(money(s.left))}</dd></div>
      </dl></section>
    <section class="section"><div class="section-head"><h2>Mes comptes</h2><button type="button" class="link-btn" data-act="adjust">Ajuster</button></div>
      <div class="panel">${groupHtml('dispo', 'Disponible', g.dispo)}${groupHtml('place', 'Placé', g.place)}${groupHtml('projet', 'Projet', g.projet)}</div></section>
    <section class="section"><div class="section-head"><h2>Dernières opérations</h2>${monthTx.length > 5 ? `<a class="link-btn" href="#operations">Voir les ${monthTx.length}</a>` : ''}</div>
      ${monthTx.length ? `<div class="panel">${monthTx.slice(0, 5).map(txRow).join('')}</div>` : `<p class="empty">Rien de noté en ${esc(mName)}.</p>`}</section>`;
  $$('[data-new]', root).forEach((b) => { b.onclick = () => openTxForm(null, b.dataset.new); });
  bindActs(root);
  bindTxRows(root);
}

function bindActs(root) {
  $$('[data-act=adjust]', root).forEach((b) => { b.onclick = openAdjust; });
  $$('[data-act=backup]', root).forEach((b) => { b.onclick = exportJson; });
}

function openAdjust() {
  const balances = balancesAt(state.txs, state.opening, today());
  const rows = (group, title) => `<fieldset><legend class="legend">${title}</legend><div class="stack">${ACCOUNTS.filter((a) => a.group === group).map((a) =>
    `<label class="adj-row"><span>${esc(a.label)}</span><input name="${a.id}" inputmode="numeric" autocomplete="off" value="${esc(formatNumber(balances[a.id]).replace('−', '-'))}"></label>`).join('')}</div></fieldset>`;
  openSheet('Ajuster mes soldes', `<p>Saisis ce qu'il y a vraiment aujourd'hui sur chaque compte, en FCFA. L'écart est reporté sur le solde de départ, sans créer d'opération.</p>
    ${rows('dispo', 'Disponible')}${rows('place', 'Placé')}${rows('projet', 'Projet')}`,
  '<button type="submit" class="btn primary">Enregistrer les soldes</button>', (d) => {
    const form = $('form', d);
    $$('input', d).forEach(bindAmount);
    form.addEventListener('submit', async () => {
      const real = {};
      for (const a of ACCOUNTS) real[a.id] = parseAmount(form.elements[a.id].value) ?? 0;
      const opening = openingFromReal(real, state.txs, today());
      await db.setMeta('opening', opening);
      await db.setMeta('openingDone', true);
      closeSheet();
      await load();
      render();
      toast('Soldes enregistrés.');
    });
  });
}

/* ---------- Opérations ---------- */
function viewOps(root) {
  const f = state.filters;
  const monthTx = inMonth(state.txs, state.month);
  const cats = [...new Set(monthTx.map((t) => t.category).filter(Boolean))].sort();
  const option = (value, label, cur) => `<option value="${esc(value)}" ${value === cur ? 'selected' : ''}>${esc(label)}</option>`;
  root.innerHTML = `
    <div class="filters">
      <label class="field wide"><span class="vh">Rechercher dans les notes et catégories</span><input type="search" id="f-q" placeholder="Rechercher une note, une catégorie…" value="${esc(f.q)}"></label>
      <label class="field"><span class="vh">Type</span><select id="f-type">${option('', 'Type : tous', f.type)}${Object.values(TYPES).map((t) => option(t, t, f.type)).join('')}</select></label>
      <label class="field"><span class="vh">Compte</span><select id="f-account">${option('', 'Compte : tous', f.account)}${ACCOUNTS.map((a) => option(a.id, a.label, f.account)).join('')}</select></label>
      <label class="field wide"><span class="vh">Catégorie</span><select id="f-category">${option('', 'Catégorie : toutes', f.category)}${cats.map((c) => option(c, categoryLabel(c), f.category)).join('')}</select></label>
      <button type="button" class="btn primary wide" id="ops-add">${icon('plus')}Noter une opération</button>
    </div>
    <p class="section small muted" id="ops-count" role="status"></p>
    <div id="ops-list"></div>`;
  const bind = (id, key, ev = 'change') => $(id, root).addEventListener(ev, (e) => { f[key] = e.target.value; renderOpsList(); });
  bind('#f-q', 'q', 'input'); bind('#f-type', 'type'); bind('#f-account', 'account'); bind('#f-category', 'category');
  $('#ops-add', root).onclick = () => openTxForm();
  renderOpsList();
}
function renderOpsList() {
  const f = state.filters;
  const q = f.q.trim().toLocaleLowerCase('fr');
  const base = inMonth(state.txs, state.month);
  const list = sortTx(base).filter((t) => (!f.type || t.type === f.type)
    && (!f.account || t.account === f.account || t.toAccount === f.account)
    && (!f.category || t.category === f.category)
    && (!q || `${t.note} ${categoryLabel(t.category)} ${t.category} ${accountLabel(t.account)}`.toLocaleLowerCase('fr').includes(q)));
  $('#ops-count').textContent = `${list.length} opération${list.length > 1 ? 's' : ''} en ${monthName(state.month)}. Touche une ligne pour la modifier.`;
  const el = $('#ops-list');
  if (!list.length) {
    el.innerHTML = `<p class="empty">${base.length ? 'Aucune opération ne correspond à ces filtres.' : `Rien de noté en ${esc(monthName(state.month, { month: 'long' }))}.`}</p>`;
    return;
  }
  const days = {};
  list.forEach((t) => { (days[t.date] ??= []).push(t); });
  el.innerHTML = Object.entries(days).map(([d, items]) => `<h2 class="day-head">${esc(dayName(d))}</h2><div class="panel ops-panel">${items.map(txRow).join('')}</div>`).join('');
  bindTxRows(el);
}

/* ---------- Budgets ---------- */
function stateLine(r) {
  if (r.state === 'over') return `<span class="state over">${icon('alert')}Dépassé de ${esc(money(-r.left))}</span>`;
  if (r.state === 'warn') return `<span class="state warn">${icon('alert')}Presque atteint, reste ${esc(money(r.left))}</span>`;
  return `<span class="state ok">${icon('check')}Reste ${esc(money(r.left))}</span>`;
}
function viewBudgets(root) {
  const rows = budgetRows(state.txs, state.month, state.budgets);
  const spent = spentByCategory(state.txs, state.month);
  const none = Object.entries(spent).filter(([c]) => !state.budgets[c]).sort((a, b) => b[1] - a[1]);
  if (!rows.length) {
    root.innerHTML = `<div class="section"><div class="panel empty"><p>Fixe un plafond mensuel par catégorie. L'application te prévient à 80 % et en cas de dépassement.</p><button type="button" class="btn" id="b-edit">Fixer mes plafonds</button></div></div>`;
  } else {
    const totalL = rows.reduce((n, r) => n + r.limit, 0);
    const totalS = rows.reduce((n, r) => n + r.spent, 0);
    const left = totalL - totalS;
    const end = parseDate(lastDayOfMonth(state.month));
    const daysLeft = end.getDate() - new Date().getDate() + 1;
    const perDay = isCurrent() && left > 0 ? `Soit ${esc(money(Math.floor(left / daysLeft)))} par jour pendant ${daysLeft} jour${daysLeft > 1 ? 's' : ''}.` : '';
    root.innerHTML = `
      <section class="section"><div class="panel"><div class="budget">
        <div class="budget-top"><span>Total des plafonds</span><span class="num">${esc(money(totalL))}</span></div>
        <div class="track" aria-hidden="true"><span class="fill ${budgetState(totalS, totalL)}" data-w="${totalS / totalL * 100}"></span></div>
        <p class="small">${left >= 0 ? `Reste ${esc(money(left))}.` : `Dépassement de ${esc(money(-left))}.`} ${perDay}</p>
      </div></div></section>
      <section class="section"><div class="section-head"><h2>Par catégorie</h2><button type="button" class="link-btn" id="b-edit">Modifier</button></div>
      <div class="panel">${rows.map((r) => `<div class="budget"><div class="budget-top"><span>${esc(categoryLabel(r.category))}</span><span class="num">${esc(formatNumber(r.spent))} / ${esc(formatNumber(r.limit))}</span></div>
        <div class="track" aria-hidden="true"><span class="fill ${r.state}" data-w="${r.ratio * 100}"></span></div>${stateLine(r)}</div>`).join('')}</div></section>
      ${none.length ? `<section class="section"><h2>Sans plafond</h2><div class="panel">${none.map(([c, v]) => `<div class="row"><span>${esc(categoryLabel(c))}</span><span class="amt num">${esc(money(v))}</span></div>`).join('')}</div></section>` : ''}`;
  }
  $('#b-edit', root).onclick = openBudgetEdit;
  applyWidths(root);
}
function openBudgetEdit() {
  const fields = EXPENSE_CATEGORIES.map((c) => `<label class="adj-row"><span>${esc(c.label)}</span><input name="${esc(c.value)}" inputmode="numeric" autocomplete="off" placeholder="Aucun" value="${state.budgets[c.value] ? esc(formatNumber(state.budgets[c.value])) : ''}"></label>`).join('');
  openSheet('Plafonds mensuels', `<p>Montants en FCFA, valables chaque mois. Laisse vide pour ne pas fixer de plafond.</p><div class="stack">${fields}</div>`,
    '<button type="submit" class="btn primary">Enregistrer les plafonds</button>', (d) => {
      const form = $('form', d);
      $$('input', d).forEach(bindAmount);
      form.addEventListener('submit', async () => {
        const budgets = {};
        for (const c of EXPENSE_CATEGORIES) {
          const n = parseAmount(form.elements[c.value].value);
          if (n && n > 0) budgets[c.value] = n;
        }
        await db.setMeta('budgets', budgets);
        closeSheet();
        await load();
        render();
        toast('Plafonds enregistrés.');
      });
    });
}

/* ---------- Analyse ---------- */
function viewAnalysis(root) {
  const spent = Object.entries(spentByCategory(state.txs, state.month)).sort((a, b) => b[1] - a[1]);
  const total = spent.reduce((n, [, v]) => n + v, 0);
  const max = spent[0]?.[1] || 1;
  const endDate = periodEnd();
  const days = sevenDays(state.txs, endDate);
  const weekMax = Math.max(...days.map((d) => d.amount), 1);
  const weekTotal = days.reduce((n, d) => n + d.amount, 0);
  const flows = accountFlows(state.txs, state.month);
  const flowMax = Math.max(1, ...flows.flatMap((f) => [f.in, f.out]));
  const dayLetter = (d) => new Intl.DateTimeFormat('fr-FR', { weekday: 'short' }).format(parseDate(d)).replace('.', '');
  const name = monthName(state.month, { month: 'long' });

  root.innerHTML = `
    <section class="section"><h2>Où part l'argent en ${esc(name)}</h2>
      ${spent.length ? `<p class="small muted">${esc(money(total))} sortis, tontine et épargne comprises.</p>
      <div class="panel">${spent.map(([c, v]) => `<div class="hbar"><div class="hbar-top"><span>${esc(categoryLabel(c))}</span><span class="num"><b>${esc(formatNumber(v))}</b> <span class="muted small">${Math.round(v / total * 100)} %</span></span></div>
        <div class="track" aria-hidden="true"><span class="fill" data-w="${v / max * 100}"></span></div></div>`).join('')}</div>`
    : `<p class="empty">Aucune dépense en ${esc(name)}.</p>`}</section>
    <section class="section"><h2>7 jours jusqu'au ${esc(shortDay(endDate))}</h2>
      <p class="readout num" id="week-read" role="status">${esc(money(weekTotal))} de dépenses</p>
      <div class="week" aria-label="Touche une barre pour voir le montant du jour">${days.map((d) => `<button type="button" data-day="${d.date}" data-amt="${d.amount}" aria-pressed="false" aria-label="${esc(dayLetter(d.date))}, ${esc(dayName(d.date))} : ${esc(money(d.amount))}"><span class="col" data-h="${d.amount / weekMax * 80}"></span>${esc(dayLetter(d.date))}</button>`).join('')}</div>
      <details class="more"><summary>Voir en tableau</summary><table><thead><tr><th scope="col">Jour</th><th scope="col">Dépenses</th></tr></thead><tbody>${days.map((d) => `<tr><td>${esc(dayName(d.date))}</td><td class="num">${esc(money(d.amount))}</td></tr>`).join('')}</tbody></table></details>
    </section>
    <section class="section"><h2>Flux par compte en ${esc(name)}</h2>
      ${flows.length ? `<p class="small muted">Transferts compris.</p><div class="panel">${flows.map((f) => `<div class="hbar"><div class="hbar-top"><b>${esc(accountLabel(f.id))}</b><span class="num ${f.in - f.out < 0 ? 'neg' : ''}">Net ${esc(formatNumber(f.in - f.out))}</span></div>
        <div class="flow-line"><span>Entré</span><div class="track" aria-hidden="true"><span class="fill in" data-w="${f.in / flowMax * 100}"></span></div><span class="num">${esc(formatNumber(f.in))}</span></div>
        <div class="flow-line"><span>Sorti</span><div class="track" aria-hidden="true"><span class="fill out" data-w="${f.out / flowMax * 100}"></span></div><span class="num">${esc(formatNumber(f.out))}</span></div></div>`).join('')}</div>`
    : `<p class="empty">Aucun mouvement en ${esc(name)}.</p>`}</section>`;
  applyWidths(root);
  $$('[data-day]', root).forEach((b) => {
    b.onclick = () => {
      const was = b.getAttribute('aria-pressed') === 'true';
      $$('[data-day]', root).forEach((x) => x.setAttribute('aria-pressed', 'false'));
      if (was) { $('#week-read', root).textContent = `${money(weekTotal)} de dépenses`; return; }
      b.setAttribute('aria-pressed', 'true');
      $('#week-read', root).textContent = `${shortDay(b.dataset.day)} : ${money(+b.dataset.amt)}`;
    };
  });
}

/* ---------- Réglages ---------- */
async function viewSettings(root) {
  const theme = (await db.getMeta('theme')) || 'system';
  const lock = await db.getMeta('lock');
  const persisted = await navigator.storage?.persisted?.();
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const secure = !!window.crypto?.subtle;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const lastTxt = state.lastBackup ? `Dernière sauvegarde le ${new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long' }).format(state.lastBackup)}.` : 'Aucune sauvegarde pour le moment.';
  root.innerHTML = `
    <section class="section"><h2>Sauvegarde</h2><div class="panel">
      <p class="setting-text">${esc(lastTxt)} Tes données ne quittent le téléphone que si tu les envoies toi-même. Le fichier n'est pas chiffré : garde-le en lieu sûr.</p>
      <div class="stack">
        <button type="button" class="btn primary" id="s-json">Sauvegarder mes données</button>
        <button type="button" class="btn" id="s-csv">Exporter pour Excel (CSV)</button>
        <label class="btn" for="s-import">Restaurer un fichier</label><input class="vh" type="file" id="s-import" accept=".json,application/json">
      </div>
      ${state.quarantine.length ? `<p class="setting-text small">${state.quarantine.length} ancienne(s) opération(s) illisible(s) mise(s) de côté. Elles restent dans la sauvegarde.</p>` : ''}
    </div></section>
    <section class="section"><h2>Soldes et budgets</h2><div class="panel"><div class="stack">
      <button type="button" class="btn" data-act="adjust">Ajuster mes soldes</button>
      <button type="button" class="btn" id="s-budgets">Modifier les plafonds</button></div></div></section>
    <section class="section"><h2>Verrouillage</h2><div class="panel">
      <p class="setting-text">${lock ? "Activé. L'application se verrouille après 1 minute en arrière-plan." : 'Désactivé.'} ${secure ? "Le code empêche d'ouvrir l'application, mais ne chiffre pas les données." : "Indisponible : l'application doit être ouverte en HTTPS."}</p>
      <div class="stack">${lock
    ? '<button type="button" class="btn" id="s-pin-change">Changer le code</button><button type="button" class="btn" id="s-pin-off">Désactiver le code</button>'
    : `<button type="button" class="btn" id="s-pin-on" ${secure ? '' : 'disabled'}>Activer un code</button>`}</div></div></section>
    <section class="section"><h2>Apparence</h2><div class="panel"><fieldset class="stack"><legend class="vh">Thème</legend><div class="seg" id="s-theme">
      ${[['system', 'Système'], ['light', 'Clair'], ['dark', 'Sombre']].map(([v, l]) => `<label><input type="radio" name="theme" value="${v}" ${v === theme ? 'checked' : ''}><span>${l}</span></label>`).join('')}
    </div></fieldset></div></section>
    <section class="section"><h2>Application</h2><div class="panel">
      <p class="setting-text">${standalone ? 'Installée sur ce téléphone.' : ios ? "Pour l'installer : menu Partager de Safari, puis « Sur l'écran d'accueil »." : "Pas encore installée. Dans Chrome, ouvre le menu puis « Installer l'application »."}</p>
      <p class="setting-text">${persisted ? 'Stockage protégé : le navigateur ne supprimera pas tes données pour libérer de la place.' : "Stockage non garanti : le navigateur peut supprimer les données si le téléphone manque d'espace. Une sauvegarde régulière reste nécessaire."}</p>
      <div class="stack">${installEvent && !standalone ? '<button type="button" class="btn primary" id="s-install">Installer l\'application</button>' : ''}${persisted ? '' : '<button type="button" class="btn" id="s-persist">Protéger le stockage</button>'}</div>
    </div></section>
    <section class="section"><h2>Effacement</h2><div class="panel"><div class="stack"><button type="button" class="btn danger" id="s-erase">Effacer toutes mes données</button></div></div></section>
    <p class="section small muted">Budget FCFA, version 2.0</p>`;
  bindActs(root);
  $('#s-json', root).onclick = exportJson;
  $('#s-csv', root).onclick = exportCsv;
  $('#s-import', root).onchange = importFile;
  $('#s-budgets', root).onclick = openBudgetEdit;
  $('#s-erase', root).onclick = () => openErase(false);
  $('#s-theme', root).onchange = async (e) => { await db.setMeta('theme', e.target.value); applyTheme(e.target.value); };
  if ($('#s-pin-on', root)) $('#s-pin-on', root).onclick = () => openPinSetup(null);
  if ($('#s-pin-change', root)) $('#s-pin-change', root).onclick = () => openPinSetup(lock);
  if ($('#s-pin-off', root)) $('#s-pin-off', root).onclick = () => openPinOff(lock);
  if ($('#s-install', root)) $('#s-install', root).onclick = async () => { await installEvent.prompt(); installEvent = null; render(); };
  if ($('#s-persist', root)) {
    $('#s-persist', root).onclick = async () => {
      const ok = await navigator.storage?.persist?.();
      toast(ok ? 'Stockage protégé.' : "Le navigateur a refusé pour l'instant. Installe l'application puis réessaie.");
      render();
    };
  }
}

function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  const dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  $('meta[name=theme-color]').content = dark ? '#141833' : '#F2F3F8';
}

/* ---------- Exports et import ---------- */
async function deliver(blob, filename, title) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title }); return true; } catch (e) { if (e.name === 'AbortError') return false; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return true;
}
async function exportJson() {
  const payload = { app: 'budget-fcfa', version: 2, exportedAt: new Date().toISOString(), transactions: state.txs, opening: state.opening, budgets: state.budgets, quarantine: state.quarantine };
  const ok = await deliver(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `budget-sauvegarde-${today()}.json`, 'Sauvegarde Budget FCFA');
  if (!ok) return;
  await db.setMeta('lastBackup', Date.now());
  await load();
  render();
  toast('Sauvegarde créée. Copie-la hors du téléphone : Drive, e-mail ou ordinateur.');
}
async function exportCsv() {
  if (!state.txs.length) { toast('Aucune opération à exporter.'); return; }
  await deliver(new Blob([`﻿${toCsv(state.txs)}`], { type: 'text/csv;charset=utf-8' }), `budget-export-${today()}.csv`, 'Export Budget FCFA');
}
async function importFile(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let r;
  try {
    if (file.size > 20e6) throw new Error('size');
    r = parseBackup(await file.text(), state.txs);
  } catch {
    toast("Ce fichier n'est pas une sauvegarde Budget FCFA valide. Rien n'a été modifié.");
    return;
  }
  const replaces = r.opening || r.budgets;
  openSheet('Restaurer ce fichier ?', `<p><b>${r.add.length}</b> opération(s) à ajouter.</p>
    <p>${r.duplicates} déjà présente(s), ignorée(s). ${r.rejected} illisible(s), ignorée(s).</p>
    ${replaces ? '<p>Les soldes et plafonds du fichier remplaceront ceux du téléphone.</p>' : ''}`,
  '<button type="button" class="btn" data-close2>Annuler</button><button type="submit" class="btn primary">Restaurer</button>', (d) => {
    $('[data-close2]', d).onclick = closeSheet;
    $('form', d).addEventListener('submit', async () => {
      const meta = {};
      if (r.opening) { meta.opening = r.opening; meta.openingDone = true; }
      if (r.budgets) meta.budgets = r.budgets;
      try {
        await db.bulkImport(r.add, meta);
        closeSheet();
        await load();
        render();
        toast(`${r.add.length} opération(s) restaurée(s).`);
      } catch (err) {
        closeSheet();
        toast(`Restauration annulée (${err?.name}). Rien n'a été modifié.`);
      }
    });
  });
}
function openErase(forgotten) {
  const intro = forgotten
    ? "Sans le code, le seul moyen de rouvrir l'application est de tout effacer : opérations, soldes, plafonds et code. Seule une sauvegarde déjà faite permettra de récupérer tes données."
    : 'Opérations, soldes et plafonds seront supprimés de ce téléphone. Fais une sauvegarde avant si tu veux pouvoir les récupérer.';
  const go = () => openSheet('Tout effacer ?', `<p>${intro}</p><label class="field"><span>Écris EFFACER pour confirmer</span><input type="text" name="confirm" autocomplete="off" autocapitalize="characters"></label><p class="err" data-err="confirm"></p>`,
    '<button type="submit" class="btn danger-solid">Effacer définitivement</button>', (d) => {
      const form = $('form', d);
      form.addEventListener('submit', async () => {
        if (form.elements.confirm.value.trim().toUpperCase() !== 'EFFACER') {
          $('[data-err=confirm]', d).textContent = 'Écris exactement EFFACER.';
          form.elements.confirm.focus();
          return;
        }
        await db.eraseData(forgotten);
        closeSheet();
        await load();
        if (forgotten) { locked = false; $('#lock').hidden = true; $('#lock').innerHTML = ''; $('#app').hidden = false; }
        render();
        toast('Données effacées.');
      });
    });
  go();
}

/* ---------- Verrouillage par code ---------- */
const PBKDF2_ITER = 150000;
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function hashPin(pin, salt, iter = PBKDF2_ITER) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256));
}
const checkPin = async (pin, lock) => (await hashPin(pin, unb64(lock.salt), lock.iter)) === lock.hash;

function openPinSetup(current) {
  const pinInput = (name, label) => `<label class="field"><span>${label}</span><input type="password" name="${name}" inputmode="numeric" maxlength="6" autocomplete="off"><p class="err" data-err="${name}"></p></label>`;
  openSheet(current ? 'Changer le code' : 'Activer un code', `
    <p>Choisis 4 à 6 chiffres. Si tu l'oublies, la seule issue sera de tout effacer : fais une sauvegarde régulièrement.</p>
    ${current ? pinInput('old', 'Code actuel') : ''}${pinInput('pin', 'Nouveau code')}${pinInput('pin2', 'Confirme le code')}`,
  '<button type="submit" class="btn primary">Enregistrer le code</button>', (d) => {
    const form = $('form', d);
    form.addEventListener('submit', async () => {
      $$('[data-err]', d).forEach((e) => { e.textContent = ''; });
      const v = (n) => form.elements[n].value;
      const fail = (n, m) => { $(`[data-err=${n}]`, d).textContent = m; form.elements[n].focus(); };
      if (current && !(await checkPin(v('old'), current))) return fail('old', 'Code actuel incorrect.');
      if (!/^\d{4,6}$/.test(v('pin'))) return fail('pin', 'Saisis 4 à 6 chiffres.');
      if (weakPin(v('pin'))) return fail('pin', 'Ce code est trop facile à deviner. Évite les suites et les répétitions.');
      if (v('pin') !== v('pin2')) return fail('pin2', 'Les deux codes sont différents.');
      const salt = crypto.getRandomValues(new Uint8Array(16));
      await db.setMeta('lock', { salt: b64(salt), hash: await hashPin(v('pin'), salt), iter: PBKDF2_ITER, len: v('pin').length });
      closeSheet();
      render();
      toast('Code enregistré.');
    });
  });
}
function openPinOff(lock) {
  openSheet('Désactiver le code', `<label class="field"><span>Code actuel</span><input type="password" name="old" inputmode="numeric" maxlength="6" autocomplete="off"></label><p class="err" data-err="old"></p>`,
    '<button type="submit" class="btn primary">Désactiver</button>', (d) => {
      const form = $('form', d);
      form.addEventListener('submit', async () => {
        if (!(await checkPin(form.elements.old.value, lock))) { $('[data-err=old]', d).textContent = 'Code incorrect.'; return; }
        await db.delMeta('lock');
        await db.delMeta('lockFails');
        closeSheet();
        render();
        toast('Code désactivé.');
      });
    });
}
async function showLock(lock) {
  locked = true;
  if (sheet().open) sheet().close();
  hideToast();
  $('#view').innerHTML = ''; // Rien de sensible ne reste dans la page derrière l'écran de code.
  $('#app').hidden = true;
  const el = $('#lock');
  el.hidden = false;
  el.innerHTML = `<div class="weave"></div><h1>Budget FCFA</h1><p>Saisis ton code</p>
    <div class="dots" aria-hidden="true"></div><p class="lock-msg" role="alert"></p>
    <div class="keypad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button type="button" data-k="${n}">${n}</button>`).join('')}
      <span></span><button type="button" data-k="0">0</button><button type="button" data-del aria-label="Effacer un chiffre">${icon('back')}</button></div>
    <button type="button" class="link-btn" id="lock-forgot">Code oublié</button>`;
  let pin = '';
  let busy = false;
  const dots = () => { $('.dots', el).innerHTML = Array.from({ length: lock.len }, (_, i) => `<i class="${i < pin.length ? 'on' : ''}"></i>`).join(''); };
  const msg = (m) => { $('.lock-msg', el).textContent = m; };
  const setKeys = (off) => $$('.keypad button', el).forEach((b) => { b.disabled = off; });
  dots();
  const wait = async () => {
    if (el.hidden) return;
    const f = (await db.getMeta('lockFails')) || { count: 0, until: 0 };
    const left = Math.ceil((f.until - Date.now()) / 1000);
    if (left > 0) {
      setKeys(true);
      msg(`Trop d'essais. Réessaie dans ${left} s.`);
      setTimeout(wait, 1000);
    } else { setKeys(false); if (f.until) msg(''); }
  };
  wait();
  const submit = async () => {
    busy = true;
    if (await checkPin(pin, lock)) {
      await db.delMeta('lockFails');
      locked = false;
      el.hidden = true;
      el.innerHTML = '';
      $('#app').hidden = false;
      await afterUnlock();
    } else {
      const f = (await db.getMeta('lockFails')) || { count: 0, until: 0 };
      f.count += 1;
      f.until = f.count >= 5 ? Date.now() + 30000 * (f.count - 4) : 0;
      await db.setMeta('lockFails', f);
      pin = '';
      dots();
      msg('Code incorrect.');
      wait();
    }
    busy = false;
  };
  $('.keypad', el).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || busy) return;
    if (b.hasAttribute('data-del')) pin = pin.slice(0, -1);
    else if (pin.length < lock.len) pin += b.dataset.k;
    dots();
    if (pin.length === lock.len) submit();
  });
  $('#lock-forgot', el).onclick = () => openErase(true);
}
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (locked || !hiddenAt || Date.now() - hiddenAt < 60000) return;
  const lock = await db.getMeta('lock');
  if (lock) showLock(lock);
});

/* ---------- Rendu et navigation ---------- */
function render() {
  if (locked) return;
  const root = $('#view');
  const v = state.view;
  $('#view-title').textContent = VIEWS[v];
  document.title = `${VIEWS[v]} - Budget FCFA`;
  $('#month-nav').hidden = v === 'reglages';
  $('#month-label').textContent = monthName(state.month);
  $('#month-next').disabled = isCurrent();
  $$('.tabs a').forEach((a) => {
    if (a.dataset.tab === v) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  ({ accueil: viewHome, operations: viewOps, budgets: viewBudgets, analyse: viewAnalysis, reglages: viewSettings }[v])(root);
}
function route(moveFocus) {
  const h = location.hash.slice(1);
  const next = VIEWS[h] ? h : 'accueil';
  const changed = next !== state.view;
  state.view = next;
  if (locked) return;
  if (changed || !moveFocus) render();
  if (changed && moveFocus) { scrollTo(0, 0); $('#view-title').focus({ preventScroll: true }); }
}
$('#month-prev').onclick = () => { state.month = shiftMonth(state.month, -1); render(); };
$('#month-next').onclick = () => { if (!isCurrent()) { state.month = shiftMonth(state.month, 1); render(); } };

async function afterUnlock() {
  route(false);
  const q = new URLSearchParams(location.search).get('noter');
  if (q) {
    history.replaceState(null, '', location.pathname + location.hash);
    openTxForm(null, q === 'entree' ? TYPES.INCOME : TYPES.EXPENSE);
  }
}

function registerSw() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const offer = (w) => toast('Nouvelle version prête.', { label: 'Mettre à jour', sticky: true, run: () => w.postMessage('SKIP_WAITING') });
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
      });
    });
  }).catch(() => {});
  let reloading = false;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
}
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  if (state.view === 'reglages' && !locked) render();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', async () => applyTheme((await db.getMeta('theme')) || 'system'));

(async function init() {
  try {
    await db.openDb();
    applyTheme((await db.getMeta('theme')) || 'system');
    await load();
    registerSw();
    const lock = await db.getMeta('lock');
    if (lock) {
      const h = location.hash.slice(1);
      state.view = VIEWS[h] ? h : 'accueil';
      await showLock(lock);
    } else {
      $('#app').hidden = false;
      await afterUnlock();
    }
  } catch (e) {
    document.body.textContent = `Impossible d'ouvrir les données (${e?.name || e?.message}). Ferme les autres onglets de l'application, puis recharge la page. Tes données n'ont pas été modifiées.`;
  }
})();
