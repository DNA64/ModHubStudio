// Example packages shown on first open, clearly marked as examples.
import { makeMod } from './model.js';
import { textBytes } from './tar.js';

const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

export function exampleMods() {
  const theme = makeMod({
    name: 'Night Sky Theme',
    source: { kind: 'zip', fileName: 'Night Sky Theme.hmod', example: true, kindFrom: 'contents' },
    entries: [
      { path: 'NightSky/readme.md', type: 'file', data: textBytes('\n---\nName: Night Sky\nCreator: you\nCategory: Theme\n---\nA dark starfield menu for the SNES Classic.\n') },
      { path: 'NightSky/usr/share/ui/snes/resources/bg.png', type: 'file', data: png() },
      { path: 'NightSky/usr/share/ui/snes-usa/resources/menu_bg.png', type: 'file', data: png() },
      { path: 'NightSky/var/lib/hakchi/rootfs/usr/share/ui/snes-usa/resources/stars.png', type: 'file', data: png() },
      { path: 'NightSky/Etc/preinit.d/p8100_nightsky', type: 'file', data: textBytes('# make sure the theme survives reboots\r\n[ -d "$rootfs/usr/share/ui" ] || return 0\r\necho nightsky loaded') },
      { path: 'NightSky/.DS_Store', type: 'file', data: textBytes('junk') },
    ],
  });
  const music = makeMod({
    name: 'menu_music_pack',
    source: { kind: 'tgz', fileName: 'menu_music_pack.hmod', example: true, kindFrom: 'contents' },
    entries: [
      { path: 'readme.md', type: 'file', data: textBytes('---\nName: Menu Music Pack\nCreator: you\nCategory: Music\nVersion: 1.2.0\n---\nReplaces the home menu music with a random track from the pack at every boot.\n') },
      { path: 'install', type: 'file', data: textBytes('mkdir -p "$rootfs/usr/share/menu_music"\nreturn 0\n') },
      { path: 'etc/preinit.d/p8200_menu_music', type: 'file', data: textBytes('menu_music_pick(){\n  ls "$rootfs/usr/share/menu_music"/*.wav 2>/dev/null | shuf -n 1\n}\n') },
      { path: 'usr/share/menu_music/track01.wav', type: 'file', data: new Uint8Array(2048) },
      { path: 'usr/share/menu_music/track02.wav', type: 'file', data: new Uint8Array(2048) },
      { path: 'usr/bin/menu-music', type: 'file', data: textBytes('#!/bin/sh\necho "now playing"\n'), mode: 0o755 },
    ],
  });
  return [theme, music];
}
