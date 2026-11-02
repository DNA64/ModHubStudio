import { parseTar, gunzip, isGzip, isZip, looksLikeTar, bytesText } from './tar.js';
import { parseReadme } from './readme.js';
import { is7z, read7z, readZip, formatFromFileName, FORMATS, FORMAT_EXTENSIONS } from './archive.js';

let nextId = 1;
export const newId = () => `m${nextId++}`;

// The two package types Hakchi2 CE knows (ModHub/Repository/Repository.cs: ItemKindFileExtensions).
export const KINDS = {
  hmod: { ext: '.hmod', label: 'Module' },
  game: { ext: '.clvg', label: 'Game' },
};
// Package files the Studio opens: the two kinds, plus ZIP and 7z archives,
// which Hakchi2 CE also installs and which are kept in their own format.
export const ACCEPTED_EXTENSIONS = [...Object.values(KINDS).map((k) => k.ext), ...FORMAT_EXTENSIONS];

const README_RE = /^(readme\.md|readme\.txt|readme)$/i;

export function kindFromFileName(fileName) {
  const lower = stripFormat(fileName).toLowerCase();
  for (const [kind, k] of Object.entries(KINDS)) if (lower.endsWith(k.ext)) return kind;
  return null;
}

// "x.zip" -> "x", "x.hmod.7z" -> "x.hmod"
function stripFormat(fileName) {
  return String(fileName).replace(/\.(zip|7z)$/i, '');
}

export function baseName(fileName) {
  return stripFormat(fileName).replace(/\.(hmod|clvg)$/i, '');
}

// True for a file name the Studio opens as a package.
export const isPackageFileName = (name) => !!(kindFromFileName(name) || formatFromFileName(name));

function cleanLeading(p) {
  return p.replace(/^(\.\/)+/, '').replace(/^\/+/, '');
}

const isArchive = (u8) => isGzip(u8) || isZip(u8) || is7z(u8) || looksLikeTar(u8);

// Raw archive bytes -> entries. Throws when the bytes aren't an archive.
async function entriesFromBytes(u8, label) {
  if (isZip(u8)) return { entries: await readZip(u8), container: 'zip' };
  if (is7z(u8)) return { entries: await read7z(u8, label), container: '7z' };
  if (isGzip(u8)) {
    const inner = await gunzip(u8);
    if (looksLikeTar(inner)) return { entries: parseTar(inner), container: 'tgz' };
    // gzip of something other than a tar: treat the decompressed bytes as one file, unwrapped below.
    return { entries: [{ path: label, type: 'file', data: inner }], container: 'gz' };
  }
  if (looksLikeTar(u8)) return { entries: parseTar(u8), container: 'tar' };
  throw new Error(`${label} isn't a tar.gz, ZIP or 7z archive, so it can't be read as a package.`);
}

// A package whose only real content is another archive (for example the .tar that
// 7-Zip shows inside a .hmod) is unwrapped, so the inner archive is what gets checked.
async function unwrapNested(entries, name) {
  const notes = [];
  for (let depth = 0; depth < 4; depth++) {
    const files = entries.filter((e) => e.type === 'file' && cleanLeading(e.path));
    const nonDocs = files.filter((e) => !README_RE.test(cleanLeading(e.path).split('/').pop()));
    let target = null;
    if (nonDocs.length === 1 && isArchive(nonDocs[0].data)) target = nonDocs[0];
    if (!target) {
      // A root-level file named after the package (with or without .tar/.gz) that is an archive.
      const stem = name.toLowerCase();
      target = files.find((e) => {
        const p = cleanLeading(e.path).toLowerCase();
        return !p.includes('/') && p.replace(/\.(tar|gz|tgz|tar\.gz|hmod|clvg|zip|7z)$/, '') === stem && isArchive(e.data);
      }) || null;
    }
    if (!target) break;
    const inner = await entriesFromBytes(target.data, cleanLeading(target.path));
    notes.push(cleanLeading(target.path));
    entries = [...entries.filter((e) => e !== target), ...inner.entries];
  }
  return { entries, notes };
}

