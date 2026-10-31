// An in-memory stand-in for the parts of the GitHub REST API the publisher
// uses. Objects are shared across a fork network, like on GitHub.
import crypto from 'node:crypto';

const sha1 = (data) => crypto.createHash('sha1').update(data).digest('hex');
const blobSha = (buf) => sha1(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf]));

export class FakeGitHub {
  constructor({ users = { 'tok-alice': 'alice' }, userIds = { alice: 101, bob: 202 } } = {}) {
    this.users = users;          // token -> login
    this.userIds = userIds;      // login -> numeric GitHub user ID
    this.repos = new Map();      // "owner/name" -> repo
    this.objects = new Map();    // sha -> { type, ... }
    this.pulls = [];
    this.log = [];
    this.fetch = this.fetch.bind(this);
  }

  // Create a repository, optionally with files on its default branch.
  addRepo(fullName, { files = null, branch = 'main', collaborators = [], pages = null } = {}) {
    const [owner, name] = fullName.split('/');
    const repo = { owner, name, default_branch: branch, refs: new Map(), collaborators, pages, parent: null };
    this.repos.set(fullName.toLowerCase(), repo);
    if (files) {
      const tree = {};
      for (const [p, v] of Object.entries(files)) tree[p] = this.putBlob(Buffer.from(v));
      repo.refs.set(branch, this.putCommit(tree, []));
    }
    return repo;
  }

  putBlob(buf) {
    const sha = blobSha(buf);
    this.objects.set(sha, { type: 'blob', data: buf });
    return sha;
  }
  putTree(entries) {
    const sha = sha1('tree' + JSON.stringify(Object.entries(entries).sort()));
    this.objects.set(sha, { type: 'tree', entries });
    return sha;
  }
  putCommit(entries, parents, message = 'commit') {
    const tree = this.putTree(entries);
    const sha = sha1(`commit ${tree} ${parents.join(',')} ${message} ${this.objects.size} ${Math.random()}`);
    this.objects.set(sha, { type: 'commit', tree, parents, message });
    return sha;
  }

  // Files on a branch as { path: text }.
  files(fullName, branch) {
    const repo = this.repos.get(fullName.toLowerCase());
    const head = repo.refs.get(branch || repo.default_branch);
    if (!head) return null;
    const tree = this.objects.get(this.objects.get(head).tree).entries;
    return Object.fromEntries(Object.entries(tree).map(([p, s]) => [p, this.objects.get(s).data]));
  }

  commits(fullName, branch) {
    const repo = this.repos.get(fullName.toLowerCase());
    let sha = repo.refs.get(branch || repo.default_branch);
    const out = [];
    while (sha) { const c = this.objects.get(sha); out.push({ sha, ...c }); sha = c.parents[0]; }
    return out;
  }

  async fetch(url, init = {}) {
    const u = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    const auth = (init.headers && init.headers.Authorization) || '';
    const login = this.users[auth.replace(/^Bearer /, '')] || null;
    const body = init.body ? JSON.parse(init.body) : null;
    this.log.push(`${method} ${u.pathname}`);
    const reply = (status, json) => ({ ok: status >= 200 && status < 300, status, text: async () => (json === undefined ? '' : JSON.stringify(json)) });
    if (!login) return reply(401, { message: 'Bad credentials' });
    try {
      const out = this.route(method, decodeURIComponent(u.pathname), u.searchParams, body, login);
      return reply(out[0], out[1]);
    } catch (e) {
      return reply(500, { message: e.message });
    }
  }

