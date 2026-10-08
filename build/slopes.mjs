// Etapa 2: perfiles longitudinales sobre la geometría de cada tramo y pendientes.
// Se separan dos usos:
//  · tiempo: cada trozo de 2 m se recorre a la velocidad de Tobler según su pendiente en el sentido de la marcha;
//  · barrera: pendiente máxima medida sobre ventanas de 10 m (la escala de las rampas de la Orden TMA/851/2021,
//    que admite tramos de hasta 9 m) y con un ajuste por mínimos cuadrados para no amplificar el ruido del modelo.
import { utm30 } from "./geo.mjs";

export const SLOPE_PARAMS = {
  step: 2,            // m entre muestras del perfil (el modelo usado tiene celdas de 2 m)
  window: 10,         // m: longitud de la ventana sobre la que se mide la pendiente
  perp: 3,            // m a cada lado para detectar muros o calles a distinta cota
  stepJump: 0.5,      // m: salto entre muestras consecutivas (2 m) que delata un escalón o un muro (25 %)
  crossJump: 1.5,     // m de diferencia entre ±3 m en perpendicular (25 % transversal): borde de muro o talud
  thresholds: [0.04, 0.06, 0.08, 0.10, 0.12],   // umbrales que ofrece la página; los tramos se parten donde cambia la clase
  minPiece: 6,        // m: trozos más cortos se unen al vecino de clase mayor (criterio conservador)
};
export const Q = { STRUCTURE: 1, DISCONTINUITY: 2, MISSING: 4, LAYER: 8 };
export const ORIGIN = [430000, 4460000];   // origen de las coordenadas UTM relativas (Float32 con precisión de mm)

// función de Tobler relativa al llano (1 en llano y bajadas suaves; <1 subiendo o bajando fuerte)
export const tobler = s => Math.min(1, Math.exp(-3.5 * (Math.abs(s + 0.05) - 0.05)));

// ---------------------------------------------------------------- plan de muestreo

export function samplePlan(graph, osm, P = SLOPE_PARAMS) {
  const { lon, lat } = osm.nodes, utm = new Map();
  const U = i => { let v = utm.get(i); if (!v) { v = utm30(lon[i], lat[i]); utm.set(i, v); } return v; };
  const xy = [], plan = [];
  graph.edges.forEach((e, ei) => {
    if (e.structure) { plan.push(null); return; }
    const pts = e.geom.map(U), cum = [0];
    for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
    const Lu = cum[cum.length - 1] || 1e-9, L = e.len, sc = Lu / L;   // posiciones en metros de e.len
    const at = s => {   // punto y dirección a la distancia s (puede salirse por los extremos: prolongación recta)
      const su = s * sc; let k = 1; while (k < cum.length - 1 && cum[k] < su) k++;
      const a = pts[k - 1], b = pts[k], seg = (cum[k] - cum[k - 1]) || 1e-9, t = (su - cum[k - 1]) / seg;
      const dx = (b[0] - a[0]) / seg, dy = (b[1] - a[1]) / seg;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, dx, dy];
    };
    let s0 = 0, s1 = L;
    if (L < P.window) { s0 = -(P.window - L) / 2; s1 = L + (P.window - L) / 2; }   // tramos cortos: ventana prolongada
    const pos = []; for (let s = s0; s < s1 - 1e-6; s += P.step) pos.push(s); pos.push(s1);
    if (L < P.window) { if (!pos.some(s => Math.abs(s) < 1e-6)) pos.push(0); if (!pos.some(s => Math.abs(s - L) < 1e-6)) pos.push(L); pos.sort((a, b) => a - b); }
    const base = xy.length / 2, perpIdx = [];
    for (const s of pos) { const [x, y] = at(s); xy.push(x - ORIGIN[0], y - ORIGIN[1]); }
    // muestras perpendiculares cada dos muestras dentro del tramo
    pos.forEach((s, k) => {
      if (s < -1e-6 || s > L + 1e-6 || k % 2) return;
      const [x, y, dx, dy] = at(s); const nx = -dy, ny = dx;
      perpIdx.push([k, xy.length / 2]); xy.push(x + nx * P.perp - ORIGIN[0], y + ny * P.perp - ORIGIN[1], x - nx * P.perp - ORIGIN[0], y - ny * P.perp - ORIGIN[1]);
    });
    plan.push({ base, pos, perpIdx });
  });
  return { xy: Float32Array.from(xy), plan };
}

