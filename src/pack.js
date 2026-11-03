import { buildTar, gzip, textBytes } from './tar.js';
import { serializeReadme, MANAGED_FIELDS, SYSTEMS_FIELD } from './readme.js';
import { fileMode, CONTROL_FILES, cleanName } from './rules.js';
import { resolveTargets, formatConsolesField } from './targets.js';
import { writeZip, write7z, FORMATS } from './archive.js';
import { isUnchanged } from './model.js';

// The name the repository lists the package under. A package opened from an
// existing repository keeps its listed name until it's renamed here.
export function hmodFileName(mod) {
  if (mod.origin && mod.name === mod.origin.name) return mod.origin.fileName;
  // Hakchi2 CE cleans hmod names (Hmod.GetCleanName); game archives keep their name.
  if (mod.kind === 'game') return `${mod.name.replace(/[\\/:*?"<>|]/g, '_') || 'game'}.clvg`;
  return `${cleanName(mod.name) || 'mod'}.hmod`;
}

export function readmeText(mod) {
  const front = { ...mod.readme.front };
  if (!front.Name) front.Name = mod.name;
  // Record the consoles in the readme so the Mod Hub shows them (CE lists extra fields).
  // Every selected console is listed, all three included.
  const { ids } = resolveTargets(mod);
  const at = (mod.readme.order || []).findIndex((k) => MANAGED_FIELDS.includes(k));
  for (const k of MANAGED_FIELDS) delete front[k];
  let order = (mod.readme.order || []).filter((k) => !MANAGED_FIELDS.includes(k));
  if (ids.length) {
    front[SYSTEMS_FIELD] = formatConsolesField(ids);
    // Keep it where the old field was, if there was one.
    order = at >= 0 ? [...order.slice(0, at), SYSTEMS_FIELD, ...order.slice(at)] : order;
  }
  return serializeReadme({ ...mod.readme, front, order });
}

// Entries in the order a person would read them: control scripts, readme, then the tree.
export function packEntries(mod) {
  const files = mod.files.filter((f) => f.type !== 'dir').map((f) => ({ ...f, mode: fileMode(f, mod.kind) }));
  const emptyDirs = mod.files.filter((f) => f.type === 'dir').map((f) => f.path);
  const control = CONTROL_FILES.map((n) => files.find((f) => f.path === n)).filter(Boolean);
  const rest = files.filter((f) => mod.kind === 'game' || !CONTROL_FILES.includes(f.path)).sort((a, b) => a.path.localeCompare(b.path));
  const dirs = new Set();
  for (const f of [...rest, ...emptyDirs.map((path) => ({ path: `${path}/.`}))]) {
    const segs = f.path.split('/');
    for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join('/'));
  }
  const dirEntries = [...dirs].sort().map((d) => ({ path: d, type: 'dir', mode: 0o755 }));
  if (mod.kind === 'game') return mergeTree(dirEntries, rest);
  const readme = { path: 'readme.md', type: 'file', data: textBytes(readmeText(mod)), mode: 0o644 };
  // Directories before files so `tar -x` creates them with the right mode.
  const ordered = [...control, readme, ...mergeTree(dirEntries, rest)];
  return ordered;
}

function mergeTree(dirs, files) {
  return [...dirs, ...files].sort((a, b) => {
    const pa = a.type === 'dir' ? a.path + '/' : a.path;
    const pb = b.type === 'dir' ? b.path + '/' : b.path;
    return pa < pb ? -1 : pa > pb ? 1 : 0;
  });
}

export async function packHmod(mod) {
  return gzip(buildTar(packEntries(mod)));
}

// The name of the package's file on the web host. ZIP and 7z packages keep
// their extension there; the repository still lists them as .hmod / .clvg.
export function serverFileName(mod) {
  const listed = hmodFileName(mod);
  return mod.format ? listed.replace(/\.(hmod|clvg)$/i, '') + FORMATS[mod.format].ext : listed;
}

// True when the package is published as the file it was opened from.
export const keepsOriginal = (mod) => !!(mod.original && mod.original.bytes && (mod.format || mod.origin) && isUnchanged(mod));

// The bytes to publish: the original file when nothing changed (for ZIP, 7z and
// packages opened from an existing repository), otherwise freshly packed in the
// package's own format.
export async function packPackage(mod) {
  if (keepsOriginal(mod)) return mod.original.bytes;
  if (mod.unavailable) throw new Error(`${hmodFileName(mod)} couldn't be downloaded, so it can't be packed.`);
  if (mod.format === 'zip') return writeZip(packEntries(mod));
  if (mod.format === '7z') return write7z(packEntries(mod));
  return packHmod(mod);
}
