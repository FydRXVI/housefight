import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, unlink } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CardDefinition } from '../engine/types.js';
import { PORTABLE_EXPORT_LIMITS, type PortableExportFile } from '../shared/portable-backup.js';
import { canUseAdmin, isLoopbackAddress } from './http-security.js';
import { MAX_PORTRAIT_UPLOAD_BYTES } from './images.js';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN_KEY = 'integration-admin-secret';

let serverProcess: ChildProcess | undefined;
let serverOutput = '';
let port = 0;
let baseUrl = '';
let temporaryRoot = '';
let dataDirectory = '';

async function availablePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolveListen, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolveListen);
  });
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve an integration-test port.');
  const selected = address.port;
  await new Promise<void>((resolveClose, reject) => probe.close((error) => error ? reject(error) : resolveClose()));
  return selected;
}

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (serverProcess?.exitCode !== null) throw new Error(`Test server exited early.\n${serverOutput}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(750) });
      if (response.ok) return;
    } catch {
      // Startup races are expected while the TypeScript loader initializes.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 75));
  }
  throw new Error(`Test server did not become healthy.\n${serverOutput}`);
}

async function stopServer(): Promise<void> {
  if (!serverProcess || serverProcess.exitCode !== null) return;
  serverProcess.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolveExit) => serverProcess?.once('exit', () => resolveExit())),
    new Promise<void>((resolveWait) => setTimeout(resolveWait, 4_000)),
  ]);
  if (serverProcess.exitCode === null) serverProcess.kill('SIGKILL');
}

async function cards(): Promise<CardDefinition[]> {
  const response = await fetch(`${baseUrl}/api/admin/cards`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { cards: CardDefinition[] }).cards;
}

function customCard(source: CardDefinition, id: string): CardDefinition {
  const card = structuredClone(source);
  card.id = id;
  card.name = 'E\u0301lodie d’Après';
  card.title = 'Combattante de la famille';
  card.quote = 'Kol khara ya shrik — mais avec élégance, s’il te plaît.';
  delete card.portrait;
  card.abilities = card.abilities.map((ability, index) => ({ ...ability, id: `${id}-move-${index + 1}` }));
  return card;
}

async function saveCard(card: CardDefinition): Promise<Response> {
  return fetch(`${baseUrl}/api/admin/cards/${encodeURIComponent(card.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(card),
  });
}

async function createTestCard(id: string): Promise<CardDefinition> {
  const source = (await cards())[0];
  if (!source) throw new Error('The seeded card pack is empty.');
  const response = await saveCard(customCard(source, id));
  expect(response.status).toBe(200);
  return ((await response.json()) as { card: CardDefinition }).card;
}

async function uploadPortrait(cardId: string, color = '#cf3c72'): Promise<CardDefinition> {
  const source = await sharp({
    create: { width: 900, height: 600, channels: 3, background: color },
  }).png().toBuffer();
  const response = await fetch(`${baseUrl}/api/admin/cards/${cardId}/portrait`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: new Uint8Array(source),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { card: CardDefinition }).card;
}

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

async function requestWithDeclaredLength(pathname: string, length: number, method: 'POST' | 'PUT' = 'POST'): Promise<RawResponse> {
  return new Promise((resolveRequest, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: { 'Content-Length': String(length), Connection: 'close' },
    }, (response) => {
      request.setTimeout(0);
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolveRequest({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.setTimeout(5_000, () => request.destroy(new Error('Oversized request test timed out.')));
    request.on('error', reject);
    request.end();
  });
}

async function findFileContaining(directory: string, fragment: string): Promise<string | null> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFileContaining(path, fragment);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name.includes(fragment)) {
      return path;
    }
  }
  return null;
}

beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'house-fight-http-test-'));
  dataDirectory = join(temporaryRoot, 'data');
  port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: REPOSITORY_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(port),
      ADMIN_KEY,
      GAME_DATA_DIR: dataDirectory,
      GAME_BACKUP_DIR: join(temporaryRoot, 'backups'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess.stdout?.on('data', (chunk: Buffer) => { serverOutput += chunk.toString(); });
  serverProcess.stderr?.on('data', (chunk: Buffer) => { serverOutput += chunk.toString(); });
  await waitForServer();
}, 30_000);

