import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createConsistentBackup, verifyConsistentBackup } from '../server/storage.js';

const dataDirectory = resolve(process.env.GAME_DATA_DIR ?? join(tmpdir(), 'house-fight-data'));
const backupRoot = resolve(process.env.GAME_BACKUP_DIR ?? `${dataDirectory}-backups`);
const result = await createConsistentBackup(dataDirectory, backupRoot);
const verification = verifyConsistentBackup(result.path);
if (!verification.ok) throw new Error(`New backup failed verification: ${verification.errors.join(' ')}`);

console.log(`Backup complete and verified: ${result.path}`);
