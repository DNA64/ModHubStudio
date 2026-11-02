// Opens a Mod Hub repository that already exists on a web host, so it can be
// managed here. Reads it the way Hakchi2 CE does (ModHub/Repository/Repository.cs):
// .repo/pack.tgz first, holding `list`, `readme.md` and <package>/{link, md5,
// sha1, readme, extract}; otherwise the same files loose in .repo/.
//
// Every package keeps its original link, hashes and readme, so publishing the
// repository again leaves unchanged packages exactly where they are.
import { parseTar, gunzip, isGzip, looksLikeTar, bytesText } from './tar.js';
import { modFromArchive, makeMod, kindFromFileName, baseName, remember, setKind } from './model.js';
import { parseReadme } from './readme.js';
import { formatFromFileName } from './archive.js';
import { normalizeBase, md5Hex, sha1Hex } from './repo.js';

const ITEM_RE = /^(?:\.\/)?([^/]+)\/(extract|link|md5|sha1|readme(?:\.(?:md|txt))?)$/i;
const README_NAMES = ['readme.md', 'readme.txt', 'readme'];
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Text as Hakchi2 CE reads it: the list split on line breaks.
const listNames = (text) => text.replace(/[\r\n]+/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);

function itemsFromList(names, details, problems) {
  const seen = new Set();
  const items = [];
  for (const name of names) {
    if (seen.has(name)) { problems.push({ severity: 'info', text: `${name} is listed twice. It's listed once from now on.` }); continue; }
    seen.add(name);
    if (!kindFromFileName(name) || /\.(zip|7z)$/i.test(name)) {
      problems.push({ severity: 'warning', text: `${name} isn't a .hmod or .clvg name, so Hakchi2 CE doesn't show it. It was left out.` });
      continue;
    }
    const d = details.get(name);
    if (!d) { problems.push({ severity: 'warning', text: `${name} is listed, but the repository has nothing else about it, so Hakchi2 CE doesn't show it. It was left out.` }); continue; }
    items.push({ fileName: name, ...d });
  }
  for (const name of details.keys()) {
    if (!seen.has(name)) problems.push({ severity: 'info', text: `${name} has details in the repository but isn't in its list, so Hakchi2 CE doesn't show it. It was left out.` });
  }
  return items;
}

// pack.tgz bytes -> { readme, items: [{fileName, link, md5, sha1, readme, readmeName, extract}], problems }
export async function parseRepoPack(bytes) {
  let raw = bytes;
  if (isGzip(raw)) raw = await gunzip(raw);
  if (!looksLikeTar(raw)) throw new Error('.repo/pack.tgz isn\'t a tar.gz archive, so the repository can\'t be read.');
  let list = null;
  let readme = '';
  const details = new Map();
  for (const e of parseTar(raw)) {
    if (e.type !== 'file') continue;
    if (/^(?:\.\/)?list$/i.test(e.path)) { list = bytesText(e.data); continue; }
    if (/^(?:\.\/)?readme\.md$/i.test(e.path)) { readme = bytesText(e.data); continue; }
    const m = ITEM_RE.exec(e.path);
    if (!m) continue;
    const d = details.get(m[1]) || {};
    const field = m[2].toLowerCase();
    if (field === 'extract') d.extract = true;
    else if (README_NAMES.includes(field)) { d.readme = bytesText(e.data); d.readmeName = m[2]; }
    else d[field] = bytesText(e.data).trim();
    details.set(m[1], d);
  }
  const problems = [];
  // Like Hakchi2 CE: with no list, everything in the pack is listed.
  const names = list != null && listNames(list).length ? listNames(list) : [...details.keys()];
  return { readme, items: itemsFromList(names, details, problems), problems };
}

// readFile(pathRelativeToSite) -> Uint8Array | null
export async function readRepositoryIndex(readFile) {
  const pack = await readFile('.repo/pack.tgz');
  if (pack) return { from: 'pack.tgz', ...(await parseRepoPack(pack)) };
  const listBytes = await readFile('.repo/list');
  if (!listBytes) throw new Error('There\'s no .repo/pack.tgz or .repo/list here, so this isn\'t a Mod Hub repository.');
  const readmeBytes = await readFile('.repo/readme.md');
  const names = listNames(bytesText(listBytes));
  const details = new Map();
  for (const name of new Set(names)) {
    const link = await readFile(`.repo/${name}/link`);
    if (!link) continue;
    const d = { link: bytesText(link).trim() };
    const md5 = await readFile(`.repo/${name}/md5`);
    const sha1 = await readFile(`.repo/${name}/sha1`);
    if (md5) d.md5 = bytesText(md5).trim();
    if (sha1) d.sha1 = bytesText(sha1).trim();
    for (const r of README_NAMES) {
      const t = await readFile(`.repo/${name}/${r}`);
      if (t) { d.readme = bytesText(t); d.readmeName = r; break; }
    }
    if (await readFile(`.repo/${name}/extract`)) d.extract = true;
    details.set(name, d);
  }
  const problems = [];
  return { from: 'list', readme: readmeBytes ? bytesText(readmeBytes) : '', items: itemsFromList(names, details, problems), problems };
}

