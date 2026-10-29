// Shared test helpers. Every fixture is built in memory here, so the tests need
// no sample files and run the same on any machine.
import JSZip from 'jszip';
import SparkMD5 from 'spark-md5';
import { buildTar, gzip, gunzip, parseTar, textBytes, bytesText } from '../src/tar.js';

// The browser build loads these from a CDN as globals; mirror that for Node.
globalThis.JSZip = JSZip;
globalThis.SparkMD5 = SparkMD5;

export { textBytes, bytesText };

// Shorthand: { 'path': 'text' | Uint8Array | { data, mode } } -> tar entries.
export function entries(spec) {
  return Object.entries(spec).map(([path, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Uint8Array)) {
      return { path, type: 'file', data: toBytes(v.data), mode: v.mode ?? 0o644 };
    }
    return { path, type: 'file', data: toBytes(v), mode: 0o644 };
  });
}

function toBytes(v) {
  return v instanceof Uint8Array ? v : textBytes(String(v ?? ''));
}

export async function tgz(spec) {
  return gzip(buildTar(entries(spec)));
}

export async function zip(spec) {
  const z = new JSZip();
  for (const [path, v] of Object.entries(spec)) z.file(path, toBytes(v));
  return z.generateAsync({ type: 'uint8array' });
}

// Folder input as the browser hands it over: [{ path, data }].
export function folder(spec) {
  return Object.entries(spec).map(([path, v]) => ({ path, data: toBytes(v) }));
}

// Unpack .hmod / .clvg bytes back into { path: { type, mode, text } }.
export async function unpack(bytes) {
  const out = {};
  for (const e of parseTar(await gunzip(bytes))) {
    out[e.path] = { type: e.type, mode: e.mode, text: e.type === 'file' ? bytesText(e.data) : null, size: e.data.length };
  }
  return out;
}

export const ids = (issues) => issues.map((i) => i.id);

export const readme = (fields, body = 'A test mod.') =>
  `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}\n`;

export const FULL_README = readme({ Name: 'Test Mod', Creator: 'tester', Category: 'Tweak', Version: '1.0.0' });

// Minimal 32-bit ELF headers, enough for the architecture check.
export function elf(machine) {
  const u8 = new Uint8Array(64);
  u8.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]);
  u8[18] = machine & 0xff;
  u8[19] = machine >> 8;
  return u8;
}
export const ELF_ARM = 40;
export const ELF_X86 = 3;

export const desktop = (code, exec, name = 'Test Game') =>
  `[Desktop Entry]\nType=Application\nExec=${exec}\nPath=/var/saves/${code}\nName=${name}\nIcon=/var/games/${code}/${code}.png\n\n[X-CLOVER Game]\nCode=${code}\n`;
