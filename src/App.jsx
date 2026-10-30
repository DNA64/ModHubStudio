import { modFromArchive, modFromFolder, modsFromPackageFolder, looksLikePackageFolder, setKind, renameFile, totalSize, KINDS, ACCEPTED_EXTENSIONS } from './model.js';
import { TARGETS, TARGET_IDS, resolveTargets, detectTargets } from './targets.js';
import { validate, applyFix, applyAllFixes, AUTO_FIX_IDS, destination, fileMode, cleanName, OVERLAY_ROOTS, CONTROL_FILES } from './rules.js';
import { packHmod, hmodFileName, readmeText } from './pack.js';
import { buildRepoFiles, buildRepoZip, repoIssues, modLink, normalizeBase } from './repo.js';
import { CATEGORIES, STANDARD_FIELDS, MANAGED_FIELDS } from './readme.js';
import { exampleMods } from './examples.js';
import { createClient, parseRepoName } from './github.js';
import { publishToPages, pagesUrl, pagesIssues } from './publish.js';
import { prepareSubmission, submitToCentral } from './submit.js';
import { CENTRAL_REPO, CENTRAL_TITLE, STUDIO_URL } from './project.js';
import { isPackageId, suggestPackageId } from './packageid.js';

const { useState, useMemo, useEffect, useRef, useCallback } = React;

const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`);
const SEV_ORDER = { error: 0, warning: 1, info: 2 };
const SEV_LABEL = { error: 'Error', warning: 'Warning', info: 'Note' };

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

// ---------- file intake ----------
async function readEntryTree(entry, prefix = '') {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    return [{ path: prefix + entry.name, data: new Uint8Array(await file.arrayBuffer()) }];
  }
  const reader = entry.createReader();
  const children = [];
  for (;;) {
    const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    children.push(...batch);
  }
  const out = [];
  for (const c of children) out.push(...(await readEntryTree(c, prefix + entry.name + '/')));
  return out;
}

const LOOKS_LIKE_CONTENTS = (name) => OVERLAY_ROOTS.includes(name.toLowerCase()) || CONTROL_FILES.includes(name) || /^readme(\.|$)/i.test(name);

async function modsFromDrop(dataTransfer) {
  const items = [...(dataTransfer.items || [])].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (!items.length) return modsFromFiles([...dataTransfer.files]);
  // Dropping the contents of a mod (etc/, usr/, install…) instead of its folder: treat as one mod.
  if (items.some((e) => LOOKS_LIKE_CONTENTS(e.name)) && items.length > 1) {
    const files = [];
    for (const e of items) files.push(...(await readEntryTree(e)));
    return [await modFromFolder('new_mod', files)];
  }
  const mods = [];
  for (const e of items) {
    if (e.isDirectory) {
      const files = (await readEntryTree(e)).map((f) => ({ ...f, path: f.path.slice(e.name.length + 1) }));
      if (looksLikePackageFolder(files)) {
        const r = await modsFromPackageFolder(files);
        mods.push(...r.mods);
        mods.skipped = [...(mods.skipped || []), ...r.errors];
        if (r.skipped.length) mods.notes = [...(mods.notes || []), `Ignored ${r.skipped.length} file${r.skipped.length === 1 ? '' : 's'} in ${e.name} that ${r.skipped.length === 1 ? "isn't a package" : "aren't packages"}.`];
      } else mods.push(await modFromFolder(e.name, files));
    } else {
      const file = await new Promise((res, rej) => e.file(res, rej));
      try { mods.push(await modFromArchive(file.name, new Uint8Array(await file.arrayBuffer()))); }
      catch (err) { mods.skipped = [...(mods.skipped || []), err.message]; }
    }
  }
  return mods;
}

async function modsFromFiles(fileList) {
  const mods = [];
  for (const f of fileList) {
    try { mods.push(await modFromArchive(f.name, new Uint8Array(await f.arrayBuffer()))); }
    catch (err) { mods.skipped = [...(mods.skipped || []), err.message]; }
  }
  return mods;
}

// mode 'unpacked': the chosen folder is one mod being authored.
// mode 'packages': the chosen folder holds .hmod/.clvg files and unpacked *.hmod/*.clvg folders.
async function modsFromFolderInput(fileList, mode) {
  if (mode === 'packages') {
    const files = [];
    let root = '';
    for (const f of fileList) {
      const [folder, ...rest] = (f.webkitRelativePath || f.name).split('/');
      root = folder;
      files.push({ path: rest.join('/'), data: new Uint8Array(await f.arrayBuffer()) });
    }
    const r = await modsFromPackageFolder(files);
    const mods = r.mods;
    mods.skipped = r.errors;
    if (!mods.length && !r.errors.length) mods.skipped = [`${root} has no .hmod or .clvg packages in it. To check a mod you're building, use Choose unpacked mod.`];
    if (r.skipped.length) mods.notes = [`Ignored ${r.skipped.length} file${r.skipped.length === 1 ? '' : 's'} that ${r.skipped.length === 1 ? "isn't a package" : "aren't packages"}.`];
    return mods;
  }
  const groups = new Map();
  for (const f of fileList) {
    const rel = f.webkitRelativePath || f.name;
    const [folder, ...rest] = rel.split('/');
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push({ path: rest.join('/'), data: new Uint8Array(await f.arrayBuffer()) });
  }
  const mods = [];
  for (const [folder, files] of groups) {
    // A real unpacked mod never contains .hmod/.clvg packages (hakchi skips them),
    // so a folder full of them is a folder of packages, whichever button picked it.
    if (looksLikePackageFolder(files)) {
      const r = await modsFromPackageFolder(files);
      mods.push(...r.mods);
      mods.skipped = [...(mods.skipped || []), ...r.errors];
      mods.notes = [...(mods.notes || []), `${folder} holds packages, so each one was added separately.`];
      if (r.skipped.length) mods.notes.push(`Ignored ${r.skipped.length} file${r.skipped.length === 1 ? '' : 's'} that ${r.skipped.length === 1 ? "isn't a package" : "aren't packages"}.`);
    } else mods.push(await modFromFolder(folder, files));
  }
  return mods;
}

// ---------- downloads ----------
// Saves a generated file through an ordinary browser download.
function offerFile(filename, data) {
  const url = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return filename;
}