// ---------------------------------------------------------------- métricas

function lsSlope(s, z, i0, i1) {   // pendiente por mínimos cuadrados de z(s) en [i0, i1]
  let n = 0, ms = 0, mz = 0;
  for (let i = i0; i <= i1; i++) if (z[i] === z[i]) { n++; ms += s[i]; mz += z[i]; }
  if (n < 3) return NaN; ms /= n; mz /= n;
  let num = 0, den = 0;
  for (let i = i0; i <= i1; i++) if (z[i] === z[i]) { num += (s[i] - ms) * (z[i] - mz); den += (s[i] - ms) ** 2; }
  return den > 0 ? num / den : NaN;
}

// z: elevaciones de todas las muestras (NaN = sin dato). Devuelve trozos (tramos partidos) y alturas de nodos.
export function computeSlopes(graph, osm, sp, z, P = SLOPE_PARAMS) {
  const E = graph.edges, nN = graph.lon.length;
  const nodeZ = new Float64Array(nN).fill(NaN), known = new Uint8Array(nN);
  // 1) perfiles de los tramos sobre el terreno
  const prof = E.map((e, ei) => {
    const p = sp.plan[ei]; if (!p) return null;
    const s = p.pos, zz = s.map((_, k) => z[p.base + k]);
    const L = e.len, inR = k => s[k] >= -1e-6 && s[k] <= L + 1e-6;
    const k0 = s.findIndex(v => Math.abs(v) < 1e-6), k1 = s.findIndex(v => Math.abs(v - L) < 1e-6);
    if (zz[k0] === zz[k0]) { nodeZ[e.u] = zz[k0]; known[e.u] = 1; }
    if (zz[k1] === zz[k1]) { nodeZ[e.v] = zz[k1]; known[e.v] = 1; }
    // discontinuidades: salto entre muestras consecutivas o fuerte desnivel transversal
    const disc = new Uint8Array(s.length);
    for (let k = 1; k < s.length; k++) if (zz[k] === zz[k] && zz[k - 1] === zz[k - 1] && Math.abs(zz[k] - zz[k - 1]) / Math.max(s[k] - s[k - 1], 1e-6) * P.step > P.stepJump) { disc[k] = disc[k - 1] = 1; }
    for (const [k, j] of p.perpIdx) { const a = z[j], b = z[j + 1]; if (a === a && b === b && Math.abs(a - b) > P.crossJump) { disc[k] = 1; if (k + 1 < s.length) disc[k + 1] = 1; if (k > 0) disc[k - 1] = 1; } }
    // pendiente en cada muestra (ventana de P.window m, encajada dentro de las muestras disponibles)
    const g = new Float64Array(s.length).fill(NaN), smin = s[0], smax = s[s.length - 1];
    for (let k = 0; k < s.length; k++) {
      if (!inR(k)) continue;
      let a = s[k] - P.window / 2, b = s[k] + P.window / 2;
      if (a < smin) { b += smin - a; a = smin; } if (b > smax) { a -= b - smax; b = smax; } a = Math.max(a, smin);
      let i0 = k, i1 = k; while (i0 > 0 && s[i0 - 1] >= a - 1e-6) i0--; while (i1 < s.length - 1 && s[i1 + 1] <= b + 1e-6) i1++;
      g[k] = lsSlope(s, zz, i0, i1);
    }
    return { s, zz, g, disc, inR };
  });
  // 2) nodos de estructuras (puentes, túneles, interiores): interpolación armónica sobre la red desde los nodos con terreno
  const adj = Array.from({ length: nN }, () => []);
  E.forEach(e => { adj[e.u].push([e.v, e.len]); adj[e.v].push([e.u, e.len]); });
  const free = []; for (let i = 0; i < nN; i++) if (!known[i]) free.push(i);
  for (let it = 0; it < 500 && free.length; it++) {
    let maxd = 0;
    for (const i of free) {
      let sw = 0, sz = 0; for (const [j, L] of adj[i]) if (nodeZ[j] === nodeZ[j]) { const w = 1 / Math.max(L, 1); sw += w; sz += w * nodeZ[j]; }
      if (sw > 0) { const nz = sz / sw; if (nodeZ[i] === nodeZ[i]) maxd = Math.max(maxd, Math.abs(nz - nodeZ[i])); nodeZ[i] = nz; }
    }
    if (it > 20 && maxd < 0.005) break;
  }
  // 3) trozos
  const pieces = [];   // { edge, a, b (m), gmax, tf, tb, q }
  const nThr = g => { let c = 0; for (const t of P.thresholds) if (Math.abs(g) > t) c++; return c; };
  E.forEach((e, ei) => {
    const L = e.len, layerQ = e.layer && !e.structure ? Q.LAYER : 0;
    const pr = prof[ei];
    if (!pr) {   // estructura: perfil recto entre sus extremos interpolados
      const dz = nodeZ[e.v] - nodeZ[e.u], ok = dz === dz;
      const gg = ok ? dz / Math.max(L, 1) : NaN;
      pieces.push({ edge: ei, a: 0, b: L, gmax: ok ? Math.abs(gg) : NaN, tf: ok ? 1 / tobler(gg) : 1, tb: ok ? 1 / tobler(-gg) : 1, q: Q.STRUCTURE | (ok ? 0 : Q.MISSING) });
      return;
    }
    const { s, g, disc, inR } = pr;
    const idx = []; for (let k = 0; k < s.length; k++) if (inR(k)) idx.push(k);
    // tiempo e incertidumbre por intervalos entre muestras
    const iv = [];   // [a, b, gmid, disc, missing]
    for (let n = 1; n < idx.length; n++) {
      const k = idx[n - 1], k2 = idx[n], gm = (g[k] + g[k2]) / 2;
      iv.push({ a: Math.max(0, s[k]), b: Math.min(L, s[k2]), g: gm, gk: [g[k], g[k2]], disc: disc[k] || disc[k2], miss: !(gm === gm), cls: Math.max(nThr(g[k] === g[k] ? g[k] : 0), nThr(g[k2] === g[k2] ? g[k2] : 0)) });
    }
    if (!iv.length) iv.push({ a: 0, b: L, g: NaN, gk: [NaN, NaN], disc: 0, miss: true, cls: 0 });
    // trozos de clase constante (las escaleras no se parten: su paso lo decide la casilla de escaleras)
    let runs = [];
    for (const v of iv) {
      const cls = e.flags & 1 ? 0 : v.cls, last = runs[runs.length - 1];
      if (last && last.cls === cls) { last.b = v.b; last.iv.push(v); } else runs.push({ a: v.a, b: v.b, cls, iv: [v] });
    }
    // unir trozos cortos al vecino de clase mayor
    let changed = true;
    while (changed && runs.length > 1) {
      changed = false;
      for (let r = 0; r < runs.length; r++) {
        if (runs[r].b - runs[r].a >= P.minPiece) continue;
        const left = runs[r - 1], right = runs[r + 1];
        const into = !left ? right : !right ? left : (left.cls >= right.cls ? left : right);
        into.cls = Math.max(into.cls, runs[r].cls);
        if (into === left) { left.b = runs[r].b; left.iv.push(...runs[r].iv); } else { right.a = runs[r].a; right.iv.unshift(...runs[r].iv); }
        runs.splice(r, 1); changed = true;
        // fusiona vecinos que hayan quedado con la misma clase
        for (let t = runs.length - 1; t > 0; t--) if (runs[t].cls === runs[t - 1].cls) { runs[t - 1].b = runs[t].b; runs[t - 1].iv.push(...runs[t].iv); runs.splice(t, 1); }
        break;
      }
    }
    for (const r of runs) {
      let gmax = 0, any = false, tfN = 0, tbN = 0, len = 0, dsc = 0, miss = 0;
      for (const v of r.iv) {
        const d = v.b - v.a; len += d;
        for (const gk of v.gk) if (gk === gk) { gmax = Math.max(gmax, Math.abs(gk)); any = true; }
        if (v.miss) { tfN += d; tbN += d; miss += d; } else { tfN += d / tobler(v.g); tbN += d / tobler(-v.g); }
        if (v.disc) dsc += d;
      }
      const q = layerQ | (dsc > 0 ? Q.DISCONTINUITY : 0) | (miss > 0.5 * len ? Q.MISSING : 0);
      pieces.push({ edge: ei, a: r.a, b: r.b, gmax: any ? gmax : NaN, tf: len > 0 ? tfN / len : 1, tb: len > 0 ? tbN / len : 1, q });
    }
  });
  return { pieces, nodeZ, prof };
}

