import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { selectLocale, t } from '../public/i18n.js';
import { VEHICLES, TRACKS } from '../shared/game.js';

test('only a Korean browser language selects Korean; everything else uses English', () => {
  for (const language of ['ko', 'ko-KR', 'ko_KR', 'KO-kr']) assert.equal(selectLocale(language), 'ko');
  for (const language of ['en', 'en-US', 'ja-JP', 'id-ID', 'kok', '', undefined, null]) assert.equal(selectLocale(language), 'en');
});

test('translations interpolate without rewriting player names, codes or replacement tokens', () => {
  assert.equal(t('연결됨 · {code}', { code: 'AB12CD' }, 'en'), 'Connected · AB12CD');
  assert.equal(t('🏁 {name} 선두 완주!', { name: '바다 {code}' }, 'en'), '🏁 바다 {code} finishes first!');
  assert.equal(t('연결됨 · {code}', { code: 'AB12CD' }, 'ko'), '연결됨 · AB12CD');
  assert.equal(t('Unknown server message.', {}, 'en'), 'Unknown server message.');
});

test('every Korean static label, dynamic message and vehicle description has English text', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const staticText = [...html.matchAll(/>([^<>]+)</g)].map(match => match[1].trim());
  const attributes = [...html.matchAll(/(?:aria-label|placeholder)="([^"]+)"/g)].map(match => match[1]);
  const messages = ['../public/main.js', '../public/scene.js', '../public/audio.js'].flatMap(path =>
    [...readFileSync(new URL(path, import.meta.url), 'utf8').matchAll(/\bt\('((?:\\.|[^'\\])*)'/g)]
      .map(match => match[1].replace(/\\n/g, '\n')));
  const descriptions = [...Object.values(VEHICLES).map(vehicle => vehicle.description), ...Object.values(TRACKS).map(track => track.name)];
  for (const source of [...staticText, ...attributes, ...messages, ...descriptions]) {
    if (/[가-힣]/.test(source)) assert.doesNotMatch(t(source, {}, 'en'), /[가-힣]/, source);
  }
});

test('game branding and shared invitations use LANRider in both languages', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<title>LANRider · 바닷가 서킷<\/title>/);
  assert.match(html, /aria-label="LANRider 처음으로">LAN<span>Rider<\/span>/);
  const invitation = 'LANRider · 방 {code}\n{url}';
  assert.equal(t(invitation, { code: 'ABC123', url: 'http://example.test/ABC123' }, 'ko'), 'LANRider · 방 ABC123\nhttp://example.test/ABC123');
  assert.equal(t(invitation, { code: 'ABC123', url: 'http://example.test/ABC123' }, 'en'), 'LANRider · Room ABC123\nhttp://example.test/ABC123');
});
