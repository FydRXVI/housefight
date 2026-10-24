import { describe, expect, it } from 'vitest';
import { normalizePublicBaseUrl } from './public-base-url.js';

describe('normalizePublicBaseUrl', () => {
  it('accepts a bare LAN IPv4 address and supplies the game port', () => {
    expect(normalizePublicBaseUrl('192.168.125.97', 4242)).toBe('http://192.168.125.97:4242');
  });

  it('accepts a bare hostname with an explicit port', () => {
    expect(normalizePublicBaseUrl('party-mac.local:5252', 4242)).toBe('http://party-mac.local:5252');
  });

  it('preserves explicit reverse-proxy origins', () => {
    expect(normalizePublicBaseUrl('https://fight.example.test', 4242)).toBe('https://fight.example.test');
  });

  it.each([
    'ftp://192.168.1.25',
    'http://user:secret@192.168.1.25:4242',
    'http://192.168.1.25:4242/game',
    'http://192.168.1.25:4242?room=1',
  ])('rejects unsafe or non-origin input %s', (value) => {
    expect(() => normalizePublicBaseUrl(value, 4242)).toThrow(/PUBLIC_BASE_URL/);
  });
});
