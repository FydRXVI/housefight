import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir, networkInterfaces, platform } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import type { Socket } from 'node:net';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';
import type { ViteDevServer } from 'vite';
import { estimateCard, simulateCard } from '../engine/balance.js';
import type { CardDefinition } from '../engine/types.js';
import { fakeCards } from '../fixtures/fake-card-pack/cards.js';
import { normalizeCardDefinition, validateCardDefinition } from '../shared/card-validation.js';
import { PORTABLE_EXPORT_LIMITS } from '../shared/portable-backup.js';
import { GameRoom } from './game-room.js';
import { canUseAdmin, isLoopbackAddress } from './http-security.js';
import { MAX_PORTRAIT_UPLOAD_BYTES, normalizePortrait } from './images.js';
import { normalizePublicBaseUrl } from './public-base-url.js';
import { GameStore } from './storage.js';

const isProduction = process.env.NODE_ENV === 'production';
const port = Number.parseInt(process.env.PORT ?? '4242', 10);
const host = process.env.HOST ?? '0.0.0.0';

function defaultDataDirectory(): string {
  if (process.env.XDG_DATA_HOME) return join(process.env.XDG_DATA_HOME, 'house-fight');
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'House Fight');
  if (platform() === 'win32' && process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, 'House Fight');
  return join(homedir(), '.local', 'share', 'house-fight');
}

function discoverJoinUrls(): string[] {
  const configured = process.env.PUBLIC_BASE_URL?.trim();
  if (configured) {
    return [normalizePublicBaseUrl(configured, port)];
  }
  if (process.env.CONTAINERIZED === 'true' || isLoopbackAddress(host)) return [];
  return [...new Set(Object.values(networkInterfaces())
    .flat()
    .filter((address) => address?.family === 'IPv4' && !address.internal)
    .map((address) => `http://${address?.address}:${port}`))];
}

const dataDirectory = process.env.GAME_DATA_DIR ?? defaultDataDirectory();
const backupDirectory = process.env.GAME_BACKUP_DIR ?? `${dataDirectory}-backups`;
const adminKey = process.env.ADMIN_KEY ?? '';
const rootDirectory = resolve(process.cwd());
const clientDirectory = join(rootDirectory, 'dist');

if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be between 1 and 65535.');

const joinUrls = discoverJoinUrls();
const store = new GameStore(dataDirectory, fakeCards);
const room = new GameRoom(store, joinUrls);
let vite: ViteDevServer | null = null;