// Turns one repository entry and (when it could be had) its file into a package.
// The package keeps where it came from in `origin`; without its file it's
// `unavailable` and is listed exactly as before.
export async function packageFromItem(item, bytes, reason = null, { id } = {}) {
  const kind = kindFromFileName(item.fileName);
  const name = baseName(item.fileName);
  const problems = [];
  let mod = null;
  if (bytes) {
    const md5 = md5Hex(bytes);
    if (item.md5 && item.md5.toLowerCase() !== md5) {
      problems.push({ severity: 'warning', text: `${item.fileName}: the downloaded file doesn't match the repository's md5. The file may have been replaced without updating the repository; editing the package here writes new hashes.` });
    } else if (item.sha1 && item.sha1.toLowerCase() !== (await sha1Hex(bytes))) {
      problems.push({ severity: 'warning', text: `${item.fileName}: the downloaded file doesn't match the repository's sha1.` });
    }
    try {
      mod = await modFromArchive(item.fileName, bytes);
    } catch (e) {
      reason = e.message;
    }
  }
  // Hakchi2 CE goes by the listed name, so that decides mod or game here.
  if (mod && mod.kind !== kind) mod = setKind(mod, kind);
  if (mod) {
    mod = { ...mod, source: { ...mod.source, kindFrom: 'repository', kindMismatch: null } };
    // A ZIP or 7z behind a .zip/.7z link (or one Hakchi2 CE is told to extract)
    // stays in its format; anything else is packed as tar.gz if it changes.
    const archive = ['zip', '7z'].includes(mod.source.kind) && !mod.source.nested.length;
    mod = { ...mod, format: archive && (formatFromFileName(item.link) || item.extract) ? mod.source.kind : null };
  } else {
    mod = makeMod({ name, kind, entries: [], source: { kind: 'none', fileName: item.fileName } });
    mod = { ...mod, unavailable: reason || 'Its file couldn\'t be read.' };
  }
  // Games keep their Mod Hub listing only in the repository; mods without a
  // readme of their own take it from there too.
  if (item.readme && (kind === 'game' || !mod.readmeFound || mod.unavailable)) {
    const parsed = parseReadme(item.readme.trimStart());
    mod = { ...mod, readme: { front: parsed.front, order: parsed.order, body: parsed.body } };
  }
  mod = {
    ...mod,
    id: id || mod.id,
    kind,
    source: { ...mod.source, fileName: item.fileName, imported: true },
    origin: { fileName: item.fileName, name, link: item.link, md5: item.md5 || '', sha1: item.sha1 || '', readme: item.readme ?? null, readmeName: item.readmeName || 'readme.md', extract: !!item.extract },
  };
  return { mod: remember(mod, mod.unavailable ? null : bytes), problems };
}

// A package's file chosen by hand for one that couldn't be downloaded.
export async function attachFile(mod, bytes) {
  const o = mod.origin;
  const r = await packageFromItem({ ...o, readme: o.readme, readmeName: o.readmeName }, bytes, null, { id: mod.id });
  if (r.mod.unavailable) throw new Error(r.mod.unavailable);
  return r;
}

// Opens a repository.
//   base         the site address, e.g. https://classicmods.net
//   readFile     (path relative to the site) -> bytes or null
//   localFile    (link) -> bytes or null, for a copy of the site on this computer
//   download     (link) -> bytes, throws when it can't
export async function importRepository({ base, readFile, localFile = null, download = null, onProgress = () => {} }) {
  onProgress('Reading the repository');
  const index = await readRepositoryIndex(readFile);
  const problems = [...index.problems];
  const mods = [];
  for (const [i, item] of index.items.entries()) {
    onProgress(`Reading ${item.fileName} (${i + 1} of ${index.items.length})`);
    let bytes = null;
    let reason = null;
    if (!item.link) reason = 'The repository has no download link for it.';
    else {
      if (localFile) bytes = await localFile(item.link);
      if (!bytes && download) {
        try { bytes = await download(item.link); } catch (e) { reason = e.message; }
      } else if (!bytes) reason = 'Its file isn\'t in the chosen folder.';
    }
    const r = await packageFromItem(item, bytes, reason);
    if (r.mod.unavailable) problems.push({ severity: 'warning', text: `${item.fileName}: ${r.mod.unavailable} It's kept as it was; select its file on the package to check or edit it.` });
    problems.push(...r.problems);
    mods.push(r.mod);
  }
  const host = (() => { try { return new URL(base).host; } catch { return ''; } })();
  return {
    mods,
    problems,
    from: index.from,
    repo: {
      baseUrl: normalizeBase(base),
      readme: index.readme,
      title: host || 'Imported repository',
      imported: { at: new Date().toISOString(), packages: mods.map((m) => ({ fileName: m.origin.fileName, link: m.origin.link, kind: kindFromFileName(m.origin.fileName) })) },
    },
    summary: `${plural(mods.length, 'package')} read from ${index.from === 'pack.tgz' ? '.repo/pack.tgz' : '.repo/list'}${mods.some((m) => m.unavailable) ? `, ${mods.filter((m) => m.unavailable).length} without their file` : ''}.`,
  };
}

