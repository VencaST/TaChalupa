// Netlify Function: /api/zaznamy  (historie dokladů TA CHALUPA, úložiště Netlify Blobs)
import { getStore } from '@netlify/blobs';
import { handle } from '../lib/zaznamy-core.mjs';

export const config = { path: ['/api/zaznamy', '/api/zaznamy/*'] };

const MAX_BODY = 1_000_000; // znaků

function reply(status, json) {
  return new Response(JSON.stringify(json), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export default async (req) => {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/zaznamy\/?/, '').split('/').filter(Boolean);

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
  let real = null;
  const open = () => (real ??= getStore({ name: 'zaznamy-tachalupa', consistency: 'strong' }));
  const store = {
    list: (...a) => open().list(...a),
    get: (...a) => open().get(...a),
    setJSON: (...a) => open().setJSON(...a),
    delete: (...a) => open().delete(...a),
  };

  const { status, json } = await handle({
    method: req.method,
    parts,
    body,
    pin: req.headers.get('x-pin'),
    expectedPin,
    store,
  });

  // Pomalejší odpověď na špatné heslo ztěžuje hádání.
  if (status === 401) await new Promise((r) => setTimeout(r, 500));
  return reply(status, json);
};
