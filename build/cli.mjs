// Línea de órdenes (Node ≥ 18). Ejemplos:
//   node build/cli.mjs --pbf madrid-261006.osm.pbf --mdt https://…/MDT_1m.zip --out .
//   node build/cli.mjs --pbf madrid-261006.osm.pbf --state-out estado.json.gz     (solo la etapa OSM)
//   node build/cli.mjs --state estado.json.gz --z alturas.bin.gz --z-meta alturas.json --out .
import { readFileSync, writeFileSync, mkdirSync, createReadStream } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { inflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { stage1, stage3, planFor, writeOutputs, CONFIG } from "./build.mjs";
import { sampleMadridMDT } from "./dem_madrid.mjs";
import { ORIGIN } from "./slopes.mjs";
import { unpackState, gzip, gunzip, enc, decodeZ, encodeZ } from "./state.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i++) { const s = process.argv[i]; if (s.startsWith("--")) { const nx = process.argv[i + 1]; args[s.slice(2)] = nx && !nx.startsWith("--") ? (i++, nx) : true; } }
const out = args.out || ".";
const write = (p, b) => { const f = join(out, p); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, b); console.log("escrito", f, b.length, "bytes"); };
const log = m => console.log(m);
const cfg = { ...CONFIG };
if (args.center) cfg.center = args.center.split(",").map(Number);
if (args.radius) cfg.radius = +args.radius;

let packed;
if (args.state) packed = JSON.parse(new TextDecoder().decode(await gunzip(new Uint8Array(readFileSync(args.state)))));
else if (args.pbf) {
  const bytes = new Uint8Array(readFileSync(args.pbf));
  const md5 = createHash("md5").update(bytes).digest("hex");
  if (md5 !== cfg.pbf.md5) console.warn(`aviso: md5 ${md5} distinto del documentado en CONFIG (${cfg.pbf.md5})`);
  packed = await stage1(bytes, async b => new Uint8Array(inflateSync(b)), cfg, log);
  packed.meta.osm.md5 = md5;
  if (args["state-out"]) write(args["state-out"], await gzip(enc(JSON.stringify(packed))));
} else {
  console.error("uso: node build/cli.mjs --pbf extracto.osm.pbf | --state estado.json.gz  [--mdt MDT_1m.zip|URL | --z alturas.bin.gz] [--out carpeta]");
  process.exit(1);
}
const state = unpackState(packed);
let z = null, demMeta = null;
if (args.z) {
  z = decodeZ(await gunzip(new Uint8Array(readFileSync(args.z))));
  demMeta = args["z-meta"] ? JSON.parse(readFileSync(args["z-meta"], "utf8")) : null;
} else if (args.mdt) {
  const local = !/^https?:/.test(args.mdt);
  const fetchImpl = local ? async () => new Response(Readable.toWeb(createReadStream(args.mdt))) : fetch;
  const r = await sampleMadridMDT(local ? "file:" + args.mdt : args.mdt, planFor(state).xy, ORIGIN, { level: cfg.mdt.level, fetchImpl,
    onProgress: p => log(`MDT: ${(p.zipBytes / 1e6).toFixed(0)} MB leídos, ${p.tilesDone}/${p.tilesNeeded} teselas`) });
  z = r.z; demMeta = r.meta;
  if (args["z-out"]) { write(args["z-out"], await gzip(encodeZ(z))); write(args["z-out"].replace(/\.bin\.gz$/, "") + ".json", enc(JSON.stringify(demMeta))); }
}
if (z) {
  const res = stage3(state, z, demMeta, cfg);
  await writeOutputs(res, write);
  console.log(JSON.stringify(res.report.stage3, null, 1));
}
