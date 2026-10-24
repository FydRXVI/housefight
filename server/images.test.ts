import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { MAX_PORTRAIT_EDGE, normalizePortrait } from './images.js';

describe('portrait normalization', () => {
  it('applies phone orientation, bounds dimensions, and strips metadata', async () => {
    const source = await sharp({
      create: { width: 2_000, height: 1_000, channels: 3, background: '#ff3344' },
    }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const normalized = await normalizePortrait(source);
    const metadata = await sharp(normalized.bytes).metadata();

    expect(normalized.mimeType).toBe('image/webp');
    expect(Math.max(normalized.width, normalized.height)).toBe(MAX_PORTRAIT_EDGE);
    expect(normalized.width).toBe(800);
    expect(normalized.height).toBe(1_600);
    expect(metadata.exif).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
    expect(normalized.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts AVIF input supported by the shipped Sharp binaries', async () => {
    const source = await sharp({
      create: { width: 48, height: 32, channels: 3, background: '#51ddff' },
    }).avif().toBuffer();

    const normalized = await normalizePortrait(source);

    expect(normalized.mimeType).toBe('image/webp');
    expect(normalized.width).toBe(48);
    expect(normalized.height).toBe(32);
  });

  it('rejects SVG even when it contains valid image markup', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"/></svg>');
    await expect(normalizePortrait(svg)).rejects.toThrow('JPEG, PNG, WebP, or AVIF');
  });

  it('rejects corrupt input with a stable user-facing error', async () => {
    await expect(normalizePortrait(Buffer.alloc(128, 7))).rejects.toThrow('could not be decoded safely');
  });
});
