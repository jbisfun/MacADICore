// Node smoke test: node test-node.mjs <state-dir>   (NODE_EXTRA_CA_CERTS=<Apple Root CA pem>)
// Prints whether headers came back, never the OTP or machine ID.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { MacAnisette } from "./mac-anisette.js";

const dir = process.argv[2] ?? "./state";
mkdirSync(dir, { recursive: true });
const storage = {
  async get(key) { const p = `${dir}/${key}`; return existsSync(p) ? new Uint8Array(readFileSync(p)) : null; },
  async set(key, value) { writeFileSync(`${dir}/${key}`, value); },
};
const bytes = async (r) => { if (!r.ok) throw new Error(`HTTP ${r.status} ${r.url}`); return new Uint8Array(await r.arrayBuffer()); };
const http = {
  get: (url, headers) => fetch(url, { headers }).then(bytes),
  post: (url, body, headers) => fetch(url, { method: "POST", body, headers }).then(bytes),
  range: (url, start, length) =>
    fetch(url, { headers: { Range: `bytes=${start}-${start + length - 1}`, "Accept-Encoding": "identity" } }).then(bytes),
};
const t0 = Date.now();
const ani = await MacAnisette.open({ http, storage });
console.log(`opened in ${Date.now() - t0} ms`);
for (let i = 0; i < 2; i++) {
  const t = Date.now();
  const h = await ani.headers();
  console.log(`headers ${i}: MD ${h["X-Apple-I-MD"].length} chars, MD-M ${h["X-Apple-I-MD-M"].length} chars, RINFO ${h["X-Apple-I-MD-RINFO"]}, ${Date.now() - t} ms`);
}
