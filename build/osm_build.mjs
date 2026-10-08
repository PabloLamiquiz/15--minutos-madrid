// Etapa 1: de un extracto .osm.pbf a la red peatonal, los destinos y las capas del mapa base.
// Todo el proceso es determinista: mismo fichero de entrada y mismos parámetros, misma salida.
import { haversine, localProj, ringCentroid, pointInPolygon, polygonArea, assembleRings, distToSeg, simplifyDP } from "./geo.mjs";
import { readPBF } from "./pbf.mjs";

// ---------------------------------------------------------------- reglas

// Filtro de vías peatonales: el mismo que OSMnx 2.x usa para network_type="walk".
const HW_EXCL = /abandoned|bus_guideway|construction|cycleway|motor|no|planned|platform|proposed|raceway|razed|rest_area|services/;
export function isWalkWay(t) {
  if (!t || !t.highway) return false;
  if (t.area && /yes/.test(t.area)) return false;
  if (t.access && /private/.test(t.access)) return false;
  if (HW_EXCL.test(t.highway)) return false;
  if (t.foot && /no/.test(t.foot)) return false;
  if (t.service && /private/.test(t.service)) return false;
  for (const k of ["sidewalk", "sidewalk:both", "sidewalk:left", "sidewalk:right"]) if (t[k] && /separate/.test(t[k])) return false;
  return true;
}
const MAJOR = new Set(["trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link", "tertiary", "tertiary_link"]);

// Por qué la superficie de una vía puede no coincidir con el terreno del modelo digital.
export function structureKind(t) {
  const yes = v => v && v !== "no";
  if (yes(t.bridge)) return "bridge";
  if (yes(t.tunnel) && t.tunnel !== "building_passage") return "tunnel";
  if (t.indoor === "yes" || t.location === "underground" || t.location === "overground") return "indoor";
  return null;
}
export function layerOf(t) { const L = parseFloat(t.layer); return Number.isFinite(L) ? L : 0; }

// Categorías de destinos (mismas etiquetas y misma prioridad que el proyecto original, con subtipos).
export const CATS = ["grocery", "health", "education", "green", "eating", "bench", "station", "bus", "entrance"];
export const RULES = {
  grocery: ["shop", ["supermarket", "convenience", "greengrocer", "bakery", "butcher"]],
  health: ["amenity", ["pharmacy", "doctors", "clinic", "hospital", "dentist"]],
  education: ["amenity", ["school", "kindergarten", "library"]],
  green: ["leisure", ["park", "garden", "playground"]],
  eating: ["amenity", ["cafe", "restaurant", "pub", "bar"]],
};
export function classify(t) {
  if (!t) return null;
  if (t.railway === "station" || t.railway === "halt" || t.railway === "tram_stop") return ["station", t.railway];
  if (t.railway === "subway_entrance" || t.railway === "train_station_entrance") return ["entrance", t.railway];
  if (t.amenity === "bench") return ["bench", "bench"];
  if (RULES.grocery[1].includes(t.shop)) return ["grocery", t.shop];
  if (RULES.health[1].includes(t.amenity)) return ["health", t.amenity];
  if (RULES.education[1].includes(t.amenity)) return ["education", t.amenity];
  if (RULES.green[1].includes(t.leisure)) return ["green", t.leisure];
  if (RULES.eating[1].includes(t.amenity)) return ["eating", t.amenity];
  if (t.highway === "bus_stop") return ["bus", "bus_stop"];
  return null;
}
export function stationType(t) {
  if (t.station === "subway" || t.subway === "yes") return "subway";
  if (t.station === "light_rail" || t.light_rail === "yes" || t.railway === "tram_stop") return "light_rail";
  if (t.station === "train" || t.train === "yes") return "train";
  return "other";
}

const KEEP_WAY_KEYS = ["highway", "leisure", "landuse", "natural", "waterway", "railway", "amenity", "shop", "public_transport", "man_made", "building"];
const AREA_LEISURE = new Set(["park", "garden", "playground", "pitch", "nature_reserve", "dog_park"]);
const GREEN_LANDUSE = new Set(["grass", "recreation_ground", "village_green", "forest", "meadow", "cemetery"]);
const GREEN_NATURAL = new Set(["wood", "scrub", "grassland", "heath"]);

