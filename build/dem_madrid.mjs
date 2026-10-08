// Lectura del Modelo Digital del Terreno 2025 del Ayuntamiento de Madrid directamente desde su descarga
// oficial (MDT_1m.zip: un GeoTIFF «cloud optimized» de 1 m, BigTIFF, Float64, teselas de 128 px con deflate y
// pirámide de resoluciones). El zip no permite acceso aleatorio, así que se lee en flujo: se descomprime en orden,
// se toman solo las teselas del nivel pedido que tocan los puntos y se corta la descarga en cuanto están todas.
// En un COG las resoluciones reducidas van antes que la completa, así que el nivel de 2 m llega en el primer
// cuarto del fichero.
// Funciona en Node ≥ 18 y en el navegador (fetch + DecompressionStream).

const OFFSET_M = 500, NODATA16 = -32768;   // las alturas se guardan como Int16 en cm por encima de 500 m

async function inflateZlib(bytes) {
  const ds = new DecompressionStream("deflate"), w = ds.writable.getWriter();
  w.write(bytes); w.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

function parseBigTIFF(buf) {   // devuelve las IFD con las etiquetas necesarias (lanza RangeError si falta buffer)
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint16(0, true) !== 0x4949 || dv.getUint16(2, true) !== 43) throw new Error("se esperaba un BigTIFF little-endian");
  const u64 = o => Number(dv.getBigUint64(o, true));
  const SZ = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8, 16: 8, 17: 8 };
  const read = (type, count, off) => {
    const out = [];
    for (let i = 0; i < count; i++) {
      const o = off + i * SZ[type];
      out.push(type === 3 ? dv.getUint16(o, true) : type === 4 ? dv.getUint32(o, true) : type === 16 ? u64(o) : type === 12 ? dv.getFloat64(o, true) : type === 2 ? dv.getUint8(o) : type === 1 ? dv.getUint8(o) : NaN);
    }
    return out;
  };
  const ifds = []; let off = u64(8);
  while (off) {
    const n = u64(off), tags = {};
    for (let i = 0; i < n; i++) {
      const p = off + 8 + i * 20, tag = dv.getUint16(p, true), type = dv.getUint16(p + 2, true), count = u64(p + 4);
      const bytes = (SZ[type] || 1) * count, at = bytes <= 8 ? p + 12 : u64(p + 12);
      if ([256, 257, 258, 259, 317, 322, 323, 339].includes(tag)) tags[tag] = read(type, Math.min(count, 4), at)[0];
      else if (tag === 324 || tag === 325) tags[tag] = { type, count, at };
      else if (tag === 33550 || tag === 33922) tags[tag] = read(type, count, at);
      else if (tag === 42113) tags[tag] = new TextDecoder().decode(buf.subarray(at, at + count)).replace(/\0/g, "");
    }
    ifds.push({ W: tags[256], H: tags[257], bps: tags[258], comp: tags[259], pred: tags[317] || 1, tw: tags[322], th: tags[323], fmt: tags[339], offsets: tags[324], counts: tags[325], scale: tags[33550], tie: tags[33922], nodata: tags[42113] });
    off = u64(off + 8 + n * 20);
  }
  return { ifds, dv, read };
}