function securityHeaders(response: ServerResponse): void {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (isProduction) {
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const payload = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Length', Buffer.byteLength(payload));
  response.end(payload);
}

class RequestError extends Error {
  constructor(readonly status: number, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const contentLengthHeader = request.headers['content-length'];
  if (contentLengthHeader !== undefined) {
    if (!/^\d+$/.test(contentLengthHeader)) throw new RequestError(400, 'Content-Length is invalid.');
    const contentLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(contentLength) || contentLength > limit) {
      throw new RequestError(413, 'Request body is too large.');
    }
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new RequestError(413, 'Request body is too large.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(request: IncomingMessage, limit = 512_000): Promise<unknown> {
  const raw = (await readBody(request, limit)).toString('utf8');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new RequestError(400, 'Request body is not valid JSON.', { cause: error });
  }
}

async function handleApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname === '/api/health') {
    sendJson(response, 200, {
      ok: true,
      service: 'house-fight',
      schemaVersion: store.schemaVersion(),
      time: new Date().toISOString(),
    });
    return true;
  }

  const mediaMatch = url.pathname.match(/^\/api\/media\/([0-9a-f-]{36})$/i);
  if (mediaMatch) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendJson(response, 405, { error: 'Method not allowed.' });
      return true;
    }
    const media = store.getMedia(mediaMatch[1]!);
    if (!media) {
      sendJson(response, 404, { error: 'Photo not found.' });
      return true;
    }
    response.statusCode = 200;
    response.setHeader('Content-Type', media.record.mimeType);
    response.setHeader('Content-Length', media.record.byteSize);
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Content-Disposition', 'inline');
    if (request.method === 'HEAD') response.end();
    else {
      const stream = createReadStream(media.absolutePath);
      stream.on('error', () => response.destroy());
      stream.pipe(response);
    }
    return true;
  }

  if (!url.pathname.startsWith('/api/admin/')) return false;
  if (!canUseAdmin(request, adminKey)) {
    sendJson(response, 403, { error: 'Admin is limited to localhost unless ADMIN_KEY is configured.' });
    return true;
  }

  if (url.pathname === '/api/admin/cards' && request.method === 'GET') {
    sendJson(response, 200, { cards: store.listCards() });
    return true;
  }

  const portraitMatch = url.pathname.match(/^\/api\/admin\/cards\/([a-z0-9-]+)\/portrait$/);
  if (portraitMatch && request.method === 'POST') {
    const card = store.listCards().find((candidate) => candidate.id === portraitMatch[1]);
    if (!card) {
      sendJson(response, 404, { error: 'Unknown card.' });
      return true;
    }
    const upload = await readBody(request, MAX_PORTRAIT_UPLOAD_BYTES);
    let normalized: Awaited<ReturnType<typeof normalizePortrait>>;
    try {
      normalized = await normalizePortrait(upload);
    } catch (error) {
      throw new RequestError(400, error instanceof Error ? error.message : 'Photo upload failed validation.', { cause: error });
    }
    const mediaId = randomUUID();
    store.saveMedia({ id: mediaId, ...normalized });
    const updated = { ...card, portrait: { mediaId, focalX: 50, focalY: 42 } };
    try {
      store.saveCard(updated);
    } catch (error) {
      try { store.deleteMedia(mediaId); } catch { /* The original save error is more useful. */ }
      throw error;
    }
    if (card.portrait && card.portrait.mediaId !== mediaId) {
      try { store.deleteMedia(card.portrait.mediaId); } catch { /* Match replays may still reference it. */ }
    }
    sendJson(response, 200, { card: updated });
    return true;
  }

  if (portraitMatch && request.method === 'DELETE') {
    const card = store.listCards().find((candidate) => candidate.id === portraitMatch[1]);
    if (!card) {
      sendJson(response, 404, { error: 'Unknown card.' });
      return true;
    }
    if (!card.portrait) {
      sendJson(response, 200, { card });
      return true;
    }
    const mediaId = card.portrait.mediaId;
    const updated = structuredClone(card);
    delete updated.portrait;
    store.saveCard(updated);
    try { store.deleteMedia(mediaId); } catch { /* Match replays may still reference it. */ }
    sendJson(response, 200, { card: updated });
    return true;
  }

  const cardMatch = url.pathname.match(/^\/api\/admin\/cards\/([a-z0-9-]+)$/);
  if (cardMatch && request.method === 'PUT') {
    const payload = await readJson(request);
    const validation = validateCardDefinition(payload);
    if (!validation.ok || typeof payload !== 'object' || payload === null || !('id' in payload) || payload.id !== cardMatch[1]) {
      sendJson(response, 400, { error: 'Invalid card payload.', errors: validation.errors });
      return true;
    }
    const card = normalizeCardDefinition(payload as Parameters<typeof normalizeCardDefinition>[0]);
    try {
      store.saveCard(card);
    } catch (error) {
      throw new RequestError(400, error instanceof Error ? error.message : 'Card could not be saved.', { cause: error });
    }
    sendJson(response, 200, { card, estimate: estimateCard(card) });
    return true;
  }

  if (cardMatch && request.method === 'DELETE') {
    try {
      if (!store.deleteCard(cardMatch[1]!)) {
        sendJson(response, 404, { error: 'Unknown card.' });
        return true;
      }
    } catch (error) {
      throw new RequestError(400, error instanceof Error ? error.message : 'Card could not be deleted.', { cause: error });
    }
    sendJson(response, 200, { deleted: cardMatch[1] });
    return true;
  }

  if (url.pathname === '/api/admin/stats' && request.method === 'GET') {
    sendJson(response, 200, { stats: store.fighterStats() });
    return true;
  }

  if (url.pathname === '/api/admin/simulate' && ['GET', 'POST'].includes(request.method ?? '')) {
    const requestedGames = Number.parseInt(url.searchParams.get('games') ?? '250', 10);
    const games = Number.isFinite(requestedGames) ? Math.min(1_000, Math.max(20, requestedGames)) : 250;
    const cards = store.listCards();
    let card: CardDefinition | undefined;
    if (request.method === 'POST') {
      const payload = await readJson(request);
      const validation = validateCardDefinition(payload);
      if (!validation.ok) {
        sendJson(response, 400, { error: 'Invalid card payload.', errors: validation.errors });
        return true;
      }
      card = normalizeCardDefinition(payload as Parameters<typeof normalizeCardDefinition>[0]);
    } else {
      const cardId = url.searchParams.get('card');
      card = cards.find((candidate) => candidate.id === cardId);
    }
    if (!card) {
      sendJson(response, 404, { error: 'Unknown card.' });
      return true;
    }
    const opponents = cards.filter((candidate) => candidate.rarity === 'standard' && candidate.id !== card.id);
    const simulationGames = Math.max(games, opponents.length * 2);
    sendJson(response, 200, {
      estimate: estimateCard(card),
      simulation: simulateCard(card, opponents, simulationGames),
    });
    return true;
  }

  if (url.pathname === '/api/admin/export' && request.method === 'GET') {
    const serialized = store.serializePortableExport({ includeMatches: url.searchParams.get('history') !== '0' });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/vnd.house-fight+json; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="house-fight-${timestamp}.housefight"`);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Length', Buffer.byteLength(serialized));
    response.end(serialized);
    return true;
  }

  if (url.pathname === '/api/admin/import' && request.method === 'POST') {
    const mode = url.searchParams.get('mode');
    if (mode !== 'merge' && mode !== 'replace') {
      sendJson(response, 400, { error: 'Import mode must be merge or replace.' });
      return true;
    }
    const payload = await readJson(request, PORTABLE_EXPORT_LIMITS.jsonBytes);
    try {
      const imported = await store.importPortableExport(payload, { mode, recoveryDirectory: backupDirectory });
      sendJson(response, 200, {
        imported: {
          cards: imported.cardsImported,
          matches: imported.matchesImported,
          media: imported.mediaImported,
        },
        recoveryPath: imported.recoveryPath,
      });
    } catch (error) {
      throw new RequestError(400, error instanceof Error ? error.message : 'Import failed validation.', { cause: error });
    }
    return true;
  }

  if (url.pathname === '/api/admin/diagnostics' && request.method === 'GET') {
    const diagnostics = store.diagnostics();
    const missingMedia: string[] = [];
    for (const media of store.listMediaRecords()) {
      try { store.getMedia(media.id); } catch { missingMedia.push(media.id); }
    }
    sendJson(response, diagnostics.integrity === 'ok' && missingMedia.length === 0 ? 200 : 503, {
      database: diagnostics.integrity,
      cards: diagnostics.cards,
      enabledCards: diagnostics.enabledCards,
      standardCards: diagnostics.standardCards,
      enabledStandardCards: diagnostics.enabledStandardCards,
      matches: diagnostics.matches,
      media: diagnostics.media,
      checkpoint: diagnostics.hasRoomCheckpoint,
      missingMedia,
      schemaVersion: diagnostics.schemaVersion,
    });
    return true;
  }

  sendJson(response, 404, { error: 'Not found.' });
  return true;
}

const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

function serveProduction(response: ServerResponse, pathname: string): void {
  const decoded = decodeURIComponent(pathname);
  const candidate = decoded === '/' || !extname(decoded) ? 'index.html' : decoded.replace(/^\/+/, '');
  const normalized = normalize(candidate).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = resolve(clientDirectory, normalized);
  if (!filePath.startsWith(`${clientDirectory}/`) && filePath !== join(clientDirectory, 'index.html')) {
    sendJson(response, 400, { error: 'Invalid path.' });
    return;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    sendJson(response, 404, { error: 'Not found.' });
    return;
  }
  const extension = extname(filePath);
  response.statusCode = 200;
  response.setHeader('Content-Type', mimeTypes[extension] ?? 'application/octet-stream');
  response.setHeader('Cache-Control', extension === '.html' ? 'no-store' : 'public, max-age=31536000, immutable');
  const stream = createReadStream(filePath);
  stream.on('error', () => response.destroy());
  stream.pipe(response);
}

const httpServer = createServer((request, response) => {
  securityHeaders(response);
  void (async () => {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      if (await handleApi(request, response, url)) return;
      if (url.pathname.startsWith('/api/')) {
        sendJson(response, 404, { error: 'Not found.' });
        return;
      }
      if (isProduction) {
        serveProduction(response, url.pathname);
        return;
      }
      if (!vite) throw new Error('Development server is not ready.');
      vite.middlewares(request, response, () => sendJson(response, 404, { error: 'Not found.' }));
    } catch (error) {
      if (!response.headersSent) {
        const status = error instanceof RequestError ? error.status : 500;
        sendJson(response, status, { error: error instanceof Error ? error.message : 'Internal error.' });
      } else {
        response.end();
      }
    }
  })();
});

type LiveSocket = WebSocket & { isAlive?: boolean };
const webSockets = new WebSocketServer({ noServer: true, maxPayload: 16_384, perMessageDeflate: false });

webSockets.on('connection', (socket: LiveSocket, request) => {
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });
  const url = new URL(request.url ?? '/ws', `http://${request.headers.host ?? 'localhost'}`);
  const role = url.searchParams.get('role') === 'arena' ? 'arena' : 'player';
  room.attach(socket, url.searchParams.get('token'), role);
});