// ---------------------------------------------------------------- lectura

export async function readOSM(bytes, inflate, cfg) {
  const [W, S, E, N] = cfg.bbox, m = cfg.marginDeg ?? 0.01;
  const ids = [], lat = [], lon = [], tagged = [];
  let lastId = -Infinity, sorted = true;
  const ways = [], rels = [];
  const idxOf = id => {   // búsqueda binaria en los ids de nodo guardados (el PBF viene ordenado)
    let a = 0, b = ids.length - 1;
    while (a <= b) { const c = (a + b) >> 1, v = ids[c]; if (v === id) return c; if (v < id) a = c + 1; else b = c - 1; }
    return -1;
  };
  const info = await readPBF(bytes, {
    node(id, la, lo, tags) {
      if (lo < W - m || lo > E + m || la < S - m || la > N + m) return;
      if (id <= lastId) sorted = false; lastId = id;
      ids.push(id); lat.push(la); lon.push(lo);
      if (tags && classify(tags)) tagged.push({ type: "n", id, lat: la, lon: lo, tags });
      else if (tags && (tags.public_transport || tags.entrance || tags.barrier)) tagged.push({ type: "n", id, lat: la, lon: lo, tags, aux: true });
    },
    way(id, refs, tags) {
      if (!sorted) throw new Error("el PBF no está ordenado por id; ordénalo con «osmium sort»");
      const idx = new Int32Array(refs.length); let any = false;
      for (let i = 0; i < refs.length; i++) { idx[i] = idxOf(refs[i]); if (idx[i] >= 0) any = true; }
      if (!any) return;
      const keep = tags && KEEP_WAY_KEYS.some(k => k in tags);
      ways.push({ id, idx, refs: refs.length > 0 ? [refs[0], refs[refs.length - 1]] : [], tags: keep ? tags : null });
    },
    relation(id, members, tags) {
      if (!tags) return;
      const mp = tags.type === "multipolygon" && (tags.leisure || tags.landuse || tags.natural || tags.waterway || tags.amenity || tags.shop || tags.railway);
      const sa = tags.public_transport === "stop_area";
      if (mp || sa) rels.push({ id, members, tags });
    }
  }, inflate);
  return { info, nodes: { ids, lat: Float64Array.from(lat), lon: Float64Array.from(lon) }, tagged, ways, rels, idxOf };
}

// ---------------------------------------------------------------- red peatonal

