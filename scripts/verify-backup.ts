import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { latestBackupDirectory, verifyConsistentBackup } from '../server/storage.js';

const dataDirectory = resolve(process.env.GAME_DATA_DIR ?? join(tmpdir(), 'house-fight-data'));
const backupRoot = resolve(process.env.GAME_BACKUP_DIR ?? `${dataDirectory}-backups`);
const requestedPath = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
const backupPath = requestedPath ? resolve(requestedPath) : latestBackupDirectory(backupRoot);
if (!backupPath) throw new Error(`No completed backup found in ${backupRoot}`);

const result = verifyConsistentBackup(backupPath);
if (!result.ok) throw new Error(`Backup verification failed: ${result.errors.join(' ')}`);
console.log(`Backup verified: ${backupPath}`);
console.log(`Schema version: ${result.manifest?.schemaVersion ?? 'unknown'}`);