httpServer.on('upgrade', (request, socket: Socket, head) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (url.pathname !== '/ws') return;
  const origin = request.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== request.headers.host) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
    } catch {
      socket.destroy();
      return;
    }
  }
  webSockets.handleUpgrade(request, socket, head, (client) => {
    webSockets.emit('connection', client, request);
  });
});

const heartbeat = setInterval(() => {
  for (const socket of webSockets.clients as Set<LiveSocket>) {
    if (socket.isAlive === false) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 30_000);
heartbeat.unref();

if (!isProduction) {
  const viteModule = await import('vite');
  vite = await viteModule.createServer({
    server: { middlewareMode: true, hmr: { server: httpServer } },
    appType: 'spa',
  });
}

httpServer.listen(port, host, () => {
  console.log(`HOUSE FIGHT listening on http://localhost:${port}`);
  for (const address of joinUrls) console.log(`LAN join: ${address}`);
  if (joinUrls.length === 0) console.warn('No shareable LAN URL detected. Set PUBLIC_BASE_URL to the origin other players can open.');
  console.log(`Private data: ${dataDirectory}`);
  console.log(`Backups: ${backupDirectory}`);
});

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeat);
  try { room.shutdown(); } catch (error) { console.error('Could not save the final room checkpoint.', error); }
  for (const socket of webSockets.clients) socket.close(1001, 'Server restarting');
  webSockets.close();
  httpServer.close(() => {
    void (async () => {
      try { await vite?.close(); } finally {
        store.close();
        process.exit(0);
      }
    })();
  });
  const forceExit = setTimeout(() => {
    try { store.close(); } catch { /* Best-effort shutdown after the grace period. */ }
    process.exit(1);
  }, 10_000);
  forceExit.unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