// ---------- reading a copy of the site ----------

// files: [{path relative to the chosen folder, data}] (a folder, or a zip of the site).
// Finds the site root (the folder holding .repo) and works out the site address
// from the links when it isn't given.
// data may be bytes or a File/Blob, read only when it's needed, so a large copy
// of a website doesn't have to be loaded whole.
export function siteFromFiles(files, address = '') {
  const map = new Map(files.map((f) => [f.path.replace(/\\/g, '/'), f.data]));
  const bytesOf = async (v) => (v == null ? null : v instanceof Uint8Array ? v : new Uint8Array(await v.arrayBuffer()));
  let root = null;
  for (const p of map.keys()) {
    const m = /^(.*?)\.repo\/(pack\.tgz|list)$/.exec(p);
    if (m && (root == null || m[1].length < root.length)) root = m[1];
  }
  if (root == null) throw new Error('There\'s no .repo/pack.tgz or .repo/list in it, so it isn\'t a copy of a Mod Hub repository.');
  const site = new Map();
  for (const [p, d] of map) if (p.startsWith(root)) site.set(p.slice(root.length), d);
  const readFile = async (rel) => bytesOf(site.get(rel));

  // The longest tail of a link's path that is a file in the copy.
  const match = (link) => {
    let segs;
    try { segs = decodeURIComponent(new URL(link).pathname).split('/').filter(Boolean); } catch { return null; }
    for (let i = 0; i < segs.length; i++) {
      const rel = segs.slice(i).join('/');
      if (site.has(rel)) return rel;
    }
    return null;
  };
  let base = normalizeBase(address);
  const localFile = async (link) => {
    if (base) {
      const b = base + '/';
      if (link.toLowerCase().startsWith(b.toLowerCase())) {
        try {
          const rel = decodeURIComponent(link.slice(b.length).split(/[?#]/)[0]);
          if (site.has(rel)) return bytesOf(site.get(rel));
        } catch { /* fall through */ }
      }
    }
    const rel = match(link);
    return rel ? bytesOf(site.get(rel)) : null;
  };
  return { readFile, localFile, match, setBase: (b) => { base = normalizeBase(b); } };
}

// The site address that makes the most links point into the copy.
export function guessBase(links, match) {
  const votes = new Map();
  for (const link of links) {
    const rel = match(link);
    if (!rel) continue;
    const clean = link.split(/[?#]/)[0];
    let decoded;
    try { decoded = decodeURI(clean); } catch { decoded = clean; }
    if (!decoded.endsWith('/' + rel)) continue;
    const b = normalizeBase(clean.slice(0, clean.length - encodeURI(rel).length - 1));
    if (b) votes.set(b, (votes.get(b) || 0) + 1);
  }
  return [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}

// Reading a live site from this page. Most hosts don't let other websites read
// their files (no Access-Control-Allow-Origin header); the browser then refuses
// before anything arrives, so that's reported in plain words.
export function siteFromAddress(address, fetchImpl = globalThis.fetch) {
  const base = normalizeBase(address);
  const host = (() => { try { return new URL(base).host; } catch { return base; } })();
  const get = async (url) => {
    let res;
    try { res = await fetchImpl(url, { cache: 'no-store' }); } catch {
      const e = new Error(`${host} doesn't let other websites read its files, or it's offline.`);
      e.blocked = true;
      throw e;
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${url} returned ${res.status}.`);
    return new Uint8Array(await res.arrayBuffer());
  };
  return {
    base,
    readFile: async (rel) => {
      try { return await get(`${base}/${rel}`); } catch (e) {
        if (e.blocked) throw new Error(`${e.message} Its repository can't be opened by address until the host sends an Access-Control-Allow-Origin header. Download a copy of the site (or just its .repo folder) and use Open a copy of the site instead.`);
        throw e;
      }
    },
    download: async (link) => {
      const r = await get(link).catch((e) => { throw new Error(e.blocked ? 'Its host doesn\'t let other websites read the file.' : e.message); });
      if (!r) throw new Error('Its download link returns 404.');
      return r;
    },
  };
}
