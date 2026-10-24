import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { latestBackupDirectory, restoreConsistentBackup } from '../server/storage.js';

const argumentsList = process.argv.slice(2);
if (!argumentsList.includes('--yes')) {
  throw new Error('Restore refused. Stop the game server, then rerun with --yes and an optional backup path.');
}

const dataDirectory = resolve(process.env.GAME_DATA_DIR ?? join(tmpdir(), 'house-fight-data'));
const backupRoot = resolve(process.env.GAME_BACKUP_DIR ?? `${dataDirectory}-backups`);
const requestedPath = argumentsList.find((argument) => !argument.startsWith('--'));
const backupPath = requestedPath ? resolve(requestedPath) : latestBackupDirectory(backupRoot);
if (!backupPath) throw new Error(`No completed backup found in ${backupRoot}`);

const result = await restoreConsistentBackup(dataDirectory, backupPath, backupRoot, {
  confirmServerStopped: true,
});
console.log(`Restore complete: ${result.restoredFrom}`);
if (result.recoveryPath) console.log(`Pre-restore recovery backup: ${result.recoveryPath}`);
