// Builds a self-hostable Hakchi2 CE Mod Hub repository.
// Format from hakchi2-CE ModHub/Repository/Repository.cs and hakchi's `hmod rinstall`:
//   <base>/.repo/pack.tgz            list + readme.md + <mod>.hmod/{link,md5,sha1,readme.md}
//   <base>/.repo/list                one "<name>.hmod" per line (used by the console's rlist)
//   <base>/.repo/<mod>.hmod/link     absolute URL of the .hmod (used by `hmod rinstall`)
import { buildTar, gzip, textBytes } from './tar.js';
import { hmodFileName, readmeText } from './pack.js';
import { resolveTargets, TARGET_IDS, TARGETS } from './targets.js';
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
  return out;
}

export function modLink(repo, mod) {
  if (mod.externalUrl) return mod.externalUrl.trim();
  return `${normalizeBase(repo.baseUrl)}/${mod.kind === 'game' ? 'games' : 'hmods'}/${encodeURIComponent(hmodFileName(mod))}`;
}

async function sha1Hex(u8) {
  const d = await crypto.subtle.digest('SHA-1', u8);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function md5Hex(u8) {
  const SparkMD5 = globalThis.SparkMD5;
  return SparkMD5.ArrayBuffer.hash(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
}

// packed: Map<modId, Uint8Array> of .hmod bytes.
// Returns [{path, data}] describing every file to upload, relative to the host root.
export async function buildRepoFiles(repo, mods, packed) {
  const base = normalizeBase(repo.baseUrl);
  const files = [];
  const meta = [];
  const listLines = [];
  for (const mod of mods) {
    const fname = hmodFileName(mod);
    const bytes = packed.get(mod.id);
    const link = modLink(repo, mod);
    const readme = readmeText(mod);
    listLines.push(fname);
    meta.push({ path: `${fname}/link`, data: textBytes(link + '\n') });
    meta.push({ path: `${fname}/md5`, data: textBytes(md5Hex(bytes) + '\n') });
    meta.push({ path: `${fname}/sha1`, data: textBytes((await sha1Hex(bytes)) + '\n') });
    meta.push({ path: `${fname}/readme.md`, data: textBytes(readme) });
    if (!mod.externalUrl) files.push({ path: `${mod.kind === 'game' ? 'games' : 'hmods'}/${fname}`, data: bytes });
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
  files.push({ path: '.nojekyll', data: new Uint8Array(0) });
  files.push({ path: 'index.html', data: textBytes(indexHtml(repo, mods, base)) });
  files.push({ path: 'HOSTING.md', data: textBytes(hostingGuide(base)) });
  return files;
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
    const t = resolveTargets(m).ids;
    const consoles = t.length === TARGET_IDS.length ? 'All' : t.map((x) => TARGETS[x].label).join(', ');
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
