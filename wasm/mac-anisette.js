// Mac anisette in the browser (or Node): Apple's Mac CoreADI (x86_64, from the
// iTunes 12.8.3 installer) runs under Unicorn's interpreter compiled to wasm
// (dist/mac_adi.mjs, built by ../build-wasm.sh from this crate's C API). Ports
// omnisette's mac_libraries.rs + mac_anisette.rs.
//
// Networking and storage are injected so the page can route Apple's hosts
// through whatever transport it has (libcurl.js over a Wisp relay in a browser):
//   http.get(url, headers) / http.post(url, body, headers) -> Promise<Uint8Array>
//   http.range(url, start, length) -> Promise<Uint8Array> (raw bytes, no gzip)
//   storage.get(key) -> Promise<Uint8Array|string|null>, storage.set(key, value)
import * as plist from "plist";
import createModule from "./dist/mac_adi.mjs";

const LIBRARY_SHA256 = "2eafc3c79c7f41a8afbfbeaaf23ee5dab5ad5bda55ec8e54dbc0ddf1d20ce630";
const PAYLOAD_SHA256 = "8a6c068c95036326eb2d2885fa60912ed0f7229d0939ae92934a70a3bb6cf025";
export const ITUNES_URL =
  "https://secure-appldnld.apple.com/itunes12/041-56365-20210413-79A5AC6D-6B0A-46EC-B399-5A381183E3BE/iTunes12.8.3.dmg";
