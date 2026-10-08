// Proceso completo de generación de los datos de la página. Los mismos módulos funcionan en Node ≥ 18 (línea de
// órdenes, al final de este fichero) y en el navegador.
//   1. OSM: red peatonal, destinos, duplicados, bocas de metro, zonas verdes y mapa base → estado intermedio
//   2. Elevación: perfil cada 2 m sobre la geometría real de cada tramo con el MDT 2025 del Ayuntamiento de Madrid
//   3. Pendientes, partición de la red, enganche de destinos y escritura de ficheros (data/ y data/audit/)
import { readOSM, buildWalkGraph, buildPolygons, buildDestinations, findDuplicates, greenClass, linkEntrances, buildBasemap,
  segmentIndex, attachDestinations, CATS, RULES } from "./osm_build.mjs";
import { samplePlan, computeSlopes, splitGraph, SLOPE_PARAMS, Q, ORIGIN } from "./slopes.mjs";
import { sampleMadridMDT } from "./dem_madrid.mjs";
import { encodeGraph, encodeDestinations, csv, GREEN_CLASSES } from "./write.mjs";
import { bboxFromPoint } from "./geo.mjs";
import { packState, unpackState, gzip, enc } from "./state.mjs";

export const CONFIG = {
  center: [40.4169, -3.7035],   // Puerta del Sol
  radius: 7000,                 // m: caja de 14 × 14 km (mismo criterio que osmnx.utils_geo.bbox_from_point)
  marginDeg: 0.01,              // nodos que se leen fuera de la caja para no cortar vías ni polígonos
  pbf: { url: "https://download.geofabrik.de/europe/spain/madrid-261006.osm.pbf", md5: "ad4f40446f40f6ec7e279eb90215d133" },
  mdt: {
    dataset: "SPA_28079_SERVICIO_MDT_MOSAICO_2025",
    url: "https://geoportal.madrid.es/fsdescargas/IDEAM_WBGEOPORTAL/ELEVACIONES/2025/MDT/MOSAICO/MDT_1m.zip",
    level: 1,                   // resolución reducida de 2 m dentro del COG de 1 m
    bytes: 1516568778, lastModified: "2025-10-15T12:21:37Z",
  },
};
const KEEP_TAGS = ["name", "amenity", "shop", "leisure", "railway", "highway", "public_transport", "station", "subway", "train", "light_rail",
  "wheelchair", "access", "garden:type", "healthcare", "healthcare:speciality", "dispensing", "isced:level", "school", "operator", "operator:type",
  "playground", "landuse", "building", "opening_hours", "entrance"];

