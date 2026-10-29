import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tgz, ids, desktop, elf, ELF_ARM, ELF_X86, readme, FULL_README } from './helpers.js';
import { modFromArchive } from '../src/model.js';
import { validate } from '../src/rules.js';
import { resolveTargets, detectTargets, parseConsolesField } from '../src/targets.js';
import { readmeText } from '../src/pack.js';

const mod = async (spec, name = 'test_mod.hmod') => modFromArchive(name, await tgz(spec));
const game = (code, exec, extra = {}) => mod({ [`${code}.desktop`]: desktop(code, exec), ...extra }, `${code}.clvg`);

test('the Consoles field accepts common spellings', () => {
  assert.deepEqual(parseConsolesField('SNES'), ['snes']);
  assert.deepEqual(parseConsolesField('NES, Super Famicom'), ['nes', 'snes']);
  assert.deepEqual(parseConsolesField('Genesis / Mega Drive'), ['sega']);
  assert.deepEqual(parseConsolesField('Genesis'), ['sega'], '"Genesis" is not NES');
  assert.deepEqual(parseConsolesField('Super Nintendo'), ['snes']);
  assert.deepEqual(parseConsolesField('Famicom Mini & Shonen Jump'), ['nes']);
  assert.deepEqual(parseConsolesField('all'), ['nes', 'snes', 'sega']);
  assert.equal(parseConsolesField('toaster'), null);
});

test('targets come from the readme, then the contents, then all', async () => {
  const fromReadme = await mod({ 'readme.md': readme({ Name: 'x', Consoles: 'NES' }), 'usr/share/x': 'x' });
  assert.deepEqual(resolveTargets(fromReadme), { ids: ['nes'], from: 'readme' });

  const snesTheme = await mod({ 'readme.md': FULL_README, 'usr/share/ui/snes-usa/resources/bg.png': 'x' });
  assert.deepEqual(resolveTargets(snesTheme), { ids: ['snes'], from: 'contents' });

  const callsCanoe = await mod({ 'readme.md': FULL_README, 'etc/preinit.d/p8000_x': 'clover-canoe-shvc --flag\n' });
  assert.deepEqual(detectTargets(callsCanoe).ids, ['snes']);

  const generic = await mod({ 'readme.md': FULL_README, 'usr/share/x': 'x' });
  assert.deepEqual(resolveTargets(generic), { ids: ['nes', 'snes', 'sega'], from: 'none' });
  assert.ok(ids(validate(generic)).includes('targets-unknown'));

  const picked = { ...generic, targets: ['sega'] };
  assert.deepEqual(resolveTargets(picked), { ids: ['sega'], from: 'manual' });
});

test('limited targets are written to the readme for the Mod Hub', async () => {
  const m = await mod({ 'readme.md': FULL_README, 'usr/share/x': 'x' });
  assert.match(readmeText({ ...m, targets: ['nes', 'snes'] }), /^Consoles: NES, SNES$/m);
  assert.doesNotMatch(readmeText(m), /Consoles:/, 'all consoles is the default and is left out');
});

test('parts for consoles the package is not set for are flagged', async () => {
  const m = await mod({
    'readme.md': readme({ Name: 'T', Creator: 'c', Category: 'Theme', Version: '1', Consoles: 'SNES' }),
    'usr/share/ui/snes-usa/resources/a.png': 'x',
    'usr/share/clover-ui/resources/b.png': 'x',
  });
  const found = ids(validate(m));
  assert.ok(found.includes('targets-stray-nes'));
  assert.ok(found.includes('targets-region-snes'), 'only SNES USA is covered');
});

test('a theme set for a console it has no menu files for is flagged', async () => {
  const m = await mod({ 'readme.md': FULL_README, 'usr/share/ui/snes-usa/resources/a.png': 'x' });
  assert.ok(ids(validate({ ...m, targets: ['nes', 'snes'] })).includes('targets-theme-missing-nes'));
});

test('games: stock emulator must exist on the target and open the ROM', async () => {
  const nes = await game('CLV-H-AAAAA', '/bin/clover-kachikachi-wr /var/games/CLV-H-AAAAA/x.nes');
  assert.deepEqual(resolveTargets(nes).ids, ['nes']);
  assert.ok(!validate(nes).some((i) => i.severity === 'error'));

  const wrongRom = await game('CLV-H-BBBBB', '/bin/clover-kachikachi-wr /var/games/CLV-H-BBBBB/sonic.bin');
  assert.ok(ids(validate(wrongRom)).includes('game-rom-ext'));

  const onSega = { ...nes, targets: ['sega'] };
  const stray = validate(onSega).find((i) => i.id === 'targets-stray-nes');
  assert.equal(stray.severity, 'error', "a NES-only emulator can't run on SEGA");

  const retro = await game('CLV-H-CCCCC', '/bin/fceumm /var/games/CLV-H-CCCCC/x.nes');
  assert.ok(ids(validate(retro)).includes('game-retroarch'));
});

test('games: .desktop rules from Hakchi2 CE import', async () => {
  const noDesktop = await mod({ 'CLV-H-DDDDD/x.nes': 'x' }, 'x.clvg');
  assert.ok(ids(validate(noDesktop)).includes('game-no-desktop'));
  const noExec = await mod({ 'CLV-H-EEEEE.desktop': 'Name=Only a name\n' }, 'x.clvg');
  assert.ok(ids(validate(noExec)).includes('game-desktop-keys'));
  const oddCode = await game('MYGAME', '/bin/fceumm /var/games/MYGAME/x.nes');
  assert.ok(ids(validate(oddCode)).includes('game-code'));
  const withArt = await game('CLV-H-FFFFF', '/bin/fceumm x.nes', { 'CLV-H-FFFFF.png': 'png' });
  assert.ok(!ids(validate(withArt)).includes('game-art'));
});

test('programs must be built for ARM', async () => {
  const arm = await mod({ 'readme.md': FULL_README, 'usr/bin/tool': elf(ELF_ARM) });
  assert.ok(!ids(validate(arm)).includes('elf-arch'));
  const x86 = await mod({ 'readme.md': FULL_README, 'usr/bin/tool': elf(ELF_X86) });
  const issue = validate(x86).find((i) => i.id === 'elf-arch');
  assert.equal(issue.severity, 'error');
  assert.match(issue.detail, /x86/);
});
