import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tgz, FULL_README, desktop, bytesText } from './helpers.js';
import { FakeGitHub } from './fake-github.js';
import { createClient, parseRepoName, gitBlobSha, toBase64, fromBase64 } from '../src/github.js';
import { publishToPages, pagesUrl, pagesIssues, cleanDomain, sizeIssues } from '../src/publish.js';
import { modFromArchive } from '../src/model.js';
import { INDEX_MARKER } from '../src/repo.js';
import { textBytes } from '../src/tar.js';

const settings = { title: 'Alice mods', readme: 'Mods by Alice.' };
const target = (extra = {}) => ({ repo: { owner: 'alice', repo: 'hmods' }, branch: 'main', cname: '', ...extra });

async function mods() {
  return [
    await modFromArchive('tool.hmod', await tgz({ 'readme.md': FULL_README, 'usr/bin/tool': '#!/bin/sh\n' })),
    await modFromArchive('CLV-H-ABCDE.clvg', await tgz({ 'CLV-H-ABCDE.desktop': desktop('CLV-H-ABCDE', '/bin/fceumm x.nes') })),
  ];
}

function setup(repoOpts = {}) {
  const fake = new FakeGitHub();
  fake.addRepo('alice/hmods', repoOpts);
  return { fake, gh: createClient({ token: 'tok-alice', fetchImpl: fake.fetch }) };
}

