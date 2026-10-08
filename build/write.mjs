// Etapa 3: codificación de los ficheros que carga la página y de los ficheros de auditoría.
import { Q } from "./slopes.mjs";

// graph.bin versión 4 (little endian):
//   cabecera 8 × uint32: 4, nodos, aristas, puntos de forma, líneas base, puntos de líneas base, 0, 0
//   nodos: lon, lat (int32, grados × 1e6)
//   aristas: u, v (uint32), longitud (uint32, cm), nombre (uint32, índice en extra.names)
//            pendiente de barrera (uint16, décimas de %; 65535 = sin dato), factor de tiempo u→v y v→u (uint16, ×1000),
//            banderas (uint16: bit0 escalera, bit1 calle principal, bit2 estructura, bit3 escalera con rampa;
//            bits 8–11 calidad de la pendiente: 1 interpolada en estructura, 2 discontinuidad, 4 sin dato, 8 capa≠0)
//   formas: inicio por arista (uint32, aristas+1) y puntos intermedios (int32, grados × 1e6)
//   líneas base: tipo (uint32), inicio (uint32, líneas+1), puntos (int32, grados × 1e5)
export function encodeGraph(g, nameIdx, lines) {
  const nN = g.lon.length, nE = g.edges.length;
  const shapes = [0], sp = [];
  for (const e of g.edges) { for (let k = 1; k < e.coords.length - 1; k++) sp.push(Math.round(e.coords[k][0] * 1e6), Math.round(e.coords[k][1] * 1e6)); shapes.push(sp.length / 2); }
  const bk = [], bst = [0], bp = [];
  for (const [kind, flat] of lines) { bk.push(kind); for (const v of flat) bp.push(v); bst.push(bp.length / 2); }
  const nS = sp.length / 2, nB = bk.length, nBP = bp.length / 2;
  const u16pad = (4 * nE * 2) % 4 ? 2 : 0;
  const size = 32 + 8 * nN + 16 * nE + 8 * nE + u16pad + 4 * (nE + 1) + 8 * nS + 4 * nB + 4 * (nB + 1) + 8 * nBP;
  const buf = new ArrayBuffer(size), dv = new DataView(buf); let o = 0;
  const u32 = v => { dv.setUint32(o, v, true); o += 4; }, i32 = v => { dv.setInt32(o, v, true); o += 4; }, u16 = v => { dv.setUint16(o, v, true); o += 2; };
  [4, nN, nE, nS, nB, nBP, 0, 0].forEach(u32);
  for (let i = 0; i < nN; i++) { i32(Math.round(g.lon[i] * 1e6)); i32(Math.round(g.lat[i] * 1e6)); }
  for (const e of g.edges) u32(e.u); for (const e of g.edges) u32(e.v);
  for (const e of g.edges) u32(Math.round(e.len * 100)); for (const e of g.edges) u32(nameIdx(e.name));
  for (const e of g.edges) u16(e.gmax === e.gmax ? Math.min(65534, Math.round(e.gmax * 1000)) : 65535);
  for (const e of g.edges) u16(Math.min(65535, Math.round(e.tf * 1000)));
  for (const e of g.edges) u16(Math.min(65535, Math.round(e.tb * 1000)));
  for (const e of g.edges) u16((e.flags & 0xff) | ((e.q & 0xff) << 8));
  o += u16pad;
  for (const v of shapes) u32(v); for (const v of sp) i32(v);
  for (const v of bk) u32(v); for (const v of bst) u32(v); for (const v of bp) i32(v);
  if (o !== size) throw new Error("tamaño de graph.bin incoherente");
  return new Uint8Array(buf);
}

// Destinos en columnas para la página.
export const GREEN_CLASSES = ["green_large", "green_small", "playground", "park_point", "garden_point", "private"];
export function encodeDestinations(dests, catList, subList, nodeOfOsmIdx) {
  const keep = dests.filter(d => !d.dropped);
  const idx = new Map(keep.map((d, i) => [d.osm, i]));
  const names = [""], nameMap = new Map([["", 0]]);
  const ni = s => { if (!nameMap.has(s)) { nameMap.set(s, names.length); names.push(s); } return nameMap.get(s); };
  const WC = { yes: 1, limited: 2, no: 3 };
  const col = { id: [], c: [], s: [], lon: [], lat: [], nm: [], wc: [], gc: [], st: [], ty: [], snap: [], ent: [] };
  for (const d of keep) {
    col.id.push(d.osm); col.c.push(catList.indexOf(d.cat)); col.s.push(subList.indexOf(d.sub));
    col.lon.push(Math.round(d.lon * 1e6)); col.lat.push(Math.round(d.lat * 1e6)); col.nm.push(ni(d.name || ""));
    col.wc.push(WC[d.wc] || 0); col.gc.push(d.cat === "green" ? GREEN_CLASSES.indexOf(d.greenClass) : -1);
    col.st.push(d.station ? (idx.has(d.station) ? idx.get(d.station) : -1) : -1);
    col.ty.push(d.cat === "station" ? ["other", "subway", "train", "light_rail"].indexOf(d.stype) : -1);
    col.snap.push(d.snap ? d.snap.flat() : []);
    col.ent.push(d.entrances ? d.entrances.map(nodeOfOsmIdx) : []);
  }
  return { cats: catList, subs: subList, greenClasses: GREEN_CLASSES, names, ...col };
}

export function csv(rows, header) {
  const esc = v => { const s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [header.join(","), ...rows.map(r => header.map(h => esc(r[h])).join(","))].join("\n") + "\n";
}
export { Q };
