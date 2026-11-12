// Bankovní výpis → platby → párování s fakturami.
// ČISTÁ logika (žádné importy z Node ani z Netlify), aby běžela na serveru, v testech i v náhledu v chatu.

/** Vlastní účty a jména – převody mezi nimi nejsou příjem ani výdaj z podnikání. Upravit zde, kdyby přibyl další. */
export const VLASTNI = {
  jmena: ['vaclav stanicek', 'stanicek vaclav', 'malinova dagmar'],
  ucty: ['2784340028', '336528685', '269179066', '2784340052', '2784340044'],
};
/** Kód banky 0710 = ČNB: na účtech vedených u ČNB mají finanční úřady příjmové účty daní. */
export const KOD_FU = '0710';
/** Jen tyto druhy plateb se ukládají (ostatní pohyby – karty, vlastní převody, výdaje – ne). */
export const UKLADAT = ['booking', 'priamo', 'fu', 'vraceni'];

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const sum = (a) => Math.round(a.reduce((s, x) => s + x, 0) * 100) / 100;
const dayNum = (s) => { const [y, m, d] = s.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86400000); };
const addDays = (s, n) => { const t = new Date((dayNum(s) + n) * 86400000); return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`; };

// deterministické ID pohybu (stejný řádek výpisu = stejné ID → opakovaný import nic nezduplikuje)
function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
export const ID_PLATBY = /^p[0-9a-f]{28}$/;
const hex14 = (n) => n.toString(16).padStart(14, '0');

/** Vytáhne z textu (Markdown / CSV) tabulku účtů a řádky Účet;Datum;Typ;Protiúčet;Protistrana;Částka;Poznámka. */
export function parseVypis(text) {
  const rows = [], accNames = {};
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    let m = t.match(/^\|\s*(\d+(?:-\d+)?\/\d{4})\s*\|\s*([^|]*?)\s*\|/);
    if (m) accNames[m[1]] = m[2];
    m = t.match(/^(\d+(?:-\d+)?\/\d{4});(\d{2})\.(\d{2})\.(\d{4});([^;]*);([^;]*);([^;]*);(-?\d+(?:[.,]\d+)?);(.*)$/);
    if (!m) continue;
    rows.push({ ucet: m[1], datum: `${m[4]}-${m[3]}-${m[2]}`, typ: m[5], protiucet: m[6], protistrana: m[7], castka: Number(m[8].replace(',', '.')), poznamka: m[9].trim() });
  }
  return { rows, accNames };
}

function accountKind(ucet, accNames) {
  if (/booking/i.test(accNames[ucet] || '')) return 'booking';
  return ucet === '2784340052/3030' ? 'booking' : 'hlavni';
}

/** Přiřadí každému pohybu druh: booking | priamo | fu | vraceni | vlastni | vydaj | ostatni | ignor. */
export function klasifikuj(rows, accNames = {}, own = VLASTNI) {
  const seen = new Map();
  const items = rows.map((r) => {
    const key = [r.ucet, r.datum, r.typ, r.protiucet, r.castka, r.poznamka].join('|');
    const n = seen.get(key) || 0; seen.set(key, n + 1);
    return { ...r, id: 'p' + hex14(cyrb53(key + '|' + n)) + hex14(cyrb53(key + '|' + n, 7)), account: accountKind(r.ucet, accNames), in: r.castka > 0, refunded: false, pair: null };
  });
  const isOwn = (x) => {
    const acc = String(x.protiucet).split('/')[0].split('-').pop();
    return own.jmena.includes(norm(x.protistrana)) || own.ucty.includes(acc);
  };
  for (const x of items) {
    const banka = String(x.protiucet).split('/')[1];
    if (x.typ === 'Karta' || x.typ === 'Odmena') { x.kind = 'ignor'; continue; }
    if (x.in) {
      if (x.account === 'booking' && /booking\.com/i.test(x.protistrana)) x.kind = 'booking';
      else if (isOwn(x)) x.kind = 'vlastni';
      else if (banka === KOD_FU) x.kind = 'fu';
      else x.kind = x.account === 'hlavni' ? 'priamo' : 'ostatni';
    } else if (banka === KOD_FU) x.kind = 'fu';
    else if (isOwn(x)) x.kind = 'vlastni';
    else x.kind = /vracen/.test(norm(x.poznamka)) ? 'vraceni' : 'vydaj';
  }
  // Vrácení: odchozí platba na stejný účet a ve stejné výši jako dřívější příchozí (storno zálohy, vratná kauce)
  for (const out of items.filter((x) => !x.in && (x.kind === 'vydaj' || x.kind === 'vraceni'))) {
    const inn = items.find((p) => p.in && p.kind === 'priamo' && !p.refunded && p.protiucet === out.protiucet
      && p.castka === -out.castka && p.datum <= out.datum && dayNum(out.datum) - dayNum(p.datum) <= 120);
    if (inn) { inn.refunded = true; inn.pair = out.id; out.kind = 'vraceni'; out.pair = inn.id; }
  }
  // částka u FÚ: odchozí = kladná (zaplaceno), příchozí (vratka) = záporná
  for (const x of items) x.amount = x.kind === 'fu' ? -x.castka : Math.abs(x.castka);
  return items;
}

export function extractVs(note) {
  const m = String(note).match(/\bVS\s*(\d{6,8})\b/i) || String(note).match(/\bv\.\s?s\.\s*(\d{6,8})\b/i) || String(note).match(/faktur\w*\s+(\d{6,8})\b/i);
  return m ? m[1] : '';
}
const STOP = new Set(['chalupa', 'zaloha', 'pobyt', 'ubytovani', 'faktura', 'doplatek']);
const tokens = (s) => norm(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w));
function nameHit(customer, text) {
  const a = tokens(customer), b = tokens(text);
  return a.some((x) => b.some((y) => x === y || (x.length >= 5 && y.length >= 5 && x.slice(0, 5) === y.slice(0, 5))));
}

/**
 * Spáruje příchozí přímé platby s fakturami (podle VS, částky a jména plátce).
 * Vrací změny faktur: { id, paid, paidAt, paidAmount, refunded } a nespárované platby.
 */
export function sparuj(platby, faktury) {
  const inv = faktury.filter((f) => f.type !== 'nabidka');
  const matches = new Map(), unmatched = [];
  const cand = platby.filter((p) => p.kind === 'priamo').sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  for (const p of cand) {
    const vs = extractVs(p.note); p.vs = vs; p.invoiceId = null;
    let best = null;
    for (const f of inv) {
      if (vs && f.invoiceNo !== vs) continue;
      const total = f.total || 0;
      let sA = 0;
      if (p.amount === f.payable) sA = 4;
      else if (total > f.payable && p.amount === total - f.payable) sA = 3;   // doplatek
      else if (total && p.amount === total) sA = 3;
      if (!sA) continue;
      const sN = nameHit(f.customer, p.who + ' ' + p.note) ? 2 : 0;
      const sD = p.date >= addDays(f.issuedAt, -5) ? 1 : -2;
      const sU = (matches.get(f.id) || []).length ? -1 : 1;
      const score = sA + sN + sD + sU;
      if (score >= (vs ? 5 : 7) && (!best || score > best.score)) best = { f, score };
    }
    if (best) { matches.set(best.f.id, [...(matches.get(best.f.id) || []), p]); p.invoiceId = best.f.id; }
    else if (!p.refunded) unmatched.push(p);
  }
  const patches = [];
  for (const [id, list] of matches) {
    const f = inv.find((x) => x.id === id);
    const paidAmount = sum(list.map((p) => p.amount));
    const refunded = sum(list.filter((p) => p.refunded).map((p) => p.amount));
    let run = 0, paidAt = null;
    for (const p of list) { run += p.amount; if (!paidAt && run >= f.payable) paidAt = p.date; }
    patches.push({ id, paid: paidAmount - refunded >= f.payable, paidAt: paidAt || list[0].date, paidAmount, refunded });
  }
  return { patches, unmatched };
}

const toPlatba = (x) => ({
  id: x.id, kind: x.kind, date: x.datum, amount: x.amount, account: x.account,
  who: String(x.protistrana || x.protiucet || '').slice(0, 120), vs: '', note: String(x.poznamka || '').slice(0, 200),
  invoiceId: null, refunded: x.refunded === true,
});

/**
 * Celý import: výpis → platby (sloučí se stávajícími) → párování s fakturami → souhrn.
 * @returns {{platby:object[], patches:object[], summary:object}}
 */
export function importVypis(text, existing = [], faktury = []) {
  const { rows, accNames } = parseVypis(text);
  if (!rows.length) throw new Error('Ve výpisu jsem nenašel žádné pohyby (čekám řádky Účet;Datum;Typ;Protiúčet;Protistrana;Částka;Poznámka).');
  const cl = klasifikuj(rows, accNames);
  const map = new Map(existing.map((p) => [p.id, { ...p }]));
  for (const x of cl.filter((c) => UKLADAT.includes(c.kind))) map.set(x.id, toPlatba(x));
  const platby = [...map.values()];
  const { patches, unmatched } = sparuj(platby, faktury);
  const group = (kind) => { const l = cl.filter((x) => x.kind === kind); return { n: l.length, sum: sum(l.map((x) => x.amount)) }; };
  const dates = rows.map((r) => r.datum).sort();
  const prime = cl.filter((x) => x.kind === 'priamo' && !x.refunded);
  return {
    platby, patches,
    summary: {
      pohybu: rows.length, od: dates[0], do: dates[dates.length - 1],
      booking: group('booking'), priamo: { n: prime.length, sum: sum(prime.map((x) => x.amount)) }, fu: group('fu'), vraceni: group('vraceni'),
      vlastni: group('vlastni'), ostatniVydaje: group('vydaj'), ignorovano: group('ignor'),
      sparovano: patches.length, zaplaceno: patches.filter((p) => p.paid).length,
      nesparovane: unmatched.map((p) => ({ date: p.date, amount: p.amount, who: p.who, vs: p.vs })),
    },
  };
}
