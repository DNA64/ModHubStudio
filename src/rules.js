// Validation rules for hakchi hmods.
// Every rule is grounded in hakchi's own install code:
//   mod/hakchi/rootfs/etc/preinit.d/b0030_package  (pack_install / transfer_path)
//   mod/hakchi/rootfs/etc/preinit                   (source_parts, b????_* / p????_*)
//   hakchi2-CE hakchi_gui/Hmod/*.cs, ModHub/Repository/Repository.cs
import { bytesText, textBytes } from './tar.js';
import { REQUIRED_FIELDS } from './readme.js';
import { extractReadme } from './model.js';
import { validateTargets } from './targets.js';

// Folders the hakchi rootfs overlay can actually place files into.
export const OVERLAY_ROOTS = ['bin', 'sbin', 'etc', 'lib', 'usr', 'root'];
// Folders that exist on the console but are mounted over at boot.
const RUNTIME_ROOTS = ['var', 'tmp', 'media', 'mnt', 'dev', 'proc', 'sys', 'newroot'];
// Folders whose contents pack_install chmods 755.
export const EXEC_DIRS = ['bin', 'sbin', 'usr/bin', 'usr/sbin', 'etc/init.d'];
// Top-level control scripts, never copied to the console.
export const CONTROL_FILES = ['install', 'uninstall', 'transfer'];
// UI resource folders hakchi itself addresses (fontfix: ui/$sftype-$sfregion).
export const UI_FOLDERS = {
  'snes-usa': 'SNES Classic (North America)',
  'snes-eur': 'SNES Classic (Europe/Australia)',
  shvc: 'Super Famicom Classic (Japan)',
  hvc: 'Shonen Jump Famicom (Japan)',
};
// From mod/hakchi/rootfs/etc/hmodblacklist: hakchi refuses to install these.
export const BLACKLIST = ['clovershell', 'extra_space', 'fontfix', 'multiboot_fixes', 'nesc_hybrid_system',
  'password', 'shonen_fix', 'tiny7zx-dynamic', 'zram-3.4.113.23-madmonkey'];
const JUNK_RE = /(^|\/)(__MACOSX(\/|$)|\.DS_Store$|Thumbs\.db$|desktop\.ini$|\._[^/]+$|\.git(\/|$))/i;
const ROOTFS_PREFIX_RE = /^((newroot\/)?var\/lib\/hakchi\/rootfs|hakchi\/rootfs|rootfs)\//;
const PREINIT_DIR = 'etc/preinit.d/';
const PREINIT_NAME_RE = /^[bp][^/]{4}_[^/]+$/;
export const BAD_NAME_CHARS = /[^a-zA-Z0-9_\-.]/g;

