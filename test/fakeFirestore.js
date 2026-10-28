'use strict';
// Firestore palsu in-memory untuk uji logika. Mendukung subset yang dipakai backend.
// Transaksi diserialkan (mutex) => memodelkan atomisitas; ini BUKAN pengganti emulator Firestore.
const SERVER_TS = { __serverTimestamp: true };
const FieldValue = { serverTimestamp: () => SERVER_TS };

function clone(v) {
  if (v === SERVER_TS) return module.exports.clock();
  if (v instanceof Date) return new Date(v.getTime());
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = clone(v[k]); return o; }
  return v;
}
class Snap { constructor(ref, data) { this.ref = ref; this.id = ref.id; this.exists = data !== undefined; this._d = data; } data() { return this.exists ? clone(this._d) : undefined; } }
class DocRef {
  constructor(db, path) { this.db = db; this.path = path; this.id = path.split('/').pop(); }
  get parent() { return new CollRef(this.db, this.path.split('/').slice(0, -1).join('/')); }
  collection(n) { return new CollRef(this.db, `${this.path}/${n}`); }
  async get() { return new Snap(this, this.db.docs.get(this.path)); }
  async set(d, o) { this.db._set(this.path, d, o); }
  async update(d) { this.db._update(this.path, d); }
  async create(d) { this.db._create(this.path, d); }
}
class Query {
  constructor(db, filt, wheres = [], order = null, lim = null) { this.db = db; this.filt = filt; this.wheres = wheres; this.order = order; this.lim = lim; }
  where(f, op, v) { if (op !== '==') throw new Error('op'); return new Query(this.db, this.filt, [...this.wheres, [f, v]], this.order, this.lim); }
  orderBy(f, dir = 'asc') { return new Query(this.db, this.filt, this.wheres, [f, dir], this.lim); }
  limit(n) { return new Query(this.db, this.filt, this.wheres, this.order, n); }
  async get() {
    let rows = [...this.db.docs.entries()].filter(([p]) => this.filt(p)).map(([p, d]) => [p, d])
      .filter(([, d]) => this.wheres.every(([f, v]) => d[f] === v));
    if (this.order) { const [f, dir] = this.order; rows.sort((a, b) => { const x = +new Date(a[1][f]), y = +new Date(b[1][f]); return dir === 'desc' ? y - x : x - y; }); }
    if (this.lim != null) rows = rows.slice(0, this.lim);
    const docs = rows.map(([p, d]) => new Snap(new DocRef(this.db, p), d));
    return { empty: docs.length === 0, docs, size: docs.length };
  }
}
class CollRef extends Query {
  constructor(db, path) { super(db, (p) => p.startsWith(path + '/') && !p.slice(path.length + 1).includes('/')); this.path = path; this.id = path.split('/').pop(); }
  doc(id) { return new DocRef(this.db, `${this.path}/${id}`); }
  get parent() { const s = this.path.split('/'); return s.length > 1 ? new DocRef(this.db, s.slice(0, -1).join('/')) : null; }
}
class FakeDb {
  constructor() { this.docs = new Map(); this._lock = Promise.resolve(); }
  collection(n) { return new CollRef(this, n); }
  doc(p) { return new DocRef(this, p); }
  collectionGroup(n) { return new Query(this, (p) => { const s = p.split('/'); return s.length % 2 === 0 && s[s.length - 2] === n; }); }
  _set(p, d, o) { const cur = this.docs.get(p); this.docs.set(p, o && o.merge && cur ? { ...cur, ...clone(d) } : clone(d)); }
  _update(p, d) { const cur = this.docs.get(p); if (!cur) throw Object.assign(new Error('NOT_FOUND'), { code: 5 }); this.docs.set(p, { ...cur, ...clone(d) }); }
  _create(p, d) { if (this.docs.has(p)) throw Object.assign(new Error('ALREADY_EXISTS'), { code: 6 }); this.docs.set(p, clone(d)); }
  batch() {
    const ops = [];
    return { create: (r, d) => ops.push(['c', r.path, d]), set: (r, d, o) => ops.push(['s', r.path, d, o]), update: (r, d) => ops.push(['u', r.path, d]),
      commit: async () => { const snapshot = new Map(this.docs); try { for (const [t, p, d, o] of ops) { if (t === 'c') this._create(p, d); else if (t === 's') this._set(p, d, o); else this._update(p, d); } } catch (e) { this.docs = snapshot; throw e; } } };
  }
  runTransaction(fn) {
    const run = async () => {
      const writes = [];
      const tx = { get: async (r) => r.get(), create: (r, d) => writes.push(['c', r.path, d]), set: (r, d, o) => writes.push(['s', r.path, d, o]), update: (r, d) => writes.push(['u', r.path, d]) };
      const result = await fn(tx);
      const snapshot = new Map(this.docs);
      try { for (const [t, p, d, o] of writes) { if (t === 'c') this._create(p, d); else if (t === 's') this._set(p, d, o); else this._update(p, d); } } catch (e) { this.docs = snapshot; throw e; }
      return result;
    };
    const p = this._lock.then(run, run);
    this._lock = p.catch(() => {});
    return p;
  }
}
module.exports = { FakeDb, FieldValue, clock: () => new Date() };
