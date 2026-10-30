// Rules for a central repository that takes packages by pull request.
// The tool checks a submission with these before opening the pull request,
// and the central repository's CI runs the same code on every pull request.
//
// Layout of a central repository:
//   repo.json                    { title, readme, siteUrl, admins: [github logins], maxPackageMB }
//   packages/<file>.hmod|.clvg   the package exactly as Hakchi2 CE downloads it
//   packages/<file>.json         { "version": "1.2.0", "maintainers": ["login"] }
//   namespaces.json              optional: { "reserved": ["word"], "namespaces": { "dna64": ["login"] } }
//
// Package IDs (src/packageid.js): the file name is the ID, yourname.package.
// The first part is a namespace. Whoever maintains a package in a namespace
// owns it; namespaces.json can also grant one. A pull request that starts a new
// namespace is listed under "Needs admin approval" for whoever merges it.
import { modFromArchive, kindFromFileName } from './model.js';
import { validate } from './rules.js';
import { hmodFileName } from './pack.js';
import { idOf, partsOf, namespaceOf, squash, packageIdProblems, suggestPackageId, isReserved } from './packageid.js';

export const PACKAGES_DIR = 'packages';
export const DEFAULT_MAX_MB = 95;
export const packagePath = (file) => `${PACKAGES_DIR}/${file}`;
export const metaPath = (file) => `${PACKAGES_DIR}/${file}.json`;
export const NAMESPACES_FILE = 'namespaces.json';
// Shorter namespaces aren't looked for inside other names; too many false alarms.
const MIN_EMBEDDED = 4;

// "v1.10.2" -> [1, 10, 2]; anything non-numeric compares as text.
export function compareVersions(a, b) {
  const parts = (v) => String(v || '').trim().replace(/^v(?=\d)/i, '').split(/[.\-_+ ]/).filter(Boolean);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0';
    const y = pb[i] ?? '0';
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) { if (+x !== +y) return +x < +y ? -1 : 1; continue; }
    if (nx !== ny) return nx ? 1 : -1; // 1.0 is newer than 1.0-beta
    const c = x.localeCompare(y);
    if (c) return c < 0 ? -1 : 1;
  }
  return 0;
}

export function parseMeta(text, file) {
  let m;
  try { m = JSON.parse(text); } catch { return { error: `${metaPath(file)} isn't valid JSON.` }; }
  if (!m || typeof m !== 'object') return { error: `${metaPath(file)} must be a JSON object.` };
  const maintainers = Array.isArray(m.maintainers) ? m.maintainers.map((x) => String(x).trim()).filter(Boolean) : [];
  if (!maintainers.length) return { error: `${metaPath(file)} needs at least one GitHub login in "maintainers".` };
  if (!String(m.version || '').trim()) return { error: `${metaPath(file)} needs a "version".` };
  return { meta: { version: String(m.version).trim(), maintainers } };
}

export function metaText(meta) {
  return JSON.stringify({ version: meta.version, maintainers: meta.maintainers }, null, 2) + '\n';
}

const lower = (s) => String(s).toLowerCase();
const isIn = (login, list) => (list || []).some((x) => lower(x) === lower(login));

// Checks one package file as it would be after the pull request.
export async function checkPackage(file, bytes, meta, { maxMB = DEFAULT_MAX_MB } = {}) {
  const errors = [];
  const warnings = [];
  if (!kindFromFileName(file)) return { errors: [`${packagePath(file)} must end in .hmod or .clvg.`], warnings };
  if (bytes.length > maxMB * 1024 * 1024) {
    errors.push(`${file} is ${(bytes.length / 1024 / 1024).toFixed(1)} MB; this repository takes packages up to ${maxMB} MB.`);
  }
  let mod;
  try { mod = await modFromArchive(file, bytes); } catch (e) { return { errors: [...errors, e.message], warnings }; }
  if (mod.source.kind !== 'tgz' || (mod.source.nested && mod.source.nested.length)) {
    errors.push(`${file} must be a plain tar.gz package. Pack it with Mod Hub Studio first.`);
  }
  if (hmodFileName(mod) !== file) errors.push(`${file} should be named ${hmodFileName(mod)}, the name Hakchi2 CE gives it.`);
  for (const i of validate(mod)) {
    if (i.id === 'package-id') continue; // checkSubmission reports IDs as errors
    if (i.severity === 'error') errors.push(`${file}: ${i.title}`);
    else if (i.severity === 'warning') warnings.push(`${file}: ${i.title}`);
  }
  const version = String(mod.readme.front.Version || '').trim();
  if (mod.kind === 'hmod' && !version) errors.push(`${file}: the readme needs a Version line.`);
  if (meta && version && meta.version !== version) {
    errors.push(`${metaPath(file)} says version ${meta.version} but the package readme says ${version}.`);
  }
  return { errors, warnings, mod };
}

