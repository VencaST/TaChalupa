// Netlify Function: /api/zaznamy  (historie dokladů TA CHALUPA, úložiště Netlify Blobs)
import { getStore } from '@netlify/blobs';
import { handle } from '../lib/zaznamy-core.mjs';

export const config = { path: ['/api/zaznamy', '/api/zaznamy/*', '/api/platby', '/api/platby/*'] };

const MAX_BODY = 1_000_000; // znaků

function reply(status, json) {
  return new Response(JSON.stringify(json), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export default async (req) => {
  const url = new URL(req.url);
  const m = url.pathname.match(/^\/api\/(zaznamy|platby)(\/.*)?$/);
  if (!m) return reply(404, { error: 'Neznámá adresa.' });
  const resource = m[1];
  const parts = (m[2] || '').split('/').filter(Boolean);

  let body = null;
  if (req.method === 'POST' || req.method === 'PATCH') {
    const text = await req.text();
    if (text.length > MAX_BODY) return reply(413, { error: 'Příliš velký požadavek.' });
    if (text) {
      try { body = JSON.parse(text); } catch { return reply(400, { error: 'Neplatný JSON.' }); }
    }
  }

  const expectedPin = globalThis.Netlify?.env?.get?.('EVIDENCE_PIN') ?? process.env.EVIDENCE_PIN;
  // Úložiště se otevře až při prvním použití (po kontrole hesla); chyba se vrátí jako čitelná odpověď.
  const wrap = (name) => {
    let real = null;
    const open = () => (real ??= getStore({ name, consistency: 'strong' }));
    return {
      list: (...a) => open().list(...a),
      get: (...a) => open().get(...a),
      setJSON: (...a) => open().setJSON(...a),
      delete: (...a) => open().delete(...a),
    };
  };
  const store = wrap('zaznamy-tachalupa');
  const platbyStore = wrap('platby-tachalupa');

  const { status, json } = await handle({
    method: req.method,
    resource,
    parts,
    body,
    pin: req.headers.get('x-pin'),
    expectedPin,
    store,
    platbyStore,
  });

  // Pomalejší odpověď na špatné heslo ztěžuje hádání.
  if (status === 401) await new Promise((r) => setTimeout(r, 500));
  return reply(status, json);
};
