// "Ready to publish": the author confirms a package's readme on its Readme tab
// before it can be published. Name, Creator, Category and Version must be filled
// in, and at least one console selected; the other standard fields only get a warning.
import { REQUIRED_FIELDS, STANDARD_FIELDS } from './readme.js';
import { resolveTargets } from './targets.js';
import { keepsOriginal, hmodFileName } from './pack.js';

const filled = (mod, k) => !!String(mod.readme.front[k] || '').trim();

// What still has to be filled in: the four readme fields, and at least one console.
export const missingRequired = (mod) => [
  ...REQUIRED_FIELDS.filter((k) => !filled(mod, k)),
  ...(resolveTargets(mod).ids.length ? [] : ['Consoles']),
];
// Emulator and core packages: their Category says so.
export const isEmulatorOrCore = (mod) => /\b(emulators?|cores?)\b/i.test(String(mod.readme.front.Category || ''));

const EXEC_DIRS = ['bin/', 'sbin/', 'usr/bin/', 'usr/sbin/'];
const isElf = (u8) => u8.length > 4 && u8[0] === 0x7f && u8[1] === 0x45 && u8[2] === 0x4c && u8[3] === 0x46;
const hasShebang = (u8) => u8.length > 2 && u8[0] === 0x23 && u8[1] === 0x21;
// Something a user runs: a program, or a script in a bin folder or marked
// executable. install/uninstall/transfer and boot scripts don't count.
export function hasExecutable(mod) {
  return mod.files.some((f) => {
    if (f.type !== 'file' || ['install', 'uninstall', 'transfer'].includes(f.path) || f.path.startsWith('etc/preinit.d/')) return false;
    if (isElf(f.data)) return true;
    if (EXEC_DIRS.some((d) => f.path.startsWith(d))) return true;
    return hasShebang(f.data) && f.mode != null && (f.mode & 0o111) !== 0;
  });
}

// Optional fields worth asking about for this package. Emulated System is only
// for emulators and cores; Command Line also for games and anything that runs a
// program. Themes, UI mods and the like aren't asked for either.
export function relevantOptional(mod) {
  const emu = isEmulatorOrCore(mod);
  return STANDARD_FIELDS.filter((k) => !REQUIRED_FIELDS.includes(k)).filter((k) => {
    if (k === 'Emulated System') return emu;
    if (k === 'Command Line') return emu || mod.kind === 'game' || hasExecutable(mod);
    return true;
  });
}

export const missingOptional = (mod) => relevantOptional(mod).filter((k) => !filled(mod, k));

// A package opened from an existing repository and left unchanged is published
// exactly as it already was, so it doesn't need confirming again. Neither does
// one whose file couldn't be downloaded: it can't be changed.
export const alreadyPublished = (mod) => !!(mod.origin && (mod.unavailable || (keepsOriginal(mod) && hmodFileName(mod) === mod.origin.fileName)));

export function isReady(mod) {
  if (alreadyPublished(mod)) return true;
  return !!mod.ready && missingRequired(mod).length === 0;
}

// Ticking needs every required field; clearing one unticks it.
export function setReady(mod, ready) {
  return { ...mod, ready: !!ready && missingRequired(mod).length === 0 };
}

// "Confirm all complete readmes": ticks every package whose required fields are
// filled in, and leaves the rest for the author to open.
export function confirmComplete(mods) {
  return mods.map((m) => (isReady(m) || missingRequired(m).length ? m : { ...m, ready: true }));
}
