import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tgz, zip, readme, desktop, bytesText } from './helpers.js';
import { FakeGitHub } from './fake-github.js';
import { createClient } from '../src/github.js';
import { compareVersions, checkSubmission, parseMeta, metaText, packagePath, metaPath } from '../src/central.js';
import { prepareSubmission, submitToCentral } from '../src/submit.js';
import { modFromArchive } from '../src/model.js';
import { packHmod } from '../src/pack.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const modReadme = (version) => readme({ Name: 'Font Tweak', Creator: 'alice', Category: 'Font', Version: version });
const makeMod = async (version = '1.0.0', name = 'font_tweak.hmod') =>
  modFromArchive(name, await tgz({ 'readme.md': modReadme(version), 'etc/preinit.d/p8100_font': 'echo font\n' }));
const entry = async (mod, maintainers = ['alice'], version) => ({ bytes: await packHmod(mod), metaText: metaText({ version: version || mod.readme.front.Version, maintainers }) });

test('versions compare numerically', () => {
  assert.equal(compareVersions('1.10', '1.9'), 1);
  assert.equal(compareVersions('v2', '2.0.0'), 0);
  assert.equal(compareVersions('1.0', '1.0-beta'), 1);
  assert.equal(compareVersions('1.0.1', '1.0.2'), -1);
});

test('meta files need a version and maintainers', () => {
  assert.match(parseMeta('{', 'x.hmod').error, /valid JSON/);
  assert.match(parseMeta('{"version":"1"}', 'x.hmod').error, /maintainers/);
  assert.deepEqual(parseMeta('{"version":"1","maintainers":["a"]}', 'x.hmod').meta, { version: '1', maintainers: ['a'] });
});