export function makeMod({ name, kind, entries, source }) {
  const files = [];
  const seen = new Set();
  const filled = new Set();
  for (const e of entries) {
    if (e.type === 'dir') continue;
    const segs = cleanLeading(e.path).split('/');
    for (let i = 1; i < segs.length; i++) filled.add(segs.slice(0, i).join('/'));
  }
  for (const e of entries) {
    const path = cleanLeading(e.path).replace(/\/+$/, '');
    if (!path || path === '.') continue;
    if (e.type === 'dir' && filled.has(path)) continue; // implied by the files inside it
    if (seen.has(path)) continue;
    seen.add(path);
    files.push({ path, type: e.type, data: e.data || new Uint8Array(0), mode: e.type === 'dir' ? null : e.mode ?? null, linkname: e.linkname || '' });
  }
  const mod = {
    id: newId(),
    kind: kind || 'hmod',
    name,
    source,
    files,
    readme: { front: {}, order: [], body: '' },
    readmeFound: null,
    readmeProblem: null,
    dismissed: [],
  };
  if (mod.kind === 'game') {
    // Use the game's own title for the Mod Hub listing.
    const desktop = files.find((f) => /^[^/]+\.desktop$/i.test(f.path));
    const title = desktop && (bytesText(desktop.data).match(/^Name=(.+)$/m) || [])[1];
    if (title) mod.readme.front.Name = title.trim();
    return mod;
  }
  return extractReadme(mod);
}

// Pull the top-level readme out of the file list into the editable readme.
export function extractReadme(mod) {
  const idx = mod.files.findIndex((f) => !f.path.includes('/') && README_RE.test(f.path) && f.type === 'file');
  if (idx < 0) return mod;
  const others = mod.files.filter((f, i) => i !== idx && !f.path.includes('/') && README_RE.test(f.path));
  const file = mod.files[idx];
  const text = bytesText(file.data);
  let parsed = parseReadme(text);
  let problem = null;
  if (parsed.frontMatterNotAtTop) {
    problem = 'not-at-top';
    parsed = parseReadme(text.trimStart());
  }
  return {
    ...mod,
    files: mod.files.filter((f) => f !== file && !others.includes(f)),
    readme: { front: parsed.front, order: parsed.order, body: parsed.body },
    readmeFound: file.path,
    readmeProblem: problem,
    readmeHadFront: parsed.hadFrontMatter,
  };
}

// Decide mod vs game from what's inside, the way the tools that consume them do:
// Hakchi2 CE imports a game by its top-level CLV-X-XXXXX.desktop (AddGamesTask.cs);
// hakchi installs a mod by copying system folders and running install/uninstall/transfer.
const HMOD_ROOTS = ['bin', 'sbin', 'etc', 'lib', 'usr', 'root'];
const HMOD_CONTROL = ['install', 'uninstall', 'transfer'];
export function detectKind(entries) {
  let paths = entries.filter((e) => e.type !== 'dir').map((e) => cleanLeading(e.path)).filter(Boolean)
    .filter((p) => !/(^|\/)(__MACOSX(\/|$)|\.DS_Store$|Thumbs\.db$|desktop\.ini$)/i.test(p));
  // Look past one wrapper folder; a wrapped package is still that kind of package.
  const firsts = new Set(paths.map((p) => (p.includes('/') ? p.split('/')[0] : null)));
  if (firsts.size === 1 && [...firsts][0] && !HMOD_ROOTS.includes([...firsts][0].toLowerCase())) {
    const w = [...firsts][0];
    paths = paths.map((p) => p.slice(w.length + 1));
  }
  const top = paths.filter((p) => !p.includes('/'));
  const gameEvidence = top.filter((p) => /\.desktop$/i.test(p));
  const hmodEvidence = [
    ...top.filter((p) => HMOD_CONTROL.includes(p)),
    ...[...new Set(paths.filter((p) => p.includes('/')).map((p) => p.split('/')[0]).filter((d) => HMOD_ROOTS.includes(d.toLowerCase())))].map((d) => d + '/'),
  ];
  const strongGame = gameEvidence.some((p) => /^CLV-[A-Z]-[A-Z0-9]{5}\.desktop$/i.test(p));
  if (gameEvidence.length && !hmodEvidence.length) return { kind: 'game', evidence: gameEvidence };
  if (hmodEvidence.length && !strongGame) return { kind: 'hmod', evidence: hmodEvidence };
  if (strongGame && !hmodEvidence.length) return { kind: 'game', evidence: gameEvidence };
  return null; // empty, or evidence both ways: let the name decide
}