export function buildWalkGraph(osm, cfg) {
  const [W, S, E, N] = cfg.bbox, { lat, lon } = osm.nodes;
  const inBox = i => i >= 0 && lon[i] >= W && lon[i] <= E && lat[i] >= S && lat[i] <= N;
  const walk = osm.ways.filter(w => isWalkWay(w.tags));
  // nodos que son cruces: usados por más de una vía (o dos veces por la misma) o extremos de vía
  const use = new Map();
  const bump = i => use.set(i, (use.get(i) || 0) + 1);
  const runs = [];   // tramos continuos de cada vía dentro de la caja
  for (const w of walk) {
    let cur = [];
    for (let k = 0; k < w.idx.length; k++) {
      const i = w.idx[k];
      if (inBox(i)) cur.push(i); else { if (cur.length >= 2) runs.push({ w, nodes: cur }); cur = []; }
    }
    if (cur.length >= 2) runs.push({ w, nodes: cur });
  }
  for (const r of runs) for (const i of r.nodes) bump(i);
  const isEnd = new Set();
  for (const r of runs) { isEnd.add(r.nodes[0]); isEnd.add(r.nodes[r.nodes.length - 1]); }
  for (const [i, c] of use) if (c >= 2) isEnd.add(i);
  // aristas entre cruces consecutivos
  const edges = [];
  for (const r of runs) {
    const t = r.w.tags; let start = 0;
    for (let k = 1; k < r.nodes.length; k++) {
      if (!isEnd.has(r.nodes[k])) continue;
      const geom = r.nodes.slice(start, k + 1);
      if (geom[0] !== geom[geom.length - 1]) edges.push(makeEdge(r.w, geom, osm));
      else if (geom.length > 3) {   // anillo con un solo cruce: se parte en dos para no perderlo
        const mid = Math.floor(geom.length / 2);
        edges.push(makeEdge(r.w, geom.slice(0, mid + 1), osm), makeEdge(r.w, geom.slice(mid), osm));
      }
      start = k;
    }
  }
  // componente conexa principal (como OSMnx con retain_all=False)
  const parent = new Map(); const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for (const e of edges) for (const v of [e.u, e.v]) if (!parent.has(v)) parent.set(v, v);
  for (const e of edges) { const a = find(e.u), b = find(e.v); if (a !== b) parent.set(a, b); }
  const size = new Map(); for (const v of parent.keys()) { const r = find(v); size.set(r, (size.get(r) || 0) + 1); }
  let best = null, bestN = -1; for (const [r, n] of size) if (n > bestN) { best = r; bestN = n; }
  const kept = edges.filter(e => find(e.u) === best);
  // solo se quitan duplicados exactos (misma secuencia de nodos); las aristas paralelas distintas se conservan
  const byKey = new Map();
  for (const e of kept) {
    const seq = e.geom[0] < e.geom[e.geom.length - 1] ? e.geom : [...e.geom].reverse();
    const k = seq.join(","); if (!byKey.has(k)) byKey.set(k, e);
  }
  const final = [...byKey.values()];
  // renumerar nodos
  const nodeIdx = new Map(), nodes = [];
  for (const e of final) for (const v of [e.u, e.v]) if (!nodeIdx.has(v)) { nodeIdx.set(v, nodes.length); nodes.push(v); }
  for (const e of final) { e.u = nodeIdx.get(e.u); e.v = nodeIdx.get(e.v); }
  return {
    nodeOsmIdx: nodes, lon: Float64Array.from(nodes, i => lon[i]), lat: Float64Array.from(nodes, i => lat[i]),
    nodeOsmId: nodes.map(i => osm.nodes.ids[i]), edges: final,
    stats: { walkWays: walk.length, edgesBefore: edges.length, kmBefore: edges.reduce((a, e) => a + e.len, 0) / 1000, kmMain: kept.reduce((a, e) => a + e.len, 0) / 1000, km: final.reduce((a, e) => a + e.len, 0) / 1000, edgesMainComponent: kept.length, edges: final.length, nodes: nodes.length, componentShare: kept.length / edges.length }
  };
}

function makeEdge(w, geom, osm) {
  const t = w.tags, { lat, lon } = osm.nodes; let len = 0;
  for (let k = 1; k < geom.length; k++) len += haversine(lon[geom[k - 1]], lat[geom[k - 1]], lon[geom[k]], lat[geom[k]]);
  const steps = t.highway === "steps";
  const ramp = steps && (t["ramp:wheelchair"] === "yes" || t["ramp:stroller"] === "yes" && t["ramp:wheelchair"] === "yes");
  const flags = (steps ? 1 : 0) | (MAJOR.has(t.highway) ? 2 : 0) | (structureKind(t) ? 4 : 0) | (steps && t["ramp:wheelchair"] === "yes" ? 8 : 0);
  return { u: geom[0], v: geom[geom.length - 1], geom, len, flags, way: w.id, highway: t.highway, name: t.name || "",
    structure: structureKind(t), layer: layerOf(t), incline: t.incline || "" };
}

// ---------------------------------------------------------------- polígonos

function wayCoords(w, osm) {
  const out = []; for (const i of w.idx) if (i >= 0) out.push([osm.nodes.lon[i], osm.nodes.lat[i]]);
  return out;
}
function isClosed(w) { return w.refs.length === 2 && w.refs[0] === w.refs[1] && w.idx.length >= 4 && [...w.idx].every(i => i >= 0); }