const OFFSET = 184_678_769;
const LENGTH = 3_471_595;
const FRAMEWORK = "System/Library/PrivateFrameworks/CoreADI.framework/Versions/A/CoreADI";
const LOOKUP = "https://gsa.apple.com/grandslam/GsService2/lookup";
// What SideStore's on-device anisette sends; GSA only offers trusted-device 2FA to current macOS.
export const CLIENT_INFO = "<MacBookPro18,3> <Mac OS X;26.6;25F84> <com.apple.AuthKit/1 (com.apple.akd/1.0)>";
export const USER_AGENT = "AuthKit/1 (Macintosh; OS X 26.6) (com.apple.akd/1.0)";
const DSID = -2n;
const NOT_PROVISIONED = -2;

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const hexUpper = (bytes) => hex(bytes).toUpperCase();
const sha256 = async (bytes) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
const b64 = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const random = (n) => crypto.getRandomValues(new Uint8Array(n));

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function cpioFile(bytes, wanted) {
  const text = new TextDecoder();
  const octal = (start, end) => parseInt(text.decode(bytes.subarray(start, end)), 8);
  let offset = 0;
  while (offset + 76 <= bytes.length) {
    if (text.decode(bytes.subarray(offset, offset + 6)) !== "070707") break;
    const nameLength = octal(offset + 59, offset + 65);
    const size = octal(offset + 65, offset + 76);
    const nameStart = offset + 76;
    const dataStart = nameStart + nameLength;
    const name = text.decode(bytes.subarray(nameStart, dataStart - 1));
    if (name.replace(/^\.\//, "") === wanted) return bytes.subarray(dataStart, dataStart + size);
    if (name === "TRAILER!!!") break;
    offset = dataStart + size;
  }
  throw new Error(`${wanted} not in the installer payload`);
}

function x86_64Slice(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== 0xcafebabe) throw new Error("CoreADI is not a fat Mach-O");
  for (let i = 0, n = view.getUint32(4); i < n; i++) {
    const entry = 8 + i * 20;
    if (view.getUint32(entry) === 0x01000007) {
      const start = view.getUint32(entry + 8);
      return bytes.subarray(start, start + view.getUint32(entry + 12));
    }
  }
  throw new Error("CoreADI has no x86_64 slice");
}

/** The pinned CoreADI build, from storage or out of Apple's iTunes 12.8.3 installer (one 3.5 MB range). */
export async function coreAdi({ http, storage }) {
  const cached = await storage.get("coreadi");
  if (cached && (await sha256(cached)) === LIBRARY_SHA256) return cached;
  const payload = await http.range(ITUNES_URL, OFFSET, LENGTH);
  if (payload.length !== LENGTH || (await sha256(payload)) !== PAYLOAD_SHA256) {
    throw new Error("Apple did not return the expected CoreADI byte range");
  }
  const library = x86_64Slice(cpioFile(await gunzip(payload), FRAMEWORK)).slice();
  if ((await sha256(library)) !== LIBRARY_SHA256) throw new Error("CoreADI checksum mismatch");
  await storage.set("coreadi", library);
  return library;
}

/** The C API of dist/mac_adi.mjs, with buffers marshalled. */
class Adi {
  static async open(image, moduleOverrides = {}) {
    const m = await createModule(moduleOverrides);
    const adi = new Adi(m);
    const out = m._malloc(4);
    const ptr = adi.copyIn(image);
    adi.check(m._adi_open(ptr, image.length, out), "adi_open");
    m._free(ptr);
    adi.handle = m.HEAPU32[out >> 2];
    m._free(out);
    return adi;
  }
  constructor(m) {
    this.m = m;
  }
  copyIn(bytes) {
    const ptr = this.m._malloc(Math.max(bytes.length, 1));
    this.m.HEAPU8.set(bytes, ptr);
    return ptr;
  }
  lastError() {
    const cap = 1024;
    const buf = this.m._malloc(cap);
    this.m._adi_last_error(buf, cap);
    const text = this.m.UTF8ToString(buf);
    this.m._free(buf);
    return text;
  }
  check(status, op) {
    if (status === 0) return;
    const error = new Error(`${op}: ${this.lastError()} (${status})`);
    error.status = status;
    throw error;
  }
  // AdiBuf is { u8* ptr; size_t len } = 8 bytes on wasm32.
  takeBuf(at) {
    const ptr = this.m.HEAPU32[at >> 2];
    const len = this.m.HEAPU32[(at >> 2) + 1];
    const bytes = this.m.HEAPU8.slice(ptr, ptr + len);
    this.m._adi_buf_free(at); // by-value struct is passed as a pointer under wasm32's C ABI
    return bytes;
  }
  call(op, fn) {
    const scratch = this.m._malloc(64);
    this.m.HEAPU8.fill(0, scratch, scratch + 64);
    try {
      this.check(fn(scratch), op);
      return scratch;
    } catch (error) {
      this.m._free(scratch);
      throw error;
    }
  }
  setHostUuid(uuid) {
    const ptr = this.copyIn(uuid);
    try {
      this.check(this.m._adi_set_host_uuid(this.handle, ptr), "adi_set_host_uuid");
    } finally {
      this.m._free(ptr);
    }
  }
  storeImport(bytes) {
    const ptr = this.copyIn(bytes);
    try {
      this.check(this.m._adi_store_import(this.handle, ptr, bytes.length), "adi_store_import");
    } finally {
      this.m._free(ptr);
    }
  }
  storeExport() {
    const s = this.call("adi_store_export", (s) => this.m._adi_store_export(this.handle, s));
    const bytes = this.takeBuf(s);
    this.m._free(s);
    return bytes;
  }
  headers() {
    // scratch: mid AdiBuf @0, otp AdiBuf @8, routing u64 @16
    const s = this.call("adi_headers", (s) => this.m._adi_headers(this.handle, DSID, s, s + 8, s + 16));
    const mid = this.takeBuf(s);
    const otp = this.takeBuf(s + 8);
    const routing = new DataView(this.m.HEAPU8.buffer).getBigUint64(s + 16, true);
    this.m._free(s);
    return { mid, otp, routing };
  }
  provisioningBegin(spim) {
    const ptr = this.copyIn(spim);
    try {
      // scratch: cpim AdiBuf @0, session u32 @8
      const s = this.call("adi_provisioning_begin", (s) =>
        this.m._adi_provisioning_begin(this.handle, DSID, ptr, spim.length, s, s + 8),
      );
      const cpim = this.takeBuf(s);
      const session = this.m.HEAPU32[(s + 8) >> 2];
      this.m._free(s);
      return { cpim, session };
    } finally {
      this.m._free(ptr);
    }
  }
  provisioningFinish(session, ptm, tk, routing) {
    const p = this.copyIn(ptm);
    const t = this.copyIn(tk);
    try {
      this.check(
        this.m._adi_provisioning_finish(this.handle, DSID, session, p, ptm.length, t, tk.length, BigInt(routing)),
        "adi_provisioning_finish",
      );
    } finally {
      this.m._free(p);
      this.m._free(t);
    }
  }
}

const SERIAL_ALPHABET = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ";

async function loadIdentity(storage) {
  const saved = await storage.get("identity");
  if (saved) return JSON.parse(typeof saved === "string" ? saved : new TextDecoder().decode(saved));
  const identity = {
    hostUuid: b64(random(16)),
    deviceId: `00006000-${hexUpper(random(8))}`,
    localUserId: hexUpper(random(16)),
    serial: "C02" + [...random(9)].map((b) => SERIAL_ALPHABET[b % SERIAL_ALPHABET.length]).join(""),
  };
  await storage.set("identity", JSON.stringify(identity));
  return identity;
}

function identityHeaders(identity) {
  return {
    "X-Mme-Device-Id": identity.deviceId,
    "X-Apple-I-MD-LU": btoa(identity.localUserId),
    "X-Apple-I-SRL-NO": identity.serial,
    "X-Mme-Client-Info": CLIENT_INFO,
    "User-Agent": USER_AGENT,
    "X-Apple-I-Client-Time": new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    "X-Apple-I-TimeZone": "UTC",
    "X-Apple-Locale": "en_US",
  };
}

function provisionResponse(bytes) {
  const outer = plist.parse(new TextDecoder().decode(bytes));
  const response = outer?.Response;
  const code = response?.Status?.ec;
  if (code !== 0) throw new Error(`Apple refused Mac provisioning (${code}: ${response?.Status?.em ?? "no status"})`);
  return response;
}

const data = (response, key) => {
  const value = response[key];
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return unb64(value);
  if (value?.buffer) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new Error(`Apple provisioning reply has no ${key}`);
};

const request = (body) => plist.build({ Header: {}, Request: body });

export class MacAnisette {
  /** @param options {{ http, storage, moduleOverrides? }} */
  static async open(options) {
    const image = await coreAdi(options);
    const identity = await loadIdentity(options.storage);
    const adi = await Adi.open(image, options.moduleOverrides);
    adi.setHostUuid(unb64(identity.hostUuid));
    const store = await options.storage.get("store");
    if (store?.length) adi.storeImport(store instanceof Uint8Array ? store : unb64(store));
    return new MacAnisette(adi, identity, options);
  }

  constructor(adi, identity, { http, storage }) {
    this.adi = adi;
    this.identity = identity;
    this.http = http;
    this.storage = storage;
  }

  async save() {
    await this.storage.set("store", this.adi.storeExport());
  }

  async provision() {
    const headers = identityHeaders(this.identity);
    const lookup = plist.parse(new TextDecoder().decode(await this.http.get(LOOKUP, headers)));
    const start = lookup?.urls?.midStartProvisioning;
    const finish = lookup?.urls?.midFinishProvisioning;
    if (!start || !finish) throw new Error("Apple's lookup has no provisioning URLs");
    const post = { ...headers, "Content-Type": "text/x-xml-plist" };
    const spim = data(provisionResponse(await this.http.post(start, request({}), post)), "spim");
    const { cpim, session } = this.adi.provisioningBegin(spim);
    const reply = provisionResponse(await this.http.post(finish, request({ cpim: b64(cpim) }), post));
    const routing = Number(reply["X-Apple-I-MD-RINFO"]);
    if (!Number.isFinite(routing)) throw new Error("Apple's reply has no routing information");
    this.adi.provisioningFinish(session, data(reply, "ptm"), data(reply, "tk"), routing);
    await this.save();
  }

  /** A fresh set of anisette headers; provisions this machine with Apple first if needed. */
  async headers() {
    let result;
    try {
      result = this.adi.headers();
    } catch (error) {
      if (error.status !== NOT_PROVISIONED) throw error;
      await this.provision();
      result = this.adi.headers();
    }
    await this.save();
    return {
      ...identityHeaders(this.identity),
      "X-Apple-I-MD-M": b64(result.mid),
      "X-Apple-I-MD": b64(result.otp),
      "X-Apple-I-MD-RINFO": String(result.routing),
    };
  }
}