async function sha256hex(bytes) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(h, b => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------- etapa 1
export async function stage1(bytes, inflate, cfg = CONFIG, log = () => {}) {
  const bbox = bboxFromPoint(cfg.center[0], cfg.center[1], cfg.radius), c = { bbox, marginDeg: cfg.marginDeg };
  const t0 = Date.now();
  const osm = await readOSM(bytes, inflate, c); log(`OSM leído en ${Date.now() - t0} ms`);
  const graph = buildWalkGraph(osm, c); log(`red: ${graph.edges.length} tramos, ${graph.stats.km.toFixed(1)} km`);
  const polys = buildPolygons(osm);
  const all = buildDestinations(osm, polys, c);
  const dup = findDuplicates(all);
  all.forEach((d, i) => { if (dup.dupOf[i] >= 0) { d.dropped = "duplicado"; d.dupOf = all[dup.dupOf[i]].osm; } });
  const live = all.filter(d => !d.dropped);
  const ent = linkEntrances(live, osm);
  for (const d of live) if (d.mergedInto) d.dropped = "estación repetida";
  for (const d of all) if (d.cat === "green") d.greenClass = greenClass(d);
  const basemap = buildBasemap(osm, polys, graph, c); log("destinos y mapa base listos");
  // tabla de nodos reducida a la geometría de la red
  const used = new Map(), nlon = [], nlat = [];
  const ix = i => { let k = used.get(i); if (k === undefined) { k = nlon.length; used.set(i, k); nlon.push(osm.nodes.lon[i]); nlat.push(osm.nodes.lat[i]); } return k; };
  for (const e of graph.edges) e.geom = e.geom.map(ix);
  const nodeIdx = graph.nodeOsmIdx.map(ix);
  // informes
  const byType = {};
  for (const d of all) {
    const k = d.cat + "/" + d.sub, r = byType[k] || (byType[k] = { cat: d.cat, sub: d.sub, node: 0, way: 0, relation: 0, polygon: 0, dropped_duplicate: 0, dropped_station: 0, kept: 0 });
    r[{ n: "node", w: "way", r: "relation" }[d.osm[0]]]++; if (d.poly) r.polygon++;
    if (d.dropped === "duplicado") r.dropped_duplicate++; else if (d.dropped) r.dropped_station++; else r.kept++;
  }
  const greenCount = {}; for (const d of all) if (d.cat === "green" && !d.dropped) greenCount[d.greenClass] = (greenCount[d.greenClass] || 0) + 1;
  const ek = { steps: 0, steps_ramp: 0, bridge: 0, tunnel: 0, indoor: 0, layer: 0, incline: 0 };
  for (const e of graph.edges) { if (e.flags & 1) ek.steps++; if (e.flags & 8) ek.steps_ramp++; if (e.structure) ek[e.structure]++; if (e.layer && !e.structure) ek.layer++; if (e.incline) ek.incline++; }
  const S = {
    meta: { created: new Date().toISOString(), config: cfg, bbox,
      osm: { bytes: bytes.length, sha256: await sha256hex(bytes), timestamp: osm.info.timestamp ? new Date(osm.info.timestamp * 1000).toISOString() : null, replicationUrl: osm.info.replicationUrl || null } },
    reports: { graph: { ...graph.stats, edgeKinds: ek }, destTypes: Object.values(byType), duplicates: dup.reasons, entrances: ent, greenClasses: greenCount,
      rules: RULES, precedence: "railway=station|halt|tram_stop → railway=subway_entrance|train_station_entrance → amenity=bench → shop → amenity (salud) → amenity (educación) → leisure → amenity (comer) → highway=bus_stop" },
    nodes: { lon: Float64Array.from(nlon), lat: Float64Array.from(nlat) },
    graph: { nodeIdx, nodeOsmId: graph.nodeOsmId, stats: graph.stats, edges: graph.edges },
    basemap,
    dests: all.map(d => {
      const tags = {}; for (const k of KEEP_TAGS) if (d.tags[k] !== undefined) tags[k] = d.tags[k];
      const o = { osm: d.osm, cat: d.cat, sub: d.sub, lon: d.lon, lat: d.lat, name: d.name, area: d.area, tags };
      for (const k of ["partial", "dropped", "dupOf", "mergedInto", "greenClass", "wc", "station", "stype", "stationByDistance"]) if (d[k] !== undefined && d[k] !== "" && d[k] !== false) o[k] = d[k];
      if (d.poly && !d.dropped) o.poly = d.poly;
      return o;
    }),
  };
  return packState(S);
}

// ---------------------------------------------------------------- etapa 2: puntos de muestreo
export function planFor(state) { return samplePlan(state.graph, { nodes: state.nodes }); }

export async function sampleElevation(state, cfg = CONFIG, opts = {}) {
  const sp = planFor(state);
  const r = await sampleMadridMDT(cfg.mdt.url, sp.xy, ORIGIN, { level: cfg.mdt.level, ...opts });
  return { z: r.z, meta: r.meta };
}

// ---------------------------------------------------------------- etapa 3
export function stage3(state, z, demMeta, cfg = CONFIG, P = SLOPE_PARAMS) {
  const osmLike = { nodes: state.nodes };
  const sp = samplePlan(state.graph, osmLike, P);
  if (z.length !== sp.xy.length / 2) throw new Error(`alturas: ${z.length} muestras, se esperaban ${sp.xy.length / 2}`);
  const res = computeSlopes(state.graph, osmLike, sp, z, P);
  const split = splitGraph(state.graph, osmLike, res);
  // destinos
  const live = state.dests.filter(d => !d.dropped);
  const seg = segmentIndex(split, null);
  const attach = attachDestinations(live, split, null, seg);
  // nombres de calles y parques
  const names = [""], nIdx = new Map([["", 0]]);
  const ni = s => { s = s || ""; if (!nIdx.has(s)) { nIdx.set(s, names.length); names.push(s); } return nIdx.get(s); };
  const graphBin = encodeGraph(split, ni, state.basemap.lines);
  const subs = [...new Set(live.map(d => d.sub))].sort();
  const pois = encodeDestinations(live, CATS, subs, i => i);
  const date = (state.meta.osm.timestamp || "").slice(0, 10);
  const extra = {
    v: 4, date, bbox: state.meta.bbox, start: cfg.center, names,
    parks: state.basemap.parks, water: state.basemap.water,
    parkLabels: state.basemap.labels.map(l => [Math.round(l.lon * 1e5), Math.round(l.lat * 1e5), ni(l.name)]),
    slope: { thresholds: P.thresholds.map(t => Math.round(t * 100)), window_m: P.window, step_m: P.step, minPiece_m: P.minPiece, quality: Q },
    sources: { osm: { url: cfg.pbf.url, timestamp: state.meta.osm.timestamp, sha256: state.meta.osm.sha256 }, mdt: { dataset: cfg.mdt.dataset, url: cfg.mdt.url, level: cfg.mdt.level, resolution_m: demMeta && demMeta.resolution_m } },
  };
  // informes de etapa 3
  const rep = slopeReport(state, split, res, z, sp);
  rep.attach = attach;
  const snapD = live.filter(d => d.snap).map(d => d.snap[0][2]).sort((a, b) => a - b);
  rep.attach.snapDistance_m = { p50: snapD[snapD.length >> 1], p90: snapD[Math.floor(snapD.length * 0.9)], max: snapD[snapD.length - 1] };
  const report = { meta: state.meta, dem: demMeta || null, slopeParams: P, stage1: state.reports, stage3: rep,
    output: { nodes: split.lon.length, edges: split.edges.length, pois: live.length } };
  const auditFiles = auditTables(state, live, split);
  return { files: { "graph.bin": graphBin, "extra.json": enc(JSON.stringify(extra)), "pois.json": enc(JSON.stringify(pois)) }, report, audit: auditFiles, split, res, sp, live };
}

function slopeReport(state, split, res, z, sp) {
  const km = { total: 0 }, cls = {}, qkm = { structure: 0, discontinuity: 0, missing: 0, layer: 0 };
  for (const e of split.edges) {
    const L = e.len / 1000; km.total += L;
    if (e.flags & 1) { cls.steps = (cls.steps || 0) + L; continue; }
    const g = e.gmax, k = g !== g ? "unknown" : g <= 0.04 ? "0-4" : g <= 0.06 ? "4-6" : g <= 0.08 ? "6-8" : g <= 0.10 ? "8-10" : g <= 0.12 ? "10-12" : ">12";
    cls[k] = (cls[k] || 0) + L;
    if (e.q & Q.STRUCTURE) qkm.structure += L; if (e.q & Q.DISCONTINUITY) qkm.discontinuity += L; if (e.q & Q.MISSING) qkm.missing += L; if (e.q & Q.LAYER) qkm.layer += L;
  }
  const L0 = state.graph.edges.reduce((s, e) => s + e.len, 0), L1 = split.edges.reduce((s, e) => s + e.len, 0);
  let nan = 0; for (let i = 0; i < z.length; i++) if (z[i] !== z[i]) nan++;
  const round = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 100) / 100]));
  return { km_by_class: round(cls), km_flagged: round(qkm), km_total: Math.round(km.total * 100) / 100,
    length_before_m: Math.round(L0 * 1000) / 1000, length_after_m: Math.round(L1 * 1000) / 1000,
    edges_before: state.graph.edges.length, edges_after: split.edges.length, samples: z.length, samples_missing: nan };
}

