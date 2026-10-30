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
import { compareVersions, checkSubmission, parseMeta, metaText, packagePath, metaPath, reportMarkdown } from '../src/central.js';
import { prepareSubmission, submitToCentral } from '../src/submit.js';
import { modFromArchive } from '../src/model.js';
import { packHmod } from '../src/pack.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const modReadme = (version) => readme({ Name: 'Font Tweak', Creator: 'alice', Category: 'Font', Version: version });
const makeMod = async (version = '1.0.0', name = 'alice.font-tweak.hmod') =>
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

  ok(await checkSubmission({ before: new Map(), after: new Map([['alice.font-tweak.hmod', v1]]), author: 'alice' }));

  const notListed = await checkSubmission({ before: new Map(), after: new Map([['alice.font-tweak.hmod', v1]]), author: 'bob' });
  assert.match(notListed.errors.join(), /bob must be listed/);

  const update = await checkSubmission({ before: new Map([['alice.font-tweak.hmod', v1]]), after: new Map([['alice.font-tweak.hmod', v2]]), author: 'alice' });
  ok(update);
  assert.deepEqual(update.changes, [{ file: 'alice.font-tweak.hmod', action: 'updated', version: '1.1.0', from: '1.0.0' }]);

  const sameVersion = await checkSubmission({ before: new Map([['alice.font-tweak.hmod', v1]]), after: new Map([['alice.font-tweak.hmod', await entry(await makeMod('1.0.0'), ['alice', 'carol'])]]), author: 'alice' });
  assert.match(sameVersion.errors.join(), /already at version 1\.0\.0/);

  const takeover = await checkSubmission({ before: new Map([['alice.font-tweak.hmod', v1]]), after: new Map([['alice.font-tweak.hmod', await entry(await makeMod('2.0.0'), ['bob'])]]), author: 'bob' });
  assert.match(takeover.errors.join(), /belongs to alice/);

  const adminFix = await checkSubmission({ before: new Map([['alice.font-tweak.hmod', v1]]), after: new Map([['alice.font-tweak.hmod', v2]]), author: 'admin', admins: ['Admin'] });
  ok(adminFix);

  const removed = await checkSubmission({ before: new Map([['alice.font-tweak.hmod', v1]]), after: new Map(), author: 'bob' });
  assert.match(removed.errors.join(), /can't remove/);
});

test('package content and naming are checked', async () => {
  const wrongVersion = { ...(await entry(await makeMod('1.0.0'))), metaText: metaText({ version: '9.9', maintainers: ['alice'] }) };
  assert.match((await checkSubmission({ before: new Map(), after: new Map([['alice.font-tweak.hmod', wrongVersion]]), author: 'alice' })).errors.join(), /says version 9\.9/);

  const zipped = { bytes: await zip({ 'readme.md': modReadme('1'), 'etc/preinit.d/p8100_font': 'echo\n' }), metaText: metaText({ version: '1', maintainers: ['alice'] }) };
  assert.match((await checkSubmission({ before: new Map(), after: new Map([['alice.font-tweak.hmod', zipped]]), author: 'alice' })).errors.join(), /plain tar\.gz/);

  const misnamed = await entry(await makeMod('1.0.0', 'Font Tweak.hmod'));
  assert.match((await checkSubmission({ before: new Map(), after: new Map([['Font Tweak.hmod', misnamed]]), author: 'alice' })).errors.join(), /should be named Font_Tweak\.hmod/);

  const broken = { bytes: await tgz({ 'readme.md': modReadme('1'), 'etc/preinit.d/p8100_x': 'exit 0\n' }), metaText: metaText({ version: '1', maintainers: ['alice'] }) };
  assert.match((await checkSubmission({ before: new Map(), after: new Map([['alice.font-tweak.hmod', broken]]), author: 'alice' })).errors.join(), /exit/);

  const v1 = await entry(await makeMod('1.0.0'));
  const clash = await checkSubmission({ before: new Map([['alice.font-tweak.hmod', v1]]), after: new Map([['alice.font-tweak.hmod', v1], ['ALICE.FONT-TWEAK.hmod', await entry(await makeMod('1.0.0', 'ALICE.FONT-TWEAK.hmod'))]]), author: 'alice' });
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
  assert.match(p.head, /^alice:submit\/alice\.font-tweak-1\.0\.0-/);
  assert.match(p.title, /^Add Font Tweak 1\.0\.0$/);
  const files = fake.files('alice/central', p.head.split(':')[1]);
  assert.ok(files[packagePath('alice.font-tweak.hmod')]);
  assert.deepEqual(JSON.parse(bytesText(files[metaPath('alice.font-tweak.hmod')])), { version: '1.0.0', maintainers: ['alice'] });
  assert.ok(files['repo.json'], 'the branch starts from the central repository');
  assert.ok(steps.some((s) => /Forking/.test(s)));
});

