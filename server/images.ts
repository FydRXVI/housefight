import { createHash } from 'node:crypto';
import sharp from 'sharp';

export const MAX_PORTRAIT_UPLOAD_BYTES = 12 * 1024 * 1024;
export const MAX_PORTRAIT_PIXELS = 40_000_000;
export const MAX_PORTRAIT_EDGE = 1_600;

// Sharp reports AVIF containers as `heif` with AV1 compression. Stock
// cross-platform binaries intentionally do not promise HEVC/HEIC decoding.
const ACCEPTED_INPUT_FORMATS = new Set(['jpeg', 'png', 'webp', 'heif']);

export interface NormalizedPortrait {
  bytes: Uint8Array;
  mimeType: 'image/webp';
  width: number;
  height: number;
  sha256: string;
}

export async function normalizePortrait(input: Uint8Array): Promise<NormalizedPortrait> {
  if (input.byteLength < 32) throw new Error('The selected image is empty or incomplete.');
  if (input.byteLength > MAX_PORTRAIT_UPLOAD_BYTES) {
    throw new Error('The selected image is larger than 12 MB.');
  }

  try {
    const source = sharp(input, {
      animated: false,
      failOn: 'warning',
      limitInputPixels: MAX_PORTRAIT_PIXELS,
      sequentialRead: true,
    });
    const metadata = await source.metadata();
    if (!metadata.format || !ACCEPTED_INPUT_FORMATS.has(metadata.format)
      || (metadata.format === 'heif' && metadata.compression !== 'av1')) {
      throw new Error('Use a JPEG, PNG, WebP, or AVIF photo. SVG, HEIC, and animated images are not accepted.');
    }
    if (!metadata.width || !metadata.height) throw new Error('The image has no readable dimensions.');
    if ((metadata.pages ?? 1) > 1) throw new Error('Animated or multi-page images are not accepted.');

    const result = await source
      .rotate()
      .resize({
        width: MAX_PORTRAIT_EDGE,
        height: MAX_PORTRAIT_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 88, alphaQuality: 90, smartSubsample: true, effort: 5 })
      .toBuffer({ resolveWithObject: true });

    return {
      bytes: result.data,
      mimeType: 'image/webp',
      width: result.info.width,
      height: result.info.height,
      sha256: createHash('sha256').update(result.data).digest('hex'),
    };
  } catch (error) {
    if (error instanceof Error && (
      error.message.startsWith('Use a ')
      || error.message.startsWith('The image ')
      || error.message.startsWith('Animated ')
    )) throw error;
    throw new Error('That file could not be decoded safely as a photo.', { cause: error });
  }
}