test('helpers: repo names, Pages addresses, domains, encodings', async () => {
  assert.deepEqual(parseRepoName('https://github.com/Alice/hmods.git'), { owner: 'Alice', repo: 'hmods' });
  assert.equal(parseRepoName('not a repo'), null);
  assert.equal(pagesUrl({ owner: 'Alice', repo: 'hmods' }), 'https://alice.github.io/hmods');
  assert.equal(pagesUrl({ owner: 'Alice', repo: 'alice.github.io' }), 'https://alice.github.io');
  assert.equal(pagesUrl({ owner: 'Alice', repo: 'hmods' }, 'https://Mods.Example.com/'), 'https://mods.example.com');
  assert.equal(cleanDomain('http://mods.example.com/path'), 'mods.example.com');
  assert.ok(pagesIssues(target({ cname: 'not a domain' })).length);
  assert.ok(pagesIssues(target({ cname: 'alice.github.io' })).length, 'github.io is not a custom domain');
  assert.deepEqual(pagesIssues(target({ cname: 'mods.example.com' })), []);
  assert.equal(await gitBlobSha(textBytes('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
});

test('publishing to an empty repository creates the whole site', async () => {
  const { fake, gh } = setup();
  const r = await publishToPages(gh, { target: target(), repoSettings: settings, mods: await mods() });
  const files = fake.files('alice/hmods', 'main');
  for (const p of ['.nojekyll', 'index.html', '.repo/pack.tgz', '.repo/list', 'hmods/tool.hmod', 'games/CLV-H-ABCDE.clvg']) assert.ok(files[p], p);
  assert.ok(!files['HOSTING.md'], 'hosting notes are only for manual uploads');
  assert.equal(bytesText(files['.repo/tool.hmod/link']).trim(), 'https://alice.github.io/hmods/hmods/tool.hmod');
  assert.equal(r.baseUrl, 'https://alice.github.io/hmods');
  assert.ok(r.notes.some((n) => n.kind === 'enable-pages'), 'without permission, explains how to turn Pages on');
});

test('publishing again with no changes makes no commit and uploads nothing', async () => {
  const { fake, gh } = setup();
  const list = await mods();
  await publishToPages(gh, { target: target(), repoSettings: settings, mods: list });
  const commits = fake.commits('alice/hmods', 'main').length;
  const blobsBefore = fake.log.filter((l) => l.endsWith('/git/blobs')).length;
  const r = await publishToPages(gh, { target: target(), repoSettings: settings, mods: list });
  assert.ok(r.unchanged);
  assert.equal(fake.commits('alice/hmods', 'main').length, commits);
  assert.equal(fake.log.filter((l) => l.endsWith('/git/blobs')).length, blobsBefore);
});

test('removed packages are deleted, other files in the repository are kept', async () => {
  const { fake, gh } = setup({ files: { 'README.md': 'my repo', 'index.html': '<h1>My own page</h1>', 'hmods/old.hmod': 'old' } });
  const list = await mods();
  const r = await publishToPages(gh, { target: target(), repoSettings: settings, mods: list.slice(0, 1) });
  const files = fake.files('alice/hmods', 'main');
  assert.equal(bytesText(files['README.md']), 'my repo');
  assert.equal(bytesText(files['index.html']), '<h1>My own page</h1>', "the user's own index.html stays");
  assert.ok(!files['hmods/old.hmod'], 'a package no longer in the list is removed');
  assert.ok(!files['games/CLV-H-ABCDE.clvg']);
  assert.ok(r.deleted.includes('hmods/old.hmod'));
  assert.ok(r.notes.some((n) => n.kind === 'index'));
});

test('a generated index.html is replaced on the next publish', async () => {
  const { fake, gh } = setup({ files: { 'index.html': `<!doctype html>${INDEX_MARKER}<h1>old</h1>` } });
  await publishToPages(gh, { target: target(), repoSettings: { ...settings, title: 'New title' }, mods: await mods() });
  assert.match(bytesText(fake.files('alice/hmods', 'main')['index.html']), /New title/);
});

test('a custom domain is written to CNAME and used for every link', async () => {
  const { fake, gh } = setup();
  const r = await publishToPages(gh, { target: target({ cname: 'Mods.Example.com' }), repoSettings: settings, mods: await mods() });
  const files = fake.files('alice/hmods', 'main');
  assert.equal(bytesText(files.CNAME), 'mods.example.com\n');
  assert.equal(bytesText(files['.repo/tool.hmod/link']).trim(), 'https://mods.example.com/hmods/tool.hmod');
  assert.equal(r.baseUrl, 'https://mods.example.com');
  assert.ok(r.notes.some((n) => n.kind === 'dns'));
});

test('an existing CNAME is kept when no domain is entered', async () => {
  const { fake, gh } = setup({ files: { CNAME: 'mods.example.org\n' } });
  const r = await publishToPages(gh, { target: target(), repoSettings: settings, mods: await mods() });
  assert.equal(r.baseUrl, 'https://mods.example.org');
  assert.equal(bytesText(fake.files('alice/hmods', 'main').CNAME), 'mods.example.org\n');
});

test('Pages is turned on when the token allows it', async () => {
  const { fake, gh } = setup();
  fake.repos.get('alice/hmods').allowPagesApi = true;
  const r = await publishToPages(gh, { target: target(), repoSettings: settings, mods: await mods() });
  assert.deepEqual(fake.repos.get('alice/hmods').pages.source, { branch: 'main', path: '/' });
  assert.ok(!r.notes.some((n) => n.kind === 'enable-pages'));
});

test('a new branch starts its own history with only the site', async () => {
  const { fake, gh } = setup({ files: { 'src/code.js': 'x' } });
  await publishToPages(gh, { target: target({ branch: 'gh-pages' }), repoSettings: settings, mods: await mods() });
  const files = fake.files('alice/hmods', 'gh-pages');
  assert.ok(files['.repo/pack.tgz']);
  assert.ok(!files['src/code.js']);
  assert.ok(fake.files('alice/hmods', 'main')['src/code.js'], 'main is untouched');
});

test('clear errors for a missing repository, someone else\'s repository, and huge files', async () => {
  const { fake, gh } = setup();
  await assert.rejects(publishToPages(gh, { target: target({ repo: { owner: 'alice', repo: 'nope' } }), repoSettings: settings, mods: await mods() }), /Couldn't find alice\/nope/);
  fake.addRepo('bob/site', { files: { a: 'a' } });
  await assert.rejects(publishToPages(gh, { target: target({ repo: { owner: 'bob', repo: 'site' } }), repoSettings: settings, mods: await mods() }), /can't write/);
  const big = [{ path: 'hmods/big.hmod', data: { length: 101 * 1024 * 1024 } }, { path: 'hmods/mid.hmod', data: { length: 60 * 1024 * 1024 } }];
  assert.deepEqual(sizeIssues(big).map((i) => i.severity), ['error', 'warning']);
  const bad = createClient({ token: 'wrong', fetchImpl: fake.fetch });
  await assert.rejects(bad.user(), /rejected the token/);
});