// ---------- small components ----------
function Logo() {
  return (
    <svg className="logo" viewBox="0 0 28 28" aria-hidden="true">
      <circle cx="14" cy="6" r="4.2" fill="var(--btn-x)" />
      <circle cx="22" cy="14" r="4.2" fill="var(--btn-a)" />
      <circle cx="14" cy="22" r="4.2" fill="var(--btn-b)" />
      <circle cx="6" cy="14" r="4.2" fill="var(--btn-y)" />
    </svg>
  );
}

function Counts({ issues, compact }) {
  const c = { error: 0, warning: 0, info: 0 };
  for (const i of issues) c[i.severity]++;
  if (!c.error && !c.warning) return <span className="pill pill-ok">{compact ? 'Ready' : 'Ready to publish'}</span>;
  return (
    <span className="counts">
      {c.error > 0 && <span className="pill pill-error">{c.error} {compact ? 'err' : c.error === 1 ? 'error' : 'errors'}</span>}
      {c.warning > 0 && <span className="pill pill-warning">{c.warning} {compact ? 'warn' : c.warning === 1 ? 'warning' : 'warnings'}</span>}
    </span>
  );
}

function PathList({ paths }) {
  const [open, setOpen] = useState(false);
  if (!paths || !paths.length) return null;
  const shown = open ? paths : paths.slice(0, 4);
  return (
    <div className="pathlist">
      {shown.map((p) => <code key={p}>{p}</code>)}
      {paths.length > 4 && (
        <button className="linkish" onClick={() => setOpen(!open)}>{open ? 'Show fewer' : `Show all ${paths.length}`}</button>
      )}
    </div>
  );
}

function Issue({ issue, onFix, onDismiss }) {
  return (
    <li className={`issue sev-${issue.severity}`}>
      <div className="issue-head">
        <span className={`sev sev-tag-${issue.severity}`}>{SEV_LABEL[issue.severity]}</span>
        <h4>{issue.title}</h4>
      </div>
      <p>{renderTicks(issue.detail)}</p>
      <PathList paths={issue.paths} />
      {(issue.fixLabel || issue.severity !== 'error') && (
        <div className="issue-actions">
          {issue.fixLabel && <button className="btn btn-small btn-primary" onClick={() => onFix(issue.id)}>{issue.fixLabel}</button>}
          {issue.severity !== 'error' && <button className="btn btn-small btn-quiet" onClick={() => onDismiss(issue.id)}>Ignore</button>}
        </div>
      )}
    </li>
  );
}

function renderTicks(text) {
  return text.split(/(`[^`]+`)/g).map((part, i) => (part.startsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : part));
}

// ---------- mod views ----------
function ChecksTab({ mod, issues, update }) {
  const fixable = issues.filter((i) => i.fixLabel && AUTO_FIX_IDS.includes(i.id));
  const sorted = [...issues].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  return (
    <div className="stack">
      <div className="summary-bar">
        <div>
          <Counts issues={issues} />
          <p className="muted small">{issues.length ? `${issues.length} finding${issues.length === 1 ? '' : 's'} from hakchi's install rules.` : 'No problems found against hakchi\'s install rules.'}</p>
        </div>
        {fixable.length > 0 && (
          <button className="btn btn-primary" onClick={() => update(applyAllFixes(mod))}>Apply {fixable.length} automatic fix{fixable.length === 1 ? '' : 'es'}</button>
        )}
      </div>
      {sorted.length > 0 ? (
        <ul className="issues">
          {sorted.map((i) => (
            <Issue key={i.id} issue={i}
              onFix={(id) => update(applyFix(mod, id))}
              onDismiss={(id) => update({ ...mod, dismissed: [...(mod.dismissed || []), id] })} />
          ))}
        </ul>
      ) : (
        <div className="empty-ok">
          <strong>Everything installs where it should.</strong>
          <span>Check the Files tab for the final layout, then pack it.</span>
        </div>
      )}
      {mod.dismissed && mod.dismissed.length > 0 && (
        <button className="linkish" onClick={() => update({ ...mod, dismissed: [] })}>Show {mod.dismissed.length} ignored finding{mod.dismissed.length === 1 ? '' : 's'}</button>
      )}
    </div>
  );
}

