import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { createBattle } from '../engine/engine.js';
import type { CardDefinition } from '../engine/types.js';
import { fakeCards } from '../fixtures/fake-card-pack/cards.js';
import {
  CURRENT_SCHEMA_VERSION,
  GameStore,
  createConsistentBackup,
  restoreConsistentBackup,
  verifyConsistentBackup,
} from './storage.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'house-fight-storage-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function portraitBytes(color = '#295f91'): Promise<Buffer> {
  return sharp({
    create: { width: 32, height: 24, channels: 3, background: color },
  }).webp().toBuffer();
}

function customCard(base: CardDefinition, id: string, mediaId?: string): CardDefinition {
  return {
    ...structuredClone(base),
    id,
    name: `Custom ${id}`,
    ...(mediaId ? { portrait: { mediaId, focalX: 50, focalY: 50 } } : {}),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('durable game storage', () => {
  it('migrates a legacy database, applies private permissions, and round-trips a checkpoint', () => {
    const root = temporaryDirectory();
    const dataDirectory = join(root, 'data');
    mkdirSync(dataDirectory, { recursive: true });
    const legacy = new DatabaseSync(join(dataDirectory, 'game.sqlite'));
    legacy.exec(`
      CREATE TABLE cards (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE matches (
        id TEXT PRIMARY KEY,
        seed INTEGER NOT NULL,
        mode TEXT NOT NULL,
        playlist TEXT NOT NULL,
        rounds INTEGER NOT NULL,
        winner_ids TEXT NOT NULL,
        fighter_ids TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    const customized = { ...(fakeCards[0] as CardDefinition), title: 'LEGACY CUSTOM TITLE' };
    legacy.prepare('INSERT INTO cards (id, payload) VALUES (?, ?)').run(customized.id, JSON.stringify(customized));
    legacy.close();

    const store = new GameStore(dataDirectory, fakeCards);
    expect(store.schemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
    expect(store.listCards().find((card) => card.id === customized.id)?.title).toBe('LEGACY CUSTOM TITLE');
    expect(statSync(dataDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(join(dataDirectory, 'game.sqlite')).mode & 0o777).toBe(0o600);

    const checkpoint = { version: 1, phrase: 'Kol khara ya shrik', french: 'Ça va ?', arabic: 'مرحبا' };
    store.saveRoomCheckpoint(checkpoint);
    expect(store.loadRoomCheckpoint()).toEqual(checkpoint);
    expect(store.diagnostics()).toMatchObject({ schemaVersion: CURRENT_SCHEMA_VERSION, integrity: 'ok', hasRoomCheckpoint: true });
    store.clearRoomCheckpoint();
    expect(store.loadRoomCheckpoint()).toBeNull();
    store.close();
  });

  it('upgrades untouched built-in cards while preserving customized cards with the same ids', () => {
    const root = temporaryDirectory();
    const dataDirectory = join(root, 'data');
    const oldPack = structuredClone(fakeCards);
    const first = oldPack[0] as CardDefinition;
    const second = oldPack[1] as CardDefinition;
    first.title = 'OLD BUILTIN TITLE';
    second.title = 'OLD SECOND TITLE';

    const oldStore = new GameStore(dataDirectory, oldPack);
    oldStore.saveCard({ ...second, title: 'MY CUSTOM TITLE' });
    oldStore.close();

    const upgraded = new GameStore(dataDirectory, fakeCards);
    expect(upgraded.listCards().find((card) => card.id === first.id)?.title).toBe(fakeCards[0]?.title);
    expect(upgraded.listCards().find((card) => card.id === second.id)?.title).toBe('MY CUSTOM TITLE');
    upgraded.close();
  });

  it('rejects symbolic links inside private storage paths', () => {
    const root = temporaryDirectory();
    const dataDirectory = join(root, 'data');
    const outsideDirectory = join(root, 'outside');
    mkdirSync(dataDirectory, { mode: 0o700 });
    mkdirSync(outsideDirectory, { mode: 0o700 });
    symlinkSync(outsideDirectory, join(dataDirectory, 'media'), 'dir');
    expect(() => new GameStore(dataDirectory, fakeCards)).toThrow(/real directory|Symbolic links/);
  });

  it('deduplicates media files and protects referenced portraits and the minimum playable roster', async () => {
    const root = temporaryDirectory();
    const store = new GameStore(join(root, 'data'), fakeCards);
    const bytes = await portraitBytes();
    const firstMediaId = randomUUID();
    const secondMediaId = randomUUID();
    store.saveMedia({ id: firstMediaId, bytes, mimeType: 'image/webp', width: 32, height: 24 });
    store.saveMedia({ id: secondMediaId, bytes, mimeType: 'image/webp', width: 32, height: 24 });
    const sharedPath = store.getMedia(firstMediaId)?.absolutePath;
    expect(sharedPath).toBeTruthy();
    expect(store.getMedia(secondMediaId)?.absolutePath).toBe(sharedPath);

    const firstCard = customCard(fakeCards[0] as CardDefinition, 'custom-first', firstMediaId);
    const secondCard = customCard(fakeCards[1] as CardDefinition, 'custom-second', secondMediaId);
    store.saveCard(firstCard);
    store.saveCard({
      ...firstCard,
      name: 'ÇA VA L’ÉQUIPE',
      title: 'Kol khara ya shrik',
      quote: 'مرحبا يا شريك',
    });
    store.saveCard(secondCard);
    expect(store.listCards().find((card) => card.id === firstCard.id)).toMatchObject({
      name: 'ÇA VA L’ÉQUIPE',
      title: 'Kol khara ya shrik',
      quote: 'مرحبا يا شريك',
    });
    expect(() => store.deleteMedia(firstMediaId)).toThrow(/referenced/);

    expect(store.deleteCard(firstCard.id)).toBe(true);
    expect(store.getMediaRecord(firstMediaId)).toBeNull();
    expect(existsSync(sharedPath as string)).toBe(true);
    expect(store.deleteCard(secondCard.id)).toBe(true);
    expect(store.getMediaRecord(secondMediaId)).toBeNull();
    expect(existsSync(sharedPath as string)).toBe(false);

    const protectedStandard = store.listCards().find((card) => card.rarity === 'standard') as CardDefinition;
    expect(() => store.saveCard({ ...protectedStandard, rarity: 'boss' })).toThrow(/12 enabled Standard/);
    expect(store.listCards().find((card) => card.id === protectedStandard.id)?.rarity).toBe('standard');
    store.saveCard({ ...protectedStandard, title: 'EDITED BUILT-IN' });
    expect(() => store.deleteCard(protectedStandard.id)).toThrow(/Built-in cards cannot be deleted/);
    const special = store.listCards().find((card) => card.rarity !== 'standard') as CardDefinition;
    const removableSpecial = customCard(special, 'custom-special');
    store.saveCard(removableSpecial);
    expect(store.deleteCard(removableSpecial.id)).toBe(true);

    const checkpointMediaId = randomUUID();
    store.saveMedia({ id: checkpointMediaId, bytes: await portraitBytes('#665522'), mimeType: 'image/webp', width: 32, height: 24 });
    store.saveRoomCheckpoint({ room: { battle: { fighters: [{ card: { portrait: { mediaId: checkpointMediaId } } }] } } });
    expect(() => store.deleteMedia(checkpointMediaId)).toThrow(/referenced/);
    store.clearRoomCheckpoint();
    expect(store.deleteMedia(checkpointMediaId)).toBe(true);
    store.close();

    const floorStore = new GameStore(join(root, 'floor'), []);
    const customStandards = fakeCards
      .filter((card) => card.rarity === 'standard')
      .map((card) => ({ ...structuredClone(card), id: `floor-${card.id}` }));
    for (const card of customStandards) floorStore.saveCard(card);
    expect(floorStore.diagnostics().standardCards).toBe(12);
    expect(() => floorStore.deleteCard(customStandards[0]?.id ?? '')).toThrow(/12 enabled Standard/);
    expect(() => floorStore.saveCard({ ...(customStandards[0] as CardDefinition), rarity: 'boss' })).toThrow(/12 enabled Standard/);
    const extraStandard = { ...(customStandards[0] as CardDefinition), id: 'floor-extra', enabled: true };
    floorStore.saveCard(extraStandard);
    floorStore.saveCard({ ...(customStandards[0] as CardDefinition), enabled: false });
    expect(floorStore.diagnostics()).toMatchObject({ cards: 13, enabledCards: 12, standardCards: 13, enabledStandardCards: 12 });
    expect(floorStore.listCards().find((card) => card.id === customStandards[0]?.id)?.enabled).toBe(false);
    expect(() => floorStore.saveCard({ ...(customStandards[1] as CardDefinition), enabled: false })).toThrow(/12 enabled Standard/);

    const toggleTarget = new GameStore(join(root, 'toggle-target'), []);
    await toggleTarget.importPortableExport(floorStore.createPortableExport(), {
      mode: 'replace',
      recoveryDirectory: join(root, 'toggle-recovery'),
    });
    expect(toggleTarget.listCards().find((card) => card.id === customStandards[0]?.id)?.enabled).toBe(false);
    toggleTarget.close();
    floorStore.close();
  });

  it('exports and imports cards, media, and deterministic replay data while rejecting tampering', async () => {
    const root = temporaryDirectory();
    const source = new GameStore(join(root, 'source'), fakeCards);
    const mediaId = randomUUID();
    source.saveMedia({
      id: mediaId,
      bytes: await portraitBytes('#78375c'),
      mimeType: 'image/webp',
      width: 32,
      height: 24,
    });
    source.saveCard({
      ...customCard(fakeCards[0] as CardDefinition, 'portable-card', mediaId),
      name: 'ÇA VA L’ÉQUIPE',
      title: 'Kol khara ya shrik',
      quote: 'مرحبا يا شريك',
    });
    const cards = source.listCards();
    const left = cards.find((card) => card.id === 'portable-card') as CardDefinition;
    const right = cards.find((card) => card.id !== left.id && card.rarity === 'standard') as CardDefinition;
    const initialBattle = createBattle([
      { id: 'player-a', name: 'Équipe أ', teamId: 'player-a', card: left },
      { id: 'player-b', name: 'Player B', teamId: 'player-b', card: right },
    ], 'duel', 1234);
    const roundActions = [[
      { actorId: 'player-a', abilityId: left.abilities[0]?.id ?? '', targetIds: ['player-b'] },
      { actorId: 'player-b', abilityId: right.abilities[0]?.id ?? '', targetIds: ['player-a'] },
    ]];
    source.recordMatch({
      id: 'REPLAY-1',
      seed: 1234,
      mode: 'duel',
      playlist: 'balanced',
      rounds: 1,
      winnerIds: [],
      fighterIds: [left.id, right.id],
      initialBattle,
      roundActions,
    });

    const portable = source.createPortableExport({ includeMatches: true });
    expect(portable.media).toHaveLength(1);
    expect(portable.matches[0]?.initialBattle?.fighters['player-a']?.name).toBe('Équipe أ');
    const tampered = structuredClone(portable);
    (tampered.cards[0] as typeof tampered.cards[number]).card.name = 'Tampered';

    const targetData = join(root, 'target');
    const target = new GameStore(targetData, fakeCards);
    const obsoleteMediaId = randomUUID();
    target.saveMedia({
      id: obsoleteMediaId,
      bytes: await portraitBytes('#116644'),
      mimeType: 'image/webp',
      width: 32,
      height: 24,
    });
    target.saveCard(customCard(fakeCards[2] as CardDefinition, 'obsolete-card', obsoleteMediaId));
    const obsoletePath = target.getMedia(obsoleteMediaId)?.absolutePath as string;
    await expect(target.importPortableExport(tampered, {
      mode: 'replace',
      recoveryDirectory: join(root, 'recovery'),
    })).rejects.toThrow(/checksum/);
    const undersizedSource = new GameStore(join(root, 'undersized'), [fakeCards[0] as CardDefinition]);
    const undersized = undersizedSource.createPortableExport();
    await expect(target.importPortableExport(undersized, {
      mode: 'replace',
      recoveryDirectory: join(root, 'recovery'),
    })).rejects.toThrow(/12 enabled Standard/);
    const unsafeMergeSource = new GameStore(join(root, 'unsafe-merge'), [
      { ...(fakeCards[0] as CardDefinition), rarity: 'boss' },
      { ...(fakeCards[1] as CardDefinition), rarity: 'boss' },
    ]);
    await expect(target.importPortableExport(unsafeMergeSource.createPortableExport(), {
      mode: 'merge',
      recoveryDirectory: join(root, 'recovery'),
    })).rejects.toThrow(/12 enabled Standard/);
    expect(target.diagnostics().standardCards).toBe(13);
    undersizedSource.close();
    unsafeMergeSource.close();
    const imported = await target.importPortableExport(portable, {
      mode: 'replace',
      recoveryDirectory: join(root, 'recovery'),
    });
    expect(imported).toMatchObject({ cardsImported: portable.cards.length, matchesImported: 1, mediaImported: 1 });
    expect(verifyConsistentBackup(imported.recoveryPath).ok).toBe(true);
    expect(target.listCards().find((card) => card.id === left.id)?.portrait?.mediaId).toBe(mediaId);
    expect(target.listCards().find((card) => card.id === left.id)).toMatchObject({
      name: 'ÇA VA L’ÉQUIPE',
      title: 'Kol khara ya shrik',
      quote: 'مرحبا يا شريك',
    });
    expect(target.getMedia(mediaId)?.record.sha256).toBe(portable.media[0]?.sha256);
    expect(target.getMediaRecord(obsoleteMediaId)).toBeNull();
    expect(existsSync(obsoletePath)).toBe(false);
    source.close();
    target.close();
  });

  it('removes newly materialized media when a later import file fails validation on disk', async () => {
    const root = temporaryDirectory();
    const source = new GameStore(join(root, 'source'), fakeCards);
    const firstMediaId = '00000000-0000-4000-8000-000000000001';
    const secondMediaId = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
    source.saveMedia({ id: firstMediaId, bytes: await portraitBytes('#111199'), mimeType: 'image/webp', width: 32, height: 24 });
    source.saveMedia({ id: secondMediaId, bytes: await portraitBytes('#991111'), mimeType: 'image/webp', width: 32, height: 24 });
    source.saveCard(customCard(fakeCards[0] as CardDefinition, 'aaa-media-card', firstMediaId));
    source.saveCard(customCard(fakeCards[1] as CardDefinition, 'zzz-media-card', secondMediaId));
    const portable = source.createPortableExport();
    expect(portable.media.map((media) => media.id)).toEqual([firstMediaId, secondMediaId]);

    const targetData = join(root, 'target');
    const target = new GameStore(targetData, fakeCards);
    const firstMedia = portable.media[0] as typeof portable.media[number];
    const secondMedia = portable.media[1] as typeof portable.media[number];
    const firstPath = join(targetData, 'media', 'people', `${firstMedia.sha256}.webp`);
    const secondPath = join(targetData, 'media', 'people', `${secondMedia.sha256}.webp`);
    mkdirSync(dirname(secondPath), { recursive: true });
    writeFileSync(secondPath, 'not the expected image', { mode: 0o600 });

    await expect(target.importPortableExport(portable, {
      mode: 'replace',
      recoveryDirectory: join(root, 'recovery'),
    })).rejects.toThrow(/collision/);
    expect(existsSync(firstPath)).toBe(false);
    expect(readFileSync(secondPath, 'utf8')).toBe('not the expected image');
    expect(target.diagnostics()).toMatchObject({ cards: fakeCards.length, media: 0, standardCards: 12 });
    source.close();
    target.close();
  });

  it('creates, detects corruption in, and safely restores a consistent backup', async () => {
    const root = temporaryDirectory();
    const dataDirectory = join(root, 'data');
    const backupRoot = join(root, 'backups');
    const store = new GameStore(dataDirectory, fakeCards);
    store.saveCard({ ...(fakeCards[0] as CardDefinition), title: 'BEFORE BACKUP' });
    const sharedBytes = await portraitBytes('#334455');
    store.saveMedia({ id: randomUUID(), bytes: sharedBytes, mimeType: 'image/webp', width: 32, height: 24 });
    store.saveMedia({ id: randomUUID(), bytes: sharedBytes, mimeType: 'image/webp', width: 32, height: 24 });
    const backup = await createConsistentBackup(dataDirectory, backupRoot, 'release-gate');
    expect(verifyConsistentBackup(backup.path)).toMatchObject({ ok: true });
    expect(backup.manifest.files.filter((file) => file.path.startsWith('media/'))).toHaveLength(1);
    store.saveCard({ ...(fakeCards[0] as CardDefinition), title: 'AFTER BACKUP' });
    store.close();

    const corrupt = join(root, 'corrupt');
    cpSync(backup.path, corrupt, { recursive: true });
    const corruptDatabase = join(corrupt, 'game.sqlite');
    writeFileSync(corruptDatabase, Buffer.concat([readFileSync(corruptDatabase), Buffer.from('tampered')]));
    expect(verifyConsistentBackup(corrupt).ok).toBe(false);

    await expect(restoreConsistentBackup(dataDirectory, backup.path, backupRoot, {
      confirmServerStopped: false,
    })).rejects.toThrow(/confirm/);
    const restored = await restoreConsistentBackup(dataDirectory, backup.path, backupRoot, {
      confirmServerStopped: true,
    });
    expect(restored.recoveryPath).toBeTruthy();
    expect(verifyConsistentBackup(restored.recoveryPath as string).ok).toBe(true);
    const reopened = new GameStore(dataDirectory, fakeCards);
    expect(reopened.listCards().find((card) => card.id === fakeCards[0]?.id)?.title).toBe('BEFORE BACKUP');
    reopened.close();
  });
});