export function buildPolygons(osm) {
  const byId = new Map(osm.ways.map(w => [w.id, w]));
  const polys = [];   // { type, id, tags, poly:{outer,inner} }
  for (const w of osm.ways) {
    if (!w.tags || !isClosed(w)) continue;
    polys.push({ type: "w", id: w.id, tags: w.tags, poly: { outer: [wayCoords(w, osm)], inner: [] } });
  }
  for (const r of osm.rels) {
    if (r.tags.type !== "multipolygon") continue;
    const outerL = [], innerL = []; let complete = true;
    for (const mb of r.members) {
      if (mb.type !== "w") continue;
      const w = byId.get(mb.ref); if (!w) { complete = false; continue; }
      const c = wayCoords(w, osm); if (c.length !== w.idx.length) complete = false;
      (mb.role === "inner" ? innerL : outerL).push(c);
    }
    const outer = assembleRings(outerL), inner = assembleRings(innerL);
    if (outer.length) polys.push({ type: "r", id: r.id, tags: r.tags, poly: { outer, inner }, partial: !complete });
  }
  return polys;
}

// ---------------------------------------------------------------- destinos

export function buildDestinations(osm, polys, cfg) {
  const [W, S, E, N] = cfg.bbox, P = localProj((S + N) / 2);
  const inBox = (lo, la) => lo >= W && lo <= E && la >= S && la <= N;
  const out = [];
  const nameOf = t => (t.name || "").trim();
  for (const n of osm.tagged) {
    if (n.aux) continue;
    const c = classify(n.tags); if (!c || !inBox(n.lon, n.lat)) continue;
    out.push({ osm: "n" + n.id, cat: c[0], sub: c[1], lon: n.lon, lat: n.lat, name: nameOf(n.tags), tags: n.tags, poly: null, area: 0 });
  }
  for (const p of polys) {
    const c = classify(p.tags); if (!c) continue;
    const big = p.poly.outer.reduce((a, r) => (r.length > a.length ? r : a), p.poly.outer[0]);
    let [lo, la] = ringCentroid(big, P);
    if (!pointInPolygon(lo, la, p.poly)) { lo = big[0][0]; la = big[0][1]; }   // centroide fuera (forma en U): un vértice
    if (!inBox(lo, la)) continue;
    out.push({ osm: p.type + p.id, cat: c[0], sub: c[1], lon: lo, lat: la, name: nameOf(p.tags), tags: p.tags, poly: p.poly, area: polygonArea(p.poly, P), partial: !!p.partial });
  }
  // vías abiertas con etiqueta de destino (poco frecuente): punto medio
  for (const w of osm.ways) {
    if (!w.tags || isClosed(w)) continue;
    const c = classify(w.tags); if (!c || c[0] === "green") continue;
    const co = wayCoords(w, osm); if (!co.length) continue;
    const [lo, la] = co[Math.floor(co.length / 2)]; if (!inBox(lo, la)) continue;
    out.push({ osm: "w" + w.id, cat: c[0], sub: c[1], lon: lo, lat: la, name: nameOf(w.tags), tags: w.tags, poly: null, area: 0 });
  }
  return out;
}

// Duplicados: el mismo establecimiento cartografiado como nodo y como polígono, o dos veces.
// Hace falta la misma categoría y subtipo y, además, (a) un nodo dentro del polígono del otro, o
// (b) el mismo nombre normalizado a menos de 40 m. La proximidad sola no basta.
export function findDuplicates(dests) {
  const P = localProj(40.4), norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const cell = 50, grid = new Map(), key = (x, y) => Math.floor(x / cell) + ":" + Math.floor(y / cell);
  dests.forEach((d, i) => { d._x = P.x(d.lon); d._y = P.y(d.lat); const k = key(d._x, d._y); (grid.get(k) || grid.set(k, []).get(k)).push(i); });
  const dupOf = new Int32Array(dests.length).fill(-1), reasons = [];
  for (let i = 0; i < dests.length; i++) {
    const a = dests[i]; if (a.cat === "bench" || a.cat === "bus" || a.cat === "entrance") continue;
    const cx = Math.floor(a._x / cell), cy = Math.floor(a._y / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const j of grid.get((cx + dx) + ":" + (cy + dy)) || []) {
      if (j <= i || dupOf[j] >= 0 || dupOf[i] >= 0) continue;
      const b = dests[j]; if (a.cat !== b.cat || a.sub !== b.sub) continue;
      const d = Math.hypot(a._x - b._x, a._y - b._y);
      let why = null;
      const node = a.poly ? (b.poly ? null : b) : (b.poly ? a : null), polyD = node === a ? b : a;
      if (node && polyD.poly && pointInPolygon(node.lon, node.lat, polyD.poly) && (!node.name || !polyD.name || norm(node.name) === norm(polyD.name))) why = "nodo dentro del polígono";
      else if (a.name && b.name && norm(a.name) === norm(b.name) && d < 40) why = "mismo nombre a <40 m";
      if (!why) continue;
      // se conserva el elemento con más información (polígono o más etiquetas)
      const keepA = (a.poly ? 1 : 0) - (b.poly ? 1 : 0) || Object.keys(a.tags).length - Object.keys(b.tags).length;
      const drop = keepA >= 0 ? j : i, keep = drop === j ? i : j;
      dupOf[drop] = keep; reasons.push({ keep: dests[keep].osm, drop: dests[drop].osm, cat: a.cat, sub: a.sub, dist_m: Math.round(d), why });
    }
  }
  return { dupOf, reasons };
}