function chooseKind(nameKind, entries) {
  const found = detectKind(entries);
  const kind = (found && found.kind) || nameKind || 'hmod';
  const mismatch = nameKind && found && found.kind !== nameKind ? { fromName: nameKind, fromContent: found.kind, evidence: found.evidence } : null;
  return { kind, kindFrom: found ? 'contents' : nameKind ? 'name' : 'default', mismatch };
}

export async function modFromArchive(fileName, u8) {
  const nameKind = kindFromFileName(fileName);
  const nameFormat = formatFromFileName(fileName);
  if (!nameKind && !nameFormat) {
    throw new Error(`${fileName} was skipped. Hakchi2 CE packages end in ${ACCEPTED_EXTENSIONS.join(', ')}; rename it if it is one.`);
  }
  const name = baseName(fileName);
  const first = await entriesFromBytes(u8, fileName);
  const { entries, notes } = await unwrapNested(first.entries, name);
  const k = chooseKind(nameKind, entries);
  const mod = makeMod({ name, kind: k.kind, entries, source: { kind: first.container, fileName, nested: notes, kindFrom: k.kindFrom, kindMismatch: k.mismatch } });
  // A .zip or .7z file stays one, as long as that's really what it holds.
  return remember({ ...mod, format: nameFormat && nameFormat === first.container && !notes.length ? nameFormat : null }, u8);
}

// What a package looked like when it was opened, so an unchanged one can be
// published byte for byte (its hashes and download stay the same).
function stateKey(mod) {
  return JSON.stringify({ name: mod.name, kind: mod.kind, targets: mod.targets || null, readme: mod.readme, readmeProblem: mod.readmeProblem || null, format: mod.format || null });
}
export function remember(mod, bytes) {
  return { ...mod, original: { bytes: bytes || null, key: stateKey(mod), files: mod.files.map((f) => [f.path, f.type, f.mode, f.linkname, f.data]) } };
}
export function isUnchanged(mod) {
  const o = mod.original;
  if (!o || o.key !== stateKey(mod) || o.files.length !== mod.files.length) return false;
  return mod.files.every((f, i) => {
    const g = o.files[i];
    return g[0] === f.path && g[1] === f.type && g[2] === f.mode && g[3] === f.linkname && g[4] === f.data;
  });
}

export const formatLabel = (mod) => (mod.format ? FORMATS[mod.format].label : null);

// files: [{path (relative inside folder, without the folder itself), data}]
// An unpacked package. Its contents decide mod vs game; a .hmod/.clvg folder name is the tiebreaker.
export async function modFromFolder(folderName, files) {
  const nameKind = kindFromFileName(folderName);
  const name = baseName(folderName);
  let entries = files.map((f) => ({ path: f.path, type: 'file', data: f.data, mode: null }));
  const unwrapped = await unwrapNested(entries, name);
  entries = unwrapped.entries;
  // An extracted copy often sits in a subfolder named after the package; that's
  // the author's working folder, not part of the package, so drop it here.
  const firsts = new Set(entries.map((e) => (cleanLeading(e.path).includes('/') ? cleanLeading(e.path).split('/')[0] : null)));
  const notes = [...unwrapped.notes];
  if (firsts.size === 1) {
    const only = [...firsts][0];
    if (only && baseName(only).toLowerCase() === name.toLowerCase()) {
      entries = entries.map((e) => ({ ...e, path: cleanLeading(e.path).slice(only.length + 1) }));
      notes.push(only + '/');
    }
  }
  const k = chooseKind(nameKind, entries);
  return makeMod({ name, kind: k.kind, entries, source: { kind: 'folder', fileName: folderName, nested: notes, kindFrom: k.kindFrom, kindMismatch: k.mismatch } });
}