// ---------------------------------------------------------------- partir la red

// Parte cada arista en sus trozos, con nodos nuevos en los cortes. Conserva longitudes, conexiones y geometría.
export function splitGraph(graph, osm, res) {
  const { lon, lat } = osm.nodes, E = graph.edges;
  const nlon = Array.from(graph.lon), nlat = Array.from(graph.lat), nz = Array.from(res.nodeZ), nOsm = [...graph.nodeOsmId];
  const out = [];
  const byEdge = new Map(); for (const p of res.pieces) (byEdge.get(p.edge) || byEdge.set(p.edge, []).get(p.edge)).push(p);
  E.forEach((e, ei) => {
    const ps = byEdge.get(ei).sort((x, y) => x.a - y.a);
    const coords = e.geom.map(i => [lon[i], lat[i]]);
    if (ps.length === 1) { out.push({ ...e, coords, gmax: ps[0].gmax, tf: ps[0].tf, tb: ps[0].tb, q: ps[0].q, src: ei, a: 0, b: e.len }); return; }
    // longitudes acumuladas (haversine, como e.len)
    const cum = [0]; for (let k = 1; k < coords.length; k++) cum.push(cum[k - 1] + hav(coords[k - 1], coords[k]));
    const sc = e.len / (cum[cum.length - 1] || 1);
    const pointAt = s => { const su = s / sc; let k = 1; while (k < cum.length - 1 && cum[k] < su) k++; const t = (su - cum[k - 1]) / ((cum[k] - cum[k - 1]) || 1e-9); return [coords[k - 1][0] + (coords[k][0] - coords[k - 1][0]) * t, coords[k - 1][1] + (coords[k][1] - coords[k - 1][1]) * t, k]; };
    const pr = res.prof[ei];
    const zAt = s => { if (!pr) return NaN; let k = 1; while (k < pr.s.length - 1 && pr.s[k] < s) k++; const t = (s - pr.s[k - 1]) / ((pr.s[k] - pr.s[k - 1]) || 1e-9); return pr.zz[k - 1] + (pr.zz[k] - pr.zz[k - 1]) * t; };
    let prevNode = e.u;
    ps.forEach((p, n) => {
      let endNode;
      if (n === ps.length - 1) endNode = e.v;
      else { const [x, y] = pointAt(p.b); endNode = nlon.length; nlon.push(x); nlat.push(y); nz.push(zAt(p.b)); nOsm.push(0); }
      const [, , ka] = pointAt(p.a), [, , kb] = pointAt(p.b);
      const startPt = n === 0 ? coords[0] : pointAt(p.a).slice(0, 2), endPt = n === ps.length - 1 ? coords[coords.length - 1] : pointAt(p.b).slice(0, 2);
      const mid = []; for (let k = ka; k < kb; k++) if (cum[k] * sc > p.a + 1e-6 && cum[k] * sc < p.b - 1e-6) mid.push(coords[k]);
      out.push({ ...e, u: prevNode, v: endNode, len: p.b - p.a, coords: [startPt, ...mid, endPt], gmax: p.gmax, tf: p.tf, tb: p.tb, q: p.q, src: ei, a: p.a, b: p.b });
      prevNode = endNode;
    });
  });
  return { lon: nlon, lat: nlat, z: nz, nodeOsmId: nOsm, edges: out };
}
function hav(a, b) { const R = 6371009, r = Math.PI / 180, p1 = a[1] * r, p2 = b[1] * r; const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((b[0] - a[0]) * r / 2) ** 2; return 2 * R * Math.asin(Math.min(1, Math.sqrt(h))); }