// Zonas verdes: tamaño y acceso. Umbral de 0,5 ha: tamaño mínimo de zona verde de la referencia de la OMS
// (WHO Regional Office for Europe, 2016). Lo que no se puede saber con los datos se deja «sin clasificar».
export function greenClass(d) {
  const t = d.tags, acc = t.access || "";
  if (d.sub === "playground") return /private|no|customers/.test(acc) ? "private" : "playground";
  if (/private|no|customers/.test(acc) || t["garden:type"] === "residential" || t["garden:type"] === "private") return "private";
  if (!d.poly) return d.sub === "park" ? "park_point" : "garden_point";
  return d.area >= 5000 ? "green_large" : "green_small";
}

// ---------------------------------------------------------------- estaciones y bocas de metro

export function linkEntrances(dests, osm) {
  const stations = dests.filter(d => d.cat === "station"), ents = dests.filter(d => d.cat === "entrance");
  const P = localProj(40.4), byOsm = new Map(dests.map(d => [d.osm, d]));
  for (const s of stations) { s.stype = stationType(s.tags); s.wc = s.tags.wheelchair || ""; }
  // mismas estaciones cartografiadas varias veces (nodo y área): mismo nombre y tipo a menos de 250 m
  const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  for (let i = 0; i < stations.length; i++) for (let j = i + 1; j < stations.length; j++) {
    const a = stations[i], b = stations[j]; if (a.mergedInto || b.mergedInto || !a.name || norm(a.name) !== norm(b.name) || a.stype !== b.stype) continue;
    if (Math.hypot(P.x(a.lon) - P.x(b.lon), P.y(a.lat) - P.y(b.lat)) < 250) { const drop = a.poly && !b.poly ? a : b; drop.mergedInto = (drop === a ? b : a).osm; }
  }
  const live = stations.filter(s => !s.mergedInto);
  // 1) relaciones stop_area: la boca pertenece a la estación de su misma relación
  let viaRel = 0, viaNear = 0, orphan = 0;
  const stOf = new Map();
  for (const r of osm.rels) {
    if (r.tags.public_transport !== "stop_area") continue;
    const memb = r.members.map(mb => byOsm.get(mb.type + mb.ref)).filter(Boolean);
    const st = memb.find(d => d.cat === "station" && !d.mergedInto && d.stype === "subway") || memb.find(d => d.cat === "station" && !d.mergedInto);
    if (!st) continue;
    for (const d of memb) if (d.cat === "entrance" && !stOf.has(d.osm)) stOf.set(d.osm, st.osm);
  }
  for (const e of ents) {
    e.wc = e.tags.wheelchair || "";
    if (stOf.has(e.osm)) { e.station = stOf.get(e.osm); viaRel++; continue; }
    // 2) si no está en ninguna relación: estación de metro más cercana a menos de 400 m
    let best = null, bd = 400;
    for (const s of live) { if (e.sub === "subway_entrance" && s.stype !== "subway") continue; const d = Math.hypot(P.x(s.lon) - P.x(e.lon), P.y(s.lat) - P.y(e.lat)); if (d < bd) { bd = d; best = s; } }
    if (best) { e.station = best.osm; e.stationByDistance = true; viaNear++; } else orphan++;
  }
  return { stations: live.length, merged: stations.length - live.length, entrances: ents.length, viaRel, viaNear, orphan };
}

