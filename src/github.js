// Minimal GitHub REST client for the browser (and Node, for tests).
// GitHub's API allows cross-origin requests with a token, so the page can
// publish without a server of its own. `fetchImpl` is injectable for tests.

export const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function explain(status, body, what) {
  const msg = (body && body.message) || '';
  if (status === 401) return 'GitHub rejected the token. Check it was copied in full and has not expired.';
  if (status === 403 && /rate limit/i.test(msg)) return 'GitHub\'s rate limit was reached. Wait a few minutes and try again.';
  if (status === 403 || (status === 404 && what.write)) {
    return `The token isn't allowed to ${what.label || 'do that'}. ${what.scopeHint || 'Give it the public_repo scope, or for a fine-grained token, Contents: read and write on this repository.'}`;
  }
  if (status === 404) return `${what.label ? what.label[0].toUpperCase() + what.label.slice(1) : 'That'} failed: GitHub couldn't find it.`;
  if (status === 422 && /too large|exceeds/i.test(msg)) return 'A file is too large for GitHub (100 MB limit per file).';
  return `GitHub returned ${status}${msg ? `: ${msg}` : ''}.`;
}

export function toBase64(u8) {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  return btoa(s);
}

export function fromBase64(b64) {
  const s = atob(String(b64).replace(/\s+/g, ''));
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

// The sha git assigns a file's contents, so unchanged files can be skipped.
export async function gitBlobSha(u8) {
  const header = new TextEncoder().encode(`blob ${u8.length}\0`);
  const buf = new Uint8Array(header.length + u8.length);
  buf.set(header);
  buf.set(u8, header.length);
  const d = await crypto.subtle.digest('SHA-1', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function parseRepoName(value) {
  const v = String(value || '').trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  const m = v.match(/^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

export function createClient({ token, fetchImpl = globalThis.fetch.bind(globalThis), api = API } = {}) {
  async function request(method, path, body, what = {}) {
    const res = await fetchImpl(`${api}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) throw new GitHubError(res.status, explain(res.status, json, what), json);
    return json;
  }
  const get = (p, w) => request('GET', p, undefined, w);
  const maybe = async (p) => {
    try { return await get(p); } catch (e) { if (e.status === 404 || e.status === 409) return null; throw e; }
  };
  const repoPath = ({ owner, repo }) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  const client = {
    request,
    user: () => get('/user', { label: 'read your account' }),
    repo: (r) => get(repoPath(r), { label: `open ${r.owner}/${r.repo}` }),
    maybeRepo: (r) => maybe(repoPath(r)),
    branchHead: async (r, branch) => {
      const ref = await maybe(`${repoPath(r)}/git/ref/heads/${encodeURIComponent(branch)}`);
      return ref ? ref.object.sha : null;
    },
    tree: async (r, commitSha) => {
      const commit = await get(`${repoPath(r)}/git/commits/${commitSha}`);
      const tree = await get(`${repoPath(r)}/git/trees/${commit.tree.sha}?recursive=1`);
      if (tree.truncated) throw new GitHubError(0, 'The repository has too many files to compare in one go. Publish into a repository used only for this site.');
      return { treeSha: commit.tree.sha, entries: tree.tree.filter((e) => e.type === 'blob') };
    },
    // Text file contents, or null when missing.
    readText: async (r, path, ref) => {
      const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
      const f = await maybe(`${repoPath(r)}/contents/${path.split('/').map(encodeURIComponent).join('/')}${q}`);
      if (!f || Array.isArray(f) || f.type !== 'file') return null;
      return new TextDecoder().decode(fromBase64(f.content || ''));
    },
    // An empty repository has no git database yet; one file through the
    // contents API creates the first commit and branch.
    initEmpty: (r) => request('PUT', `${repoPath(r)}/contents/.nojekyll`, {
      message: 'Initialise repository', content: '',
    }, { label: `write to ${r.owner}/${r.repo}`, write: true }),
    blob: (r, u8) => request('POST', `${repoPath(r)}/git/blobs`, { content: toBase64(u8), encoding: 'base64' },
      { label: `upload files to ${r.owner}/${r.repo}`, write: true }),
    createTree: (r, body) => request('POST', `${repoPath(r)}/git/trees`, body, { label: `write to ${r.owner}/${r.repo}`, write: true }),
    createCommit: (r, body) => request('POST', `${repoPath(r)}/git/commits`, body, { label: `write to ${r.owner}/${r.repo}`, write: true }),
    updateRef: (r, branch, sha, force = false) => request('PATCH', `${repoPath(r)}/git/refs/heads/${encodeURIComponent(branch)}`, { sha, force },
      { label: `update ${branch} in ${r.owner}/${r.repo}`, write: true }),
    createRef: (r, branch, sha) => request('POST', `${repoPath(r)}/git/refs`, { ref: `refs/heads/${branch}`, sha },
      { label: `create a branch in ${r.owner}/${r.repo}`, write: true }),
    fork: (r) => request('POST', `${repoPath(r)}/forks`, {}, { label: `fork ${r.owner}/${r.repo}`, write: true }),
    syncFork: async (r, branch) => {
      try { await request('POST', `${repoPath(r)}/merge-upstream`, { branch }); return true; } catch { return false; }
    },
    openPull: (r, body) => request('POST', `${repoPath(r)}/pulls`, body,
      { label: `open a pull request on ${r.owner}/${r.repo}`, write: true }),
    pages: (r) => maybe(`${repoPath(r)}/pages`),
    enablePages: (r, branch) => request('POST', `${repoPath(r)}/pages`, { build_type: 'legacy', source: { branch, path: '/' } },
      { label: 'turn on GitHub Pages', write: true, scopeHint: 'That needs the repo scope (or Pages and Administration write for a fine-grained token).' }),
    setPagesDomain: (r, branch, cname) => request('PUT', `${repoPath(r)}/pages`, { cname: cname || null, source: { branch, path: '/' } },
      { label: 'set the custom domain', write: true, scopeHint: 'That needs the repo scope (or Pages and Administration write for a fine-grained token).' }),
  };

  // Commit a set of files to a branch in one commit.
  //   files:    [{ path, data: Uint8Array }]
  //   prune:    (path) => true for existing paths this commit owns and may delete
  //   baseSha:  start the branch from this commit instead of its current head
  // A branch that doesn't exist yet starts a new history holding only `files`.
  // Returns { commit, changed: [...], deleted: [...], uploaded, skipped, created }.
  client.commitFiles = async (r, { branch, files, message, prune = () => false, baseSha = null, onProgress = () => {} }) => {
    let head = baseSha || (await client.branchHead(r, branch));
    let created = false;
    if (!head) {
      const info = await client.maybeRepo(r);
      if (!info) throw new GitHubError(404, `Couldn't find ${r.owner}/${r.repo}. Create it on GitHub first, or check the name.`);
      if (info.size === 0 || !(await client.branchHead(r, info.default_branch))) {
        onProgress('Setting up the empty repository');
        await client.initEmpty(r);
        head = await client.branchHead(r, branch);
      }
    }
    const existing = new Map();
    let baseTree = null;
    if (head) {
      const t = await client.tree(r, head);
      baseTree = t.treeSha;
      for (const e of t.entries) existing.set(e.path, e.sha);
    }
    const entries = [];
    const changed = [];
    let uploaded = 0;
    let skipped = 0;
    const wanted = new Set(files.map((f) => f.path));
    let i = 0;
    for (const f of files) {
      i++;
      const sha = await gitBlobSha(f.data);
      if (existing.get(f.path) === sha) { skipped++; continue; }
      onProgress(`Uploading ${f.path} (${i} of ${files.length})`);
      const blob = await client.blob(r, f.data);
      entries.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
      changed.push(f.path);
      uploaded++;
    }
    const deleted = [...existing.keys()].filter((p) => !wanted.has(p) && prune(p));
    for (const p of deleted) entries.push({ path: p, mode: '100644', type: 'blob', sha: null });
    if (!entries.length && head) return { commit: head, changed, deleted, uploaded, skipped, created, unchanged: true };

    onProgress('Saving the commit');
    const tree = await client.createTree(r, baseTree ? { base_tree: baseTree, tree: entries } : { tree: entries });
    const commit = await client.createCommit(r, { message, tree: tree.sha, parents: head ? [head] : [] });
    if (head && !baseSha) await client.updateRef(r, branch, commit.sha);
    else if (head && baseSha) {
      // Caller manages the ref (new branch from a known base).
      if (await client.branchHead(r, branch)) await client.updateRef(r, branch, commit.sha, true);
      else { await client.createRef(r, branch, commit.sha); created = true; }
    } else { await client.createRef(r, branch, commit.sha); created = true; }
    return { commit: commit.sha, changed, deleted, uploaded, skipped, created, unchanged: false };
  };

  return client;
}
