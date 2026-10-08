// Utilidades geográficas (sin dependencias). Distancias en metros.
export const R_EARTH = 6371009;   // radio medio, el mismo que usa OSMnx
const RAD = Math.PI / 180;

export function haversine(lon1, lat1, lon2, lat2) {
  const p1 = lat1 * RAD, p2 = lat2 * RAD, dp = p2 - p1, dl = (lon2 - lon1) * RAD;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

// lon/lat (ETRS89 ≈ WGS84) -> UTM zona 30N (EPSG:25830), serie de Krüger (error < 1 mm en Madrid)
export function utm30(lon, lat) {
  const a = 6378137, f = 1 / 298.257222101, k0 = 0.9996, lon0 = -3 * RAD;
  const n = f / (2 - f), A = a / (1 + n) * (1 + n * n / 4 + n ** 4 / 64);
  const al1 = n / 2 - 2 * n * n / 3 + 5 * n ** 3 / 16, al2 = 13 * n * n / 48 - 3 * n ** 3 / 5, al3 = 61 * n ** 3 / 240;
  const e = Math.sqrt(f * (2 - f)), phi = lat * RAD, lam = lon * RAD - lon0;
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - e * Math.atanh(e * Math.sin(phi)));
  const xi = Math.atan(t / Math.cos(lam)), eta = Math.atanh(Math.sin(lam) / Math.sqrt(1 + t * t));
  const x = eta + al1 * Math.cos(2 * xi) * Math.sinh(2 * eta) + al2 * Math.cos(4 * xi) * Math.sinh(4 * eta) + al3 * Math.cos(6 * xi) * Math.sinh(6 * eta);
  const y = xi + al1 * Math.sin(2 * xi) * Math.cosh(2 * eta) + al2 * Math.sin(4 * xi) * Math.cosh(4 * eta) + al3 * Math.sin(6 * xi) * Math.cosh(6 * eta);
  return [500000 + k0 * A * x, k0 * A * y];
}

// caja alrededor de un punto con el mismo criterio que osmnx.utils_geo.bbox_from_point
export function bboxFromPoint(lat, lon, dist) {
  const dLat = dist / R_EARTH / RAD, dLon = dist / (R_EARTH * Math.cos(lat * RAD)) / RAD;
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];   // [oeste, sur, este, norte]
}

// proyección local equirectangular (metros) alrededor de una latitud de referencia
export function localProj(lat0) {
  const kx = Math.cos(lat0 * RAD) * RAD * R_EARTH, ky = RAD * R_EARTH;
  return { kx, ky, x: lon => lon * kx, y: lat => lat * ky };
}

// área (m²) con signo de un anillo [[lon,lat],...] en proyección local
export function ringArea(ring, P) {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (P.x(ring[j][0]) * P.y(ring[i][1]) - P.x(ring[i][0]) * P.y(ring[j][1]));
  return s / 2;
}
export function ringCentroid(ring, P) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const x0 = P.x(ring[j][0]), y0 = P.y(ring[j][1]), x1 = P.x(ring[i][0]), y1 = P.y(ring[i][1]), c = x0 * y1 - x1 * y0;
    a += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c;
  }
  if (Math.abs(a) < 1e-9) { const m = ring.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]); return [m[0] / ring.length, m[1] / ring.length]; }
  return [cx / (3 * a) / P.kx, cy / (3 * a) / P.ky];
}
export function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// polígono = { outer: [anillos], inner: [anillos] }
export function pointInPolygon(lon, lat, poly) {
  if (!poly.outer.some(r => pointInRing(lon, lat, r))) return false;
  return !poly.inner.some(r => pointInRing(lon, lat, r));
}
export function polygonArea(poly, P) {
  return poly.outer.reduce((s, r) => s + Math.abs(ringArea(r, P)), 0) - poly.inner.reduce((s, r) => s + Math.abs(ringArea(r, P)), 0);
}

// une vías en anillos cerrados (multipolígonos). Devuelve los anillos cerrados; ignora los que no cierran.
export function assembleRings(lines) {
  const rings = [], open = lines.filter(l => l.length >= 2).map(l => l.slice());
  const key = p => p[0].toFixed(7) + "," + p[1].toFixed(7);
  while (open.length) {
    let cur = open.pop();
    let guard = 0;
    while (key(cur[0]) !== key(cur[cur.length - 1]) && guard++ < 10000) {
      const end = key(cur[cur.length - 1]);
      let k = open.findIndex(l => key(l[0]) === end || key(l[l.length - 1]) === end);
      if (k < 0) break;
      let nxt = open.splice(k, 1)[0];
      if (key(nxt[0]) !== end) nxt = nxt.slice().reverse();
      cur = cur.concat(nxt.slice(1));
    }
    if (cur.length >= 4 && key(cur[0]) === key(cur[cur.length - 1])) rings.push(cur);
  }
  return rings;
}

// distancia de un punto (metros locales) a un segmento; devuelve [distancia, t (0..1)]
export function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx, qy = ay + t * dy; return [Math.hypot(px - qx, py - qy), t];
}

// Douglas-Peucker sobre [lon,lat] con tolerancia en grados (como shapely.simplify en el original)
export function simplifyDP(pts, tol) {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(); let md = -1, mi = -1;
    for (let i = a + 1; i < b; i++) { const [d] = distToSeg(pts[i][0], pts[i][1], pts[a][0], pts[a][1], pts[b][0], pts[b][1]); if (d > md) { md = d; mi = i; } }
    if (md > tol) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
