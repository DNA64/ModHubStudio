// Publish a repository straight to the user's own GitHub Pages site.
import { buildRepoFiles, INDEX_MARKERS } from './repo.js';
import { packHmod } from './pack.js';
import { textBytes } from './tar.js';

// Paths the publisher owns in the target branch. Anything else there (the
// user's README, LICENSE, other pages) is left alone.
const MANAGED_DIRS = ['.repo/', 'hmods/', 'games/'];
export const MAX_FILE_BYTES = 100 * 1024 * 1024; // GitHub's per-file limit
export const WARN_FILE_BYTES = 50 * 1024 * 1024;

export function cleanDomain(value) {
  return String(value || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
}

export function validDomain(d) {
  return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d) && !/\.github\.io$/.test(d);
}

// Where GitHub serves a Pages site for this repository.
export function pagesUrl({ owner, repo }, cname) {
  const domain = cleanDomain(cname);
  if (domain) return `https://${domain}`;
  const o = owner.toLowerCase();
  if (repo.toLowerCase() === `${o}.github.io`) return `https://${o}.github.io`;
  return `https://${o}.github.io/${repo}`;
}

export function pagesIssues(target) {
  const out = [];
  if (!target.repo) out.push({ severity: 'error', text: 'Enter the GitHub repository to publish to, as owner/name.' });
  if (!String(target.branch || '').trim()) out.push({ severity: 'error', text: 'Enter the branch GitHub Pages publishes from.' });
  const d = cleanDomain(target.cname);
  if (d && !validDomain(d)) out.push({ severity: 'error', text: `${d} isn't a domain name. Use something like mods.example.com, or leave it empty to use github.io.` });
  return out;
}

export function sizeIssues(files) {
  const out = [];
  for (const f of files) {
    const mb = (f.data.length / 1024 / 1024).toFixed(1);
    if (f.data.length > MAX_FILE_BYTES) {
      out.push({ severity: 'error', path: f.path, text: `${f.path} is ${mb} MB. GitHub refuses files over 100 MB. Upload it as a GitHub release asset and paste that link as its download link.` });
    } else if (f.data.length > WARN_FILE_BYTES) {
      out.push({ severity: 'warning', path: f.path, text: `${f.path} is ${mb} MB. GitHub accepts it, but files over 50 MB make the repository slow to clone.` });
    }
  }
  return out;
}

// gh: client from github.js. target: { repo: {owner, repo}, branch, cname }.
// Returns a summary for the interface.
export async function publishToPages(gh, { target, repoSettings, mods, onProgress = () => {} }) {
  const { repo: r, branch } = target;
  onProgress(`Checking ${r.owner}/${r.repo}`);
  const info = await gh.maybeRepo(r);
  if (!info) throw new Error(`Couldn't find ${r.owner}/${r.repo}. Create it on GitHub first (it can be empty), or check the name and that the token can see it.`);
  if (info.permissions && !info.permissions.push) throw new Error(`Your account can't write to ${r.owner}/${r.repo}.`);

  // Keep a custom domain the site already has unless the user typed a new one.
  const head = await gh.branchHead(r, branch);
  const existingCname = head ? cleanDomain(await gh.readText(r, 'CNAME', branch)) : '';
  const cname = cleanDomain(target.cname) || existingCname;
  const baseUrl = pagesUrl(r, cname);

  onProgress('Packing packages');
  const packed = new Map();
  for (const m of mods) packed.set(m.id, await packHmod(m));
  const all = await buildRepoFiles({ ...repoSettings, baseUrl }, mods, packed);
  const files = all.filter((f) => f.path !== 'HOSTING.md');
  if (cname) files.push({ path: 'CNAME', data: textBytes(cname + '\n') });

  const tooBig = sizeIssues(files).filter((i) => i.severity === 'error');
  if (tooBig.length) throw new Error(tooBig.map((i) => i.text).join(' '));

  // Don't replace an index.html the user wrote themselves.
  let keptIndex = false;
  if (head) {
    const current = await gh.readText(r, 'index.html', branch);
    if (current && !INDEX_MARKERS.some((m) => current.includes(m))) {
      keptIndex = true;
      files.splice(files.findIndex((f) => f.path === 'index.html'), 1);
    }
  }

  const result = await gh.commitFiles(r, {
    branch,
    files,
    message: `Publish ${mods.length} package${mods.length === 1 ? '' : 's'} with Mod Hub Studio`,
    prune: (p) => MANAGED_DIRS.some((d) => p.startsWith(d)),
    onProgress,
  });

  // Turn Pages on and record the domain when the token allows it.
  const notes = [];
  let pages = await gh.pages(r);
  if (!pages) {
    try {
      onProgress('Turning on GitHub Pages');
      pages = await gh.enablePages(r, branch);
    } catch {
      notes.push({ kind: 'enable-pages', text: `Turn on GitHub Pages once: in ${r.owner}/${r.repo} open Settings → Pages, choose "Deploy from a branch", then ${branch} and / (root).` });
    }
  } else if (pages.build_type === 'workflow') {
    notes.push({ kind: 'pages-workflow', text: `GitHub Pages in ${r.owner}/${r.repo} is set to deploy with GitHub Actions, which ignores this branch. In Settings → Pages choose "Deploy from a branch", then ${branch} and / (root).` });
  } else if (pages.source && pages.source.branch !== branch) {
    notes.push({ kind: 'pages-branch', text: `GitHub Pages is publishing from ${pages.source.branch}, not ${branch}. Change it in Settings → Pages, or publish to ${pages.source.branch}.` });
  }
  if (cname && pages && cleanDomain(pages.cname) !== cname) {
    try { await gh.setPagesDomain(r, branch, cname); } catch {
      notes.push({ kind: 'domain', text: `Confirm ${cname} under Settings → Pages → Custom domain.` });
    }
  }
  if (cname) notes.push({ kind: 'dns', text: `Point ${cname} at GitHub with a CNAME record to ${r.owner.toLowerCase()}.github.io at your domain provider. HTTPS becomes available once GitHub sees it.` });
  if (keptIndex) notes.push({ kind: 'index', text: 'Your own index.html was kept. Hakchi2 CE only needs the .repo folder, so the site works either way.' });

  return { ...result, baseUrl, cname, notes, commitUrl: `https://github.com/${r.owner}/${r.repo}/commit/${result.commit}` };
}
