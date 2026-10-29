// Minimal ustar reader/writer plus gzip helpers built on the browser's
// CompressionStream (also available in Node 18+).

const enc = new TextEncoder();
const dec = new TextDecoder();

export function isGzip(u8) {
  return u8.length > 2 && u8[0] === 0x1f && u8[1] === 0x8b;
}
export function isZip(u8) {
  return u8.length > 3 && u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04;
}
export function looksLikeTar(u8) {
  return u8.length >= 512 && dec.decode(u8.subarray(257, 262)) === 'ustar';
}

async function streamThrough(u8, stream) {
  const out = new Response(new Blob([u8]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
export const gunzip = (u8) => streamThrough(u8, new DecompressionStream('gzip'));
export const gzip = (u8) => streamThrough(u8, new CompressionStream('gzip'));

function readStr(u8, off, len) {
  let end = off;
  while (end < off + len && u8[end] !== 0) end++;
  return dec.decode(u8.subarray(off, end));
}
function readOctal(u8, off, len) {
  const s = readStr(u8, off, len).trim();
  return s ? parseInt(s, 8) : 0;
}

// Returns [{path, type: 'file'|'dir'|'symlink', data, mode, linkname}]
export function parseTar(u8) {
  const entries = [];
  let off = 0;
  let longName = null;
  let paxPath = null;
  while (off + 512 <= u8.length) {
    const header = u8.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    let name = readStr(header, 0, 100);
    const mode = readOctal(header, 100, 8);
    const size = readOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] || 48);
    const linkname = readStr(header, 157, 100);
    const magic = readStr(header, 257, 6);
    const prefix = magic.startsWith('ustar') ? readStr(header, 345, 155) : '';
    if (prefix) name = prefix + '/' + name;
    const dataStart = off + 512;
    const data = u8.slice(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512;

    if (typeflag === 'L') { longName = readStr(data, 0, data.length); continue; }
    if (typeflag === 'x') {
      const m = dec.decode(data).match(/\d+ path=([^\n]*)\n/);
      if (m) paxPath = m[1];
      continue;
    }
    if (typeflag === 'g') continue;
    if (longName) { name = longName; longName = null; }
    if (paxPath) { name = paxPath; paxPath = null; }

    let type = 'file';
    if (typeflag === '5') type = 'dir';
    else if (typeflag === '2') type = 'symlink';
    else if (typeflag !== '0' && typeflag !== '\0' && typeflag !== '7') continue; // devices, hardlinks
    entries.push({ path: name, type, data: type === 'file' ? data : new Uint8Array(0), mode, linkname });
  }
  return entries;
}

function writeStr(buf, off, len, s) {
  const b = enc.encode(s);
  buf.set(b.subarray(0, len), off);
}
function writeOctal(buf, off, len, n) {
  writeStr(buf, off, len, n.toString(8).padStart(len - 1, '0') + '\0');
}

function splitUstar(path) {
  const bytes = enc.encode(path).length;
  if (bytes <= 100) return { name: path, prefix: '' };
  for (let i = path.length - 1; i > 0; i--) {
    if (path[i] !== '/') continue;
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (enc.encode(prefix).length <= 155 && enc.encode(name).length <= 100 && name) return { name, prefix };
  }
  return null;
}

function header({ path, type, size, mode, linkname, mtime }) {
  const h = new Uint8Array(512);
  const split = splitUstar(path);
  writeStr(h, 0, 100, split ? split.name : path.slice(0, 100));
  writeOctal(h, 100, 8, mode);
  writeOctal(h, 108, 8, 0); // uid root
  writeOctal(h, 116, 8, 0); // gid root
  writeOctal(h, 124, 12, size);
  writeOctal(h, 136, 12, mtime);
  h.fill(0x20, 148, 156);
  h[156] = (type === 'dir' ? '5' : type === 'symlink' ? '2' : '0').charCodeAt(0);
  if (linkname) writeStr(h, 157, 100, linkname);
  writeStr(h, 257, 6, 'ustar\0');
  writeStr(h, 263, 2, '00');
  writeStr(h, 265, 32, 'root');
  writeStr(h, 297, 32, 'root');
  if (split && split.prefix) writeStr(h, 345, 155, split.prefix);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  writeStr(h, 148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
  return { h, needsLong: !split };
}

// entries: [{path, type, data, mode, linkname}]; dirs need no trailing slash.
export function buildTar(entries, mtime = Math.floor(Date.UTC(2026, 0, 1) / 1000)) {
  const chunks = [];
  for (const e of entries) {
    const data = e.type === 'file' ? e.data : new Uint8Array(0);
    const path = e.type === 'dir' ? e.path.replace(/\/?$/, '/') : e.path;
    const meta = { path, type: e.type, size: data.length, mode: e.mode, linkname: e.linkname, mtime };
    const first = header(meta);
    if (first.needsLong) {
      const nameBytes = enc.encode(path + '\0');
      const lh = header({ path: '././@LongLink', type: 'file', size: nameBytes.length, mode: 0o644, mtime: 0 }).h;
      lh[156] = 'L'.charCodeAt(0);
      let sum = 0; lh.fill(0x20, 148, 156);
      for (let i = 0; i < 512; i++) sum += lh[i];
      writeStr(lh, 148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
      chunks.push(lh, pad(nameBytes));
    }
    chunks.push(first.h);
    if (data.length) chunks.push(pad(data));
  }
  chunks.push(new Uint8Array(1024));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function pad(data) {
  const size = Math.ceil(data.length / 512) * 512;
  if (size === data.length) return data;
  const out = new Uint8Array(size);
  out.set(data);
  return out;
}

export const textBytes = (s) => enc.encode(s);
export const bytesText = (u8) => dec.decode(u8);