  route(method, path, query, body, login) {
    if (method === 'GET' && path === '/user') return [200, { login, id: this.userIds?.[login] }];
    const m = path.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
    if (!m) return [404, { message: 'Not Found' }];
    const full = `${m[1]}/${m[2]}`;
    const repo = this.repos.get(full.toLowerCase());
    const rest = m[3] || '';
    if (!repo) {
      return [404, { message: 'Not Found' }];
    }
    const canPush = repo.owner.toLowerCase() === login.toLowerCase() || repo.collaborators.includes(login);
    const write = method !== 'GET';
    if (write && !canPush && !['/forks', '/pulls'].includes(rest)) return [403, { message: 'Resource not accessible by personal access token' }];
    const empty = repo.refs.size === 0;

    if (method === 'GET' && rest === '') {
      return [200, { full_name: full, name: repo.name, owner: { login: repo.owner }, default_branch: repo.default_branch, size: empty ? 0 : 1, permissions: { push: canPush, admin: canPush } }];
    }
    let r;
    if ((r = rest.match(/^\/git\/ref\/heads\/(.+)$/)) && method === 'GET') {
      if (empty) return [409, { message: 'Git Repository is empty.' }];
      const sha = repo.refs.get(r[1]);
      return sha ? [200, { object: { sha } }] : [404, { message: 'Not Found' }];
    }
    if ((r = rest.match(/^\/git\/commits\/([0-9a-f]+)$/)) && method === 'GET') {
      const c = this.objects.get(r[1]);
      return c && c.type === 'commit' ? [200, { sha: r[1], tree: { sha: c.tree } }] : [404, { message: 'Not Found' }];
    }
    if ((r = rest.match(/^\/git\/trees\/([0-9a-f]+)$/)) && method === 'GET') {
      const t = this.objects.get(r[1]);
      return [200, { sha: r[1], truncated: false, tree: Object.entries(t.entries).map(([p, sha]) => ({ path: p, type: 'blob', sha })) }];
    }
    if ((r = rest.match(/^\/contents\/(.+)$/))) {
      if (method === 'PUT') {
        if (!empty) return [422, { message: 'sha wasn\'t supplied' }];
        const sha = this.putCommit({ [r[1]]: this.putBlob(Buffer.from(body.content || '', 'base64')) }, [], body.message);
        repo.refs.set(repo.default_branch, sha);
        return [201, { commit: { sha } }];
      }
      if (empty) return [404, { message: 'This repository is empty.' }];
      const files = this.files(full, query.get('ref') || repo.default_branch);
      if (!files || !files[r[1]]) return [404, { message: 'Not Found' }];
      return [200, { type: 'file', content: files[r[1]].toString('base64') }];
    }
    if (rest === '/git/blobs' && method === 'POST') {
      if (empty) return [409, { message: 'Git Repository is empty.' }];
      return [201, { sha: this.putBlob(Buffer.from(body.content, 'base64')) }];
    }
    if (rest === '/git/trees' && method === 'POST') {
      if (empty) return [409, { message: 'Git Repository is empty.' }];
      const entries = body.base_tree ? { ...this.objects.get(body.base_tree).entries } : {};
      for (const e of body.tree) {
        if (e.sha === null) {
          if (!(e.path in entries)) return [422, { message: `path ${e.path} not in tree` }];
          delete entries[e.path];
        } else entries[e.path] = e.sha;
      }
      return [201, { sha: this.putTree(entries) }];
    }
    if (rest === '/git/commits' && method === 'POST') {
      const t = this.objects.get(body.tree);
      const sha = sha1(`commit ${body.tree} ${body.parents.join(',')} ${body.message} ${this.objects.size}`);
      this.objects.set(sha, { type: 'commit', tree: body.tree, parents: body.parents, message: body.message, entries: t.entries });
      return [201, { sha }];
    }
    if (rest === '/git/refs' && method === 'POST') {
      const name = body.ref.replace(/^refs\/heads\//, '');
      if (repo.refs.has(name)) return [422, { message: 'Reference already exists' }];
      repo.refs.set(name, body.sha);
      return [201, { ref: body.ref, object: { sha: body.sha } }];
    }
    if ((r = rest.match(/^\/git\/refs\/heads\/(.+)$/)) && method === 'PATCH') {
      const cur = repo.refs.get(r[1]);
      if (!cur) return [422, { message: 'Reference does not exist' }];
      if (!body.force && !this.isAncestor(cur, body.sha)) return [422, { message: 'Update is not a fast forward' }];
      repo.refs.set(r[1], body.sha);
      return [200, { object: { sha: body.sha } }];
    }
    if (rest === '/forks' && method === 'POST') {
      const forkName = `${login}/${repo.name}`;
      let fork = this.repos.get(forkName.toLowerCase());
      if (!fork) {
        fork = this.addRepo(forkName, { branch: repo.default_branch });
        fork.parent = full;
        for (const [k, v] of repo.refs) fork.refs.set(k, v);
      }
      return [202, { name: fork.name, owner: { login }, full_name: forkName }];
    }
    if (rest === '/merge-upstream' && method === 'POST') {
      if (!repo.parent) return [422, { message: 'Not a fork' }];
      const up = this.repos.get(repo.parent.toLowerCase());
      repo.refs.set(body.branch, up.refs.get(body.branch));
      return [200, { message: 'Successfully fetched and fast-forwarded' }];
    }
    if (rest === '/pulls' && method === 'POST') {
      const [headOwner, headBranch] = body.head.includes(':') ? body.head.split(':') : [repo.owner, body.head];
      const headRepo = [...this.repos.values()].find((x) => x.owner.toLowerCase() === headOwner.toLowerCase() && (x === repo || x.parent?.toLowerCase() === full.toLowerCase()));
      if (!headRepo || !headRepo.refs.has(headBranch)) return [422, { message: 'Validation Failed: head not found' }];
      const pr = { number: this.pulls.length + 1, repo: full, ...body, headSha: headRepo.refs.get(headBranch), headRepo: `${headRepo.owner}/${headRepo.name}`, author: login };
      this.pulls.push(pr);
      return [201, { number: pr.number, html_url: `https://github.com/${full}/pull/${pr.number}` }];
    }
    if (rest === '/pages') {
      if (method === 'GET') return repo.pages ? [200, repo.pages] : [404, { message: 'Not Found' }];
      if (!repo.allowPagesApi) return [403, { message: 'Resource not accessible by personal access token' }];
      if (method === 'POST') { repo.pages = { build_type: body.build_type, source: body.source, cname: null }; return [201, repo.pages]; }
      if (method === 'PUT') { repo.pages = { ...repo.pages, cname: body.cname, source: body.source }; return [204]; }
    }
    return [404, { message: `No fake for ${method} ${rest}` }];
  }

  isAncestor(ancestor, sha) {
    while (sha) {
      if (sha === ancestor) return true;
      sha = this.objects.get(sha).parents[0];
    }
    return false;
  }
}
