// Submit one package to a central repository by pull request.
import { packHmod, hmodFileName } from './pack.js';
import { textBytes } from './tar.js';
import { STUDIO_URL } from './project.js';
import { checkSubmission, packagePath, metaPath, parseMeta, metaText, parseNamespaces, DEFAULT_MAX_MB, NAMESPACES_FILE, PACKAGES_DIR } from './central.js';
import { kindFromFileName } from './model.js';
import { idOf, partsOf, namespaceOf, squash } from './packageid.js';

const sleepMs = (ms) => new Promise((res) => setTimeout(res, ms));

export function submissionVersion(mod) {
  return String(mod.readme.front.Version || '').trim();
}

export async function readCentralConfig(gh, central) {
  const text = await gh.readText(central, 'repo.json');
  if (!text) return { admins: [], maxPackageMB: DEFAULT_MAX_MB, title: `${central.owner}/${central.repo}`, missing: true };
  try {
    const c = JSON.parse(text);
    return {
      title: c.title || `${central.owner}/${central.repo}`,
      siteUrl: c.siteUrl || '',
      admins: Array.isArray(c.admins) ? c.admins : [],
      maxPackageMB: Number(c.maxPackageMB) || DEFAULT_MAX_MB,
    };
  } catch {
    return { admins: [], maxPackageMB: DEFAULT_MAX_MB, title: `${central.owner}/${central.repo}`, invalid: true };
  }
}

// Everything the interface needs before the person clicks Submit.
// The packages already in the central repository that matter for this ID's
// namespace checks: Map(file -> { metaText }). One tree read lists every
// package; only those whose namespace touches a part of this ID are read.
export async function readExisting(gh, central, branch, file) {
  const head = await gh.branchHead(central, branch);
  if (!head) return new Map();
  const { entries } = await gh.tree(central, head);
  const prefix = `${PACKAGES_DIR}/`;
  const names = entries.map((e) => e.path).filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
    .map((p) => p.slice(prefix.length)).filter((n) => kindFromFileName(n));
  const parts = partsOf(idOf(file)).map(squash);
  const relevant = (n) => {
    const ns = namespaceOf(idOf(n));
    if (!ns) return false;
    const k = squash(ns);
    return parts.some((p) => p === k || (k.length >= 4 && p.includes(k)));
  };
  const out = new Map(names.map((n) => [n, { metaText: null }]));
  await Promise.all(names.filter(relevant).map(async (n) => {
    out.set(n, { metaText: await gh.readText(central, metaPath(n), branch) });
  }));
  return out;
}

export async function prepareSubmission(gh, { central, mod }) {
  const [me, upstream, config] = await Promise.all([gh.user(), gh.repo(central), readCentralConfig(gh, central)]);
  if (config.missing) throw new Error(`${central.owner}/${central.repo} has no repo.json, so it isn't set up as a central hmod repository.`);
  const file = hmodFileName(mod);
  const [existing, nsText] = await Promise.all([
    readExisting(gh, central, upstream.default_branch, file),
    gh.readText(central, NAMESPACES_FILE, upstream.default_branch),
  ]);
  const namespaces = parseNamespaces(nsText);
  const prevText = await gh.readText(central, metaPath(file), upstream.default_branch);
  const prev = prevText ? parseMeta(prevText, file).meta || null : null;
  const version = submissionVersion(mod);
  const meta = { version, maintainers: prev ? prev.maintainers : [me.login] };
  const bytes = await packHmod(mod);
  if (!version) {
    const result = { errors: ['Add a Version in the Readme tab. The central repository uses it to tell updates apart.'], warnings: [], approvals: [], changes: [] };
    return { me, upstream, config, file, prev, meta, bytes, result, isUpdate: !!prev, canPush: !!(upstream.permissions && upstream.permissions.push) };
  }
  const result = await checkSubmission({
    before: prev ? new Map([[file, { bytes: new Uint8Array(0), metaText: prevText }]]) : new Map(),
    after: new Map([[file, { bytes, metaText: metaText(meta) }]]),
    author: me.login,
    admins: config.admins,
    maxMB: config.maxPackageMB,
    existing,
    namespaces,
  });
  return { me, upstream, config, file, prev, meta, bytes, result, isUpdate: !!prev, canPush: !!(upstream.permissions && upstream.permissions.push) };
}

async function waitForFork(gh, fork, branch, { tries = 20, delay = 1500, sleep = sleepMs } = {}) {
  for (let i = 0; i < tries; i++) {
    if (await gh.branchHead(fork, branch)) return;
    await sleep(delay);
  }
  throw new Error(`GitHub is still creating your fork of the repository. Wait a minute and submit again.`);
}

export async function submitToCentral(gh, { central, mod, prepared = null, onProgress = () => {}, sleep = sleepMs, now = () => new Date() }) {
  const p = prepared || (await prepareSubmission(gh, { central, mod }));
  if (p.result.errors.length) throw new Error(p.result.errors.join(' '));
  const base = p.upstream.default_branch;

  let target = central;
  let headPrefix = '';
  if (!p.canPush) {
    onProgress(`Forking ${central.owner}/${central.repo} to your account`);
    const f = await gh.fork(central);
    target = { owner: f.owner.login, repo: f.name };
    headPrefix = `${f.owner.login}:`;
    await waitForFork(gh, target, base, { sleep });
    onProgress('Bringing your fork up to date');
    await gh.syncFork(target, base);
  }

  const baseSha = await gh.branchHead(central, base);
  const stamp = now().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const slug = p.file.replace(/\.(hmod|clvg)$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-');
  const branch = `submit/${slug}-${(p.meta.version || 'v').replace(/[^A-Za-z0-9._-]+/g, '-')}-${stamp}`;
  const name = mod.readme.front.Name || mod.name;

  await gh.commitFiles(target, {
    branch,
    baseSha,
    files: [
      { path: packagePath(p.file), data: p.bytes },
      { path: metaPath(p.file), data: textBytes(metaText(p.meta)) },
    ],
    message: `${p.isUpdate ? 'Update' : 'Add'} ${p.file} ${p.meta.version}`.trim(),
    onProgress,
  });

  onProgress('Opening the pull request');
  const approvals = p.result.approvals && p.result.approvals.length ? `\n\n**Needs admin approval**\n${p.result.approvals.map((a) => `- ${a}`).join('\n')}` : '';
  const warnings = p.result.warnings.length ? `\n\n**Warnings from the publisher**\n${p.result.warnings.map((w) => `- ${w}`).join('\n')}` : '';
  const pr = await gh.openPull(central, {
    title: `${p.isUpdate ? 'Update' : 'Add'} ${name} ${p.meta.version}`.trim(),
    head: `${headPrefix}${branch}`,
    base,
    maintainer_can_modify: true,
    body: [
      `${p.isUpdate ? `Updates \`${p.file}\` from ${p.prev.version} to ${p.meta.version}.` : `Adds \`${p.file}\` at version ${p.meta.version}.`}`,
      '',
      `- Kind: ${mod.kind === 'game' ? 'game (.clvg)' : 'mod (.hmod)'}`,
      mod.readme.front.Creator ? `- Creator: ${mod.readme.front.Creator}` : null,
      mod.readme.front.Consoles ? `- Consoles: ${mod.readme.front.Consoles}` : null,
      `- Maintainers: ${p.meta.maintainers.join(', ')}`,
      '',
      `Submitted with [Mod Hub Studio](${STUDIO_URL}). The repository's checks run again on this pull request.`,
    ].filter((l) => l !== null).join('\n') + approvals + warnings,
  });
  return { url: pr.html_url, number: pr.number, branch, forked: !p.canPush };
}
