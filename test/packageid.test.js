import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tgz, readme, desktop, ids, FULL_README } from './helpers.js';
import { modFromArchive } from '../src/model.js';
import { validate, applyFix } from '../src/rules.js';
import { packageIdProblems, isPackageId, suggestPackageId, namespaceOf, squash, isReserved, idOf } from '../src/packageid.js';

test('package IDs are lowercase, dotted, at least two parts, no underscores', () => {
  for (const ok of ['dna64.snes9x-theme', 'dna64.snes9x.core', 'a.b', 'team-x.font-pack-2']) assert.ok(isPackageId(ok), ok);
  const why = (id) => packageIdProblems(id).join(' ');
  assert.match(why('Font_Tweak'), /capital/);
  assert.match(why('Font_Tweak'), /underscore/);
  assert.match(why('fonttweak'), /two parts/);
  assert.match(why('dna64..theme'), /empty part/);
  assert.match(why('.dna64.theme'), /empty part/);
  assert.match(why('dna64.-theme'), /hyphen/);
  assert.match(why('dna64.my theme'), /characters/);
  assert.match(why('a.' + 'x'.repeat(120)), /longer/);
  assert.match(why(''), /no name/);
});

test('namespaces and lookalikes', () => {
  assert.equal(namespaceOf('dna64.theme'), 'dna64');
  assert.equal(namespaceOf('legacy_name'), null);
  assert.equal(squash('DNA-6_4'), squash('dna64'));
  assert.ok(isReserved('snes-9x'));
  assert.ok(isReserved('Theme'));
  assert.ok(isReserved('mycustom', ['my-custom']));
  assert.ok(!isReserved('dna64'));
  assert.equal(idOf('dna64.theme.hmod'), 'dna64.theme');
  assert.equal(idOf('dna64.game.clvg'), 'dna64.game');
});

test('suggestions are valid IDs built from the name or the readme', () => {
  const s = (name, front = {}, kind = 'hmod') => suggestPackageId({ name, kind, readme: { front } });
  assert.equal(s('DNA64.Snes9x_Theme'), 'dna64.snes9x-theme');
  assert.equal(s('Font Tweak', { Creator: 'Alice', Name: 'Font Tweak' }), 'alice.font-tweak');
  assert.equal(s('x', { Creator: 'Team Shinkansen, others', Name: 'Café Menu' }), 'teamshinkansen.cafe-menu');
  assert.equal(s('Alice Fonts', { Creator: 'alice' }), 'alice.fonts');
  assert.equal(s('font', {}), 'yourname.font');
  assert.ok(isReserved('yourname'), 'the placeholder has to be replaced before the central repository takes it');
  for (const id of [s('DNA64.Snes9x_Theme'), s('Font Tweak', { Creator: 'Alice' }), s('!!!', {}, 'game')]) assert.ok(isPackageId(id), id);
});

test('the Studio warns about a non-ID name and renames it on request', async () => {
  const mod = await modFromArchive('Font_Tweak.hmod', await tgz({ 'readme.md': readme({ Name: 'Font Tweak', Creator: 'alice', Version: '1' }), 'usr/share/x': 'x' }));
  const issue = validate(mod).find((i) => i.id === 'package-id');
  assert.equal(issue.severity, 'warning', 'only a warning: own Mod Hub sites may use any name');
  assert.equal(issue.fixLabel, 'Rename to alice.font-tweak');
  const fixed = applyFix(mod, 'package-id');
  assert.equal(fixed.name, 'alice.font-tweak');
  assert.ok(!ids(validate(fixed)).includes('package-id'));

  const good = await modFromArchive('tester.test-mod.hmod', await tgz({ 'readme.md': FULL_README, 'usr/share/x': 'x' }));
  assert.ok(!ids(validate(good)).includes('package-id'));

  const game = await modFromArchive('CLV-H-ABCDE.clvg', await tgz({ 'CLV-H-ABCDE.desktop': desktop('CLV-H-ABCDE', '/bin/fceumm x.nes') }));
  assert.ok(ids(validate(game)).includes('package-id'), 'games are named with IDs too');
});