export function parseNamespaces(text) {
  if (text == null || text === '') return { reserved: [], namespaces: {} };
  let n;
  try { n = JSON.parse(text); } catch { return { error: `${NAMESPACES_FILE} isn't valid JSON.`, reserved: [], namespaces: {} }; }
  const reserved = Array.isArray(n && n.reserved) ? n.reserved.map(String) : [];
  const namespaces = {};
  for (const [k, v] of Object.entries((n && n.namespaces) || {})) namespaces[k] = (Array.isArray(v) ? v : [v]).map(String).filter(Boolean);
  return { reserved, namespaces };
}

// Who owns each namespace: Map(squashed -> { name, owners: [login] }).
// existing: Map(file -> { metaText }) for the packages already published.
export function namespaceRegistry(existing, namespaces = {}) {
  const reg = new Map();
  const add = (name, owners) => {
    const k = squash(name);
    const e = reg.get(k) || { name, owners: [] };
    for (const o of owners) if (!isIn(o, e.owners)) e.owners.push(o);
    reg.set(k, e);
  };
  for (const [name, owners] of Object.entries(namespaces)) add(name, owners);
  for (const [file, e] of existing) {
    const ns = namespaceOf(idOf(file));
    if (!ns) continue;
    const meta = e && e.metaText != null ? parseMeta(e.metaText, file).meta : null;
    add(ns, meta ? meta.maintainers : []);
  }
  return reg;
}

// Every package in the repository is named with a Package ID.
export function idFormatErrors(file) {
  const id = idOf(file);
  const problems = packageIdProblems(id);
  if (!problems.length) return [];
  const suggestion = suggestPackageId({ name: id, kind: kindFromFileName(file), readme: { front: {} } });
  return [`${file} isn't named with a Package ID. ${problems.join(' ')} Rename it, for example to ${suggestion}${file.slice(id.length)}.`];
}

// The ID and namespace rules for a package that's new to the repository.
// Returns { errors, approvals }.
export function checkNewId(file, { author, isAdmin, registry, reserved = [] }) {
  const errors = [];
  const approvals = [];
  const id = idOf(file);
  errors.push(...idFormatErrors(file));
  if (errors.length || isAdmin) return { errors, approvals };
  const parts = partsOf(id);
  const ns = parts[0];
  const owns = (entry) => isIn(author, entry.owners);
  const mine = registry.get(squash(ns));
  if (isReserved(ns, reserved)) {
    errors.push(`${file}: "${ns}" is a reserved word and can't be used as a namespace. Start the ID with your own name, like yourname.${parts.slice(1).join('.')}.`);
  } else if (mine && !owns(mine)) {
    errors.push(`${file}: the namespace "${ns}"${mine.name !== ns ? ` (the same as "${mine.name}")` : ''} belongs to ${mine.owners.join(', ') || 'someone else'}. Start the ID with your own name.`);
  } else if (!mine) {
    approvals.push(`${file} starts the new namespace "${ns}". Merging gives ${author} the namespace.`);
  }
  // Someone else's namespace anywhere else in the ID is impersonation;
  // inside a part (dna64-fix) it may be legitimate, so it goes to review.
  for (const [i, part] of parts.entries()) {
    const k = squash(part);
    const whole = i > 0 && registry.get(k);
    if (whole && !owns(whole)) {
      errors.push(`${file}: "${part}" is ${whole.owners.join(', ') || 'someone else'}'s namespace, and only they can use it in a Package ID.`);
      continue;
    }
    for (const [other, entry] of registry) {
      if (other === k || other.length < MIN_EMBEDDED || !k.includes(other) || owns(entry)) continue;
      approvals.push(`${file} contains "${entry.name}", the namespace of ${entry.owners.join(', ') || 'another author'}. Check it isn't posing as their package.`);
    }
  }
  return { errors, approvals };
}

// The game code Hakchi2 CE will use: the top-level .desktop file's name.
export function gameCode(mod) {
  const d = mod && mod.kind === 'game' && mod.files.find((f) => /^[^/]+\.desktop$/i.test(f.path));
  return d ? d.path.replace(/\.desktop$/i, '') : null;
}

