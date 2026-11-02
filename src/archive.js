// ZIP and 7z packages. Hakchi2 CE accepts both: its Mod Hub extracts a module
// marked with an `extract` file (ModHubTabControl.cs, ArchiveTasks.ExtractArchive),
// and its game import opens .zip and .7z archives (AddGamesTask.cs).
//
// ZIP goes through JSZip. 7z goes through 7-Zip compiled to WebAssembly
// (7z-wasm, LGPL), which the page only loads the first time a 7z is opened.
import { bytesText } from './tar.js';

export const SEVEN_ZIP_VERSION = '1.2.0';
export const SEVEN_ZIP_BASE = `https://cdn.jsdelivr.net/npm/7z-wasm@${SEVEN_ZIP_VERSION}/`;

export function is7z(u8) {
  return u8.length > 6 && u8[0] === 0x37 && u8[1] === 0x7a && u8[2] === 0xbc && u8[3] === 0xaf && u8[4] === 0x27 && u8[5] === 0x1c;
}

// Package formats kept as they are instead of being repacked as tar.gz.
export const FORMATS = {
  zip: { ext: '.zip', label: 'ZIP' },
  '7z': { ext: '.7z', label: '7z' },
};
export const FORMAT_EXTENSIONS = Object.values(FORMATS).map((f) => f.ext);

export function formatFromFileName(fileName) {
  const lower = String(fileName || '').toLowerCase().split(/[?#]/)[0];
  for (const [id, f] of Object.entries(FORMATS)) if (lower.endsWith(f.ext)) return id;
  return null;
}

let loading = null;
function loadScript() {
  if (globalThis.SevenZip) return Promise.resolve();
  if (typeof document === 'undefined') return Promise.reject(new Error('7-Zip isn\'t available here.'));
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `${SEVEN_ZIP_BASE}7zz.umd.js`;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { loading = null; reject(new Error('7-Zip couldn\'t be loaded, so 7z archives can\'t be opened. Check the internet connection and try again.')); };
      document.head.appendChild(s);
    });
  }
  return loading;
}

// A fresh 7-Zip instance for each archive, so nothing is left over between them.
async function sevenZip() {
  await loadScript();
  const opts = { print() {}, printErr() {} };
  if (typeof document !== 'undefined') opts.locateFile = (p) => SEVEN_ZIP_BASE + p;
  return globalThis.SevenZip(opts);
}

function walk(FS, dir, prefix, out) {
  for (const name of FS.readdir(dir)) {
    if (name === '.' || name === '..') continue;
    const full = `${dir}/${name}`;
    const rel = prefix ? `${prefix}/${name}` : name;
    const st = FS.lstat(full);
    if (FS.isLink(st.mode)) out.push({ path: rel, type: 'symlink', data: new Uint8Array(0), mode: 0o777, linkname: FS.readlink(full) });
    else if (FS.isDir(st.mode)) {
      out.push({ path: rel, type: 'dir', mode: 0o755 });
      walk(FS, full, rel, out);
    } else out.push({ path: rel, type: 'file', data: FS.readFile(full), mode: null });
  }
  return out;
}

export async function read7z(u8, label = 'archive') {
  const sz = await sevenZip();
  sz.FS.writeFile('/in.7z', u8);
  sz.FS.mkdir('/out');
  const rc = sz.callMain(['x', '/in.7z', '-o/out', '-y', '-bso0', '-bsp0']);
  if (rc !== 0) throw new Error(`${label} is a damaged or password-protected 7z archive, so it can't be read.`);
  return walk(sz.FS, '/out', '', []);
}

function mkdirs(FS, path) {
  let cur = '';
  for (const seg of path.split('/')) {
    cur += '/' + seg;
    try { FS.mkdir(cur); } catch { /* already there */ }
  }
}

// entries: [{path, type, data, mode, linkname}] in the order they should appear.
export async function write7z(entries) {
  const sz = await sevenZip();
  const { FS } = sz;
  mkdirs(FS, 'pkg');
  for (const e of entries) {
    const full = `/pkg/${e.path}`;
    if (e.type === 'dir') { mkdirs(FS, `pkg/${e.path}`); continue; }
    const parent = e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/')) : '';
    if (parent) mkdirs(FS, `pkg/${parent}`);
    if (e.type === 'symlink') FS.symlink(e.linkname, full);
    else {
      FS.writeFile(full, e.data);
      if (e.mode != null) FS.chmod(full, e.mode & 0o777);
    }
  }
  FS.chdir('/pkg');
  if (!FS.readdir('/pkg').some((n) => n !== '.' && n !== '..')) throw new Error('There is nothing to pack.');
  const rc = sz.callMain(['a', '-t7z', '/out.7z', '*', '-snl', '-bso0', '-bsp0']);
  if (rc !== 0) throw new Error('7-Zip couldn\'t write the archive.');
  return FS.readFile('/out.7z');
}

export async function readZip(u8) {
  const zip = await globalThis.JSZip.loadAsync(u8);
  const entries = [];
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const unixMode = entry.unixPermissions ? entry.unixPermissions & 0o7777 : null;
    const isLink = entry.unixPermissions && (entry.unixPermissions & 0o170000) === 0o120000;
    const data = await entry.async('uint8array');
    entries.push(isLink
      ? { path, type: 'symlink', data: new Uint8Array(0), mode: 0o777, linkname: bytesText(data) }
      : { path, type: 'file', data, mode: unixMode });
  }
  return entries;
}

export async function writeZip(entries) {
  const zip = new globalThis.JSZip();
  const date = new Date(Date.UTC(2026, 0, 1));
  for (const e of entries) {
    if (e.type === 'dir') zip.folder(e.path);
    else if (e.type === 'symlink') zip.file(e.path, e.linkname, { date, unixPermissions: 0o120777 });
    else zip.file(e.path, e.data, { date, unixPermissions: 0o100000 | (e.mode ?? 0o644) });
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' });
}
