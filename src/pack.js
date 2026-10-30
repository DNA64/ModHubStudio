import { buildTar, gzip, textBytes } from './tar.js';
import { serializeReadme } from './readme.js';
import { fileMode, CONTROL_FILES, cleanName } from './rules.js';
import { resolveTargets, formatConsolesField, TARGET_IDS } from './targets.js';

export function hmodFileName(mod) {
  // Hakchi2 CE cleans hmod names (Hmod.GetCleanName); game archives keep their name.
  if (mod.kind === 'game') return `${mod.name.replace(/[\\/:*?"<>|]/g, '_') || 'game'}.clvg`;
  return `${cleanName(mod.name) || 'mod'}.hmod`;
}

export function readmeText(mod) {
  const front = { ...mod.readme.front };
  if (!front.Name) front.Name = mod.name;
  // Record the consoles in the readme so the Mod Hub shows them (CE lists extra fields).
  const { ids } = resolveTargets(mod);
  if (ids.length && ids.length < TARGET_IDS.length) front.Consoles = formatConsolesField(ids);
  else delete front.Consoles;
  return serializeReadme({ ...mod.readme, front });
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