test('an update keeps the maintainers; a stale version is refused before any pull request', async () => {
  const existing = await makeMod('1.0.0');
  const fake = central({
    [packagePath('alice.font-tweak.hmod')]: Buffer.from(await packHmod(existing)),
    [metaPath('alice.font-tweak.hmod')]: metaText({ version: '1.0.0', maintainers: ['alice', 'carol'] }),
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
  const meta = JSON.parse(bytesText(fake.files('alice/central', p.head.split(':')[1])[metaPath('alice.font-tweak.hmod')]));
  assert.deepEqual(meta, { version: '1.2.0', maintainers: ['alice', 'carol'] });
});

test("someone else's package can't be updated", async () => {
  const fake = central({
    [packagePath('alice.font-tweak.hmod')]: Buffer.from(await packHmod(await makeMod('1.0.0'))),
    [metaPath('alice.font-tweak.hmod')]: metaText({ version: '1.0.0', maintainers: ['alice'] }),
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
  const mod = await modFromArchive('alice.nover.hmod', await tgz({ 'readme.md': readme({ Name: 'x' }), 'usr/share/x': 'x' }));
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
      'packages/alice.font-tweak.hmod': await packHmod(await makeMod('1.0.0')),
      'packages/alice.font-tweak.hmod.json': metaText({ version: '1.0.0', maintainers: ['alice'] }),
    });
    const summary = path.join(tmp, 'summary.md');
    const good = run('check-pr.mjs', ['--base', base, '--head', head, '--author', 'alice', '--summary', summary]);
    assert.equal(good.code, 0, good.out);
    assert.match(fs.readFileSync(summary, 'utf8'), /alice\.font-tweak\.hmod.*added → 1\.0\.0/);

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
      'packages/alice.font-tweak.hmod': font,
      'packages/alice.font-tweak.hmod.json': metaText({ version: '1.0.0', maintainers: ['alice'] }),
      'packages/CLV-H-ABCDE.clvg': game,
      'packages/CLV-H-ABCDE.clvg.json': metaText({ version: '3', maintainers: ['alice'] }),
    });
    const r = run('build-site.mjs', ['--repo', repo, '--out', out]);
    assert.equal(r.code, 0, r.out);
    const read = (p) => fs.readFileSync(path.join(out, p));
    assert.deepEqual(new Uint8Array(read('hmods/alice.font-tweak.hmod')), font, 'the reviewed bytes are published unchanged');
    assert.equal(read('.repo/alice.font-tweak.hmod/link').toString().trim(), 'https://mods.example.com/hmods/alice.font-tweak.hmod');
    assert.equal(read('CNAME').toString(), 'mods.example.com\n');
    assert.match(read('.repo/CLV-H-ABCDE.clvg/readme.md').toString(), /Version: 3/);
    assert.ok(fs.existsSync(path.join(out, '.nojekyll')));

    fs.writeFileSync(path.join(repo, 'repo.json'), JSON.stringify({ title: 'Hub' }));
    const gh = run('build-site.mjs', ['--repo', repo, '--out', out], { GITHUB_REPOSITORY: 'Hub/central' });
    assert.equal(gh.code, 0, gh.out);
    assert.equal(read('.repo/alice.font-tweak.hmod/link').toString().trim(), 'https://hub.github.io/central/hmods/alice.font-tweak.hmod');
    assert.ok(!fs.existsSync(path.join(out, 'CNAME')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- package IDs and namespaces

const namedMod = async (name, version = '1.0.0') =>
  modFromArchive(name, await tgz({ 'readme.md': modReadme(version), 'etc/preinit.d/p8100_font': 'echo font\n' }));
const pkg = async (name, maintainers = ['alice'], version = '1.0.0') => entry(await namedMod(name, version), maintainers, version);
const repoOf = async (spec) => new Map(await Promise.all(Object.entries(spec).map(async ([f, m]) => [f, await pkg(f, m)])));

test('every package needs a Package ID, admins included', async () => {
  const noId = await pkg('font_tweak.hmod');
  const added = await checkSubmission({ before: new Map(), after: new Map([['font_tweak.hmod', noId]]), author: 'alice' });
  assert.match(added.errors.join(), /font_tweak\.hmod isn't named with a Package ID.*alice\.font-tweak\.hmod|font_tweak\.hmod isn't named with a Package ID/);

  const asAdmin = await checkSubmission({ before: new Map(), after: new Map([['font_tweak.hmod', noId]]), author: 'hub', admins: ['hub'] });
  assert.match(asAdmin.errors.join(), /isn't named with a Package ID/);

  const updated = await checkSubmission({ before: new Map([['font_tweak.hmod', noId]]), after: new Map([['font_tweak.hmod', await pkg('font_tweak.hmod', ['alice'], '1.1.0')]]), author: 'alice' });
  assert.match(updated.errors.join(), /isn't named with a Package ID/, 'updates are held to the same rule');
});

test('namespaces belong to the people who publish in them', async () => {
  const existing = await repoOf({ 'dna64.theme.hmod': ['DNA64'], 'alice.fonts.hmod': ['alice'] });
  const submit = async (file, author, extra = {}) =>
    checkSubmission({ before: existing, after: new Map([...existing, [file, await pkg(file, [author])]]), author, ...extra });

  assert.deepEqual((await submit('dna64.clock.hmod', 'dna64')).errors, [], 'logins compare without case');
  assert.deepEqual((await submit('dna64.clock.hmod', 'dna64')).approvals, []);

  assert.match((await submit('dna64.clock.hmod', 'mallory')).errors.join(), /namespace "dna64" belongs to DNA64/);
  assert.match((await submit('dna-64.clock.hmod', 'mallory')).errors.join(), /"dna-64" \(the same as "dna64"\) belongs to DNA64/);
  assert.match((await submit('snes9x.dna64.hmod', 'mallory')).errors.join(), /"dna64" is DNA64's namespace/);
  assert.match((await submit('mallory.dna_64.hmod', 'mallory')).errors.join(), /isn't named with a Package ID/);
  assert.match((await submit('mallory.dna-64.hmod', 'mallory')).errors.join(), /"dna-64" is DNA64's namespace/);
  assert.match((await submit('theme.clock.hmod', 'mallory')).errors.join(), /"theme" is a reserved word/);
  assert.match((await submit('snes-9x.clock.hmod', 'mallory')).errors.join(), /reserved/);

  const fresh = await submit('mallory.clock.hmod', 'mallory');
  assert.deepEqual(fresh.errors, []);
  assert.deepEqual(fresh.approvals, ['mallory.clock.hmod starts the new namespace "mallory". Merging gives mallory the namespace.']);

  const embedded = await submit('mallory.dna64-fix.hmod', 'mallory');
  assert.deepEqual(embedded.errors, []);
  assert.ok(embedded.approvals.some((a) => /contains "dna64", the namespace of DNA64/.test(a)));
  assert.ok((await submit('dna64fan.clock.hmod', 'mallory')).approvals.some((a) => /contains "dna64"/.test(a)));

  assert.deepEqual((await submit('alice.snes9x.core.hmod', 'alice')).errors, [], 'reserved words are fine after the namespace');
  const byAdmin = await submit('dna64.clock.hmod', 'hub', { admins: ['hub'] });
  assert.deepEqual(byAdmin.errors, []);

  const granted = await submit('carol.clock.hmod', 'mallory', { namespaces: { namespaces: { carol: ['carol'] } } });
  assert.match(granted.errors.join(), /"carol" belongs to carol/, 'namespaces.json grants namespaces');
  const extraReserved = await submit('arcade.clock.hmod', 'mallory', { namespaces: { reserved: ['arcade'] } });
  assert.match(extraReserved.errors.join(), /"arcade" is a reserved word/);
});

test('no two games share a game code', async () => {
  const game = async (file, code) => ({
    bytes: await packHmod(await modFromArchive(file, await tgz({ [`${code}.desktop`]: desktop(code, '/bin/fceumm x.nes'), [`${code}.png`]: 'png' }))),
    metaText: metaText({ version: '1', maintainers: ['alice'] }),
  });
  const base = new Map([['alice.zelda-hack.clvg', await game('alice.zelda-hack.clvg', 'CLV-H-ABCDE')]]);
  const clash = await checkSubmission({ before: base, after: new Map([...base, ['alice.other.clvg', await game('alice.other.clvg', 'clv-h-abcde')]]), author: 'alice' });
  assert.match(clash.errors.join(), /alice\.other\.clvg uses the game code CLV-H-ABCDE, which alice\.zelda-hack\.clvg already uses/i);

  const twoNew = await checkSubmission({ before: new Map(), after: new Map([['alice.a.clvg', await game('alice.a.clvg', 'CLV-H-AAAAA')], ['alice.b.clvg', await game('alice.b.clvg', 'CLV-H-AAAAA')]]), author: 'alice' });
  assert.match(twoNew.errors.join(), /alice\.b\.clvg uses the game code CLV-H-AAAAA, and so does alice\.a\.clvg/);

  const fine = await checkSubmission({ before: base, after: new Map([...base, ['alice.other.clvg', await game('alice.other.clvg', 'CLV-H-ZZZZZ')]]), author: 'alice' });
  assert.deepEqual(fine.errors, []);

  const replaced = await checkSubmission({ before: base, after: new Map([['alice.zelda-hack-2.clvg', await game('alice.zelda-hack-2.clvg', 'CLV-H-ABCDE')]]), author: 'alice' });
  assert.deepEqual(replaced.errors, [], 'a game removed in the same pull request frees its code');
});

test('the report lists what needs an admin\'s approval', async () => {
  const r = await checkSubmission({ before: new Map(), after: new Map([['alice.font-tweak.hmod', await pkg('alice.font-tweak.hmod')]]), author: 'alice' });
  const md = reportMarkdown(r, 'alice');
  assert.match(md, /### Needs admin approval\n- alice\.font-tweak\.hmod starts the new namespace "alice"/);
  assert.match(md, /All checks passed/);
});

test('submitting checks namespaces against the central repository first', async () => {
  const fake = central({
    [packagePath('dna64.theme.hmod')]: Buffer.from(await packHmod(await namedMod('dna64.theme.hmod'))),
    [metaPath('dna64.theme.hmod')]: metaText({ version: '1.0.0', maintainers: ['hub'] }),
    'namespaces.json': JSON.stringify({ reserved: ['arcade'] }),
  });
  const where = { owner: 'hub', repo: 'central' };
  const gh = createClient({ token: 'tok-alice', fetchImpl: fake.fetch });

  const taken = await prepareSubmission(gh, { central: where, mod: await namedMod('dna64.clock.hmod') });
  assert.match(taken.result.errors.join(), /namespace "dna64" belongs to hub/);
  await assert.rejects(submitToCentral(gh, { central: where, mod: await namedMod('dna64.clock.hmod'), sleep: async () => {} }), /belongs to hub/);
  assert.equal(fake.pulls.length, 0, 'no pull request was opened');

  const posing = await prepareSubmission(gh, { central: where, mod: await namedMod('snes9x.dna64.hmod') });
  assert.match(posing.result.errors.join(), /"dna64" is hub's namespace/);
  assert.match((await prepareSubmission(gh, { central: where, mod: await namedMod('arcade.clock.hmod') })).result.errors.join(), /reserved/);
  assert.match((await prepareSubmission(gh, { central: where, mod: await namedMod('Font_Tweak.hmod') })).result.errors.join(), /Package ID/);

  const pr = await submitToCentral(gh, { central: where, mod: await namedMod('alice.clock.hmod'), sleep: async () => {} });
  assert.ok(pr.url);
  assert.match(fake.pulls[0].body, /\*\*Needs admin approval\*\*\n- alice\.clock\.hmod starts the new namespace "alice"/);
});

test('ci/check-pr.mjs reads namespaces.json from the base branch only', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hmod-ci-'));
  try {
    const base = path.join(tmp, 'base');
    const head = path.join(tmp, 'head');
    const repoJson = JSON.stringify({ title: 'Hub', admins: ['hub'] });
    writeTree(base, { 'repo.json': repoJson, 'packages/.gitkeep': '', 'namespaces.json': JSON.stringify({ namespaces: { carol: ['carol'] } }) });
    writeTree(head, {
      'repo.json': repoJson,
      'packages/.gitkeep': '',
      'namespaces.json': JSON.stringify({ namespaces: { carol: ['mallory'] } }),
      'packages/carol.clock.hmod': await packHmod(await namedMod('carol.clock.hmod')),
      'packages/carol.clock.hmod.json': metaText({ version: '1.0.0', maintainers: ['mallory'] }),
    });
    const r = run('check-pr.mjs', ['--base', base, '--head', head, '--author', 'mallory']);
    assert.equal(r.code, 1);
    assert.match(r.out, /namespace "carol" belongs to carol/);
    assert.match(r.out, /namespaces\.json is outside packages/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
