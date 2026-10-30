// Package IDs. A package's file name, without .hmod / .clvg, is its ID:
//   dna64.snes9x-theme.hmod  ->  ID dna64.snes9x-theme, namespace dna64
// IDs are lowercase letters, digits and hyphens in two or more dot-separated
// parts. The first part is the author's namespace; further parts are the
// author's choice and mean nothing to the tooling.
//
// No underscores: Hakchi2 CE's Hmod.GetCleanName appends _1, _2 ... when a file
// of the same name is already in user_mods, so a trailing _N is always an
// append and never part of an ID.

export const MAX_ID_LENGTH = 100;
const PART_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

// Words nobody can claim as a namespace. A central repository adds its own in
// namespaces.json ("reserved"); compared with squash(), so "snes-9x" is "snes9x".
export const DEFAULT_RESERVED = [
  'admin', 'author', 'boot', 'ce', 'clover', 'core', 'cores', 'emu', 'emulator', 'famicom', 'font', 'fonts',
  'game', 'games', 'genesis', 'hakchi', 'hakchi2', 'hakchi2-ce', 'hmod', 'hmods', 'kernel', 'megadrive', 'menu',
  'mod', 'mods', 'music', 'nes', 'nintendo', 'official', 'retroarch', 'sega', 'sfc', 'snes', 'snes9x', 'system',
  'test', 'theme', 'themes', 'ui', 'user', 'yourname',
];

export const idOf = (fileName) => String(fileName).replace(/\.(hmod|clvg)$/i, '');
export const partsOf = (id) => String(id).split('.');
export const namespaceOf = (id) => (String(id).includes('.') ? partsOf(id)[0] : null);
// Lowercase with hyphens and underscores removed, so dna64, dna-64 and DNA_64 match.
export const squash = (s) => String(s || '').toLowerCase().replace(/[-_]/g, '');

// Every way an ID breaks the rules, as sentences. Empty means it's valid.
export function packageIdProblems(id) {
  const s = String(id || '');
  if (!s) return ['It has no name.'];
  const problems = [];
  if (s !== s.toLowerCase()) problems.push('It has capital letters; IDs are lowercase.');
  if (s.includes('_')) problems.push('It has an underscore; use a hyphen instead.');
  if (/[^A-Za-z0-9_.-]/.test(s)) problems.push('It has characters other than letters, digits, hyphens and dots.');
  const parts = partsOf(s.toLowerCase().replace(/_/g, '-'));
  if (parts.length < 2) problems.push('It needs at least two parts separated by a dot, your name first: yourname.package.');
  else if (parts.some((p) => !p)) problems.push('It has an empty part (two dots together, or a dot at the start or end).');
  else if (parts.some((p) => /^[a-z0-9-]+$/.test(p) && !PART_RE.test(p))) problems.push('A part starts or ends with a hyphen.');
  if (s.length > MAX_ID_LENGTH) problems.push(`It is longer than ${MAX_ID_LENGTH} characters.`);
  return problems;
}

export const isPackageId = (id) => packageIdProblems(id).length === 0;

export function slugPart(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// A valid ID for a package: its own name tidied up when that already reads as
// namespace.package, otherwise Creator + Name from the readme.
export function suggestPackageId(mod) {
  const own = String(mod.name || '').split('.').map(slugPart).filter(Boolean);
  if (own.length >= 2) return own.join('.').slice(0, MAX_ID_LENGTH);
  const front = (mod.readme && mod.readme.front) || {};
  const ns = slugPart(String(front.Creator || '').split(/[,&/]/)[0]).replace(/-/g, '') || 'yourname';
  let pkg = slugPart(front.Name || mod.name) || (mod.kind === 'game' ? 'game' : 'package');
  if (pkg === ns || pkg.startsWith(ns + '-')) pkg = pkg.slice(ns.length + 1) || pkg;
  return `${ns}.${pkg}`.slice(0, MAX_ID_LENGTH).replace(/[-.]+$/, '');
}

export const isReserved = (ns, extra = []) => {
  const k = squash(ns);
  return [...DEFAULT_RESERVED, ...extra].some((r) => squash(r) === k);
};
