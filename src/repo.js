// Builds a self-hostable Hakchi2 CE Mod Hub repository.
// Format from hakchi2-CE ModHub/Repository/Repository.cs and hakchi's `hmod rinstall`:
//   <base>/.repo/pack.tgz            list + readme.md + <mod>.hmod/{link,md5,sha1,readme.md}
//   <base>/.repo/list                one "<name>.hmod" per line (used by the console's rlist)
//   <base>/.repo/<mod>.hmod/link     absolute URL of the .hmod (used by `hmod rinstall`)
import { buildTar, gzip, textBytes } from './tar.js';
import { hmodFileName, readmeText, serverFileName, keepsOriginal } from './pack.js';
import { consolesLabel } from './targets.js';
import { STUDIO_URL } from './project.js';

export function normalizeBase(url) {
  return (url || '').trim().replace(/\/+$/, '').replace(/\/\.repo$/, '');
}

export function repoIssues(repo, mods) {
  const out = [];
  const base = normalizeBase(repo.baseUrl);
  if (!base) out.push({ severity: 'error', text: 'Add the address you will host the repository at. Each mod\'s download link is built from it.' });
  else if (!/^https?:\/\/[^/\s]+/i.test(base)) out.push({ severity: 'error', text: 'The address must start with http:// or https://.' });
  else if (/^http:\/\//i.test(base)) out.push({ severity: 'warning', text: 'Plain http works, but many free hosts redirect to https. Use https if your host supports it.' });
  if (/github\.com\/[^/]+\/[^/]+(\/|$)/i.test(base) && !/github\.io/i.test(base)) {
    out.push({ severity: 'error', text: 'github.com repository pages serve HTML, not files. Use your GitHub Pages address (username.github.io/repo) or raw.githubusercontent.com.' });
  }
  // An empty repository is valid: it's how the last package is removed.
  if (!mods.length) out.push({ severity: 'warning', text: 'There are no packages. Publishing makes the repository empty, so Hakchi2 CE will list nothing from it.' });
  const names = new Map();
  for (const m of mods) {
    const n = hmodFileName(m).toLowerCase();
    names.set(n, (names.get(n) || 0) + 1);
  }
  for (const [n, c] of names) if (c > 1) out.push({ severity: 'error', text: `${c} mods pack to ${n}. Mod names must be unique within a repository.` });
  const missing = mods.filter((m) => m.unavailable);
  if (missing.length) {
    out.push({ severity: 'info', text: `${missing.length === 1 ? `${hmodFileName(missing[0])} couldn't be downloaded, so it's` : `${missing.length} packages couldn't be downloaded, so they're`} listed exactly as before. Remove ${missing.length === 1 ? 'it if you don\'t want it' : 'any you don\'t want'} listed.` });
  }
  if (repo.imported) {
    for (const m of mods) {
      const place = packagePlacement(repo, m);
      if (place.otherHost && !m.unavailable && !keepsOriginal(m)) {
        out.push({ severity: 'warning', text: `${hmodFileName(m)} changed, and it's downloaded from ${new URL(place.link).host}. Its new file has to be uploaded there by hand; the download keeps it in other-hosts/.` });
      }
    }
  }
  return out;
}

// ---------- where each package lives ----------

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

// The path of a link on this site, relative to its address, or null when the
// link points somewhere else.
// http and https count as the same site: a repository added as http:// often
// links its packages over https.
export function sitePath(base, link) {
  const noScheme = (u) => u.replace(/^https?:\/\//i, '');
  const b = noScheme(normalizeBase(base));
  const l = noScheme(String(link || '').trim());
  if (!b || !l.toLowerCase().startsWith(b.toLowerCase() + '/')) return null;
  try { return decodeURIComponent(l.slice(b.length + 1).split(/[?#]/)[0]); } catch { return null; }
}

const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

// The folders an opened repository already keeps packages in, most used first,
// with how many mods and games each holds.
export function siteFolders(repo, mods) {
  if (!repo.imported) return [];
  const counts = new Map();
  const base = normalizeBase(repo.baseUrl);
  for (const p of repo.imported.packages || []) {
    const path = sitePath(base, p.link);
    if (path == null) continue;
    const dir = dirOf(path);
    const c = counts.get(dir) || { folder: dir, hmod: 0, game: 0 };
    c[p.kind === 'game' ? 'game' : 'hmod']++;
    counts.set(dir, c);
  }
  for (const m of mods || []) if (m.folder != null && !counts.has(m.folder)) counts.set(m.folder, { folder: m.folder, hmod: 0, game: 0 });
  return [...counts.values()].sort((a, b) => (b.hmod + b.game) - (a.hmod + a.game) || a.folder.localeCompare(b.folder));
}

// Where a new package goes in an opened repository unless the author picks
// another folder: the folder holding most packages of its kind.
export function defaultFolder(repo, mod) {
  const folders = siteFolders(repo, []);
  if (!folders.length) return mod.kind === 'game' ? 'games' : 'hmods';
  const k = mod.kind === 'game' ? 'game' : 'hmod';
  return [...folders].sort((a, b) => b[k] - a[k])[0].folder;
}

// { link, path, otherHost }: the download link, and the path to upload the
// package's file to (relative to the site), or null when there's nothing to upload.
export function packagePlacement(repo, mod) {
  const base = normalizeBase(repo.baseUrl);
  if (mod.externalUrl) return { link: mod.externalUrl.trim(), path: null };
  const o = mod.origin;
  const renamed = o && hmodFileName(mod) !== o.fileName;
  if (o && !renamed) {
    // Packages opened from an existing repository keep their link and path.
    const path = sitePath(base, o.link);
    return { link: o.link, path, otherHost: path == null };
  }
  const file = serverFileName(mod);
  let folder;
  if (mod.folder != null) folder = mod.folder;
  else if (o && sitePath(base, o.link) != null) folder = dirOf(sitePath(base, o.link));
  else if (repo.imported) folder = defaultFolder(repo, mod);
  else folder = mod.kind === 'game' ? 'games' : 'hmods';
  const path = folder ? `${folder}/${file}` : file;
  return { link: `${base}/${encodePath(path)}`, path };
}

export function modLink(repo, mod) {
  return packagePlacement(repo, mod).link;
}

export async function sha1Hex(u8) {
  const d = await crypto.subtle.digest('SHA-1', u8);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function md5Hex(u8) {
  const SparkMD5 = globalThis.SparkMD5;
  return SparkMD5.ArrayBuffer.hash(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
}

// packed: Map<modId, Uint8Array> of package bytes (see packPackage). A package
// published unchanged from an existing repository needs none.
// Returns [{path, data}] describing every file to upload, relative to the host root.
export async function buildRepoFiles(repo, mods, packed) {
  const base = normalizeBase(repo.baseUrl);
  const imported = !!repo.imported;
  const files = [];
  const meta = [];
  const listLines = [];
  const uploads = [];
  for (const mod of mods) {
    const o = mod.origin;
    // A package that couldn't be downloaded can't be repacked, so it keeps its listing.
    const fname = mod.unavailable && o ? o.fileName : hmodFileName(mod);
    const place = packagePlacement(repo, mod);
    listLines.push(fname);
    if (o && (mod.unavailable || (keepsOriginal(mod) && fname === o.fileName))) {
      // Unchanged: everything the repository said about it stays as it was.
      meta.push({ path: `${fname}/link`, data: textBytes(o.link + '\n') });
      if (o.md5) meta.push({ path: `${fname}/md5`, data: textBytes(o.md5.trim() + '\n') });
      if (o.sha1) meta.push({ path: `${fname}/sha1`, data: textBytes(o.sha1.trim() + '\n') });
      if (o.readme != null) meta.push({ path: `${fname}/${o.readmeName || 'readme.md'}`, data: textBytes(o.readme) });
      if (o.extract) meta.push({ path: `${fname}/extract`, data: new Uint8Array(0) });
      continue;
    }
    const bytes = packed.get(mod.id);
    meta.push({ path: `${fname}/link`, data: textBytes(place.link + '\n') });
    meta.push({ path: `${fname}/md5`, data: textBytes(md5Hex(bytes) + '\n') });
    meta.push({ path: `${fname}/sha1`, data: textBytes((await sha1Hex(bytes)) + '\n') });
    meta.push({ path: `${fname}/readme.md`, data: textBytes(readmeText(mod)) });
    // Hakchi2 CE extracts a module marked this way instead of saving it as is.
    if (mod.kind === 'hmod' && mod.format) meta.push({ path: `${fname}/extract`, data: new Uint8Array(0) });
    if (place.path) {
      files.push({ path: place.path, data: bytes });
      uploads.push({ path: place.path, mod });
    } else if (place.otherHost && imported) {
      const u = new URL(place.link);
      const path = `other-hosts/${u.host}${decodeURIComponent(u.pathname)}`;
      files.push({ path, data: bytes });
      uploads.push({ path, mod, link: place.link });
    }
  }
  // No packages: an empty list, not a blank line `hmod rlist` would print.
  const list = textBytes(listLines.length ? listLines.join('\n') + '\n' : '');
  const repoReadme = textBytes((repo.readme || '').trim() + '\n');

  const tarEntries = [
    { path: 'list', type: 'file', data: list, mode: 0o644 },
    { path: 'readme.md', type: 'file', data: repoReadme, mode: 0o644 },
  ];
  for (const name of listLines) tarEntries.push({ path: name, type: 'dir', mode: 0o755 });
  for (const m of meta) tarEntries.push({ ...m, type: 'file', mode: 0o644 });
  const packTgz = await gzip(buildTar(tarEntries));

  files.push({ path: '.repo/pack.tgz', data: packTgz });
  files.push({ path: '.repo/list', data: list });
  files.push({ path: '.repo/readme.md', data: repoReadme });
  for (const m of meta) files.push({ path: `.repo/${m.path}`, data: m.data });
  if (imported) {
    // An existing site keeps its own pages; only what changed is in the download.
    files.push({ path: 'UPLOAD.md', data: textBytes(uploadGuide(repo, mods, uploads)) });
    return files;
  }
  files.push({ path: '.nojekyll', data: new Uint8Array(0) });
  files.push({ path: 'index.html', data: textBytes(indexHtml(repo, mods, base)) });
  files.push({ path: 'HOSTING.md', data: textBytes(hostingGuide(base)) });
  return files;
}

// Files on an opened site that nothing points to any more: packages removed
// from the list, and old files of packages that were renamed or moved.
export function staleFiles(repo, mods) {
  if (!repo.imported) return [];
  const base = normalizeBase(repo.baseUrl);
  const kept = new Set();
  for (const m of mods) {
    const p = packagePlacement(repo, m).path;
    if (p) kept.add(p);
  }
  const out = [];
  for (const p of repo.imported.packages || []) {
    const path = sitePath(base, p.link);
    if (path != null && !kept.has(path)) out.push(path);
  }
  return [...new Set(out)];
}

function uploadGuide(repo, mods, uploads) {
  const base = normalizeBase(repo.baseUrl);
  const onSite = uploads.filter((u) => !u.link);
  const elsewhere = uploads.filter((u) => u.link);
  const listed = new Set(mods.map((m) => hmodFileName(m)));
  const removed = (repo.imported.packages || []).filter((p) => !listed.has(p.fileName));
  const stale = staleFiles(repo, mods);
  const lines = [
    '# Updating this repository',
    '',
    `This download holds only what changed on ${base || 'the site'}. Upload it over the site, keeping the folders as they are. Nothing else on the site needs to change.`,
    '',
    '## Upload',
    '',
    '- the whole `.repo` folder (it is hidden on some computers)',
    ...onSite.map((u) => `- \`${u.path}\` (${hmodFileName(u.mod)})`),
    '',
  ];
  if (elsewhere.length) {
    lines.push('## Upload to other hosts', '', 'These packages are downloaded from another site. Their new files are in `other-hosts/`; put each one at its link:', '');
    for (const u of elsewhere) lines.push(`- \`${u.path}\` → ${u.link}`);
    lines.push('');
  }
  if (stale.length || removed.length) {
    lines.push('## Can be deleted', '', 'Nothing links to these any more. Deleting them is optional:', '');
    for (const p of stale) lines.push(`- \`${p}\``);
    for (const p of removed) lines.push(`- \`.repo/${p.fileName}/\` (if the site has it)`);
    lines.push('');
  }
  return lines.join('\n');
}

export async function buildRepoZip(repo, mods, packed) {
  const JSZip = globalThis.JSZip;
  const zip = new JSZip();
  for (const f of await buildRepoFiles(repo, mods, packed)) zip.file(f.path, f.data, { date: new Date(Date.UTC(2026, 0, 1)) });
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

// Marks index.html as generated, so publishing only replaces its own page.
export const INDEX_MARKER = '<meta name="generator" content="Mod Hub Studio">';
// Pages generated before the rename count as generated too.
export const INDEX_MARKERS = [INDEX_MARKER, '<meta name="generator" content="hmod Repo Publisher">'];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function indexHtml(repo, mods, base) {
  const rows = mods.map((m) => {
    const f = m.readme.front;
    const consoles = consolesLabel(m);
    return `<tr><td><a href="${esc(modLink(repo, m))}">${esc(f.Name || m.name)}</a></td><td>${esc(f.Version || '')}</td><td>${esc(consoles)}</td><td>${esc(f.Creator || '')}</td><td>${esc(f.Category || '')}</td></tr>`;
  }).join('\n');
  return `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${INDEX_MARKER}
<title>${esc(repo.title || 'hmod repository')}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:.4rem .6rem;border-bottom:1px solid #ccc}code{background:#eee;padding:.1rem .3rem}</style>
<h1>${esc(repo.title || 'hmod repository')}</h1>
<p>Add this repository in Hakchi2 CE under <b>Modules → Mod Hub → Repositories</b>:</p>
<p><code>${esc(base)}</code></p>
${mods.length ? '' : '<p>This repository has no packages yet.</p>\n'}<table><tr><th>Package</th><th>Version</th><th>Consoles</th><th>Creator</th><th>Category</th></tr>
${rows}
</table>
<p><small>Published with <a href="${STUDIO_URL}">Mod Hub Studio</a>.</small></p>
`;
}

function hostingGuide(base) {
  return `# Hosting this hmod repository

Upload everything in this folder to your web host so that this address works:

    ${base || 'https://example.com/my-repo'}/.repo/pack.tgz

Keep the hidden \`.repo\` folder and the \`.nojekyll\` file. GitHub Pages skips
folders starting with a dot unless \`.nojekyll\` is present.

## Add it in Hakchi2 CE

Modules → Mod Hub → Repositories → add:

    ${base || 'https://example.com/my-repo'}

Hakchi2 CE appends \`/.repo/\` itself and downloads \`pack.tgz\`.

## Install from the console

hakchi can also install straight from the repository over SSH or telnet.
Add the address to \`/etc/hmodrepos.conf\`, then run \`hmod rlist\` or
\`hmod rinstall <name>\`. That path reads \`.repo/list\` and
\`.repo/<name>.hmod/link\`, which is why those loose files are included next
to pack.tgz. The console only installs .hmod packages this way; .clvg
games are installed through Hakchi2 CE.

## Updating a mod

Re-export from the publisher and upload again. Keep each mod's file name the
same between releases: hakchi tracks installs by file name, and a renamed
package installs alongside the old one instead of replacing it.
`;
}