// ---------------------------------------------------------------- mapa base

export function buildBasemap(osm, polys, graph, cfg) {
  const [W, S, E, N] = cfg.bbox, P = localProj((S + N) / 2), m = 0.02;
  const near = (lo, la) => lo >= W - m && lo <= E + m && la >= S - m && la <= N + m;
  const e5 = v => Math.round(v * 1e5);
  const flat = ring => { const s = simplifyDP(ring, 2e-5); const o = []; for (const [lo, la] of s) o.push(e5(lo), e5(la)); return o; };
  const parks = [], water = [], labels = [];
  for (const p of polys) {
    const t = p.tags;
    const green = AREA_LEISURE.has(t.leisure) || GREEN_LANDUSE.has(t.landuse) || GREEN_NATURAL.has(t.natural);
    const wat = t.natural === "water" || t.waterway === "riverbank" || t.landuse === "reservoir" || t.landuse === "basin";
    if (!green && !wat) continue;
    const big = p.poly.outer.reduce((a, r) => (r.length > a.length ? r : a), p.poly.outer[0]);
    const [cx, cy] = ringCentroid(big, P); if (!near(cx, cy)) continue;
    for (const r of p.poly.outer) (wat ? water : parks).push(flat(r));
    if (green && t.name && (t.leisure === "park" || t.leisure === "garden" || t.landuse === "recreation_ground")) labels.push({ name: t.name, area: polygonArea(p.poly, P), lon: cx, lat: cy, poly: p.poly });
  }
  labels.sort((a, b) => b.area - a.area);
  const lines = [];   // [tipo, [coords]] 1 autovía, 2 tren, 3 río
  for (const w of osm.ways) {
    const t = w.tags; if (!t) continue;
    const tunnel = t.tunnel && t.tunnel !== "no";
    let kind = 0;
    if (/^(motorway|motorway_link|trunk|trunk_link)$/.test(t.highway || "") && !tunnel) kind = 1;
    else if (/^(rail|light_rail)$/.test(t.railway || "") && !tunnel) kind = 2;
    else if (/^(river|canal)$/.test(t.waterway || "") && !tunnel) kind = 3;
    if (!kind) continue;
    const co = wayCoords(w, osm); if (co.length < 2) continue;
    lines.push([kind, flat(co)]);
  }
  return { parks, water, lines, labels: labels.slice(0, 120).map(l => {
    let lo = l.lon, la = l.lat; if (!pointInPolygon(lo, la, l.poly)) { const r = l.poly.outer[0]; lo = r[0][0]; la = r[0][1]; }
    return { name: l.name, lon: lo, lat: la };
  }) };
}

// ---------------------------------------------------------------- enganche a la red

// Rejilla de segmentos de la red (geometría completa) para buscar el punto de red más cercano.
// Acepta aristas con `geom` (índices de nodos OSM) o con `coords` ([lon, lat], red ya partida).
export function segmentIndex(graph, osm) {
  const P = localProj(40.4), cell = 25, grid = new Map(), segs = [];
  graph.edges.forEach((e, ei) => {
    let acc = 0; const pts = e.coords ? e.coords.map(([lo, la]) => [P.x(lo), P.y(la)]) : e.geom.map(i => [P.x(osm.nodes.lon[i]), P.y(osm.nodes.lat[i])]);
    let tot = 0; for (let k = 1; k < pts.length; k++) tot += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    const scale = tot > 0 ? e.len / tot : 1;   // posiciones en metros de la longitud oficial de la arista
    for (let k = 1; k < pts.length; k++) {
      const [ax, ay] = pts[k - 1], [bx, by] = pts[k], L = Math.hypot(bx - ax, by - ay);
      const s = segs.length; segs.push([ei, ax, ay, bx, by, acc * scale, L * scale]); acc += L;
      const x0 = Math.floor(Math.min(ax, bx) / cell), x1 = Math.floor(Math.max(ax, bx) / cell), y0 = Math.floor(Math.min(ay, by) / cell), y1 = Math.floor(Math.max(ay, by) / cell);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const k2 = x + ":" + y; (grid.get(k2) || grid.set(k2, []).get(k2)).push(s); }
    }
  });
  // las k aristas más cercanas a un punto, cada una con su proyección
  function nearest(lon, lat, k = 2, maxD = 150) {
    const px = P.x(lon), py = P.y(lat), best = new Map();
    for (let ring = 0; ring * cell <= maxD + cell; ring++) {
      const cx = Math.floor(px / cell), cy = Math.floor(py / cell);
      for (let dx = -ring; dx <= ring; dx++) for (let dy = -ring; dy <= ring; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        for (const s of grid.get((cx + dx) + ":" + (cy + dy)) || []) {
          const [ei, ax, ay, bx, by, off, L] = segs[s], [d, t] = distToSeg(px, py, ax, ay, bx, by);
          const cur = best.get(ei); if (d <= maxD && (!cur || d < cur.d)) best.set(ei, { e: ei, d, pos: off + t * L });
        }
      }
      const arr = [...best.values()].sort((a, b) => a.d - b.d);
      if (arr.length >= k && arr[k - 1].d <= ring * cell) return arr.slice(0, k);
    }
    return [...best.values()].sort((a, b) => a.d - b.d).slice(0, k);
  }
  return { nearest, P };
}