test('new, updated and removed packages follow the maintainer and version rules', async () => {
  const v1 = await entry(await makeMod('1.0.0'));
  const v2 = await entry(await makeMod('1.1.0'));
  const ok = (r) => assert.deepEqual(r.errors, []);

  ok(await checkSubmission({ before: new Map(), after: new Map([['font_tweak.hmod', v1]]), author: 'alice' }));

  const notListed = await checkSubmission({ before: new Map(), after: new Map([['font_tweak.hmod', v1]]), author: 'bob' });
  assert.match(notListed.errors.join(), /bob must be listed/);

  const update = await checkSubmission({ before: new Map([['font_tweak.hmod', v1]]), after: new Map([['font_tweak.hmod', v2]]), author: 'alice' });
  ok(update);
  assert.deepEqual(update.changes, [{ file: 'font_tweak.hmod', action: 'updated', version: '1.1.0', from: '1.0.0' }]);

  const sameVersion = await checkSubmission({ before: new Map([['font_tweak.hmod', v1]]), after: new Map([['font_tweak.hmod', await entry(await makeMod('1.0.0'), ['alice', 'carol'])]]), author: 'alice' });
  assert.match(sameVersion.errors.join(), /already at version 1\.0\.0/);

  const takeover = await checkSubmission({ before: new Map([['font_tweak.hmod', v1]]), after: new Map([['font_tweak.hmod', await entry(await makeMod('2.0.0'), ['bob'])]]), author: 'bob' });
  assert.match(takeover.errors.join(), /belongs to alice/);

  const adminFix = await checkSubmission({ before: new Map([['font_tweak.hmod', v1]]), after: new Map([['font_tweak.hmod', v2]]), author: 'admin', admins: ['Admin'] });
  ok(adminFix);

  const removed = await checkSubmission({ before: new Map([['font_tweak.hmod', v1]]), after: new Map(), author: 'bob' });
  assert.match(removed.errors.join(), /can't remove/);
});

test('package content and naming are checked', async () => {
  const wrongVersion = { ...(await entry(await makeMod('1.0.0'))), metaText: metaText({ version: '9.9', maintainers: ['alice'] }) };
  assert.match((await checkSubmission({ before: new Map(), after: new Map([['font_tweak.hmod', wrongVersion]]), author: 'alice' })).errors.join(), /says version 9\.9/);

  const zipped = { bytes: await zip({ 'readme.md': modReadme('1'), 'etc/preinit.d/p8100_font': 'echo\n' }), metaText: metaText({ version: '1', maintainers: ['alice'] }) };
  assert.match((await checkSubmission({ before: new Map(), after: new Map([['font_tweak.hmod', zipped]]), author: 'alice' })).errors.join(), /plain tar\.gz/);

  const misnamed = await entry(await makeMod('1.0.0', 'Font Tweak.hmod'));
  assert.match((await checkSubmission({ before: new Map(), after: new Map([['Font Tweak.hmod', misnamed]]), author: 'alice' })).errors.join(), /should be named Font_Tweak\.hmod/);

  const broken = { bytes: await tgz({ 'readme.md': modReadme('1'), 'etc/preinit.d/p8100_x': 'exit 0\n' }), metaText: metaText({ version: '1', maintainers: ['alice'] }) };
  assert.match((await checkSubmission({ before: new Map(), after: new Map([['font_tweak.hmod', broken]]), author: 'alice' })).errors.join(), /exit/);

  const v1 = await entry(await makeMod('1.0.0'));
  const clash = await checkSubmission({ before: new Map([['font_tweak.hmod', v1]]), after: new Map([['font_tweak.hmod', v1], ['FONT_TWEAK.hmod', await entry(await makeMod('1.0.0', 'FONT_TWEAK.hmod'))]]), author: 'alice' });
  assert.match(clash.errors.join(), /clashes/);

  const lonely = await checkSubmission({ before: new Map(), after: new Map([['x.hmod', { bytes: v1.bytes, metaText: null }]]), author: 'alice' });
  assert.match(lonely.errors.join(), /needs packages\/x\.hmod\.json/);

  const outside = await checkSubmission({ before: new Map(), after: new Map(), author: 'alice', otherChanges: ['.github/workflows/check.yml'] });
  assert.match(outside.errors.join(), /outside packages/);
});

// ---- submitting through the GitHub API

function central(files = {}) {
  const fake = new FakeGitHub({ users: { 'tok-alice': 'alice', 'tok-bob': 'bob', 'tok-owner': 'hub' } });
  fake.addRepo('hub/central', { files: { 'repo.json': JSON.stringify({ title: 'Hub', admins: ['hub'] }), 'packages/.gitkeep': '', ...files } });
  return fake;
}

test('submitting a new package forks, commits and opens a pull request', async () => {
  const fake = central();
  const gh = createClient({ token: 'tok-alice', fetchImpl: fake.fetch });
  const mod = await makeMod('1.0.0');
  const steps = [];
  const pr = await submitToCentral(gh, { central: { owner: 'hub', repo: 'central' }, mod, onProgress: (s) => steps.push(s), sleep: async () => {} });

  assert.equal(pr.url, 'https://github.com/hub/central/pull/1');
  assert.ok(pr.forked);
  assert.ok(fake.repos.has('alice/central'), 'a fork was made');
  const p = fake.pulls[0];
  assert.equal(p.base, 'main');
  assert.match(p.head, /^alice:submit\/font_tweak-1\.0\.0-/);
  assert.match(p.title, /^Add Font Tweak 1\.0\.0$/);
  const files = fake.files('alice/central', p.head.split(':')[1]);
  assert.ok(files[packagePath('font_tweak.hmod')]);
  assert.deepEqual(JSON.parse(bytesText(files[metaPath('font_tweak.hmod')])), { version: '1.0.0', maintainers: ['alice'] });
  assert.ok(files['repo.json'], 'the branch starts from the central repository');
  assert.ok(steps.some((s) => /Forking/.test(s)));
});

test('an update keeps the maintainers; a stale version is refused before any pull request', async () => {
  const existing = await makeMod('1.0.0');
  const fake = central({
    [packagePath('font_tweak.hmod')]: Buffer.from(await packHmod(existing)),
    [metaPath('font_tweak.hmod')]: metaText({ version: '1.0.0', maintainers: ['alice', 'carol'] }),
  });
  const gh = createClient({ token: 'tok-alice', fetchImpl: fake.fetch });
  const where = { owner: 'hub', repo: 'central' };

  const stale = await prepareSubmission(gh, { central: where, mod: await makeMod('1.0.0') });
  assert.match(stale.result.errors.join(), /already at version 1\.0\.0/);
  await assert.rejects(submitToCentral(gh, { central: where, mod: await makeMod('1.0.0'), sleep: async () => {} }), /already at version/);
  assert.equal(fake.pulls.length, 0);

  await submitToCentral(gh, { central: where, mod: await makeMod('1.2.0'), sleep: async () => {} });
  const p = fake.pulls[0];
  assert.match(p.title, /^Update Font Tweak 1\.2\.0$/);
  const meta = JSON.parse(bytesText(fake.files('alice/central', p.head.split(':')[1])[metaPath('font_tweak.hmod')]));
  assert.deepEqual(meta, { version: '1.2.0', maintainers: ['alice', 'carol'] });
});

test("someone else's package can't be updated", async () => {
  const fake = central({
    [packagePath('font_tweak.hmod')]: Buffer.from(await packHmod(await makeMod('1.0.0'))),
    [metaPath('font_tweak.hmod')]: metaText({ version: '1.0.0', maintainers: ['alice'] }),
  });
  const gh = createClient({ token: 'tok-bob', fetchImpl: fake.fetch });
  const prep = await prepareSubmission(gh, { central: { owner: 'hub', repo: 'central' }, mod: await makeMod('2.0.0') });
  assert.match(prep.result.errors.join(), /belongs to alice/);
});

test('the repository owner submits without a fork', async () => {
  const fake = central();
  const gh = createClient({ token: 'tok-owner', fetchImpl: fake.fetch });
  const pr = await submitToCentral(gh, { central: { owner: 'hub', repo: 'central' }, mod: await makeMod('1.0.0'), sleep: async () => {} });
  assert.ok(!pr.forked);
  assert.ok(!fake.repos.has('hub/central-1'));
  assert.ok(!fake.pulls[0].head.includes(':'));
});

test('a repository without repo.json is not treated as a central repository', async () => {
  const fake = new FakeGitHub();
  fake.addRepo('hub/other', { files: { 'README.md': 'x' } });
  const gh = createClient({ token: 'tok-alice', fetchImpl: fake.fetch });
  await assert.rejects(prepareSubmission(gh, { central: { owner: 'hub', repo: 'other' }, mod: await makeMod() }), /no repo\.json/);
});

test('a mod without a version asks for one', async () => {
  const fake = central();
  const gh = createClient({ token: 'tok-alice', fetchImpl: fake.fetch });
  const mod = await modFromArchive('nover.hmod', await tgz({ 'readme.md': readme({ Name: 'x' }), 'usr/share/x': 'x' }));
  const prep = await prepareSubmission(gh, { central: { owner: 'hub', repo: 'central' }, mod });
  assert.match(prep.result.errors.join(), /Add a Version/);
});

// ---- the CI scripts, run as the workflows run them

function writeTree(root, files) {
  for (const [p, data] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), data);
  }
}
const run = (script, args, env = {}) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [path.join(ROOT, 'ci', script), ...args], { encoding: 'utf8', env: { ...process.env, ...env } }) };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
};

