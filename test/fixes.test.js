import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zip, FULL_README } from './helpers.js';
import { modFromArchive } from '../src/model.js';
import { applyAllFixes, applyFix, AUTO_FIX_IDS, FIXES } from '../src/rules.js';
import { describeChanges, FIX_DESCRIPTIONS } from '../src/fixes.js';

test('every automatic fix says what it does', () => {
  for (const id of [...AUTO_FIX_IDS, ...Object.keys(FIXES)]) assert.ok(FIX_DESCRIPTIONS[id], id);
});

test('the changes a fix makes are listed file by file', async () => {
  const mod = await modFromArchive('Night Sky.hmod', await zip({
    'NightSky/readme.md': FULL_README,
    'NightSky/Etc/preinit.d/p8100_sky': 'echo sky\r\necho on',
    'NightSky/usr/bin/tool': '#!/bin/sh\n',
    'NightSky/usr/share/sky/run.sh': '#!/bin/sh\necho run\n',
    'NightSky/.DS_Store': 'junk',
  }));
  const after = applyAllFixes(mod);
  const texts = describeChanges(mod, after).map((c) => `${c.kind}: ${c.text}`);
  assert.ok(texts.includes('renamed: Package name: Night Sky → Night_Sky'), texts.join('\n'));
  assert.ok(texts.includes('readme: NightSky/readme.md: read into the Readme tab, and packed as readme.md at the root'));
  assert.ok(texts.includes('removed: Removed NightSky/.DS_Store'));
  assert.ok(texts.includes('moved: NightSky/usr/bin/tool → usr/bin/tool'));
  assert.ok(texts.includes('moved: NightSky/Etc/preinit.d/p8100_sky → etc/preinit.d/p8100_sky'), 'moved and edited is still one file');
  assert.ok(texts.includes('edited: etc/preinit.d/p8100_sky: final line break added'), texts.join('\n'));
  assert.ok(texts.includes('mode: usr/share/sky/run.sh: permissions unset → 755'), texts.join('\n'));
});

test('describing nothing changed gives an empty list', async () => {
  const mod = await modFromArchive('t.hmod', await zip({ 'readme.md': FULL_README, 'usr/share/x/a': 'a' }));
  assert.deepEqual(describeChanges(mod, applyFix(mod, 'nope')), []);
});

test('line ending changes are named', async () => {
  const mod = await modFromArchive('t.hmod', await zip({ 'readme.md': FULL_README, 'usr/bin/tool': '#!/bin/sh\r\necho a\r\n' }));
  const texts = describeChanges(mod, applyAllFixes(mod)).map((c) => c.text);
  assert.ok(texts.includes('usr/bin/tool: Windows line endings converted to Unix'), texts.join('\n'));
});

test('only the chosen fixes are applied, in the safe order', async () => {
  const { applyFixes } = await import('../src/rules.js');
  const mod = await modFromArchive('Night Sky.hmod', await zip({
    'NightSky/readme.md': FULL_README,
    'NightSky/Etc/preinit.d/p8100_sky': 'echo sky',
    'NightSky/.DS_Store': 'junk',
  }));
  const all = applyFixes(mod);
  const ids = all.applied.map((f) => f.id);
  assert.ok(ids.includes('junk') && ids.includes('wrapper') && ids.includes('root-case'), ids.join(','));
  assert.ok(all.applied.every((f) => f.fixLabel && f.title));

  const some = applyFixes(mod, new Set(ids.filter((id) => id !== 'junk' && id !== 'bad-name')));
  const paths = some.mod.files.map((f) => f.path);
  assert.ok(paths.includes('.DS_Store'), 'junk kept when its fix is unticked');
  assert.ok(paths.includes('etc/preinit.d/p8100_sky'), 'the rest still ran');
  assert.equal(some.mod.name, 'Night Sky', 'not renamed');
  assert.ok(!some.applied.some((f) => f.id === 'junk'));

  assert.deepEqual(applyFixes(mod, new Set()).applied, []);
  assert.equal(applyFixes(mod, new Set()).mod, mod);
});
