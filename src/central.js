// Rules for a central repository that takes packages by pull request.
// The tool checks a submission with these before opening the pull request,
// and the central repository's CI runs the same code on every pull request.
//
// Layout of a central repository:
//   repo.json                    { title, readme, siteUrl, admins: [github logins], maxPackageMB }
//   packages/<file>.hmod|.clvg   the package exactly as Hakchi2 CE downloads it
//   packages/<file>.json         { "version": "1.2.0", "maintainers": ["login"] }
import { modFromArchive, kindFromFileName } from './model.js';
import { validate } from './rules.js';
import { hmodFileName } from './pack.js';

export const PACKAGES_DIR = 'packages';
export const DEFAULT_MAX_MB = 95;
export const packagePath = (file) => `${PACKAGES_DIR}/${file}`;
export const metaPath = (file) => `${PACKAGES_DIR}/${file}.json`;

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

// before/after: Map(file -> { bytes, metaText })  (the packages/ folder on the
// base branch and on the pull request). otherChanges: changed paths outside
// packages/. Returns { errors, warnings, changes: [{file, action, version}] }.
export async function checkSubmission({ before, after, author, admins = [], maxMB = DEFAULT_MAX_MB, otherChanges = [] }) {
  const errors = [];
  const warnings = [];
  const changes = [];
  const isAdmin = isIn(author, admins);

  for (const p of otherChanges) {
    if (isAdmin) warnings.push(`${p} changed outside ${PACKAGES_DIR}/ (allowed for admins).`);
    else errors.push(`${p} is outside ${PACKAGES_DIR}/. Package submissions can only change files in ${PACKAGES_DIR}/.`);
  }

  const files = new Set([...before.keys(), ...after.keys()]);
  const existingLower = new Map([...before.keys()].map((f) => [lower(f), f]));
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
      if (clash && clash !== file) { errors.push(`${file} clashes with the existing ${clash}. Package names are compared without case.`); continue; }
      if (!isAdmin && !isIn(author, meta.maintainers)) errors.push(`${file} is new, so ${author} must be listed in its maintainers.`);
    } else {
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
    changes.push({ file, action: was ? 'updated' : 'added', version: meta.version, from: prevMeta && prevMeta.version });
  }
  if (!changes.length && !otherChanges.length) warnings.push('This pull request does not change any packages.');
  return { errors, warnings, changes };
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
  if (result.warnings.length) lines.push('### Warnings', ...result.warnings.map((w) => `- ${w}`), '');
  if (!result.errors.length) lines.push('All checks passed.');
  return lines.join('\n') + '\n';
}
