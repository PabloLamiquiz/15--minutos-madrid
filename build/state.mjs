// Estado intermedio tras la etapa OSM: red, destinos y mapa base, sin el extracto completo.
// JSON comprimido con enteros: coordenadas en grados × 1e7 (la resolución nativa de OSM) y longitudes en mm,
// con las secuencias codificadas como diferencias para que ocupen poco. Cualquier entorno que lo lea (Node o
// navegador) reconstruye exactamente los mismos puntos de muestreo.

const ST = [null, "bridge", "tunnel", "indoor"];
export const delta = a => { const o = new Array(a.length); let p = 0; for (let i = 0; i < a.length; i++) { o[i] = a[i] - p; p = a[i]; } return o; };
export const undelta = a => { const o = new Array(a.length); let p = 0; for (let i = 0; i < a.length; i++) { p += a[i]; o[i] = p; } return o; };
const e7 = v => Math.round(v * 1e7);

// Solo lo que hace falta para calcular los puntos de muestreo del perfil (se usa para llevarlo a otro entorno).
export function packGeometry(S) {
  const E = S.graph.edges;
  return { version: 1, lon: delta(Array.from(S.nodes.lon, e7)), lat: delta(Array.from(S.nodes.lat, e7)),
    gn: E.map(e => e.geom.length), gi: delta(E.flatMap(e => e.geom)), len: E.map(e => Math.round(e.len * 1000)), st: E.map(e => ST.indexOf(e.structure)) };
}
export function unpackGeometry(o) {
  const lon = undelta(o.lon), lat = undelta(o.lat), gi = undelta(o.gi), edges = []; let k = 0;
  for (let i = 0; i < o.gn.length; i++) { edges.push({ geom: gi.slice(k, k + o.gn[i]), len: o.len[i] / 1000, structure: ST[o.st[i]] }); k += o.gn[i]; }
  return { nodes: { lon: Float64Array.from(lon, v => v / 1e7), lat: Float64Array.from(lat, v => v / 1e7) }, graph: { edges } };
}

export function packState(S) {
  const strings = [""], sIdx = new Map([["", 0]]);
  const si = s => { s = s || ""; if (!sIdx.has(s)) { sIdx.set(s, strings.length); strings.push(s); } return sIdx.get(s); };
  const E = S.graph.edges, geo = packGeometry(S);
  const ring = r => { const o = []; for (const [lo, la] of r) o.push(e7(lo), e7(la)); return delta(o); };
  return {
    version: 1, meta: S.meta, reports: S.reports, strings, geometry: geo,
    basemap: { ...S.basemap, parks: S.basemap.parks.map(delta), water: S.basemap.water.map(delta), lines: S.basemap.lines.map(([k, f]) => [k, delta(f)]) },
    graph: {
      nodeIdx: delta(S.graph.nodeIdx), nodeOsmId: delta(S.graph.nodeOsmId), stats: S.graph.stats,
      u: E.map(e => e.u), v: E.map(e => e.v), flags: E.map(e => e.flags), way: delta(E.map(e => e.way)),
      hw: E.map(e => si(e.highway)), nm: E.map(e => si(e.name)), layer: E.map(e => e.layer), inc: E.map(e => si(e.incline)),
    },
    dests: S.dests.map(d => ({ ...d, lon: e7(d.lon), lat: e7(d.lat), area: Math.round(d.area), poly: d.poly ? { outer: d.poly.outer.map(ring), inner: d.poly.inner.map(ring) } : null })),
  };
}

export function unpackState(o) {
  if (o.version !== 1) throw new Error("versión de estado desconocida");
  const { nodes, graph: { edges: ge } } = unpackGeometry(o.geometry);
  const G = o.graph, s = o.strings, way = undelta(G.way);
  const edges = ge.map((g, k) => ({ u: G.u[k], v: G.v[k], geom: g.geom, len: g.len, flags: G.flags[k], way: way[k],
    highway: s[G.hw[k]], name: s[G.nm[k]], structure: g.structure, layer: G.layer[k], incline: s[G.inc[k]] }));
  const nodeIdx = undelta(G.nodeIdx);
  const graph = { nodeIdx, nodeOsmId: undelta(G.nodeOsmId), stats: G.stats, edges,
    lon: Float64Array.from(nodeIdx, i => nodes.lon[i]), lat: Float64Array.from(nodeIdx, i => nodes.lat[i]) };
  const unring = r => { const a = undelta(r), out = []; for (let i = 0; i < a.length; i += 2) out.push([a[i] / 1e7, a[i + 1] / 1e7]); return out; };
  const dests = o.dests.map(d => ({ ...d, lon: d.lon / 1e7, lat: d.lat / 1e7, poly: d.poly ? { outer: d.poly.outer.map(unring), inner: d.poly.inner.map(unring) } : null }));
  const B = o.basemap, basemap = { ...B, parks: B.parks.map(undelta), water: B.water.map(undelta), lines: B.lines.map(([k, f]) => [k, undelta(f)]) };
  return { meta: o.meta, reports: o.reports, basemap, nodes, graph, dests };
}

// Alturas muestreadas: enteros en cm sobre 500 m (−32768 = sin dato), diferencias con signo en varint zigzag.
export function encodeZ(z) {
  const out = new Uint8Array(z.length * 3 + 16); let o = 0, prev = 0;
  const put = v => { v = v >= 0 ? 2 * v : -2 * v - 1; while (v >= 128) { out[o++] = (v & 127) | 128; v = Math.floor(v / 128); } out[o++] = v; };
  put(z.length);
  for (let i = 0; i < z.length; i++) { const q = z[i] === z[i] ? Math.round((z[i] - 500) * 100) : -32768; put(q - prev); prev = q; }
  return out.slice(0, o);
}
export function decodeZ(b) {
  let p = 0;
  const get = () => { let v = 0, m = 1, c; do { c = b[p++]; v += (c & 127) * m; m *= 128; } while (c & 128); return v % 2 ? -(v + 1) / 2 : v / 2; };
  const n = get(), z = new Float32Array(n); let q = 0;
  for (let i = 0; i < n; i++) { q += get(); z[i] = q === -32768 ? NaN : q / 100 + 500; }
  return z;
}

// gzip con las API de flujo (Node ≥ 18 y navegadores actuales)
export async function gzip(bytes) { return pipe(bytes, new CompressionStream("gzip")); }
export async function gunzip(bytes) { return pipe(bytes, new DecompressionStream("gzip")); }
async function pipe(bytes, ts) {
  const w = ts.writable.getWriter(); w.write(bytes); w.close();
  return new Uint8Array(await new Response(ts.readable).arrayBuffer());
}
export const enc = s => new TextEncoder().encode(s), dec = b => new TextDecoder().decode(b);