// Para cada destino: hasta dos puntos de red (arista + posición + distancia), o, en polígonos con
// caminos dentro (parques, recintos), los nodos de la red donde esos caminos cruzan el borde (entradas).
export function attachDestinations(dests, graph, osm, segIdx) {
  const inside = new Map();   // destino -> nodos interiores
  const polyDests = dests.filter(d => d.poly && (d.cat === "green" || d.area >= 2000));
  // nodos de la red dentro de cada polígono
  const P = segIdx.P, cell = 100, ngrid = new Map();
  for (let i = 0; i < graph.lon.length; i++) { const k = Math.floor(P.x(graph.lon[i]) / cell) + ":" + Math.floor(P.y(graph.lat[i]) / cell); (ngrid.get(k) || ngrid.set(k, []).get(k)).push(i); }
  for (const d of polyDests) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of d.poly.outer) for (const [lo, la] of r) { x0 = Math.min(x0, P.x(lo)); x1 = Math.max(x1, P.x(lo)); y0 = Math.min(y0, P.y(la)); y1 = Math.max(y1, P.y(la)); }
    const ins = new Set();
    for (let x = Math.floor(x0 / cell); x <= Math.floor(x1 / cell); x++) for (let y = Math.floor(y0 / cell); y <= Math.floor(y1 / cell); y++)
      for (const i of ngrid.get(x + ":" + y) || []) if (pointInPolygon(graph.lon[i], graph.lat[i], d.poly)) ins.add(i);
    if (ins.size) inside.set(d, ins);
  }
  const adj = new Map(); graph.edges.forEach(e => { (adj.get(e.u) || adj.set(e.u, []).get(e.u)).push(e.v); (adj.get(e.v) || adj.set(e.v, []).get(e.v)).push(e.u); });
  let viaEntr = 0, viaSnap = 0, none = 0;
  for (const d of dests) {
    const ins = inside.get(d);
    if (ins) {
      const entr = [...ins].filter(i => (adj.get(i) || []).some(j => !ins.has(j)));
      if (entr.length) { d.entrances = entr.slice(0, 64); viaEntr++; continue; }
    }
    // punto de enganche: desde el punto (nodos) o desde el vértice del borde más próximo a la red (polígonos)
    let pts = [[d.lon, d.lat]];
    if (d.poly) pts = d.poly.outer[0].filter((_, k, a) => a.length < 60 || k % Math.ceil(a.length / 60) === 0);
    let best = null;
    for (const [lo, la] of pts) { const c = segIdx.nearest(lo, la, 2, 150); if (c.length && (!best || c[0].d < best[0].d)) best = c; }
    if (best && best.length) { d.snap = best.map(c => [c.e, Math.round(c.pos * 10) / 10, Math.round(c.d * 10) / 10]); viaSnap++; } else none++;
  }
  return { viaEntr, viaSnap, none };
}