function FileRow({ file: f, mod, update, remove }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(f.path);
  const [error, setError] = useState(null);
  const d = destination(editing ? value.replace(/^\/+/, '') : f.path, mod.kind);
  const commit = () => {
    const r = renameFile(mod, f.path, value);
    if (r.error) { setError(r.error); return; }
    setEditing(false); setError(null);
    if (r.mod !== mod) update(r.mod);
  };
  const cancel = () => { setEditing(false); setError(null); setValue(f.path); };
  return (
    <tr className={editing ? 'row-editing' : ''}>
      <td>
        {editing ? (
          <div className="rename">
            <input id={`path-${mod.id}-${f.path}`} className="mono small" value={value} autoFocus spellCheck="false"
              aria-label={`New path for ${f.path}`} aria-invalid={!!error}
              onChange={(e) => { setValue(e.target.value); setError(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') cancel(); }} />
            {error && <span className="field-error">{error}</span>}
          </div>
        ) : (
          <><code>{f.path}{f.type === 'dir' ? '/' : ''}</code>{f.type === 'symlink' && <span className="muted small"> → {f.linkname}</span>}</>
        )}
      </td>
      <td><span className={`dest dest-${d.kind}`}>{d.label}</span></td>
      <td className="num mono">{fileMode(f, mod.kind).toString(8)}</td>
      <td className="num">{fmtSize(f.data.length)}</td>
      <td className="row-actions">
        {editing ? (
          <>
            <button className="btn btn-small btn-primary" onClick={commit}>Save</button>
            <button className="btn btn-small btn-quiet" onClick={cancel}>Cancel</button>
          </>
        ) : (
          <>
            <button className="btn btn-small btn-quiet" onClick={() => { setValue(f.path); setEditing(true); }} aria-label={`Rename ${f.path}`}>Rename</button>
            <button className="btn btn-small btn-quiet" onClick={() => remove(f.path)} aria-label={`Remove ${f.path}`}>Remove</button>
          </>
        )}
      </td>
    </tr>
  );
}

function FilesTab({ mod, update }) {
  const rows = [...mod.files].sort((a, b) => a.path.localeCompare(b.path));
  const remove = (path) => update({ ...mod, files: mod.files.filter((f) => f.path !== path) });
  return (
    <div className="stack">
      {mod.kind === 'game'
        ? <p className="muted">Hakchi2 CE extracts a .clvg into a game folder and imports the .desktop file at its top level.</p>
        : <p className="muted">hakchi copies the package root onto the console's root through its overlay in <code>/var/lib/hakchi/rootfs</code>. The right column is where each file ends up. Rename a file to move it; type the full path, folders included.</p>}
      <div className="table-wrap">
        <table className="files">
          <thead><tr><th>In the package</th><th>{mod.kind === 'game' ? 'Role' : 'On the console'}</th><th className="num">Mode</th><th className="num">Size</th><th aria-label="Actions" /></tr></thead>
          <tbody>
            {mod.kind !== 'game' && <tr className="row-generated">
              <td><code>readme.md</code></td>
              <td><span className="dest dest-skipped">Read by Hakchi2 CE, not installed</span></td>
              <td className="num mono">644</td>
              <td className="num">{fmtSize(new TextEncoder().encode(readmeText(mod)).length)}</td>
              <td className="muted small">generated</td>
            </tr>}
            {rows.map((f) => <FileRow key={f.path} file={f} mod={mod} update={update} remove={remove} />)}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Hint text for the readme fields. Hakchi2 CE shows any field it doesn't use by name as "Field: value".
const PLACEHOLDERS = {
  Maintainer: 'optional',
  Version: '1.0.0',
  'Emulated System': 'optional',
  Prerequisite: 'optional, e.g. RetroArch',
  'Command Line': 'optional',
  Tags: 'optional',
};

function ReadmeTab({ mod, update }) {
  const set = (k, v) => update({ ...mod, readme: { ...mod.readme, front: { ...mod.readme.front, [k]: v } } });
  const extra = Object.keys(mod.readme.front).filter((k) => !STANDARD_FIELDS.includes(k) && !MANAGED_FIELDS.includes(k));
  return (
    <div className="readme-grid">
      <div className="stack">
        <div className="fields">
          {STANDARD_FIELDS.map((k) => (
            <label key={k} className="field">
              <span>{k}</span>
              <input id={`fm-${mod.id}-${k}`} value={mod.readme.front[k] || ''} list={k === 'Category' ? 'categories' : undefined}
                placeholder={k === 'Name' ? mod.name : PLACEHOLDERS[k] || ''}
                onChange={(e) => set(k, e.target.value)} />
            </label>
          ))}
          {extra.map((k) => (
            <label key={k} className="field">
              <span>{k}</span>
              <input id={`fm-${mod.id}-x-${k}`} value={mod.readme.front[k] || ''} onChange={(e) => set(k, e.target.value)} />
            </label>
          ))}
          <datalist id="categories">{CATEGORIES.map((c) => <option key={c} value={c} />)}</datalist>
        </div>
        <label className="field">
          <span>Description (Markdown)</span>
          <textarea id={`body-${mod.id}`} rows={10} value={mod.readme.body}
            onChange={(e) => update({ ...mod, readme: { ...mod.readme, body: e.target.value } })} />
        </label>
      </div>
      <div className="stack">
        <span className="eyebrow">{mod.kind === 'game' ? 'Mod Hub listing (kept in .repo only)' : 'readme.md as packed'}</span>
        <pre className="code">{readmeText(mod)}</pre>
      </div>
    </div>
  );
}

// ---------- GitHub ----------
const TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=public_repo&description=hmod%20Repo%20Publisher';

function GitHubConnect({ github, setGithub, compact }) {
  const [token, setToken] = useState('');
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  if (github.login) {
    return (
      <div className="gh-connected">
        <span>Signed in to GitHub as <strong>{github.login}</strong>{github.remember ? ' · remembered on this device' : ''}</span>
        <button className="btn btn-small btn-quiet" onClick={() => setGithub({ token: '', login: '', remember: false })}>Disconnect</button>
      </div>
    );
  }
  const connect = async () => {
    setBusy(true); setError(null);
    try {
      const me = await createClient({ token: token.trim() }).user();
      setGithub({ token: token.trim(), login: me.login, remember });
      setToken('');
    } catch (e) { setError(e.message || 'Couldn\'t reach GitHub.'); } finally { setBusy(false); }
  };
  return (
    <div className={`gh-connect ${compact ? 'compact' : ''}`}>
      <label className="field"><span>GitHub token</span>
        <input id="gh-token" type="password" autoComplete="off" spellCheck="false" value={token} placeholder="ghp_… or github_pat_…"
          onChange={(e) => { setToken(e.target.value); setError(null); }} onKeyDown={(e) => { if (e.key === 'Enter' && token.trim()) connect(); }} />
      </label>
      <div className="row">
        <button className="btn btn-primary" disabled={busy || !token.trim()} onClick={connect}>{busy ? 'Checking…' : 'Connect'}</button>
        <label className="check"><input id="gh-remember" type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember on this device</label>
      </div>
      {error && <p className="field-error">{error}</p>}
      <p className="muted small">
        <a href={TOKEN_URL} target="_blank" rel="noopener noreferrer">Create a token</a> with the <code>public_repo</code> scope, or a fine-grained token with Contents: read and write on your repository.
        It is only sent to api.github.com and stays in this browser.
      </p>
    </div>
  );
}

// One package in the central-repository list on the Publish tab.
function SubmitItem({ mod, issues, central, github, notify, open }) {
  const [prep, setPrep] = useState(null);
  const [busy, setBusy] = useState(null);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  useEffect(() => { setPrep(null); setDone(null); setError(null); }, [mod, central && `${central.owner}/${central.repo}`, github.login]);
  const gh = () => createClient({ token: github.token });
  const localErrors = issues.filter((i) => i.severity === 'error').length;
  const ready = github.login && central;

  const check = async () => {
    setBusy('check'); setError(null); setDone(null);
    try { setPrep(await prepareSubmission(gh(), { central, mod })); } catch (e) { setError(e.message); } finally { setBusy(null); }
  };
  const submit = async () => {
    setBusy('submit'); setError(null);
    try {
      const pr = await submitToCentral(gh(), { central, mod, prepared: prep, onProgress: setProgress });
      setDone(pr);
      notify(`Opened pull request #${pr.number} on ${central.owner}/${central.repo}.`);
    } catch (e) { setError(e.message); } finally { setBusy(null); setProgress(''); }
  };

  return (
    <li className="submit-item">
      <div className="submit-head">
        <div className="submit-name">
          <button className="linkish strong" onClick={open}>{mod.readme.front.Name || mod.name}</button>
          <span className="muted small mono">{hmodFileName(mod)}{mod.readme.front.Version ? ` · ${mod.readme.front.Version}` : ''}</span>
        </div>
        <Counts issues={issues} compact />
        <div className="row submit-actions">
          {done ? (
            <a className="btn btn-small" href={done.url} target="_blank" rel="noopener noreferrer">View pull request #{done.number}</a>
          ) : localErrors > 0 ? (
            <span className="muted small">Fix {localErrors === 1 ? 'its error' : `its ${localErrors} errors`} first</span>
          ) : (
            <>
              <button className="btn btn-small" disabled={!ready || !!busy} onClick={check}>{busy === 'check' ? 'Checking…' : prep ? 'Check again' : 'Check'}</button>
              {prep && !prep.result.errors.length && (
                <button className="btn btn-small btn-primary" disabled={!!busy} onClick={submit}>{busy === 'submit' ? 'Submitting…' : 'Open pull request'}</button>
              )}
            </>
          )}
        </div>
      </div>
      {progress && <p className="muted small" role="status">{progress}…</p>}
      {error && <p className="callout callout-error">{error}</p>}
      {prep && !done && (
        <div className="submission">
          <p className="small">
            {prep.isUpdate ? `Updates ${prep.file} from ${prep.prev.version} to ${prep.meta.version || '?'}` : `Adds ${prep.file} at version ${prep.meta.version || '?'}`}
            {' '}to {prep.config.title}. Maintainers: {prep.meta.maintainers.join(', ')}.
            {' '}{prep.canPush ? 'Sent as a branch in the repository.' : `Sent from a fork in your account (${prep.me.login}/${central.repo}).`}
          </p>
          {prep.result.errors.length > 0 && <ul className="plain-issues">{prep.result.errors.map((t, i) => <li key={i} className="callout callout-error">{t}</li>)}</ul>}
          {prep.result.approvals && prep.result.approvals.length > 0 && (
            <div className="callout callout-ok small">
              <strong>An admin will review this when merging:</strong>
              <ul>{prep.result.approvals.map((t, i) => <li key={i}>{t}</li>)}</ul>
            </div>
          )}
          {prep.result.warnings.length > 0 && <ul className="plain-issues">{prep.result.warnings.map((t, i) => <li key={i} className="callout callout-warning">{t}</li>)}</ul>}
        </div>
      )}
    </li>
  );
}

function PackageTab({ mod, issues, notify, goPublish }) {
  const [busy, setBusy] = useState(false);
  const errors = issues.filter((i) => i.severity === 'error').length;
  const pack = async () => {
    setBusy(true);
    try {
      const bytes = await packHmod(mod);
      const name = hmodFileName(mod);
      offerFile(name, bytes);
      notify(`Saved ${name}.`);
    } catch (e) {
      notify((e && e.message) || 'The download could not start.', true);
    } finally { setBusy(false); }
  };
  return (
    <div className="stack">
      <dl className="facts">
        <div><dt>File</dt><dd><code>{hmodFileName(mod)}</code></dd></div>
        {mod.kind === 'game' ? <>
          <div><dt>Format</dt><dd>gzip-compressed tar, the same layout Hakchi2 CE's own game export writes</dd></div>
          <div><dt>Contents</dt><dd>{mod.files.length} files, {fmtSize(totalSize(mod))} before compression</dd></div>
        </> : <>
          <div><dt>Format</dt><dd>gzip-compressed tar, owned by root, as <code>tar -xzf</code> expects</dd></div>
          <div><dt>Contents</dt><dd>{mod.files.length + 1} files, {fmtSize(totalSize(mod))} before compression</dd></div>
          <div><dt>Permissions</dt><dd>755 for bin, sbin, usr/bin, usr/sbin, etc/init.d and marked executables; 644 for everything else</dd></div>
        </>}
      </dl>
      {errors > 0 && <p className="callout callout-error">There {errors === 1 ? 'is 1 error' : `are ${errors} errors`} in Checks. You can still pack, but the mod won't install correctly until they're fixed.</p>}
      <div className="row">
        <button className="btn btn-primary" disabled={busy} onClick={pack}>{busy ? 'Packing…' : `Download ${hmodFileName(mod)}`}</button>
      </div>
      <p className="muted small">To put it on your Mod Hub site or send it to a central repository, use the <button className="linkish small" onClick={goPublish}>Publish tab</button>.</p>
    </div>
  );
}

function ConsolePicker({ mod, update }) {
  const { ids, from } = resolveTargets(mod);
  const detected = useMemo(() => detectTargets(mod), [mod]);
  const toggle = (t) => {
    const next = ids.includes(t) ? ids.filter((x) => x !== t) : [...ids, t];
    if (!next.length) return;
    update({ ...mod, targets: TARGET_IDS.filter((x) => next.includes(x)) });
  };
  const caption = {
    manual: 'Set by you',
    readme: 'From the readme\'s Consoles field',
    contents: `Detected: ${[...new Set(detected.evidence.map((e) => e.reason))].slice(0, 2).join('; ')}`,
    none: 'Nothing console-specific found, so all consoles',
  }[from];
  return (
    <div className="kind-row">
      <span className="eyebrow">Consoles</span>
      <div className="segmented" role="group" aria-label="Target consoles">
        {TARGET_IDS.map((t) => (
          <button key={t} aria-pressed={ids.includes(t)} className={ids.includes(t) ? 'on' : ''} onClick={() => toggle(t)}
            title={TARGETS[t].consoles}>{TARGETS[t].label}</button>
        ))}
      </div>
      <span className="muted small">{caption}</span>
      {from === 'manual' && <button className="linkish small" onClick={() => update({ ...mod, targets: null })}>Reset</button>}
    </div>
  );
}

function ModView({ mod, update, remove, notify, goPublish }) {
  const [tab, setTab] = useState('checks');
  const issues = useMemo(() => validate(mod), [mod]);
  const idOk = isPackageId(mod.name);
  const nameIssue = (mod.kind !== 'game' && cleanName(mod.name) !== mod.name) || !idOk;
  const tabs = [
    ['checks', 'Checks', <Counts key="c" issues={issues} compact />],
    ['files', 'Files', <span key="f" className="tab-count">{mod.files.length}</span>],
    ['readme', 'Readme', null],
    ['package', 'Package', null],
  ];
  return (
    <section className="pane">
      <header className="pane-head">
        <div className="name-edit">
          <label htmlFor={`name-${mod.id}`} className="eyebrow">Package ID</label>
          <div className="name-row">
            <input id={`name-${mod.id}`} className={`name-input ${nameIssue ? 'has-issue' : ''}`} value={mod.name}
              size={Math.max(6, mod.name.length + 1)} onChange={(e) => update({ ...mod, name: e.target.value })} spellCheck="false"
              title="Click to rename the packed file" />
            <span className="ext">{KINDS[mod.kind].ext}</span>
            <button className="btn btn-small btn-quiet rename-btn" onClick={() => { const el = document.getElementById(`name-${mod.id}`); el.focus(); el.select(); }}>Rename</button>
          </div>
          {!idOk && (
            <p className="muted small">
              Not a Package ID yet (yourname.package, lowercase, no underscores). The central repository requires one.{' '}
              <button className="linkish" onClick={() => update({ ...mod, name: suggestPackageId(mod) })}>Use {suggestPackageId(mod)}</button>
            </p>
          )}
          <p className="muted small">
            {mod.source?.example ? <span className="pill pill-example">Example</span> : null}{' '}
            From {mod.source?.fileName} · {mod.files.length} files · {fmtSize(totalSize(mod))}
          </p>
          <div className="kind-row">
            <div className="segmented" role="radiogroup" aria-label="Package type">
              {Object.entries(KINDS).map(([k, v]) => (
                <button key={k} role="radio" aria-checked={mod.kind === k} className={mod.kind === k ? 'on' : ''}
                  onClick={() => update(setKind(mod, k))}>{v.label} <span className="mono">{v.ext}</span></button>
              ))}
            </div>
            <span className="muted small">{{ contents: 'Detected from its contents', name: 'From the file name (contents were unclear)', default: 'Defaulted to mod (contents were unclear)', manual: 'Set by you' }[mod.source?.kindFrom || 'name']}</span>
          </div>
          <ConsolePicker mod={mod} update={update} />
        </div>
        <button className="btn btn-quiet" onClick={remove}>Remove from repository</button>
      </header>
      <nav className="tabs" role="tablist">
        {tabs.map(([id, label, extra]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={`tab ${tab === id ? 'on' : ''}`} onClick={() => setTab(id)}>
            {label}{extra}
          </button>
        ))}
      </nav>
      <div className="pane-body">
        {tab === 'checks' && <ChecksTab mod={mod} issues={issues} update={update} />}
        {tab === 'files' && <FilesTab mod={mod} update={update} />}
        {tab === 'readme' && <ReadmeTab mod={mod} update={update} />}
        {tab === 'package' && <PackageTab mod={mod} issues={issues} notify={notify} goPublish={goPublish} />}
      </div>
    </section>
  );
}

// ---------- repository view ----------
// The address Hakchi2 CE users add: the Pages address when publishing to
// GitHub Pages, otherwise whatever the person typed for their own host.
export function siteAddress(repo) {
  if (repo.hosting === 'pages') {
    const r = parseRepoName(repo.pages && repo.pages.repo);
    return r ? pagesUrl(r, repo.pages.cname) : '';
  }
  return normalizeBase(repo.baseUrl);
}

function PagesPublish({ repo, setRepo, mods, github, notify, blocking }) {
  const pages = repo.pages || { repo: '', branch: 'main', cname: '' };
  const setPages = (patch) => setRepo({ ...repo, pages: { ...pages, ...patch } });
  const target = parseRepoName(pages.repo);
  const problems = pagesIssues({ repo: target, branch: pages.branch, cname: pages.cname });
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const publish = async () => {
    setBusy(true); setError(null); setResult(null); setSteps([]);
    try {
      const gh = createClient({ token: github.token });
      const r = await publishToPages(gh, {
        target: { repo: target, branch: pages.branch.trim(), cname: pages.cname },
        repoSettings: repo,
        mods,
        onProgress: (t) => setSteps((s) => [...s.slice(-5), t]),
      });
      setResult(r);
      if (r.cname && r.cname !== pages.cname) setPages({ cname: r.cname });
      notify(r.unchanged ? 'Nothing changed since the last publish.' : `Published to ${r.baseUrl}.`);
    } catch (e) {
      setError(e.message || 'Publishing failed.');
    } finally { setBusy(false); }
  };

  return (
    <div className="stack">
      <div className="fields">
        <label className="field"><span>GitHub repository</span>
          <input id="pages-repo" value={pages.repo} placeholder={`${github.login || 'username'}/hmods`} spellCheck="false"
            onChange={(e) => setPages({ repo: e.target.value })} />
        </label>
        <label className="field"><span>Branch</span>
          <input id="pages-branch" value={pages.branch} spellCheck="false" onChange={(e) => setPages({ branch: e.target.value })} />
        </label>
        <label className="field"><span>Custom domain (optional)</span>
          <input id="pages-cname" value={pages.cname} placeholder="mods.example.com" spellCheck="false"
            onChange={(e) => setPages({ cname: e.target.value })} />
        </label>
      </div>
      <p className="muted small">Create the repository on GitHub first; it can be empty. Publishing only replaces <code>.repo/</code>, <code>hmods/</code>, <code>games/</code> and the generated <code>index.html</code>, so anything else in it stays. To use your own domain, enter it here and add a CNAME record at your domain provider pointing to <code>{(target && target.owner.toLowerCase()) || 'username'}.github.io</code>.</p>
      {pages.repo && problems.length > 0 && <ul className="plain-issues">{problems.map((p, i) => <li key={i} className="callout callout-error">{p.text}</li>)}</ul>}
      <div className="row">
        <button className="btn btn-primary" disabled={busy || !github.login || problems.length > 0 || blocking}
          onClick={publish}>{busy ? 'Publishing…' : 'Publish to GitHub Pages'}</button>
        {!github.login && <span className="muted small">Connect your GitHub account above to publish.</span>}
      </div>
      {busy && steps.length > 0 && <ol className="steps" role="status">{steps.map((t, i) => <li key={i}>{t}</li>)}</ol>}
      {error && <p className="callout callout-error">{error}</p>}
      {result && (
        <div className="callout callout-ok stack">
          <strong>{result.unchanged ? 'Already up to date.' : `Published ${result.uploaded} file${result.uploaded === 1 ? '' : 's'}${result.deleted.length ? `, removed ${result.deleted.length}` : ''}${result.skipped ? `, ${result.skipped} unchanged` : ''}.`}</strong>
          <span>Add <code>{result.baseUrl}</code> in Hakchi2 CE under Modules → Mod Hub → Repositories. GitHub Pages usually updates within a minute.</span>
          {!result.unchanged && <a href={result.commitUrl} target="_blank" rel="noopener noreferrer">View the commit on GitHub</a>}
          {result.notes.length > 0 && <ul>{result.notes.map((n) => <li key={n.kind}>{n.text}</li>)}</ul>}
        </div>
      )}
    </div>
  );
}

function useRepoBasics(repo, mods) {
  const base = siteAddress(repo);
  const effective = useMemo(() => ({ ...repo, baseUrl: base }), [repo, base]);
  const problems = useMemo(() => repoIssues(effective, mods).filter((p) => repo.hosting !== 'pages' || !/address/i.test(p.text)), [effective, mods]);
  const modIssues = useMemo(() => mods.map((m) => validate(m)), [mods]);
  return { base, effective, problems, modIssues, hosting: repo.hosting || 'own' };
}

const consolesLabel = (m) => { const t = resolveTargets(m).ids; return t.length === TARGET_IDS.length ? 'All' : t.map((x) => TARGETS[x].label).join(', '); };

function RepoView({ repo, setRepo, mods, updateMod, open, goPublish }) {
  const [tree, setTree] = useState(null);
  const { base, effective, modIssues, hosting } = useRepoBasics(repo, mods);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!mods.length) { setTree([]); return; }
      const packed = new Map();
      for (const m of mods) packed.set(m.id, new Uint8Array(0));
      const files = await buildRepoFiles({ ...effective, baseUrl: base || 'https://example.com/my-repo' }, mods, packed);
      const paths = files.map((f) => f.path).filter((p) => hosting !== 'pages' || p !== 'HOSTING.md');
      if (hosting === 'pages' && repo.pages && repo.pages.cname) paths.push('CNAME');
      if (alive) setTree(paths.sort((a, b) => a.localeCompare(b)));
    })();
    return () => { alive = false; };
  }, [effective, mods, hosting]);

  return (
    <section className="pane">
      <header className="pane-head">
        <div>
          <span className="eyebrow">Repository</span>
          <h2>{repo.title || 'Untitled repository'}</h2>
          <p className="muted small">{base ? <>Hakchi2 CE users add <code>{base}</code> under Modules → Mod Hub → Repositories.</> : <>No site address yet. Choose where it's hosted on the <button className="linkish small" onClick={goPublish}>Publish tab</button>.</>}</p>
        </div>
      </header>
      <div className="pane-body stack-lg">
        <div className="repo-grid">
          <div className="stack">
            <label className="field"><span>Repository name</span>
              <input id="repo-title" value={repo.title} onChange={(e) => setRepo({ ...repo, title: e.target.value })} /></label>
            <label className="field"><span>Description (Markdown, shown in the Mod Hub)</span>
              <textarea id="repo-readme" rows={4} value={repo.readme} onChange={(e) => setRepo({ ...repo, readme: e.target.value })} /></label>
          </div>
          <div className="stack">
            <span className="eyebrow">Files in the published site</span>
            <pre className="code tree">{tree ? tree.join('\n') : 'Building…'}</pre>
          </div>
        </div>

        <div className="stack">
          <h3>Packages</h3>
          {mods.length ? (
            <div className="table-wrap">
              <table className="files">
                <thead><tr><th>Package</th><th>Version</th><th>Consoles</th><th>Status</th><th>Download link</th></tr></thead>
                <tbody>
                  {mods.map((m, i) => (
                    <tr key={m.id}>
                      <td><button className="linkish strong" onClick={() => open(m.id)}>{m.readme.front.Name || m.name}</button><div className="muted small mono">{hmodFileName(m)}</div></td>
                      <td>{m.readme.front.Version || <span className="muted">—</span>}</td>
                      <td className="small">{consolesLabel(m)}</td>
                      <td><Counts issues={modIssues[i]} compact /></td>
                      <td className="link-cell">
                        <input id={`ext-${m.id}`} className="mono small" value={m.externalUrl || ''}
                          placeholder={base ? modLink(effective, { ...m, externalUrl: '' }) : 'hosted with the repository'}
                          onChange={(e) => updateMod({ ...m, externalUrl: e.target.value })} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="muted">No packages yet. Add them on the Packages tab.</p>}
          <p className="muted small">Leave a download link empty to host the package with the repository, or paste a URL such as a GitHub release asset. Use a release asset for anything over 100 MB, which GitHub won't store in a repository.</p>
        </div>
      </div>
    </section>
  );
}

function PublishView({ repo, setRepo, mods, notify, github, setGithub, open }) {
  const [busy, setBusy] = useState(false);
  const { base, effective, problems, modIssues, hosting } = useRepoBasics(repo, mods);
  const blocking = problems.filter((p) => p.severity === 'error');
  const central = parseRepoName(repo.central);

  const exportRepo = async () => {
    setBusy(true);
    try {
      const packed = new Map();
      for (const m of mods) packed.set(m.id, await packHmod(m));
      const zip = await buildRepoZip(effective, mods, packed);
      const name = `${cleanName(repo.title || 'hmod-repo').toLowerCase()}-site.zip`;
      offerFile(name, zip);
      notify(`Saved ${name}. Upload its contents to ${base || 'your host'}.`);
    } catch (e) {
      notify((e && e.message) || 'The download could not start.', true);
    } finally { setBusy(false); }
  };

  return (
    <section className="pane">
      <header className="pane-head">
        <div>
          <span className="eyebrow">Publish</span>
          <h2>Publish and submit</h2>
          <p className="muted small">Put the whole repository on your own Mod Hub site, or send packages to a shared central repository for review.</p>
        </div>
      </header>
      <div className="pane-body stack-lg">
        <div className="stack panel">
          <h3>GitHub account</h3>
          <p className="muted small">Needed to publish to GitHub Pages and to submit to a central repository. Not needed to download the repository for your own web host.</p>
          <GitHubConnect github={github} setGithub={setGithub} />
        </div>

        <div className="stack panel">
          <h3>Your Mod Hub site</h3>
          <div className="kind-row">
            <div className="segmented" role="radiogroup" aria-label="Where the repository is hosted">
              {[['pages', 'GitHub Pages'], ['own', 'My own web host']].map(([k, label]) => (
                <button key={k} role="radio" aria-checked={hosting === k} className={hosting === k ? 'on' : ''}
                  onClick={() => setRepo({ ...repo, hosting: k })}>{label}</button>
              ))}
            </div>
            {base && <span className="muted small">Site address: <code>{base}</code></span>}
          </div>
          {problems.length > 0 && (
            <ul className="plain-issues">
              {problems.map((p, i) => <li key={i} className={`callout callout-${p.severity}`}>{p.text}</li>)}
            </ul>
          )}
          {modIssues.some((iss) => iss.some((x) => x.severity === 'error')) && (
            <p className="callout callout-warning">Some packages still have errors. They'll be published as they are.</p>
          )}
          {hosting === 'pages' ? (
            <PagesPublish repo={repo} setRepo={setRepo} mods={mods} github={github} notify={notify} blocking={blocking.length > 0} />
          ) : (
            <div className="stack">
              <label className="field"><span>Hosted at</span>
                <input id="repo-url" value={repo.baseUrl} placeholder="https://mods.example.com/hmods" spellCheck="false"
                  onChange={(e) => setRepo({ ...repo, baseUrl: e.target.value })} />
                <small className="muted">The exact address the files will live at. Users add it in Hakchi2 CE under Modules → Mod Hub → Repositories.</small>
              </label>
              <div className="row">
                <button className="btn btn-primary" disabled={busy || blocking.length > 0} onClick={exportRepo}>{busy ? 'Building…' : 'Download repository'}</button>
                <span className="muted small">Unzip it and upload everything, including the hidden <code>.repo</code> folder, to that address. <code>HOSTING.md</code> inside has the details.</span>
              </div>
            </div>
          )}
        </div>

        <div className="stack panel">
          <h3>Central repository</h3>
          <p className="muted small">Each submission becomes a pull request. Its maintainers review it, and its checks run the same rules as this tool plus version and maintainer rules. Each package is checked here first, so one that would be rejected never becomes a pull request.</p>
          <label className="field central-field"><span>Central repository on GitHub</span>
            <input id="central-repo" value={repo.central || ''} placeholder={CENTRAL_REPO} spellCheck="false"
              onChange={(e) => setRepo({ ...repo, central: e.target.value })} />
            {parseRepoName(repo.central) && `${parseRepoName(repo.central).owner}/${parseRepoName(repo.central).repo}`.toLowerCase() === CENTRAL_REPO.toLowerCase() && <small className="muted">{CENTRAL_TITLE}</small>}
            {repo.central && !central && <small className="field-error">Enter it as owner/repository, for example DNA64/ModHubRepo.</small>}
          </label>
          {(!github.login || !central) && <p className="muted small">{!github.login ? 'Connect your GitHub account above' : 'Enter the central repository'} to check and submit packages.</p>}
          {mods.length ? (
            <ul className="submit-list">
              {mods.map((m, i) => (
                <SubmitItem key={m.id} mod={m} issues={modIssues[i]} central={central} github={github} notify={notify} open={() => open(m.id)} />
              ))}
            </ul>
          ) : <p className="muted">No packages yet. Add them on the Packages tab.</p>}
        </div>
      </div>
    </section>
  );
}

// ---------- app ----------
const VIEWS = ['packages', 'repository', 'publish'];
const allIssuesList = (mods) => mods.map((m) => validate(m));

export function App() {
  const [mods, setMods] = useState(() => exampleMods());
  const [selected, setSelected] = useState(null);
  const [view, setViewState] = useState(() => (VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'packages'));
  const setView = (v) => {
    setViewState(v);
    try { history.replaceState(null, '', `#${v}`); } catch { /* not allowed here */ }
  };
  useEffect(() => {
    const onHash = () => { const v = location.hash.slice(1); if (VIEWS.includes(v)) setViewState(v); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const open = (id) => { setSelected(id); setView('packages'); };
  const [repo, setRepoState] = useState(() => {
    const loaded = {
    title: 'My hmod repository',
    baseUrl: '',
    readme: 'Themes and tweaks for the SNES Classic.',
    hosting: 'pages',
    pages: { repo: '', branch: 'main', cname: '' },
    ...load('hmodpub.repo', {}),
    ...load('mhs.repo', {}),
    };
    // The MMC central repository is the default place to submit to.
    if (!loaded.central) loaded.central = CENTRAL_REPO;
    return loaded;
  });

  // The token is kept only for this tab unless the person ticks Remember.
  const [github, setGithubState] = useState(() => load('mhs.github', load('hmodpub.github', { token: '', login: '', remember: false })));
  const setGithub = (g) => {
    setGithubState(g);
    try { localStorage.removeItem('hmodpub.github'); } catch { /* storage unavailable */ }
    if (g.remember) save('mhs.github', g);
    else { try { localStorage.removeItem('mhs.github'); } catch { /* storage unavailable */ } }
  };
  const [toast, setToast] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const fileInput = useRef(null);
  const folderInput = useRef(null);
  const packagesInput = useRef(null);

  const setRepo = (r) => { setRepoState(r); save('mhs.repo', r); };
  const notify = useCallback((text, error = false, action = null) => {
    setToast({ text, error, action, at: Date.now() });
  }, []);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), toast.action ? 10000 : 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const updateMod = (next) => setMods((ms) => ms.map((m) => (m.id === next.id ? next : m)));
  const removeMod = (id) => {
    const index = mods.findIndex((m) => m.id === id);
    const removed = mods[index];
    if (!removed) return;
    setMods((ms) => ms.filter((m) => m.id !== id));
    setSelected((mods[index + 1] || mods[index - 1] || {}).id || null);
    const left = mods.length - 1;
    notify(`Removed ${hmodFileName(removed)}. ${left === 0 ? 'The repository is now empty.' : `${left} package${left === 1 ? '' : 's'} left.`}`, false, {
      label: 'Undo',
      run: () => {
        setMods((ms) => (ms.some((m) => m.id === id) ? ms : [...ms.slice(0, index), removed, ...ms.slice(index)]));
        setSelected(id);
        setToast(null);
      },
    });
  };
  const hasExamples = mods.some((m) => m.source?.example);

  const addMods = async (producer) => {
    setLoading(true);
    try {
      const added = await producer();
      const skipped = added.skipped || [];
      if (added.length) {
        if (mods.length && hasExamplesOnlyFirst(mods)) added.notes = [...(added.notes || []), 'The examples were cleared.'];
        setMods((ms) => [...ms.filter((m) => !m.source?.example || !hasExamplesOnlyFirst(ms)), ...added]);
        setSelected(added[0].id);
        setView('packages');
      }
      const notes = () => added.notes || [];
      if (skipped.length) notify(skipped.join(' '), true);
      else if (added.length) notify([`Added ${added.length > 3 ? `${added.length} packages` : added.map((m) => m.name).join(', ')}.`, ...notes()].join(' '));
    } catch (e) {
      notify(e.message || 'That file could not be read.', true);
    } finally { setLoading(false); }
  };
  // The first real import replaces the examples; later imports keep everything.
  const hasExamplesOnlyFirst = (ms) => ms.every((m) => m.source?.example);

  const onDrop = (e) => {
    e.preventDefault(); setDragging(false);
    const dt = e.dataTransfer;
    addMods(() => modsFromDrop(dt));
  };

  const current = mods.find((m) => m.id === selected) || mods[0];
  const totals = useMemo(() => {
    let errors = 0;
    for (const iss of allIssuesList(mods)) if (iss.some((i) => i.severity === 'error')) errors++;
    return { errors };
  }, [mods]);
  const allIssues = useMemo(() => new Map(mods.map((m) => [m.id, validate(m)])), [mods]);

  return (
    <div className={`app ${dragging ? 'is-dragging' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={(e) => { if (e.target === e.currentTarget) setDragging(false); }}
      onDrop={onDrop}>
      <header className="topbar">
        <div className="brand"><Logo /><div><a className="brand-name" href={STUDIO_URL} target="_blank" rel="noopener noreferrer">Mod Hub Studio</a><span>Check, pack and publish Hakchi2 CE modules and games</span></div></div>
        <nav className="views" aria-label="Sections">
          {[['packages', 'Packages', mods.length], ['repository', 'Repository', null], ['publish', 'Publish', null]].map(([id, label, count]) => (
            <a key={id} href={`#${id}`} className={`view-tab ${view === id ? 'on' : ''}`} aria-current={view === id ? 'page' : undefined}
              onClick={(e) => { e.preventDefault(); setView(id); }}>
              {label}{count != null && <span className="tab-count">{count}</span>}
              {id === 'packages' && totals.errors > 0 && <span className="pill pill-error">{totals.errors} with errors</span>}
            </a>
          ))}
        </nav>
      </header>
      {view === 'packages' ? (
        <div className="layout">
          <aside className="rail">
            <div className="rail-head">
              <span className="eyebrow">Packages · {mods.length}</span>
              {hasExamples && <button className="linkish small" onClick={() => { setMods((ms) => ms.filter((m) => !m.source?.example)); setSelected(null); }}>Clear examples</button>}
            </div>
            <ul className="rail-list">
              {mods.map((m) => (
                <li key={m.id}>
                  <button className={`rail-item ${current && current.id === m.id ? 'on' : ''}`} onClick={() => setSelected(m.id)}>
                    <span className="rail-title">{m.readme.front.Name || m.name}{m.source?.example && <span className="pill pill-example">Example</span>}</span>
                    <span className="rail-meta"><span className="mono small muted">{hmodFileName(m)}</span><Counts issues={allIssues.get(m.id) || []} compact /></span>
                  </button>
                </li>
              ))}
            </ul>
            <div className={`dropzone ${loading ? 'busy' : ''}`}>
              <p><strong>{loading ? 'Reading…' : 'Add packages'}</strong><br /><span className="muted small">Drop files or folders here, or:</span></p>
              <div className="pickers">
                <button className="btn btn-small" onClick={() => fileInput.current.click()}>Select a module</button>
                <span className="muted small">A .hmod module or .clvg game file</span>
                <button className="btn btn-small" onClick={() => folderInput.current.click()}>Select an unpacked module</button>
                <span className="muted small">The folder you're building a module in</span>
                <button className="btn btn-small" onClick={() => packagesInput.current.click()}>Select multiple packages</button>
                <span className="muted small">A folder of .hmod and .clvg files, like Hakchi2 CE's user_mods</span>
              </div>
              <input ref={fileInput} id="pick-files" type="file" multiple hidden accept={ACCEPTED_EXTENSIONS.join(",")}
                onChange={(e) => { const fl = [...e.target.files]; e.target.value = ''; addMods(() => modsFromFiles(fl)); }} />
              <input ref={folderInput} id="pick-folder" type="file" hidden webkitdirectory="" directory=""
                onChange={(e) => { const fl = [...e.target.files]; e.target.value = ''; addMods(() => modsFromFolderInput(fl, 'unpacked')); }} />
              <input ref={packagesInput} id="pick-packages" type="file" hidden webkitdirectory="" directory=""
                onChange={(e) => { const fl = [...e.target.files]; e.target.value = ''; addMods(() => modsFromFolderInput(fl, 'packages')); }} />
            </div>
            <p className="muted small rail-foot">Files stay in this browser until you publish.</p>
          </aside>
          <main className="main">
            {current
              ? <ModView key={current.id} mod={current} update={updateMod} remove={() => removeMod(current.id)} notify={notify} goPublish={() => setView('publish')} />
              : (
                <section className="pane">
                  <div className="empty-start">
                    <h2>No packages yet</h2>
                    <p className="muted">Add a module, an unpacked module folder, or a folder of packages from the panel on the left. Each one is checked against hakchi's install rules as soon as it's added.</p>
                  </div>
                </section>
              )}
          </main>
        </div>
      ) : (
        <div className="single">
          {view === 'repository'
            ? <RepoView repo={repo} setRepo={setRepo} mods={mods} updateMod={updateMod} open={open} goPublish={() => setView('publish')} />
            : <PublishView repo={repo} setRepo={setRepo} mods={mods} notify={notify} github={github} setGithub={setGithub} open={open} />}
        </div>
      )}
      {dragging && <div className="drag-overlay"><span>Drop to add to the repository</span></div>}
      {toast && (
        <div className={`toast ${toast.error ? 'toast-error' : ''}`} role="status">
          <span>{toast.text}</span>
          {toast.action && <button className="toast-action" onClick={toast.action.run}>{toast.action.label}</button>}
        </div>
      )}
    </div>
  );
}