// before/after: Map(file -> { bytes, metaText })  (the packages/ folder on the
// base branch and on the pull request). otherChanges: changed paths outside
// packages/. Returns { errors, warnings, changes: [{file, action, version}] }.
// existing: every package already in the repository, Map(file -> { bytes?, metaText }),
// for namespaces, name clashes and game codes; defaults to before.
// namespaces: parsed namespaces.json from the target branch.
export async function checkSubmission({ before, after, author, admins = [], maxMB = DEFAULT_MAX_MB, otherChanges = [], existing = before, namespaces = {} }) {
  const errors = [];
  const warnings = [];
  const approvals = [];
  const changes = [];
  const isAdmin = isIn(author, admins);
  const ns = { reserved: namespaces.reserved || [], namespaces: namespaces.namespaces || {} };
  if (namespaces.error) errors.push(namespaces.error);
  const registry = namespaceRegistry(existing, ns.namespaces);
  const games = []; // [{ file, mod }] games added or updated here

  for (const p of otherChanges) {
    if (isAdmin) warnings.push(`${p} changed outside ${PACKAGES_DIR}/ (allowed for admins).`);
    else errors.push(`${p} is outside ${PACKAGES_DIR}/. Package submissions can only change files in ${PACKAGES_DIR}/.`);
  }

  const files = new Set([...before.keys(), ...after.keys()]);
  const existingLower = new Map([...existing.keys(), ...before.keys()].map((f) => [lower(f), f]));
  for (const file of [...files].sort()) {
    const was = before.get(file);
    const now = after.get(file);
    if (was && now && was.metaText === now.metaText && sameBytes(was.bytes, now.bytes)) continue;

    if (now && (!now.bytes || now.metaText == null)) {
      errors.push(now.bytes ? `${packagePath(file)} needs ${metaPath(file)} next to it.` : `${metaPath(file)} has no ${packagePath(file)} next to it.`);
      continue;
    }
    const prevMeta = was && was.metaText != null ? parseMeta(was.metaText, file).meta : null;
    const owners = prevMeta ? prevMeta.maintainers : [];

    if (!now) {
      if (!isAdmin && !isIn(author, owners)) errors.push(`${author} can't remove ${file}; only its maintainers (${owners.join(', ') || 'none listed'}) or an admin can.`);
      changes.push({ file, action: 'removed' });
      continue;
    }
    const parsed = parseMeta(now.metaText, file);
    if (parsed.error) { errors.push(parsed.error); continue; }
    const meta = parsed.meta;

    if (!was) {
      const clash = existingLower.get(lower(file));
      if (clash && clash !== file && !(before.has(clash) && !after.has(clash))) { errors.push(`${file} clashes with the existing ${clash}. Package names are compared without case.`); continue; }
      if (!isAdmin && !isIn(author, meta.maintainers)) errors.push(`${file} is new, so ${author} must be listed in its maintainers.`);
      const idCheck = checkNewId(file, { author, isAdmin, registry, reserved: ns.reserved });
      errors.push(...idCheck.errors);
      for (const a of idCheck.approvals) if (!approvals.includes(a)) approvals.push(a);
    } else {
      errors.push(...idFormatErrors(file));
      if (!isAdmin && !isIn(author, owners)) {
        errors.push(`${file} belongs to ${owners.join(', ')}. Ask one of them to add ${author} as a maintainer, or submit it under a different name.`);
      }
      if (prevMeta && compareVersions(meta.version, prevMeta.version) <= 0) {
        errors.push(`${file} is already at version ${prevMeta.version}. Raise the Version in its readme above ${prevMeta.version} to publish an update.`);
      }
    }
    const pkg = await checkPackage(file, now.bytes, meta, { maxMB });
    errors.push(...pkg.errors);
    warnings.push(...pkg.warnings);
    if (pkg.mod && pkg.mod.kind === 'game') games.push({ file, mod: pkg.mod });
    changes.push({ file, action: was ? 'updated' : 'added', version: meta.version, from: prevMeta && prevMeta.version });
  }
  errors.push(...(await gameCodeClashes(games, after, existing)));
  if (!changes.length && !otherChanges.length) warnings.push('This pull request does not change any packages.');
  return { errors, warnings, approvals, changes };
}

// Two games with one code would install into the same folder on the console.
async function gameCodeClashes(games, after, existing) {
  if (!games.length) return [];
  const errors = [];
  const changed = new Set(games.map((g) => g.file));
  const codes = new Map(); // code -> file
  for (const g of games) {
    const c = gameCode(g.mod);
    if (!c) continue;
    const prev = codes.get(c.toUpperCase());
    if (prev) errors.push(`${g.file} uses the game code ${c}, and so does ${prev}. Hakchi2 CE installs a game into a folder named after its code, so the two would overwrite each other.`);
    else codes.set(c.toUpperCase(), g.file);
  }
  const others = new Map([...existing, ...after]);
  for (const [file, e] of others) {
    if (changed.has(file) || !after.has(file) || kindFromFileName(file) !== 'game' || !e || !e.bytes || !e.bytes.length) continue;
    let mod;
    try { mod = await modFromArchive(file, e.bytes); } catch { continue; }
    const c = gameCode(mod);
    const clash = c && codes.get(c.toUpperCase());
    if (clash) errors.push(`${clash} uses the game code ${c}, which ${file} already uses. Hakchi2 CE installs a game into a folder named after its code, so the two would overwrite each other. Give this game a different code (rename its .desktop file and the matching files).`);
  }
  return errors;
}

function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Markdown report for the pull request's check summary.
export function reportMarkdown(result, author) {
  const lines = [`## Package check for ${author}`, ''];
  if (result.changes.length) {
    lines.push('| Package | Change |', '|---|---|');
    for (const c of result.changes) lines.push(`| \`${c.file}\` | ${c.action}${c.version ? ` → ${c.version}` : ''}${c.from ? ` (was ${c.from})` : ''} |`);
    lines.push('');
  }
  if (result.errors.length) lines.push('### Must fix', ...result.errors.map((e) => `- ${e}`), '');
  if (result.approvals && result.approvals.length) lines.push('### Needs admin approval', ...result.approvals.map((a) => `- ${a}`), '');
  if (result.warnings.length) lines.push('### Warnings', ...result.warnings.map((w) => `- ${w}`), '');
  if (!result.errors.length) lines.push('All checks passed.');
  return lines.join('\n') + '\n';
}