// Switch a package between mod and game by hand.
export function setKind(mod, kind) {
  if (mod.kind === kind) return mod;
  let next = { ...mod, kind, source: { ...mod.source, kindFrom: 'manual' } };
  if (kind === 'hmod') next = extractReadme(next);
  if (kind === 'game' && !next.readme.front.Name) {
    const desktop = next.files.find((f) => /^[^/]+\.desktop$/i.test(f.path));
    const title = desktop && (bytesText(desktop.data).match(/^Name=(.+)$/m) || [])[1];
    if (title) next = { ...next, readme: { ...next.readme, front: { ...next.readme.front, Name: title.trim() } } };
  }
  return next;
}

// Sorts a folder's files into packages: packed .hmod/.clvg files (and .zip/.7z
// at the top of the folder), and unpacked
// package folders named *.hmod / *.clvg (the way Hakchi2 CE keeps user_mods).
// files: [{path relative to the chosen folder, data}]
export async function modsFromPackageFolder(files) {
  const packed = [];
  const unpacked = new Map();
  const skipped = [];
  for (const f of files) {
    const segs = f.path.split('/');
    const dirIdx = segs.slice(0, -1).findIndex((s) => kindFromFileName(s));
    if (dirIdx >= 0) {
      const key = segs.slice(0, dirIdx + 1).join('/');
      if (!unpacked.has(key)) unpacked.set(key, []);
      unpacked.get(key).push({ path: segs.slice(dirIdx + 1).join('/'), data: f.data });
    } else if (kindFromFileName(segs[segs.length - 1]) || (segs.length === 1 && formatFromFileName(segs[0]))) packed.push(f);
    else skipped.push(f.path);
  }
  const mods = [];
  const errors = [];
  for (const f of packed) {
    try { mods.push(await modFromArchive(f.path.split('/').pop(), f.data)); } catch (e) { errors.push(e.message); }
  }
  for (const [key, list] of unpacked) mods.push(await modFromFolder(key.split('/').pop(), list));
  return { mods, skipped, errors };
}

// True when a folder holds packages rather than being one unpacked mod.
export function looksLikePackageFolder(files) {
  // .zip and .7z only count at the top: a mod can carry archives of its own.
  const hasPackages = files.some((f) => f.path.split('/').some((s) => kindFromFileName(s)) || (!f.path.includes('/') && formatFromFileName(f.path)));
  if (!hasPackages) return false;
  const found = detectKind(files.filter((f) => !f.path.split('/').some((s) => kindFromFileName(s))).map((f) => ({ path: f.path, type: 'file' })));
  return !found;
}

export function totalSize(mod) {
  return mod.files.reduce((n, f) => n + f.data.length, 0);
}

// Rename or move one file inside a package. Returns { mod } or { error }.
export function renameFile(mod, from, to) {
  let path = String(to || '').trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!path) return { error: 'Enter a path.' };
  if (path.split('/').some((s) => s === '..' || s === '.')) return { error: 'Paths can\'t contain . or .. folders.' };
  if (path === from) return { mod };
  if (mod.files.some((f) => f.path === path)) return { error: `${path} already exists in this package.` };
  if (mod.kind === 'hmod' && /^readme(\.(md|txt))?$/i.test(path)) return { error: 'The readme is generated from the Readme tab. Pick another name.' };
  if (mod.files.some((f) => f.path.startsWith(path + '/'))) return { error: `${path} is a folder in this package.` };
  return { mod: { ...mod, files: mod.files.map((f) => (f.path === from ? { ...f, path } : f)) } };
}
