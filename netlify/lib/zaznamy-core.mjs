// Logika API pro historii dokladů (TA CHALUPA).
// Žádná závislost na Netlify – "store" se předává zvenku, takže jde otestovat s falešným úložištěm.
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';

const TYPES = ['doklad', 'nabidka', 'faktura'];
const MODES = ['zaloha', 'pronajem'];
const PAYS = ['ucet', 'hotove'];
const SEASONS = ['leto', 'mimo', 'tyden', 'silvestr'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_IMPORT = 1000;

class Bad extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function str(v, max, field) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new Bad(`Pole „${field}“ musí být text.`);
  return v.trim().slice(0, max);
}
function num(v, min, max, field) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Bad(`Pole „${field}“ má neplatnou hodnotu.`);
  return Math.round(n * 100) / 100;
}
function dateOrNull(v, field) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(v + 'T00:00:00Z'))) {
    throw new Bad(`Pole „${field}“ musí být datum RRRR-MM-DD.`);
  }
  return v;
}
function oneOf(v, list, field) {
  if (!list.includes(v)) throw new Bad(`Pole „${field}“ má neplatnou hodnotu.`);
  return v;
}

// Do úložiště se dostanou jen tato pole a jen v tomto tvaru.
export function sanitizeRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Bad('Chybí data záznamu.');
  const issuedAt = dateOrNull(input.issuedAt, 'issuedAt');
  if (!issuedAt) throw new Bad('Chybí datum vystavení (issuedAt).');
  return {
    type: oneOf(input.type, TYPES, 'type'),
    mode: oneOf(input.mode, MODES, 'mode'),
    pay: oneOf(input.pay, PAYS, 'pay'),
    season: input.season == null ? null : oneOf(input.season, SEASONS, 'season'),
    customer: str(input.customer, 200, 'customer'),
    customerAddr: str(input.customerAddr, 400, 'customerAddr'),
    stayFrom: dateOrNull(input.stayFrom, 'stayFrom'),
    stayTo: dateOrNull(input.stayTo, 'stayTo'),
    persons: Math.round(num(input.persons ?? 0, 0, 100, 'persons')),
    nights: Math.round(num(input.nights ?? 0, 0, 366, 'nights')),
    total: num(input.total ?? 0, 0, 10_000_000, 'total'),
    payable: num(input.payable ?? 0, 0, 10_000_000, 'payable'),
    discountPct: num(input.discountPct ?? 0, 0, 100, 'discountPct'),
    invoiceNo: input.invoiceNo == null || input.invoiceNo === '' ? null : str(input.invoiceNo, 40, 'invoiceNo'),
    desc: str(input.desc, 400, 'desc'),
    issuedAt,
    dueAt: dateOrNull(input.dueAt, 'dueAt'),
    paid: input.paid === true,
  };
}

function pinOk(given, expected) {
  const a = createHash('sha256').update(String(given ?? '')).digest();
  const b = createHash('sha256').update(String(expected)).digest();
  return timingSafeEqual(a, b);
}

async function listAll(store) {
  const { blobs } = await store.list();
  const recs = await Promise.all(blobs.map((b) => store.get(b.key, { type: 'json' })));
  return recs
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

/**
 * @param {{method:string, parts:string[], body:any, pin:string|null, expectedPin:string|undefined, store:any, now?:()=>Date}} ctx
 * @returns {Promise<{status:number, json:any}>}
 */
export async function handle({ method, parts, body, pin, expectedPin, store, now = () => new Date() }) {
  try {
    if (!expectedPin) {
      return { status: 500, json: { error: 'Na serveru chybí proměnná prostředí EVIDENCE_PIN.' } };
    }
    if (!pinOk(pin, expectedPin)) {
      return { status: 401, json: { error: 'Špatné heslo.' } };
    }

    const [first, extra] = parts;

    // GET /api/zaznamy
    if (parts.length === 0 && method === 'GET') {
      return { status: 200, json: { records: await listAll(store) } };
    }

    // POST /api/zaznamy
    if (parts.length === 0 && method === 'POST') {
      const rec = { id: randomUUID(), ...sanitizeRecord(body), createdAt: now().toISOString() };
      await store.setJSON(rec.id, rec);
      return { status: 201, json: { record: rec } };
    }

    // POST /api/zaznamy/import   { records: [...] }  (obnova ze zálohy, bezpečné spustit i opakovaně)
    if (first === 'import' && parts.length === 1 && method === 'POST') {
      const list = body && body.records;
      if (!Array.isArray(list)) throw new Bad('Záloha neobsahuje seznam záznamů („records“).');
      if (list.length > MAX_IMPORT) throw new Bad(`Záloha má víc než ${MAX_IMPORT} záznamů.`);
      let imported = 0, skipped = 0;
      for (let i = 0; i < list.length; i += 25) {
        await Promise.all(list.slice(i, i + 25).map(async (raw) => {
          try {
            const clean = sanitizeRecord(raw);
            const id = typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : randomUUID();
            const createdAt = typeof raw.createdAt === 'string' && ISO_RE.test(raw.createdAt) ? raw.createdAt : now().toISOString();
            await store.setJSON(id, { id, ...clean, createdAt });
            imported++;
          } catch { skipped++; }
        }));
      }
      return { status: 200, json: { imported, skipped } };
    }

    // PATCH|DELETE /api/zaznamy/:id
    if (parts.length === 1 && (method === 'PATCH' || method === 'DELETE')) {
      if (!ID_RE.test(first)) throw new Bad('Neplatné ID záznamu.');
      const existing = await store.get(first, { type: 'json' });
      if (!existing) return { status: 404, json: { error: 'Záznam neexistuje.' } };
      if (method === 'DELETE') {
        await store.delete(first);
        return { status: 200, json: { ok: true } };
      }
      if (!body || typeof body.paid !== 'boolean') throw new Bad('Lze měnit jen stav platby („paid“: true/false).');
      const updated = { ...existing, paid: body.paid };
      await store.setJSON(first, updated);
      return { status: 200, json: { record: updated } };
    }

    return { status: 405, json: { error: 'Nepodporovaná operace.' } };
  } catch (e) {
    if (e instanceof Bad) return { status: e.status, json: { error: e.message } };
    console.error('zaznamy: chyba', e);
    return { status: 500, json: { error: 'Chyba serveru.' } };
  }
}