test('ci/check-pr.mjs passes a good pull request and fails a bad one', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hmod-ci-'));
  try {
    const base = path.join(tmp, 'base');
    const head = path.join(tmp, 'head');
    const repoJson = JSON.stringify({ title: 'Hub', admins: ['hub'] });
    writeTree(base, { 'repo.json': repoJson, 'packages/.gitkeep': '' });
    writeTree(head, {
      'repo.json': repoJson,
      'packages/.gitkeep': '',
      'packages/font_tweak.hmod': await packHmod(await makeMod('1.0.0')),
      'packages/font_tweak.hmod.json': metaText({ version: '1.0.0', maintainers: ['alice'] }),
    });
    const summary = path.join(tmp, 'summary.md');
    const good = run('check-pr.mjs', ['--base', base, '--head', head, '--author', 'alice', '--summary', summary]);
    assert.equal(good.code, 0, good.out);
    assert.match(fs.readFileSync(summary, 'utf8'), /font_tweak\.hmod.*added → 1\.0\.0/);

    writeTree(head, { 'repo.json': JSON.stringify({ admins: ['mallory'] }), 'packages/notes.txt': 'x' });
    const bad = run('check-pr.mjs', ['--base', base, '--head', head, '--author', 'mallory']);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /repo\.json is outside packages/, 'the admin list is read from the base branch');
    assert.match(bad.out, /packages\/notes\.txt/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ci/build-site.mjs builds the Mod Hub site from packages/', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hmod-ci-'));
  try {
    const repo = path.join(tmp, 'repo');
    const out = path.join(tmp, 'site');
    const font = await packHmod(await makeMod('1.0.0'));
    const game = await packHmod(await modFromArchive('CLV-H-ABCDE.clvg', await tgz({ 'CLV-H-ABCDE.desktop': desktop('CLV-H-ABCDE', '/bin/fceumm x.nes') })));
    writeTree(repo, {
      'repo.json': JSON.stringify({ title: 'Hub', readme: 'Shared mods', siteUrl: 'https://mods.example.com' }),
      'packages/font_tweak.hmod': font,
      'packages/font_tweak.hmod.json': metaText({ version: '1.0.0', maintainers: ['alice'] }),
      'packages/CLV-H-ABCDE.clvg': game,
      'packages/CLV-H-ABCDE.clvg.json': metaText({ version: '3', maintainers: ['alice'] }),
    });
    const r = run('build-site.mjs', ['--repo', repo, '--out', out]);
    assert.equal(r.code, 0, r.out);
    const read = (p) => fs.readFileSync(path.join(out, p));
    assert.deepEqual(new Uint8Array(read('hmods/font_tweak.hmod')), font, 'the reviewed bytes are published unchanged');
    assert.equal(read('.repo/font_tweak.hmod/link').toString().trim(), 'https://mods.example.com/hmods/font_tweak.hmod');
    assert.equal(read('CNAME').toString(), 'mods.example.com\n');
    assert.match(read('.repo/CLV-H-ABCDE.clvg/readme.md').toString(), /Version: 3/);
    assert.ok(fs.existsSync(path.join(out, '.nojekyll')));

    fs.writeFileSync(path.join(repo, 'repo.json'), JSON.stringify({ title: 'Hub' }));
    const gh = run('build-site.mjs', ['--repo', repo, '--out', out], { GITHUB_REPOSITORY: 'Hub/central' });
    assert.equal(gh.code, 0, gh.out);
    assert.equal(read('.repo/font_tweak.hmod/link').toString().trim(), 'https://hub.github.io/central/hmods/font_tweak.hmod');
    assert.ok(!fs.existsSync(path.join(out, 'CNAME')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
