// Explains automatic fixes: what each one does, and exactly what changed in a
// package after fixes were applied, so nothing is changed without saying so.
import { hmodFileName } from './pack.js';

// What each fix changes, in plain words.
export const FIX_DESCRIPTIONS = {
  'backslash-paths': 'Turns \\ in file paths into /, so the files land in folders on the console instead of getting \\ in their names.',
  junk: 'Removes operating-system clutter such as .DS_Store, Thumbs.db, desktop.ini and __MACOSX.',
  wrapper: 'Moves everything out of the single folder wrapping the package, so its contents sit at the package root.',
  'rootfs-prefix': 'Strips var/lib/hakchi/rootfs/ from the front of paths; hakchi already installs into that folder.',
  'root-case': 'Lowercases top-level folder names such as Etc or USR, since the console\'s file system is case-sensitive.',
  'nested-hmod': 'Removes .hmod files inside the package; hakchi skips them anyway.',
  'preinit-newline': 'Adds a final line break to boot scripts, so their last line isn\'t joined to the next script.',
  'crlf-exec': 'Converts Windows line endings (CRLF) to Unix ones (LF) in scripts, which the console\'s shell needs.',
  'exec-bit': 'Marks scripts and programs as executable.',
  'install-return': 'Adds `return 0` at the end of install, so hakchi goes on to copy the files.',
  'readme-top': 'Writes the readme\'s --- block at the very top of readme.md.',
  'bad-name': 'Replaces characters hakchi can\'t use in the package name.',
  'ui-move': 'Moves theme files into the console UI folder they belong in.',
  'package-id': 'Renames the package to the suggested Package ID.',
};

const fmtMode = (m) => (m == null ? 'unset' : (m & 0o777).toString(8));
const textOf = (u8) => { try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); } catch { return null; } };

// What changed in a file's contents, as specifically as it can be said.
function describeEdit(path, a, b) {
  const ta = textOf(a);
  const tb = textOf(b);
  if (ta != null && tb != null) {
    const parts = [];
    let t = ta;
    if (t.includes('\r\n') && !tb.includes('\r\n')) { parts.push('Windows line endings converted to Unix'); t = t.replace(/\r\n/g, '\n'); }
    if (t !== tb && tb.startsWith(t.replace(/\s*$/, ''))) {
      const added = tb.slice(t.replace(/\s*$/, '').length).trim();
      parts.push(added ? `added ${added.includes('\n') ? 'lines' : `\`${added}\``} at the end` : 'final line break added');
      t = tb;
    }
    if (t === tb && parts.length) return `${path}: ${parts.join('; ')}`;
  }
  return `${path}: contents changed (${a.length} → ${b.length} bytes)`;
}

// before/after: the same package before and after fixes.
// Returns [{ kind, text }] with kind one of renamed, moved, removed, added, edited, mode, readme.
export function describeChanges(before, after) {
  const out = [];
  if (before.name !== after.name) {
    const files = hmodFileName(before) !== hmodFileName(after) ? ` (${hmodFileName(before)} → ${hmodFileName(after)})` : '';
    out.push({ kind: 'renamed', text: `Package name: ${before.name} → ${after.name}${files}` });
  }
  if (before.readmeProblem && !after.readmeProblem) out.push({ kind: 'readme', text: 'readme.md: the --- block is now written at the top' });

  const was = new Map(before.files.map((f) => [f.path, f]));
  const now = new Map(after.files.map((f) => [f.path, f]));
  const gone = before.files.filter((f) => !now.has(f.path));
  const fresh = after.files.filter((f) => !was.has(f.path));
  const base = (p) => p.split('/').pop().toLowerCase();
  // Pair each moved file with where it went: first by its contents (a move keeps
  // the same contents object), then by file name when only one file matches.
  const pairs = [];
  const taken = new Set();
  const left = [];
  const byData = new Map();
  for (const f of fresh) if (f.data && f.data.length && !byData.has(f.data)) byData.set(f.data, f);
  for (const f of gone) {
    const to = f.data && f.data.length ? byData.get(f.data) : null;
    if (to && !taken.has(to)) { taken.add(to); pairs.push([f, to]); } else left.push(f);
  }
  const removed = [];
  for (const f of left) {
    const same = fresh.filter((g) => !taken.has(g) && base(g.path) === base(f.path));
    const others = left.filter((g) => base(g.path) === base(f.path));
    if (same.length === 1 && others.length === 1) { taken.add(same[0]); pairs.push([f, same[0]]); } else removed.push(f);
  }
  // The readme leaves the file list when it's read into the Readme tab.
  const readmeTaken = after.readmeFound && !before.readmeFound;
  for (const f of removed) {
    if (readmeTaken && /(^|\/)readme(\.(md|txt))?$/i.test(f.path)) out.push({ kind: 'readme', text: `${f.path}: read into the Readme tab, and packed as readme.md at the root` });
    else out.push({ kind: 'removed', text: `Removed ${f.path}` });
  }
  for (const f of fresh) if (!taken.has(f)) out.push({ kind: 'added', text: `Added ${f.path}` });
  for (const [f, to] of pairs) out.push({ kind: 'moved', text: `${f.path} → ${to.path}` });
  const same = after.files.filter((f) => was.has(f.path)).map((f) => [was.get(f.path), f]);
  for (const [g, f] of [...same, ...pairs]) {
    if (g.data !== f.data && !(g.data.length === f.data.length && g.data.every((b, i) => b === f.data[i]))) out.push({ kind: 'edited', text: describeEdit(f.path, g.data, f.data) });
    if ((g.mode ?? null) !== (f.mode ?? null) && f.type === 'file') out.push({ kind: 'mode', text: `${f.path}: permissions ${fmtMode(g.mode)} → ${fmtMode(f.mode)}` });
  }
  return out;
}

// Groups changes for display, largest groups shortened.
export const CHANGE_LABELS = {
  renamed: 'Renamed', readme: 'Readme', moved: 'Moved', removed: 'Removed', added: 'Added', edited: 'Edited', mode: 'Permissions',
};
