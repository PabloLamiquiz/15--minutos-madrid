import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { inflateSync } from "node:zlib";
import { stage1, stage3, writeOutputs, CONFIG, planFor } from "../build.mjs";
import { unpackState, gzip, gunzip, enc, dec, encodeZ, decodeZ, packGeometry, unpackGeometry } from "../state.mjs";
import { samplePlan, ORIGIN } from "../slopes.mjs";
import { utm30 } from "../geo.mjs";
const cfg = { ...CONFIG, center: [42.5065, 1.5218], radius: 2500 };
let t0 = Date.now();
const packed = await stage1(new Uint8Array(readFileSync(process.argv[2])), async b => new Uint8Array(inflateSync(b)), cfg, console.log);
const gz = await gzip(enc(JSON.stringify(packed)));
console.log("stage1", Date.now() - t0, "ms; state gz", gz.length, "bytes; geometry gz", (await gzip(enc(JSON.stringify(packed.geometry)))).length);
const state = unpackState(JSON.parse(dec(await gunzip(gz))));
// la geometría sola reproduce exactamente los puntos de muestreo
const sp = planFor(state), g2 = unpackGeometry(JSON.parse(JSON.stringify(packed.geometry)));
const sp2 = samplePlan(g2.graph, { nodes: g2.nodes });
let same = sp.xy.length === sp2.xy.length; for (let i = 0; same && i < sp.xy.length; i++) if (sp.xy[i] !== sp2.xy[i]) same = false;
console.log("samples", sp.xy.length / 2, "identical from geometry only:", same);
// DEM sintético: plano al 5 % hacia el este + muro de 3 m
const [cx] = utm30(1.5218, 42.5065);
const z = new Float32Array(sp.xy.length / 2);
for (let i = 0; i < z.length; i++) { const x = sp.xy[2 * i] + ORIGIN[0]; z[i] = 600 + 0.05 * (x - cx) * 0.2 + ((x - cx) > 300 ? 3 : 0); }
z[5] = NaN;
const zb = encodeZ(z), zgz = await gzip(zb), z2 = decodeZ(await gunzip(zgz));
let maxd = 0; for (let i = 0; i < z.length; i++) { if ((z[i] !== z[i]) !== (z2[i] !== z2[i])) maxd = Infinity; else if (z[i] === z[i]) maxd = Math.max(maxd, Math.abs(z[i] - z2[i])); }
console.log("z codec", zb.length, "bytes raw,", zgz.length, "gz; max abs err", maxd);
t0 = Date.now();
const out = stage3(state, z2, { resolution_m: 2 }, cfg);
console.log("stage3", Date.now() - t0, "ms", JSON.stringify(out.report.stage3));
const dir = process.argv[3] || "e2e";
await writeOutputs(out, (p, b) => { const f = join(dir, p); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, b); });
console.log(readFileSync(dir + "/data/audit/services_types.csv", "utf8").split("\n").slice(0, 8).join("\n"));
console.log(readFileSync(dir + "/data/audit/services_attachment.csv", "utf8").split("\n").slice(0, 8).join("\n"));