// Carga las teselas del nivel pedido que cubren unos puntos (xy: Float32Array UTM 30N relativa a `origin`)
// o un rectángulo UTM (`rect`: [x0, y0, x1, y1] absolutos). Devuelve { meta, sample(xy, origin) → Float32Array }.
export async function loadMadridMDT(url, { xy = null, origin = [0, 0], rect = null, level = 1, onProgress = () => {}, fetchImpl = fetch } = {}) {
  const resp = await fetchImpl(url);
  if (!resp.ok) throw new Error("MDT: " + resp.status);
  const net = resp.body.getReader();
  // cabecera local del zip
  let head = new Uint8Array(0), rawRead = 0;
  while (head.length < 30) { const { value, done } = await net.read(); if (done) throw new Error("zip vacío"); rawRead += value.length; head = cat(head, value); }
  const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (hv.getUint32(0, true) !== 0x04034b50 || hv.getUint16(8, true) !== 8) throw new Error("se esperaba un zip con deflate");
  const skip = 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
  while (head.length < skip) { const { value } = await net.read(); rawRead += value.length; head = cat(head, value); }
  const name = new TextDecoder().decode(head.subarray(30, 30 + hv.getUint16(26, true)));
  const first = head.subarray(skip);
  const raw = new ReadableStream({
    start(c) { if (first.length) c.enqueue(first); },
    async pull(c) { const { value, done } = await net.read(); if (done) c.close(); else { rawRead += value.length; c.enqueue(value); } },
    cancel() { net.cancel(); }
  });
  const tif = raw.pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  // 1) cabecera del TIFF y tablas de teselas
  let buf = new Uint8Array(0), bufStart = 0, pos = 0, info = null, lv = null, offs = null, cnts = null;
  while (!offs) {
    const { value, done } = await tif.read(); if (done) throw new Error("TIFF incompleto");
    buf = cat(buf, value); pos += value.length;
    try {
      info = info || parseBigTIFF(buf);
      lv = info.ifds[level];
      const needEnd = Math.max(lv.offsets.at + lv.offsets.count * 8, lv.counts.at + lv.counts.count * 8);
      if (needEnd <= buf.length) { offs = info.read(lv.offsets.type, lv.offsets.count, lv.offsets.at); cnts = info.read(lv.counts.type, lv.counts.count, lv.counts.at); }
    } catch (e) { if (!(e instanceof RangeError)) throw e; info = null; }
  }
  const base = info.ifds[0];
  if (lv.bps !== 64 || lv.fmt !== 3 || lv.comp !== 8 || lv.pred !== 1) throw new Error(`formato inesperado: ${JSON.stringify({ bps: lv.bps, fmt: lv.fmt, comp: lv.comp, pred: lv.pred })}`);
  const sx = base.scale[0], X0 = base.tie[3] - base.tie[0] * sx, Y0 = base.tie[4] + base.tie[1] * base.scale[1];
  const res = sx * base.W / lv.W, tilesX = Math.ceil(lv.W / lv.tw), tilesY = Math.ceil(lv.H / lv.th), nodata = base.nodata !== undefined ? parseFloat(base.nodata) : NaN;
  // 2) teselas necesarias
  const need = new Set();
  if (xy) {
    for (let i = 0; i < xy.length / 2; i++) {
      const fc = (xy[2 * i] + origin[0] - X0) / res - 0.5, fr = (Y0 - xy[2 * i + 1] - origin[1]) / res - 0.5, c = Math.floor(fc), r = Math.floor(fr);
      for (const [cc, rr] of [[c, r], [c + 1, r], [c, r + 1], [c + 1, r + 1]]) if (cc >= 0 && rr >= 0 && cc < lv.W && rr < lv.H) need.add(Math.floor(rr / lv.th) * tilesX + Math.floor(cc / lv.tw));
    }
  }
  if (rect) {
    const c0 = Math.max(0, Math.floor((rect[0] - X0) / res / lv.tw)), c1 = Math.min(tilesX - 1, Math.floor((rect[2] - X0) / res / lv.tw));
    const r0 = Math.max(0, Math.floor((Y0 - rect[3]) / res / lv.th)), r1 = Math.min(tilesY - 1, Math.floor((Y0 - rect[1]) / res / lv.th));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) need.add(r * tilesX + c);
  }
  const order = [...need].sort((a, b) => offs[a] - offs[b]);
  const tiles = new Map(); let k = 0, pending = [];
  const lastEnd = order.length ? offs[order[order.length - 1]] + cnts[order[order.length - 1]] : 0;
  // 3) lectura en flujo hasta la última tesela necesaria
  const take = (a, b) => buf.slice(a - bufStart, b - bufStart);
  const harvest = () => {
    while (k < order.length && offs[order[k]] + cnts[order[k]] <= pos) {
      const t = order[k++];
      if (!cnts[t]) continue;   // tesela vacía (fuera del ámbito del modelo)
      const bytes = take(offs[t], offs[t] + cnts[t]);
      pending.push(inflateZlib(bytes).then(d => {
        const f = new Float64Array(d.buffer, d.byteOffset, d.byteLength / 8), q = new Int16Array(f.length);
        for (let j = 0; j < f.length; j++) { const v = f[j]; q[j] = (v !== v || v === nodata || v < OFFSET_M - 50 || v > OFFSET_M + 327) ? NODATA16 : Math.round((v - OFFSET_M) * 100); }
        tiles.set(t, q);
      }));
    }
    // se descarta lo que ya no hace falta: el buffer guarda solo [bufStart, pos) desde la próxima tesela
    const next = k < order.length ? offs[order[k]] : pos;
    if (next > bufStart) {
      if (next >= pos) { buf = new Uint8Array(0); bufStart = pos; }
      else { buf = buf.slice(next - bufStart); bufStart = next; }
    }
  };
  harvest();
  let lastReport = 0;
  while (k < order.length) {
    const { value, done } = await tif.read(); if (done) break;
    buf = cat(buf, value); pos += value.length; harvest();
    if (pending.length > 64) { await Promise.all(pending); pending = []; }
    if (pos - lastReport > 20e6) { lastReport = pos; onProgress({ tiffBytes: pos, zipBytes: rawRead, tilesDone: k, tilesNeeded: order.length, lastEnd }); }
  }
  await Promise.all(pending);
  tif.cancel().catch(() => {});
  const meta = { file: name, level, resolution_m: res, origin_m: [X0, Y0], size_px: [lv.W, lv.H], tile_px: lv.tw, tilesNeeded: order.length, tilesRead: tiles.size,
    tiffBytesRead: pos, zipBytesRead: rawRead, nodata: base.nodata, quantization: "Int16, cm sobre 500 m" };
  // 4) muestreo bilineal
  const val = (c, r) => { if (c < 0 || r < 0 || c >= lv.W || r >= lv.H) return NaN; const q = tiles.get(Math.floor(r / lv.th) * tilesX + Math.floor(c / lv.tw)); if (!q) return NaN; const v = q[(r % lv.th) * lv.tw + (c % lv.tw)]; return v === NODATA16 ? NaN : v / 100 + OFFSET_M; };
  function sample(pts, org = [0, 0]) {
    const n = pts.length / 2, z = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const fc = (pts[2 * i] + org[0] - X0) / res - 0.5, fr = (Y0 - pts[2 * i + 1] - org[1]) / res - 0.5, c = Math.floor(fc), r = Math.floor(fr), dx = fc - c, dy = fr - r;
      const a = val(c, r), b = val(c + 1, r), cc = val(c, r + 1), d = val(c + 1, r + 1);
      z[i] = (a * (1 - dx) + b * dx) * (1 - dy) + (cc * (1 - dx) + d * dx) * dy;
    }
    return z;
  }
  return { meta, sample, tiles, grid: { X0, Y0, res, W: lv.W, H: lv.H, tw: lv.tw, th: lv.th, tilesX } };
}

// Atajo: alturas en los puntos xy (UTM relativa a `origin`). Devuelve { z: Float32Array (NaN = sin dato), meta }.
export async function sampleMadridMDT(url, xy, origin, opts = {}) {
  const m = await loadMadridMDT(url, { ...opts, xy, origin });
  return { z: m.sample(xy, origin), meta: m.meta };
}

function cat(a, b) { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; }
