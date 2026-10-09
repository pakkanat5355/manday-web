// Shared-room logic for the Man-Day Estimator. Storage is passed in, so this file has no dependencies.
// `store` needs: getWithMetadata(key, {type:'json'}) -> {data, etag} | null, get(key, {type:'json'}), setJSON(key, value, opts) -> {modified}

const PRESENCE_TTL = 25000;      // a user who has not been seen for this long is dropped from the room
const MAX_BODY = 2000000;
const MAX_OPS = 2000;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

// Keep in sync with applyOps() in public/index.html
export function applyOps(doc, ops) {
  const bad = k => k === '__proto__' || k === 'constructor' || k === 'prototype';
  const listOf = n => (n === 'tasks' ? doc.tasks : n === 'plan' ? doc.plan.rows : null);
  ops.forEach(op => {
    if (!op || typeof op !== 'object') return;
    if (op.t === 'meta' || op.t === 'cfg' || op.t === 'sec') {
      const target = op.t === 'meta' ? doc.meta : op.t === 'cfg' ? doc.cfg : doc.secOpt;
      if (typeof op.k !== 'string' || bad(op.k)) return;
      if (op.v === undefined) delete target[op.k]; else target[op.k] = op.v;
    } else if (op.t === 'planStart') {
      doc.plan.start = op.v;
    } else {
      const list = listOf(op.list);
      if (!list) return;
      if (op.t === 'add') {
        if (!op.v || typeof op.v.id !== 'string' || list.some(r => r.id === op.v.id)) return;
        const i = list.findIndex(r => r.id === op.after);
        list.splice(op.after == null ? 0 : (i < 0 ? list.length : i + 1), 0, op.v);
      } else if (op.t === 'del') {
        const i = list.findIndex(r => r.id === op.id);
        if (i >= 0) list.splice(i, 1);
      } else if (op.t === 'row') {
        const r = list.find(x => x.id === op.id);
        if (!r || typeof op.f !== 'string' || bad(op.f) || op.f === 'id') return;
        r[op.f] = op.v;
      }
    }
  });
  return doc;
}

function validDoc(d) {
  return !!d && typeof d === 'object' && d.meta && typeof d.meta === 'object' && d.cfg && typeof d.cfg === 'object' && Array.isArray(d.tasks);
}
function shapeDoc(d) {
  if (!d.secOpt || typeof d.secOpt !== 'object') d.secOpt = {};
  if (!d.plan || !Array.isArray(d.plan.rows)) d.plan = { start: '', rows: [] };
  return d;
}
function cleanClient(c) {
  if (!c || typeof c !== 'object' || !/^[a-z0-9]{6,24}$/.test(String(c.id))) return null;
  return {
    id: String(c.id),
    name: String(c.name || 'Guest').slice(0, 40),
    color: /^#[0-9a-fA-F]{6}$/.test(String(c.color)) ? String(c.color) : '#71717a',
    focus: /^[a-z]{1,12}:[a-z0-9]{1,40}$/.test(String(c.focus)) ? String(c.focus) : ''
  };
}

export async function handle(req, store) {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  let body;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY) return json({ error: 'request too large' }, 413);
    body = JSON.parse(text);
  } catch (e) {
    return json({ error: 'bad request' }, 400);
  }
  const room = String((body && body.room) || '');
  if (!/^[a-z0-9]{8,40}$/.test(room)) return json({ error: 'bad room id' }, 400);
  const docKey = 'doc/' + room, presKey = 'presence/' + room;
  const client = cleanClient(body.client), now = Date.now();

  if (body.leave) {
    const pres = (await store.get(presKey, { type: 'json' })) || { users: {} };
    if (client && pres.users[client.id]) { delete pres.users[client.id]; await store.setJSON(presKey, pres); }
    return json({ ok: true });
  }

  // --- document: load, apply this client's edits, write back only if nobody else wrote in between ---
  const ops = Array.isArray(body.ops) ? body.ops.slice(0, MAX_OPS) : [];
  let rec = null, done = false, changed = false;
  for (let attempt = 0; attempt < 8 && !done; attempt++) {
    const got = await store.getWithMetadata(docKey, { type: 'json' });
    rec = got && got.data ? got.data : null;
    if (!rec) {
      if (!validDoc(body.create)) return json({ error: 'room not found' }, 404);
      rec = { version: 1, doc: shapeDoc(body.create), created: now, updated: now };
      const w = await store.setJSON(docKey, rec, { onlyIfNew: true });
      done = !w || w.modified !== false;
      changed = done;
      continue;
    }
    shapeDoc(rec.doc);
    if (!ops.length) { done = true; break; }
    applyOps(rec.doc, ops);
    rec.version++; rec.updated = now;
    const w = await store.setJSON(docKey, rec, got.etag ? { onlyIfMatch: got.etag } : undefined);
    done = !w || w.modified !== false;
    changed = done;
  }
  if (!done) return json({ error: 'busy, try again' }, 409);

  // --- presence: one small record per room; lost updates heal on the next heartbeat ---
  const pres = (await store.get(presKey, { type: 'json' })) || { users: {} };
  let dirty = false;
  Object.keys(pres.users).forEach(id => { if (now - pres.users[id].ts > PRESENCE_TTL) { delete pres.users[id]; dirty = true; } });
  if (client) {
    const cur = pres.users[client.id];
    if (!cur || body.hb || cur.focus !== client.focus || cur.name !== client.name) { pres.users[client.id] = Object.assign({ ts: now }, client); dirty = true; }
  }
  if (dirty) await store.setJSON(presKey, pres);

  const out = { version: rec.version, users: Object.keys(pres.users).map(id => ({ id, name: pres.users[id].name, color: pres.users[id].color, focus: pres.users[id].focus })) };
  if (changed || body.since !== rec.version) out.doc = rec.doc;
  return json(out);
}