const isText = (u8) => {
  const n = Math.min(u8.length, 4096);
  for (let i = 0; i < n; i++) if (u8[i] === 0) return false;
  return true;
};
const hasShebang = (u8) => u8.length > 2 && u8[0] === 0x23 && u8[1] === 0x21;
const isElf = (u8) => u8.length > 4 && u8[0] === 0x7f && u8[1] === 0x45 && u8[2] === 0x4c && u8[3] === 0x46;
const hasCRLF = (u8) => { for (let i = 0; i < u8.length - 1; i++) if (u8[i] === 13 && u8[i + 1] === 10) return true; return false; };
const toLF = (u8) => textBytes(bytesText(u8).replace(/\r\n/g, '\n'));
const inExecDir = (p) => EXEC_DIRS.some((d) => p.startsWith(d + '/') && !p.slice(d.length + 1).includes('/'));
const stripComments = (s) => s.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).join('\n');
// `exit` as a command: at the start of a line or after ; & | ( { then do else.
const hasExit = (code) => /(^|[;&|({]|\b(?:then|do|else)\b)\s*exit(?=\s|;|$)/m.test(code);
// Code outside every { } block, so outside any function body.
function topLevelCode(code) {
  let depth = 0;
  const out = [];
  for (const line of code.split('\n')) {
    const bare = line.replace(/\$\{[^}]*\}/g, '');
    if (depth === 0) out.push(line);
    depth = Math.max(0, depth + (bare.match(/\{/g) || []).length - (bare.match(/\}/g) || []).length);
  }
  return out.join('\n');
}
const hasTopLevelReturn = (code) => /(^|[;&|({]|\b(?:then|do|else)\b)\s*return(?=\s|;|$)/m.test(topLevelCode(code));
const lastCodeLine = (s) => stripComments(s).split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
const top = (p) => p.split('/')[0];

export function cleanName(name) {
  return name.replace(BAD_NAME_CHARS, '_');
}

function commonWrapper(files) {
  if (!files.length) return null;
  const firsts = new Set(files.map((f) => (f.path.includes('/') ? top(f.path) : null)));
  if (firsts.size !== 1) return null;
  const only = [...firsts][0];
  if (!only || only === '..') return null;
  if (OVERLAY_ROOTS.includes(only) || RUNTIME_ROOTS.includes(only)) return null;
  return only;
}

export const FIXES = {
  'backslash-paths': (mod) => ({ ...mod, files: mod.files.map((f) => ({ ...f, path: f.path.replace(/\\/g, '/') })) }),
  junk: (mod) => ({ ...mod, files: mod.files.filter((f) => !JUNK_RE.test(f.path)) }),
  wrapper: (mod) => {
    const w = commonWrapper(mod.files);
    if (!w) return mod;
    const next = { ...mod, files: mod.files.map((f) => ({ ...f, path: f.path.slice(w.length + 1) })) };
    return mod.readmeFound ? next : extractReadme(next);
  },
  'rootfs-prefix': (mod) => ({ ...mod, files: mod.files.map((f) => ({ ...f, path: f.path.replace(ROOTFS_PREFIX_RE, '') })) }),
  'root-case': (mod) => ({
    ...mod,
    files: mod.files.map((f) => {
      const segs = f.path.split('/');
      const lower = segs[0].toLowerCase();
      if (segs.length > 1 && segs[0] !== lower && [...OVERLAY_ROOTS, ...RUNTIME_ROOTS].includes(lower)) segs[0] = lower;
      if (segs[0] === 'usr' && segs[1] && ['share', 'bin', 'sbin', 'lib'].includes(segs[1].toLowerCase())) segs[1] = segs[1].toLowerCase();
      if (segs[0] === 'etc' && segs[1] && ['preinit.d', 'init.d'].includes(segs[1].toLowerCase())) segs[1] = segs[1].toLowerCase();
      return { ...f, path: segs.join('/') };
    }),
  }),
  'preinit-newline': (mod) => ({
    ...mod,
    files: mod.files.map((f) => (f.path.startsWith(PREINIT_DIR) && f.type === 'file' && f.data.length && f.data[f.data.length - 1] !== 10
      ? { ...f, data: new Uint8Array([...f.data, 10]) } : f)),
  }),
  'crlf-exec': (mod) => ({
    ...mod,
    files: mod.files.map((f) => (f.type === 'file' && hasShebang(f.data) && hasCRLF(f.data) ? { ...f, data: toLF(f.data) } : f)),
  }),
  'exec-bit': (mod) => ({
    ...mod,
    files: mod.files.map((f) => (needsExecBit(f) ? { ...f, mode: 0o755 } : f)),
  }),
  'install-return': (mod) => ({
    ...mod,
    files: mod.files.map((f) => (f.path === 'install' ? { ...f, data: textBytes(bytesText(f.data).replace(/\s*$/, '') + '\nreturn 0\n') } : f)),
  }),
  'ui-move': (mod) => {
    const folders = new Set(mod.files.map((f) => (f.path.match(/^usr\/share\/ui\/([^/]+)\//) || [])[1]).filter(Boolean));
    const known = [...folders].filter((k) => UI_FOLDERS[k]);
    if (known.length !== 1) return mod;
    return { ...mod, files: mod.files.map((f) => {
      const m = f.path.match(/^usr\/share\/ui\/([^/]+)\/(.*)$/);
      return m && !UI_FOLDERS[m[1]] ? { ...f, path: `usr/share/ui/${known[0]}/${m[2]}` } : f;
    }) };
  },
  'bad-name': (mod) => ({ ...mod, name: cleanName(mod.name) }),
  'readme-top': (mod) => ({ ...mod, readmeProblem: null }),
  'nested-hmod': (mod) => ({ ...mod, files: mod.files.filter((f) => !/\.hmod(\/|$)/i.test(f.path)) }),
};

function needsExecBit(f) {
  if (f.type !== 'file' || inExecDir(f.path) || CONTROL_FILES.includes(f.path)) return false;
  if (f.path.startsWith(PREINIT_DIR)) return false;
  if (!(hasShebang(f.data) || isElf(f.data))) return false;
  return f.mode == null || (f.mode & 0o111) === 0;
}

export function validate(mod) {
  const issues = [];
  const add = (id, severity, title, detail, paths = [], fixLabel = null) =>
    issues.push({ id, severity, title, detail, paths, fixLabel: FIXES[id] ? fixLabel : null });
  const files = mod.files;
  const paths = files.map((f) => f.path);

  // --- Package-level
  if (mod.source?.nested?.length) {
    const folderOnly = mod.source.nested.every((n) => n.endsWith('/'));
    add('nested-archive', 'info', folderOnly ? 'Skipped the outer folder' : 'Opened the archive inside the package',
      folderOnly
        ? `Everything sat in ${mod.source.nested.map((n) => '`' + n + '`').join(', ')}, named after the package, so that folder was treated as your working folder and left out.`
        : `The package only held ${mod.source.nested.map((n) => '`' + n + '`').join(', then ')}, another archive, so that was opened and checked instead. Packing here writes the files directly, the way Hakchi2 CE expects.`);
  }
  const mm = mod.source?.kindMismatch;
  if (mm && mod.source?.kindFrom !== 'manual' && mm.fromContent === mod.kind) {
    const ext = { hmod: '.hmod', game: '.clvg' };
    add('kind-mismatch', 'error', mm.fromContent === 'game' ? `Named ${ext[mm.fromName]} but contains a game` : `Named ${ext[mm.fromName]} but contains a mod`,
      mm.fromContent === 'game'
        ? 'It has a top-level .desktop file and no system folders, which is a game. As a .hmod, hakchi would copy the game files into the console\'s root instead of adding a game. Packing here writes it as .clvg; switch it to Mod above if it really is a mod.'
        : 'It has system folders or install scripts, which is a mod. Hakchi2 CE would try to import it as a game and fail. Packing here writes it as .hmod; switch it to Game above if it really is a game.',
      mm.evidence);
  }
  if (mod.kind === 'game') return validateGame(mod, issues, add);
  if (mod.source?.kind === 'zip') {
    add('container-zip', 'info', 'Source was a ZIP archive',
      'hakchi installs hmods with `tar -xzf`, so a ZIP renamed to .hmod fails on the console. Packing here writes a proper tar.gz.');
  } else if (mod.source?.kind === 'tar') {
    add('container-tar', 'info', 'Source was an uncompressed tar',
      'hakchi expects gzip compression (`tar -xzf`). Packing here writes a proper tar.gz.');
  }
  if (!files.length) {
    add('empty', 'error', 'Nothing to install', 'The package has no files and no install script, so installing it does nothing.');
  }

  const bs = paths.filter((p) => p.includes('\\'));
  if (bs.length) add('backslash-paths', 'error', 'Windows path separators',
    'These entries use backslashes, which Linux treats as part of the file name. The console would get one file literally named `usr\\share\\…` in the root.', bs, 'Convert to forward slashes');

  const dotdot = paths.filter((p) => p.split('/').includes('..'));
  if (dotdot.length) add('path-dotdot', 'error', 'Paths that climb out of the package',
    'A .. folder in a path makes tar write outside the folder hakchi unpacks into.', dotdot);

  const junk = paths.filter((p) => JUNK_RE.test(p));
  if (junk.length) add('junk', 'warning', 'OS junk files included',
    'Finder, Explorer or git metadata would be copied onto the console and waste NAND space.', junk, 'Remove them');

  const wrapper = commonWrapper(files.filter((f) => !JUNK_RE.test(f.path) && !f.path.includes('\\')));
  if (wrapper) add('wrapper', 'error', `Everything is inside a "${wrapper}" folder`,
    `hakchi copies the package root to the console root, so these files would land in /${wrapper}/… instead of where you intended. Hakchi2 CE also won't find the readme. This usually happens when the archive was made from the parent folder.`,
    [wrapper + '/'], `Move contents up out of ${wrapper}/`);

  // Everything below looks at the package as it would be after the structural
  // fixes above, so one wrapper folder doesn't hide every other problem.
  let view = FIXES['backslash-paths'](FIXES.junk(mod));
  if (wrapper) view = FIXES.wrapper(view);
  return [...issues, ...validateContent(view, mod)].filter((i) => !new Set(mod.dismissed || []).has(i.id));
}

// .clvg game archives: Hakchi2 CE extracts them and imports the top-level *.desktop
// (Tasks/AddGamesTask.cs), the same layout GameTask.Archive writes.
function validateGame(mod, issues, add) {
  const junk = mod.files.filter((f) => JUNK_RE.test(f.path)).map((f) => f.path);
  if (junk.length) add('junk', 'warning', 'OS junk files included',
    'Finder, Explorer or git metadata would be copied into the game folder on the console.', junk, 'Remove them');
  const bs = mod.files.filter((f) => f.path.includes('\\')).map((f) => f.path);
  if (bs.length) add('backslash-paths', 'error', 'Windows path separators',
    'These entries use backslashes, which Linux treats as part of the file name.', bs, 'Convert to forward slashes');
  let view = FIXES['backslash-paths'](FIXES.junk(mod));
  const wrapper = commonWrapper(view.files);
  if (wrapper) {
    add('wrapper', 'error', `Everything is inside a "${wrapper}" folder`,
      'Hakchi2 CE only looks for the .desktop file at the top of a .clvg, so a wrapped game fails to import.', [wrapper + '/'], `Move contents up out of ${wrapper}/`);
    view = FIXES.wrapper(view);
  }
  const files = view.files;
  if (!files.length) add('empty', 'error', 'Empty game archive', 'There is nothing to import.');
  const desktops = files.filter((f) => /^[^/]+\.desktop$/i.test(f.path));
  if (!desktops.length && files.length) {
    const deeper = files.filter((f) => f.path.toLowerCase().endsWith('.desktop')).map((f) => f.path);
    add('game-no-desktop', 'error', 'No .desktop file at the top of the archive',
      'Hakchi2 CE imports a .clvg by finding its CLV-X-XXXXX.desktop at the top level. Without one, the import fails.', deeper);
  } else if (desktops.length > 1) {
    add('game-many-desktop', 'warning', 'More than one .desktop file',
      'Hakchi2 CE stops and asks the user which game to import. Publish one game per .clvg.', desktops.map((f) => f.path));
  }
  for (const d of desktops.slice(0, 1)) {
    const code = d.path.replace(/\.desktop$/i, '');
    if (!/^CLV-[A-Z]-[A-Z0-9]{5}$/.test(code)) add('game-code', 'warning', 'Unusual game code',
      `Game codes look like CLV-H-ABCDE. Hakchi2 CE uses ${code} as the folder name and save-state key, so a non-standard code can collide with other games.`, [d.path]);
    const text = bytesText(d.data);
    const missingKeys = ['Exec', 'Name'].filter((k) => !new RegExp(`^${k}=.+`, 'm').test(text));
    if (missingKeys.length) add('game-desktop-keys', 'error', `.desktop file missing ${missingKeys.join(' and ')}`,
      'Without Exec the console cannot launch the game; without Name the menu shows no title.', [d.path]);
    if (!files.some((f) => f.path === `${code}.png`)) add('game-art', 'info', 'No cover art',
      `Hakchi2 CE shows the game with a placeholder until ${code}.png is added.`, [`${code}.png`]);
  }
  validateTargets(view, add);
  return issues.filter((i) => !new Set(mod.dismissed || []).has(i.id));
}

function validateContent(mod, original) {
  const issues = [];
  const add = (id, severity, title, detail, paths = [], fixLabel = null) =>
    issues.push({ id, severity, title, detail, paths, fixLabel: FIXES[id] ? fixLabel : null });
  let files = mod.files;
  let paths = files.map((f) => f.path);
  const wrapper = null;
  const prefixed = paths.filter((p) => ROOTFS_PREFIX_RE.test(p));
  if (prefixed.length) add('rootfs-prefix', 'error', 'Paths already include the hakchi rootfs',
    'hakchi copies the package into /var/lib/hakchi/rootfs for you. Including that prefix doubles it, so the files never overlay the real filesystem.', prefixed, 'Strip the rootfs prefix');

  // --- Where files land
  const caseBad = paths.filter((p) => {
    const s = p.split('/');
    if (s.length < 2) return false;
    const l = s[0].toLowerCase();
    if (s[0] !== l && [...OVERLAY_ROOTS, ...RUNTIME_ROOTS].includes(l)) return true;
    if (s[0] === 'usr' && s[2] !== undefined && s[1] !== s[1].toLowerCase() && ['share', 'bin', 'sbin', 'lib'].includes(s[1].toLowerCase())) return true;
    if (s[0] === 'etc' && s[2] !== undefined && s[1] !== s[1].toLowerCase() && ['preinit.d', 'init.d'].includes(s[1].toLowerCase())) return true;
    return false;
  });
  if (caseBad.length) add('root-case', 'error', 'Wrong capitalisation in system folders',
    'The console filesystem is case-sensitive: `Usr/Share` and `usr/share` are different folders, and only the lowercase one is used.', caseBad, 'Lowercase the system folders');

  // Deeper checks see paths as they'd be once prefix and case are fixed.
  if (prefixed.length || caseBad.length) {
    mod = FIXES['root-case'](FIXES['rootfs-prefix'](mod));
    files = mod.files;
    paths = files.map((f) => f.path);
  }
  const dirPaths = new Set(files.filter((f) => f.type === 'dir').map((f) => f.path));
  const loose = [];
  const unknownRoot = [];
  const runtimeRoot = [];
  const nested = [];
  const droppedDocs = [];
  for (const p of paths) {
    if (/\.hmod(\/|$)/i.test(p)) { nested.push(p); continue; }
    if (!p.includes('/') && !dirPaths.has(p)) {
      if (CONTROL_FILES.includes(p)) continue;
      if (/^readme(\..*)?$/i.test(p) || /\.(txt|md)$/i.test(p)) { droppedDocs.push(p); continue; }
      loose.push(p);
      continue;
    }
    const t = top(p);
    if (p.includes('\\') || JUNK_RE.test(p)) continue;
    if (RUNTIME_ROOTS.includes(t)) runtimeRoot.push(p);
    else if (!OVERLAY_ROOTS.includes(t)) unknownRoot.push(p);
  }
  if (loose.length) add('loose-root', 'warning', 'Files at the package root',
    'Loose files at the root are copied straight into / on the console. That is almost never intended; put them under a real folder such as usr/share/<your-mod>/.', loose);
  if (unknownRoot.length) add('unknown-root', 'warning', 'Installs outside the usual system folders',
    `These go into top-level folders the console doesn't have. hakchi only overlays ${OVERLAY_ROOTS.map((r) => '/' + r).join(', ')} reliably.`, unknownRoot);
  if (runtimeRoot.length) add('runtime-root', 'warning', 'Installs into a folder that gets mounted over',
    '/var, /tmp, /media and similar are mounted at boot, which hides anything an hmod puts there. Use a preinit script to copy or link files there at boot instead.', runtimeRoot);
  if (nested.length) add('nested-hmod', 'warning', 'Contains other .hmod files',
    'pack_install skips anything named *.hmod, so these are silently dropped. Publish them as separate mods.', nested, 'Remove nested hmods');
  if (droppedDocs.length) add('dropped-docs', 'info', 'Extra docs at the root are not installed',
    'hakchi deletes readme*, *.txt and *.md from the package root before copying. That is fine for documentation; move anything the mod needs at runtime into a subfolder.', droppedDocs);

  // --- Themes / UI folders
  const uiFolders = new Map();
  for (const p of paths) {
    const m = p.match(/^usr\/share\/ui\/([^/]+)\//);
    if (m) uiFolders.set(m[1], (uiFolders.get(m[1]) || 0) + 1);
  }
  const unknownUi = [...uiFolders.keys()].filter((k) => !UI_FOLDERS[k]);
  const onlyKnown = [...uiFolders.keys()].filter((k) => UI_FOLDERS[k]);
  if (unknownUi.length) add(onlyKnown.length === 1 ? 'ui-move' : 'ui-unknown', 'error', 'Theme files in a UI folder no console uses',
    `Console UIs live in usr/share/ui/${Object.keys(UI_FOLDERS).join(', usr/share/ui/')} (and usr/share/clover-ui on the NES Classic). Files under ${unknownUi.map((u) => 'ui/' + u).join(', ')} are never read.`,
    paths.filter((p) => unknownUi.some((u) => p.startsWith(`usr/share/ui/${u}/`))),
    onlyKnown.length === 1 ? `Move into ui/${onlyKnown[0]}` : null);
  // --- preinit scripts
  const preinit = files.filter((f) => f.path.startsWith(PREINIT_DIR) && f.type === 'file');
  const badPreinitName = preinit.filter((f) => !PREINIT_NAME_RE.test(f.path.slice(PREINIT_DIR.length)));
  if (badPreinitName.length) add('preinit-name', 'error', 'Boot scripts that will never run',
    'hakchi only sources files matching b????_* or p????_* directly inside etc/preinit.d (for example p8030_mymod). Other names and subfolders are ignored.', badPreinitName.map((f) => f.path));
  const okPreinit = preinit.filter((f) => !badPreinitName.includes(f));
  const coreRange = okPreinit.filter((f) => {
    const n = f.path.slice(PREINIT_DIR.length);
    return n[0] === 'p' && /^[0-7][0-9a-f]{3}$/i.test(n.slice(1, 5));
  });
  if (coreRange.length) add('preinit-order', 'info', 'Boot script runs among hakchi core scripts',
    'hakchi uses p0000–p7fff for its own boot steps (mounting, games, hmods). Mods conventionally use p8000 and up so the system is fully set up first.', coreRange.map((f) => f.path));
  const bScripts = okPreinit.filter((f) => f.path.slice(PREINIT_DIR.length)[0] === 'b');
  if (bScripts.length) add('preinit-b', 'info', 'Base (b) scripts load into every hakchi shell',
    'b-scripts are sourced whenever hakchi starts, not just at boot. Keep them to function definitions; do the actual work in a p-script.', bScripts.map((f) => f.path));
  const binaryPreinit = okPreinit.filter((f) => !isText(f.data));
  if (binaryPreinit.length) add('preinit-binary', 'error', 'Binary file in etc/preinit.d',
    'Every file here is concatenated and run as one shell script at boot. A binary breaks the whole boot sequence.', binaryPreinit.map((f) => f.path));
  const noNewline = okPreinit.filter((f) => isText(f.data) && f.data.length && f.data[f.data.length - 1] !== 10);
  if (noNewline.length) add('preinit-newline', 'error', 'Boot script missing a final newline',
    "hakchi concatenates every preinit script before running them. Without a trailing newline, this script's last line merges with the next script's first line and both break.", noNewline.map((f) => f.path), 'Add trailing newlines');
  const exitPreinit = okPreinit.filter((f) => isText(f.data) && hasExit(stripComments(bytesText(f.data))));
  if (exitPreinit.length) add('preinit-exit', 'error', '`exit` in a boot script',
    'All preinit scripts run in one shell, so `exit` aborts every script after it, including hakchi\'s own. Use an if-block instead, or wrap the work in a function.', exitPreinit.map((f) => f.path));
  const returnPreinit = okPreinit.filter((f) => isText(f.data) && hasTopLevelReturn(stripComments(bytesText(f.data))));
  if (returnPreinit.length) add('preinit-return', 'error', '`return` outside a function in a boot script',
    'hakchi joins every preinit script into one file and sources it, so a `return` at the top level ends that whole file and skips every script after it. Put it inside a function, or use an if-block.', returnPreinit.map((f) => f.path));

  // --- control scripts
  for (const name of CONTROL_FILES) {
    const f = files.find((x) => x.path === name);
    if (!f) continue;
    if (!isText(f.data)) { add(`binary-${name}`, 'error', `\`${name}\` is not a text script`, 'hakchi sources this file as a shell script.', [name]); continue; }
    const code = stripComments(bytesText(f.data).replace(/\r\n/g, '\n'));
    if (hasExit(code)) add(`exit-${name}`, 'error', `\`exit\` in ${name}`,
      `hakchi sources ${name} inside its own installer shell. \`exit\` ends the whole install, leaving later mods and the uninstall list unwritten. Use \`return\`.`, [name]);
  }
  const install = files.find((f) => f.path === 'install');
  if (install && isText(install.data)) {
    const last = lastCodeLine(bytesText(install.data).replace(/\r\n/g, '\n'));
    if (!/^return\b/.test(last)) add('install-return', 'warning', 'install does not end with a return',
      "If the last command in install fails, hakchi skips copying your files (transfer_path checks the script's status). End with `return 0` to copy them, or `return 1` on purpose to skip.", ['install'], 'Append return 0');
  }
  const uninstall = files.find((f) => f.path === 'uninstall');
  if (uninstall && /^no-uninstall$/m.test(bytesText(uninstall.data))) add('no-uninstall', 'info', 'Marked no-uninstall',
    "hakchi won't record this mod, so it won't appear in the installed list and can't be removed.", ['uninstall']);

  // --- executables and line endings
  const crlf = files.filter((f) => f.type === 'file' && hasShebang(f.data) && hasCRLF(f.data) && !f.path.startsWith(PREINIT_DIR) && !CONTROL_FILES.includes(f.path));
  if (crlf.length) add('crlf-exec', 'error', 'Scripts saved with Windows line endings',
    'A `#!/bin/sh\\r` first line makes the kernel look for a program called "sh\\r", so the script fails with "not found". hakchi only converts install, uninstall, transfer and preinit scripts.', crlf.map((f) => f.path), 'Convert to Unix line endings');
  const execNeeded = files.filter(needsExecBit);
  if (execNeeded.length) add('exec-bit', 'warning', 'Executables that won\'t be executable',
    `hakchi only marks files in ${EXEC_DIRS.join(', ')} executable. These look like scripts or programs but sit elsewhere without an executable bit.`, execNeeded.map((f) => f.path), 'Mark executable when packing');

  // --- duplicates by case
  const lower = new Map();
  for (const p of paths) {
    const k = p.toLowerCase();
    lower.set(k, [...(lower.get(k) || []), p]);
  }
  const dupes = [...lower.values()].filter((v) => v.length > 1).flat();
  if (dupes.length) add('case-dupes', 'warning', 'Paths that differ only by case',
    'They are separate files on the console but collide when the package is unpacked on Windows or macOS.', dupes);

  // --- name and readme
  if (cleanName(mod.name) !== mod.name) {
    add('bad-name', 'warning', 'File name has characters Hakchi2 CE replaces',
      `Hakchi2 CE renames it to ${cleanName(mod.name)}.hmod. Because the uninstall record uses the file name, renaming between releases leaves an orphaned old install.`, [mod.name + '.hmod'], `Rename to ${cleanName(mod.name)}`);
  }
  if (BLACKLIST.includes(mod.name)) add('blacklisted', 'error', 'Name is on hakchi\'s blacklist',
    `hakchi refuses to install a package called ${mod.name}.hmod (etc/hmodblacklist). Pick another name.`, [mod.name + '.hmod']);
  if (!mod.readmeFound && !Object.keys(mod.readme.front).length && !mod.readme.body) {
    add('readme-missing', 'warning', 'No readme',
      'Hakchi2 CE and the Mod Hub show the readme as the mod\'s description. Fill in the Readme tab; it is written as readme.md when you pack.');
  }
  if (mod.readmeProblem === 'not-at-top') add('readme-top', 'error', 'Readme front matter isn\'t at the very top',
    'Hakchi2 CE only reads the --- block when it is the first thing in the file, so Name, Creator and Version are ignored. Packing here writes it correctly.', [mod.readmeFound], 'Write it at the top');
  const missing = REQUIRED_FIELDS.filter((k) => !String(mod.readme.front[k] || '').trim());
  if (missing.length) add('readme-fields', missing.includes('Name') || missing.includes('Version') ? 'warning' : 'info',
    `Readme missing ${missing.join(', ')}`,
    'The Mod Hub lists mods by these fields; without Name it falls back to the file name and without Version users can\'t tell when to update.');

  validateTargets(mod, add);
  return issues;
}

export function applyFix(mod, id) {
  const fix = FIXES[id];
  return fix ? fix(mod) : mod;
}

// Fixes safe to apply without a human choosing (ui-move picks a region, so it stays manual).
export const AUTO_FIX_IDS = ['backslash-paths', 'junk', 'wrapper', 'rootfs-prefix', 'root-case', 'nested-hmod', 'preinit-newline', 'crlf-exec', 'exec-bit', 'install-return', 'readme-top', 'bad-name'];

export function applyAllFixes(mod) {
  let next = mod;
  // Order matters: separators, junk, wrapper, prefix, case, then file contents.
  const order = AUTO_FIX_IDS;
  for (let pass = 0; pass < 2; pass++) {
    const ids = new Set(validate(next).map((i) => i.id));
    for (const id of order) if (ids.has(id)) next = applyFix(next, id);
  }
  return next;
}

// Where a package path ends up on the console.
export function destination(path, kind = 'hmod') {
  if (kind === 'game') {
    if (/\.desktop$/i.test(path) && !path.includes('/')) return { kind: 'boot', label: 'Game entry, read on import' };
    return { kind: 'file', label: 'Game folder · ' + path };
  }
  if (CONTROL_FILES.includes(path)) return { kind: 'control', label: 'Run by hakchi at install' };
  if (/\.hmod(\/|$)/i.test(path)) return { kind: 'skipped', label: 'Skipped by hakchi' };
  if (!path.includes('/') && (/^readme(\..*)?$/i.test(path) || /\.(txt|md)$/i.test(path))) return { kind: 'skipped', label: 'Deleted before copy' };
  if (path.startsWith(PREINIT_DIR)) {
    const ok = PREINIT_NAME_RE.test(path.slice(PREINIT_DIR.length));
    return { kind: ok ? 'boot' : 'dead', label: ok ? '/' + path + ' · runs at boot' : '/' + path + ' · never runs' };
  }
  const ui = path.match(/^usr\/share\/ui\/([^/]+)\//);
  if (ui && !UI_FOLDERS[ui[1]]) return { kind: 'dead', label: '/' + path + ' · no console reads this' };
  return { kind: 'file', label: '/' + path };
}

export function fileMode(f, kind = 'hmod') {
  if (f.type === 'symlink') return 0o777;
  if (kind === 'game') return f.mode != null ? (f.mode & 0o777) || 0o644 : 0o644;
  if (CONTROL_FILES.includes(f.path)) return 0o644;
  if (f.path.startsWith(PREINIT_DIR)) return 0o644;
  if (inExecDir(f.path)) return 0o755;
  if (f.mode != null) return f.mode & 0o777 || 0o644;
  return 0o644;
}