afterAll(async () => {
  await stopServer();
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
});

describe.sequential('HTTP admin, media, and recovery boundary', () => {
  it('sets security headers and enforces same-origin plus remote admin authentication', async () => {
    const health = await fetch(`${baseUrl}/api/health`);
    expect(health.status).toBe(200);
    expect(health.headers.get('x-content-type-options')).toBe('nosniff');
    expect(health.headers.get('content-security-policy')).toContain("default-src 'self'");

    expect((await fetch(`${baseUrl}/api/admin/cards`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/admin/cards`, {
      headers: { Origin: 'http://evil.invalid' },
    })).status).toBe(403);
    expect((await fetch(`${baseUrl}/api/admin/cards`, {
      headers: { 'Sec-Fetch-Site': 'same-site' },
    })).status).toBe(403);

    const remoteRequest = {
      headers: { host: 'game.test:4242', origin: 'http://game.test:4242' },
      socket: { remoteAddress: '192.0.2.10' },
    };
    expect(canUseAdmin(remoteRequest, ADMIN_KEY)).toBe(false);
    expect(canUseAdmin({ ...remoteRequest, headers: { ...remoteRequest.headers, 'x-admin-key': 'wrong-key' } }, ADMIN_KEY)).toBe(false);
    expect(canUseAdmin({ ...remoteRequest, headers: { ...remoteRequest.headers, 'x-admin-key': ADMIN_KEY } }, ADMIN_KEY)).toBe(true);
    expect(canUseAdmin({
      ...remoteRequest,
      headers: { ...remoteRequest.headers, origin: 'http://evil.invalid', 'x-admin-key': ADMIN_KEY },
    }, ADMIN_KEY)).toBe(false);
    expect(isLoopbackAddress('127.23.4.5')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.42')).toBe(true);
  });

  it('rejects malformed cards and nonexistent portrait references without persisting them', async () => {
    const source = (await cards())[0];
    if (!source) throw new Error('The seeded card pack is empty.');
    const invalid = customCard(source, 'invalid-http-card');
    invalid.abilities[0] = {
      ...invalid.abilities[0]!,
      effects: [{
        kind: 'conditional',
        condition: { kind: 'chance', probability: 2 },
        effects: [],
      }],
    };
    const malformed = await saveCard(invalid);
    expect(malformed.status).toBe(400);
    expect((await malformed.json()) as { errors: string[] }).toMatchObject({ errors: expect.arrayContaining([
      expect.stringContaining('probability'),
      expect.stringContaining('1–8 effects'),
    ]) });

    const pathMismatch = await fetch(`${baseUrl}/api/admin/cards/a-different-id`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(customCard(source, 'payload-id')),
    });
    expect(pathMismatch.status).toBe(400);

    const missingPortrait = customCard(source, 'missing-photo-card');
    missingPortrait.portrait = { mediaId: '00000000-0000-4000-8000-000000000000', focalX: 50, focalY: 50 };
    const missingMedia = await saveCard(missingPortrait);
    expect(missingMedia.status).toBe(400);
    expect(await missingMedia.json()).toMatchObject({ error: 'Portrait media does not exist.' });
    expect((await cards()).some((card) => card.id === invalid.id || card.id === missingPortrait.id)).toBe(false);
  });

  it('creates, normalizes, updates, lists, and deletes multilingual custom cards', async () => {
    const created = await createTestCard('multilingual-http-card');
    expect(created.name).toBe('Élodie d’Après');
    expect(created.quote).toBe('Kol khara ya shrik — mais avec élégance, s’il te plaît.');
    expect((await cards()).some((card) => card.id === created.id)).toBe(true);

    const updatedResponse = await saveCard({ ...created, hp: created.hp + 1 });
    expect(updatedResponse.status).toBe(200);
    expect(((await updatedResponse.json()) as { card: CardDefinition }).card.hp).toBe(created.hp + 1);

    const deleted = await fetch(`${baseUrl}/api/admin/cards/${created.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect((await fetch(`${baseUrl}/api/admin/cards/${created.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('evaluates an unsaved card against every Standard opponent in both seats', async () => {
    const source = (await cards()).find((card) => card.rarity === 'standard');
    if (!source) throw new Error('The seeded Standard pack is empty.');
    const unsaved = customCard(source, 'unsaved-simulation-card');
    unsaved.hp += 7;
    const response = await fetch(`${baseUrl}/api/admin/simulate?games=20`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(unsaved),
    });
    expect(response.status).toBe(200);
    const payload = await response.json() as {
      simulation: { cardId: string; games: number; wins: number; draws: number; losses: number; matchups: Array<{ games: number }> };
    };
    expect(payload.simulation.cardId).toBe(unsaved.id);
    expect(payload.simulation.matchups).toHaveLength(12);
    expect(payload.simulation.matchups.every((matchup) => matchup.games >= 2)).toBe(true);
    expect(payload.simulation.wins + payload.simulation.draws + payload.simulation.losses).toBe(payload.simulation.games);
    expect((await cards()).some((card) => card.id === unsaved.id)).toBe(false);
  });

  it('normalizes uploaded photos, serves private media headers, and returns JSON fallback errors', async () => {
    const card = await createTestCard('photo-http-card');
    const withPortrait = await uploadPortrait(card.id);
    expect(withPortrait.portrait).toMatchObject({ focalX: 50, focalY: 42 });
    const mediaId = withPortrait.portrait?.mediaId;
    if (!mediaId) throw new Error('Photo upload did not return a media id.');

    const media = await fetch(`${baseUrl}/api/media/${mediaId}`);
    expect(media.status).toBe(200);
    expect(media.headers.get('content-type')).toBe('image/webp');
    expect(media.headers.get('cache-control')).toBe('private, no-store');
    expect(media.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(media.headers.get('content-disposition')).toBe('inline');
    const mediaBytes = Buffer.from(await media.arrayBuffer());
    expect(Number(media.headers.get('content-length'))).toBe(mediaBytes.length);
    await expect(sharp(mediaBytes).metadata()).resolves.toMatchObject({ format: 'webp', width: 900, height: 600 });

    const head = await fetch(`${baseUrl}/api/media/${mediaId}`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    expect((await fetch(`${baseUrl}/api/media/00000000-0000-4000-8000-000000000000`)).status).toBe(404);

    const malformedRoute = await fetch(`${baseUrl}/api/media/not-a-uuid`);
    expect(malformedRoute.status).toBe(404);
    expect(malformedRoute.headers.get('content-type')).toContain('application/json');
    expect(await malformedRoute.json()).toEqual({ error: 'Not found.' });

    const invalidUpload = await fetch(`${baseUrl}/api/admin/cards/${card.id}/portrait`, {
      method: 'POST',
      body: new Uint8Array([1, 2, 3, 4]),
    });
    expect(invalidUpload.status).toBe(400);

    expect((await fetch(`${baseUrl}/api/admin/cards/${card.id}/portrait`, { method: 'DELETE' })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/media/${mediaId}`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/admin/cards/${card.id}`, { method: 'DELETE' })).status).toBe(200);
  });

  it('exports a checksummed portable vault and supports verified merge and replace recovery', async () => {
    const card = await createTestCard('portable-http-card');
    const withPortrait = await uploadPortrait(card.id, '#24a879');
    const mediaId = withPortrait.portrait?.mediaId;
    if (!mediaId) throw new Error('Portable test card has no portrait.');

    const exported = await fetch(`${baseUrl}/api/admin/export?history=0`);
    expect(exported.status).toBe(200);
    expect(exported.headers.get('content-type')).toContain('application/vnd.house-fight+json');
    expect(exported.headers.get('content-disposition')).toMatch(/attachment; filename="house-fight-.+\.housefight"/);
    expect(exported.headers.get('cache-control')).toBe('no-store');
    const portable = (await exported.json()) as PortableExportFile;
    expect(portable).toMatchObject({ format: 'house-fight-portable', version: 1, includesMatches: false });
    expect(portable.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(portable.media.some((media) => media.id === mediaId && media.dataBase64.length > 0)).toBe(true);

    const tampered = structuredClone(portable);
    tampered.cards[0]!.card.name += ' tampered';
    const rejected = await fetch(`${baseUrl}/api/admin/import?mode=merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tampered),
    });
    expect(rejected.status).toBe(400);
    expect(((await rejected.json()) as { error: string }).error).toMatch(/checksum/i);
    expect((await fetch(`${baseUrl}/api/admin/import?mode=erase`, { method: 'POST' })).status).toBe(400);

    const serialized = JSON.stringify(portable);
    const merged = await fetch(`${baseUrl}/api/admin/import?mode=merge`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: serialized,
    });
    expect(merged.status).toBe(200);
    expect(await merged.json()).toMatchObject({ imported: { cards: portable.cards.length, media: portable.media.length } });

    const replaced = await fetch(`${baseUrl}/api/admin/import?mode=replace`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: serialized,
    });
    expect(replaced.status).toBe(200);
    const replacement = (await replaced.json()) as { recoveryPath: string };
    expect(replacement.recoveryPath).toContain('pre-import');
    expect(existsSync(replacement.recoveryPath)).toBe(true);

    const diagnostics = await fetch(`${baseUrl}/api/admin/diagnostics`);
    expect(diagnostics.status).toBe(200);
    expect(await diagnostics.json()).toMatchObject({ database: 'ok', missingMedia: [], media: portable.media.length });
  });

  it('rejects declared oversized card, portrait, and portable-import bodies before reading them', async () => {
    const card = (await cards()).find((candidate) => candidate.id === 'portable-http-card');
    if (!card) throw new Error('Portable test card disappeared after replacement import.');

    const cardBody = await requestWithDeclaredLength(`/api/admin/cards/${card.id}`, 512_001, 'PUT');
    expect(cardBody.status).toBe(413);
    expect(JSON.parse(cardBody.body)).toEqual({ error: 'Request body is too large.' });

    const portraitBody = await requestWithDeclaredLength(`/api/admin/cards/${card.id}/portrait`, MAX_PORTRAIT_UPLOAD_BYTES + 1);
    expect(portraitBody.status).toBe(413);
    const importBody = await requestWithDeclaredLength('/api/admin/import?mode=merge', PORTABLE_EXPORT_LIMITS.jsonBytes + 1);
    expect(importBody.status).toBe(413);
  });

  it('surfaces missing photo files through media errors and health diagnostics', async () => {
    const card = await createTestCard('missing-file-http-card');
    const withPortrait = await uploadPortrait(card.id, '#ef8b22');
    const mediaId = withPortrait.portrait?.mediaId;
    if (!mediaId) throw new Error('Missing-file test card has no portrait.');

    const exported = (await (await fetch(`${baseUrl}/api/admin/export?history=0`)).json()) as PortableExportFile;
    const media = exported.media.find((candidate) => candidate.id === mediaId);
    if (!media) throw new Error('Uploaded portrait is absent from the export.');
    const mediaPath = await findFileContaining(dataDirectory, media.sha256);
    if (!mediaPath) throw new Error('Uploaded portrait file was not found in the temporary vault.');
    await unlink(mediaPath);

    const missing = await fetch(`${baseUrl}/api/media/${mediaId}`);
    expect(missing.status).toBe(500);
    expect(missing.headers.get('content-type')).toContain('application/json');
    expect(((await missing.json()) as { error: string }).error).toMatch(/missing/i);

    const diagnostics = await fetch(`${baseUrl}/api/admin/diagnostics`);
    expect(diagnostics.status).toBe(503);
    expect(await diagnostics.json()).toMatchObject({ database: 'ok', missingMedia: [mediaId] });

    expect((await fetch(`${baseUrl}/api/admin/cards/${card.id}/portrait`, { method: 'DELETE' })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/admin/cards/${card.id}`, { method: 'DELETE' })).status).toBe(200);
  });
});
