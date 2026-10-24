import { describe, expect, it } from 'vitest';
import { SOUNDTRACKS, soundtrackDuration } from './soundtrack.js';

describe('original soundtrack pack', () => {
  it('ships multiple distinct bounded chiptune scores without external media', () => {
    expect(SOUNDTRACKS.length).toBeGreaterThanOrEqual(8);
    expect(new Set(SOUNDTRACKS.map((track) => track.name)).size).toBe(SOUNDTRACKS.length);
    expect(new Set(SOUNDTRACKS.map((track) => JSON.stringify(track.lead))).size).toBe(SOUNDTRACKS.length);
    for (const track of SOUNDTRACKS) {
      expect(track.bpm).toBeGreaterThanOrEqual(90);
      expect(track.bpm).toBeLessThanOrEqual(180);
      expect(track.lead).toHaveLength(track.harmony.length);
      expect(track.lead).toHaveLength(track.bass.length);
      expect(track.lead).toHaveLength(track.arp.length);
      expect(track.lead).toHaveLength(track.drums.length);
      expect(track.lead.length).toBeGreaterThanOrEqual(320);
      expect(soundtrackDuration(track)).toBeGreaterThanOrEqual(30);
      expect(soundtrackDuration(track)).toBeLessThan(60);
      expect(new Set(track.drums).size).toBeGreaterThanOrEqual(4);
      expect(track.harmony.some((note) => note !== null)).toBe(true);
      expect(track.arp.some((note) => note !== null)).toBe(true);
      for (const note of [...track.lead, ...track.harmony, ...track.bass, ...track.arp]) {
        expect(note === null || (note >= 24 && note <= 96)).toBe(true);
      }
      expect(JSON.stringify(track)).not.toMatch(/https?:|\.mp3|\.wav|\.ogg/i);
    }
  });
});
