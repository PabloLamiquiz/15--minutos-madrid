// Lector mínimo de ficheros OpenStreetMap .osm.pbf (sin dependencias).
// Formato: https://wiki.openstreetmap.org/wiki/PBF_Format
// Funciona en Node ≥ 18 y en el navegador. `inflate` recibe un bloque zlib y devuelve sus bytes.

const TD = new TextDecoder();

class PB {   // lector de protobuf
  constructor(buf, pos = 0, end = buf.length) { this.b = buf; this.p = pos; this.e = end; }
  more() { return this.p < this.e; }
  varint() {   // hasta 2^53, suficiente para ids de OSM
    let r = 0, m = 1, c;
    do { c = this.b[this.p++]; r += (c & 0x7f) * m; m *= 128; } while (c & 0x80);
    return r;
  }
  svarint() { const n = this.varint(); return n % 2 === 1 ? -(n + 1) / 2 : n / 2; }
  key() { const k = this.varint(); return [Math.floor(k / 8), k & 7]; }
  bytes() { const n = this.varint(), s = this.p; this.p += n; return this.b.subarray(s, s + n); }
  skip(wt) {
    if (wt === 0) this.varint(); else if (wt === 1) this.p += 8; else if (wt === 2) { const n = this.varint(); this.p += n; } else if (wt === 5) this.p += 4;
    else throw new Error("tipo protobuf no soportado " + wt);
  }
  packed(fn) { const n = this.varint(), end = this.p + n, out = []; while (this.p < end) out.push(fn.call(this)); return out; }
}

function parseStringTable(buf) {
  const pb = new PB(buf), out = [];
  while (pb.more()) { const [f, wt] = pb.key(); if (f === 1) out.push(TD.decode(pb.bytes())); else pb.skip(wt); }
  return out;
}

function tagsFrom(keys, vals, st) {
  if (!keys.length) return null;
  const t = {}; for (let i = 0; i < keys.length; i++) t[st[keys[i]]] = st[vals[i]]; return t;
}

function parseBlock(buf, h) {
  const pb = new PB(buf); let st = [], gran = 100, latOff = 0, lonOff = 0; const groups = [];
  while (pb.more()) {
    const [f, wt] = pb.key();
    if (f === 1) st = parseStringTable(pb.bytes());
    else if (f === 2) groups.push(pb.bytes());
    else if (f === 17) gran = pb.varint(); else if (f === 19) latOff = pb.varint(); else if (f === 20) lonOff = pb.varint();
    else pb.skip(wt);
  }
  const toDeg = (off, v) => 1e-9 * (off + gran * v);
  for (const g of groups) {
    const gp = new PB(g);
    while (gp.more()) {
      const [f, wt] = gp.key();
      if (f === 2 && h.node) {   // DenseNodes
        const d = new PB(gp.bytes()); let ids = [], lats = [], lons = [], kv = [];
        while (d.more()) {
          const [ff, ww] = d.key();
          if (ff === 1) ids = d.packed(PB.prototype.svarint); else if (ff === 8) lats = d.packed(PB.prototype.svarint);
          else if (ff === 9) lons = d.packed(PB.prototype.svarint); else if (ff === 10) kv = d.packed(PB.prototype.varint); else d.skip(ww);
        }
        let id = 0, la = 0, lo = 0, k = 0;
        for (let i = 0; i < ids.length; i++) {
          id += ids[i]; la += lats[i]; lo += lons[i];
          let tags = null;
          if (kv.length) { while (kv[k] !== 0) { (tags || (tags = {}))[st[kv[k]]] = st[kv[k + 1]]; k += 2; } k++; }
          h.node(id, toDeg(latOff, la), toDeg(lonOff, lo), tags);
        }
      } else if (f === 1 && h.node) {   // Node suelto
        const d = new PB(gp.bytes()); let id = 0, la = 0, lo = 0, keys = [], vals = [];
        while (d.more()) {
          const [ff, ww] = d.key();
          if (ff === 1) id = d.svarint(); else if (ff === 2) keys = d.packed(PB.prototype.varint); else if (ff === 3) vals = d.packed(PB.prototype.varint);
          else if (ff === 8) la = d.svarint(); else if (ff === 9) lo = d.svarint(); else d.skip(ww);
        }
        h.node(id, toDeg(latOff, la), toDeg(lonOff, lo), tagsFrom(keys, vals, st));
      } else if (f === 3 && h.way) {
        const d = new PB(gp.bytes()); let id = 0, keys = [], vals = [], refs = [];
        while (d.more()) {
          const [ff, ww] = d.key();
          if (ff === 1) id = d.varint(); else if (ff === 2) keys = d.packed(PB.prototype.varint); else if (ff === 3) vals = d.packed(PB.prototype.varint);
          else if (ff === 8) refs = d.packed(PB.prototype.svarint); else d.skip(ww);
        }
        for (let i = 1; i < refs.length; i++) refs[i] += refs[i - 1];
        h.way(id, refs, tagsFrom(keys, vals, st));
      } else if (f === 4 && h.relation) {
        const d = new PB(gp.bytes()); let id = 0, keys = [], vals = [], roles = [], mids = [], types = [];
        while (d.more()) {
          const [ff, ww] = d.key();
          if (ff === 1) id = d.varint(); else if (ff === 2) keys = d.packed(PB.prototype.varint); else if (ff === 3) vals = d.packed(PB.prototype.varint);
          else if (ff === 8) roles = d.packed(PB.prototype.varint); else if (ff === 9) mids = d.packed(PB.prototype.svarint);
          else if (ff === 10) types = d.packed(PB.prototype.varint); else d.skip(ww);
        }
        for (let i = 1; i < mids.length; i++) mids[i] += mids[i - 1];
        const members = mids.map((m, i) => ({ type: ["n", "w", "r"][types[i]], ref: m, role: st[roles[i]] }));
        h.relation(id, members, tagsFrom(keys, vals, st));
      } else gp.skip(wt);
    }
  }
}

// Recorre el fichero completo. Devuelve { header } con la fecha de los datos si viene en la cabecera.
export async function readPBF(bytes, handlers, inflate) {
  let p = 0; const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); const info = {};
  while (p < bytes.length) {
    const hlen = dv.getUint32(p); p += 4;
    const hp = new PB(bytes, p, p + hlen); let type = "", size = 0;
    while (hp.more()) { const [f, wt] = hp.key(); if (f === 1) type = TD.decode(hp.bytes()); else if (f === 3) size = hp.varint(); else hp.skip(wt); }
    p += hlen;
    const bp = new PB(bytes, p, p + size); let raw = null, zdata = null;
    while (bp.more()) { const [f, wt] = bp.key(); if (f === 1) raw = bp.bytes(); else if (f === 3) zdata = bp.bytes(); else bp.skip(wt); }
    p += size;
    const data = raw || await inflate(zdata);
    if (type === "OSMHeader") {
      const q = new PB(data);
      while (q.more()) { const [f, wt] = q.key(); if (f === 4) (info.required ||= []).push(TD.decode(q.bytes())); else if (f === 32) info.timestamp = q.varint(); else if (f === 34) info.replicationUrl = TD.decode(q.bytes()); else q.skip(wt); }
    } else if (type === "OSMData") parseBlock(data, handlers);
  }
  return info;
}