function auditTables(state, live, split) {
  const types = csv(state.reports.destTypes.map(r => ({ ...r, rule: ruleText(r.cat, r.sub) })), ["cat", "sub", "rule", "node", "way", "relation", "polygon", "dropped_duplicate", "dropped_station", "kept"]);
  const dups = csv(state.reports.duplicates, ["cat", "sub", "keep", "drop", "dist_m", "why"]);
  const how = {}; for (const d of live) { const k = d.cat + "/" + d.sub, r = how[k] || (how[k] = { cat: d.cat, sub: d.sub, entrances: 0, snap: 0, none: 0, snap_p50_m: [], snap_gt50: 0 });
    if (d.entrances) r.entrances++; else if (d.snap) { r.snap++; r.snap_p50_m.push(d.snap[0][2]); if (d.snap[0][2] > 50) r.snap_gt50++; } else r.none++; }
  const attach = csv(Object.values(how).map(r => { const a = r.snap_p50_m.sort((x, y) => x - y); return { ...r, snap_p50_m: a.length ? a[a.length >> 1] : "" }; }),
    ["cat", "sub", "entrances", "snap", "none", "snap_p50_m", "snap_gt50"]);
  return { "services_types.csv": types, "services_duplicates.csv": dups, "services_attachment.csv": attach };
}
function ruleText(cat, sub) {
  if (cat === "station") return `railway=${sub}`;
  if (cat === "entrance") return `railway=${sub}`;
  if (cat === "bench") return "amenity=bench";
  if (cat === "bus") return "highway=bus_stop";
  const r = RULES[cat]; return r ? `${r[0]}=${sub}` : "";
}

// ---------------------------------------------------------------- escritura
export async function writeOutputs(out, write) {
  for (const [name, bytes] of Object.entries(out.files)) await write("data/" + name + ".gz", await gzip(bytes));
  await write("data/audit/build_report.json", enc(JSON.stringify(out.report, null, 1)));
  for (const [name, text] of Object.entries(out.audit)) await write("data/audit/" + name, enc(text));
}
