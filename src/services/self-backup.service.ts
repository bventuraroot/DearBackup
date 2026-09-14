import path from 'path';
import fs from 'fs';
import { db } from '../db/database';
import { CloudService } from './cloud.service';

export class SelfBackupService {
  /**
   * Directorio de almacenamiento de snapshots locales del sistema
   */
  public static getSystemBackupDir(): string {
    const baseBackupDir = process.env.BACKUPS_DIR || path.join(process.cwd(), 'backups');
    const systemDir = path.join(baseBackupDir, 'system_database');
    if (!fs.existsSync(systemDir)) {
      fs.mkdirSync(systemDir, { recursive: true });
    }
    return systemDir;
  }

  /**
   * Ejecuta un auto-respaldo y exportación limpia de la base de datos SQLite
   * Guarda una copia local y la replica a la nube si S3/R2 está activo
   */
  public static async runSelfBackup(): Promise<{
    success: boolean;
    localPath: string;
    fileSizeMB: string;
    replicatedCloud: boolean;
    cloudKey?: string;
    message: string;
  }> {
    try {
      // 1. Vaciar el WAL de SQLite hacia el archivo principal en disco
      db.pragma('wal_checkpoint(TRUNCATE)');

      const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
      const liveDbPath = path.join(dataDir, 'dearbackup.db');

      if (!fs.existsSync(liveDbPath)) {
        throw new Error('El archivo de base de datos no existe en: ' + liveDbPath);
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `dearbackup_db_${timestamp}.db`;
      const systemDir = this.getSystemBackupDir();
      const targetSnapshotPath = path.join(systemDir, filename);

      // 2. Copiar archivo SQLite limpio
      fs.copyFileSync(liveDbPath, targetSnapshotPath);
      const stats = fs.statSync(targetSnapshotPath);
      const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);

      console.log(`✓ Snapshot automático de base de datos creado: ${filename} (${fileSizeMB} MB)`);

      // 3. Replicar a Cloud Storage (R2 / S3 / B2) si está configurado
      let replicatedCloud = false;
      let cloudKey: string | undefined;
      const cloudConfig = CloudService.getConfig();

      if (cloudConfig && cloudConfig.isEnabled) {
        try {
          const remoteKey = `system_database/${filename}`;
          cloudKey = await CloudService.uploadFile(targetSnapshotPath, remoteKey);
          replicatedCloud = true;
          console.log(`☁️ Snapshot de base de datos replicado exitosamente en Cloud: ${remoteKey}`);
        } catch (cloudErr: any) {
          console.warn('Aviso: Falló la replicación del snapshot a Cloud:', cloudErr.message);
        }
      }

      // 4. Limpieza de retención: conservar los últimos 14 snapshots de la base de datos
      this.cleanOldSnapshots(systemDir, 14);

      // 5. Guardar registro en settings del último auto-respaldo
      const statusInfo = {
        lastRun: new Date().toISOString(),
        filename,
        fileSizeMB,
        replicatedCloud
      };
      db.prepare('INSERT OR REPLACE INTO settings (key, value, is_encrypted) VALUES (?, ?, 0)')
        .run('last_self_backup_info', JSON.stringify(statusInfo));

      return {
        success: true,
        localPath: targetSnapshotPath,
        fileSizeMB,
        replicatedCloud,
        cloudKey,
        message: `Auto-respaldo completado (${fileSizeMB} MB)${replicatedCloud ? ' y replicado a la Nube' : ''}.`
      };
    } catch (err: any) {
      console.error('Error en auto-respaldo de base de datos:', err);
      throw err;
    }
  }

  /**
   * Limpia snapshots antiguos locales para no saturar disco
   */
  private static cleanOldSnapshots(dir: string, keepCount: number = 14): void {
    try {
      const files = fs.readdirSync(dir)
        .filter(f => f.startsWith('dearbackup_db_') && f.endsWith('.db'))
        .map(f => ({
          name: f,
          fullPath: path.join(dir, f),
          time: fs.statSync(path.join(dir, f)).mtimeMs
        }))
        .sort((a, b) => b.time - a.time);

      if (files.length > keepCount) {
        const toDelete = files.slice(keepCount);
        for (const file of toDelete) {
          try {
            fs.unlinkSync(file.fullPath);
            console.log(`🧹 Purgado snapshot antiguo de base de datos: ${file.name}`);
          } catch {}
        }
      }
    } catch {}
  }
}
