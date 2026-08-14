import fs from 'fs';
import { db } from '../db/database';
import { CloudService } from './cloud.service';

export class RetentionService {
  /**
   * Ejecuta la política de retención por cliente (elimina copias viejas en local y en la nube)
   */
  public static async applyRetentionForClient(clientId: string, retentionDays: number, retentionCount: number): Promise<{ prunedLocal: number; prunedCloud: number }> {
    let prunedLocal = 0;
    let prunedCloud = 0;

    try {
      // 1. Obtener todos los backups exitosos ordenados del más reciente al más antiguo
      const logs = db.prepare(`
        SELECT id, client_id, file_name, file_path, cloud_path, is_replicated_cloud, start_time, file_size_bytes 
        FROM backup_logs 
        WHERE client_id = ? AND status = 'success' 
        ORDER BY start_time DESC
      `).all(clientId) as Array<{
        id: string;
        client_id: string;
        file_name: string;
        file_path: string | null;
        cloud_path: string | null;
        is_replicated_cloud: number;
        start_time: string;
        file_size_bytes: number;
      }>;

      if (logs.length <= retentionCount) {
        return { prunedLocal, prunedCloud };
      }

      // Los logs que sobrepasan la cantidad máxima de copias permitidas
      const logsToPrune = logs.slice(retentionCount);

      // Fecha límite para retención por días
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - (retentionDays || 30));

      for (const log of logsToPrune) {
        const logDate = new Date(log.start_time);
        const shouldPrune = logDate < cutoffDate || logs.length > retentionCount;

        if (shouldPrune) {
          // A. Eliminar archivo físico local si existe
          if (log.file_path && fs.existsSync(log.file_path)) {
            try {
              fs.unlinkSync(log.file_path);
              prunedLocal++;
            } catch (e: any) {
              console.error(`Error borrando archivo local ${log.file_path}:`, e.message);
            }
          }

          // B. Eliminar archivo en la nube (R2 / S3) si fue replicado
          const remoteKey = log.cloud_path || (log.file_name ? `${log.client_id}/${log.file_name}` : null);
          if ((log.is_replicated_cloud || log.cloud_path) && remoteKey) {
            try {
              await CloudService.deleteFile(remoteKey);
              prunedCloud++;
            } catch (e: any) {
              console.error(`Error borrando archivo en nube ${remoteKey}:`, e.message);
            }
          }

          // C. Actualizar registro en la base de datos
          db.prepare(`
            UPDATE backup_logs 
            SET file_path = NULL,
                cloud_path = NULL,
                is_replicated_cloud = 0,
                status = 'purged',
                error_message = 'Eliminado por política de retención automática'
            WHERE id = ?
          `).run(log.id);
        }
      }

      // 2. Aplicar cuota global de la nube si está configurada
      const cloudConfig = CloudService.getConfig();
      if (cloudConfig && cloudConfig.isEnabled && cloudConfig.maxStorageGB && cloudConfig.maxStorageGB > 0) {
        await this.applyGlobalCloudQuota(cloudConfig.maxStorageGB);
      }

    } catch (err: any) {
      console.error(`Error aplicando retención para cliente ${clientId}:`, err.message);
    }

    return { prunedLocal, prunedCloud };
  }

  /**
   * Aplica límite de cuota global en la nube (elimina los respaldos más viejos en Cloud si se excede el límite en GB)
   */
  public static async applyGlobalCloudQuota(maxStorageGB: number): Promise<number> {
    let deletedCount = 0;
    try {
      const maxBytes = maxStorageGB * 1024 * 1024 * 1024;
      
      const cloudLogs = db.prepare(`
        SELECT id, client_id, file_name, cloud_path, file_size_bytes, start_time
        FROM backup_logs
        WHERE is_replicated_cloud = 1 AND status = 'success'
        ORDER BY start_time ASC
      `).all() as Array<{
        id: string;
        client_id: string;
        file_name: string;
        cloud_path: string | null;
        file_size_bytes: number;
        start_time: string;
      }>;

      let currentTotalBytes = cloudLogs.reduce((acc, l) => acc + (Number(l.file_size_bytes) || 0), 0);

      if (currentTotalBytes <= maxBytes) {
        return deletedCount;
      }

      for (const log of cloudLogs) {
        if (currentTotalBytes <= maxBytes) break;

        const remoteKey = log.cloud_path || (log.file_name ? `${log.client_id}/${log.file_name}` : null);
        if (remoteKey) {
          try {
            await CloudService.deleteFile(remoteKey);
            deletedCount++;
          } catch (e: any) {
            console.error(`Error eliminando archivo por cuota cloud ${remoteKey}:`, e.message);
          }
        }

        currentTotalBytes -= (Number(log.file_size_bytes) || 0);

        db.prepare(`
          UPDATE backup_logs 
          SET cloud_path = NULL,
              is_replicated_cloud = 0
          WHERE id = ?
        `).run(log.id);
      }
    } catch (err: any) {
      console.error('Error aplicando cuota global de la nube:', err.message);
    }

    return deletedCount;
  }

  /**
   * Purga forzada bajo demanda de respaldos viejos en la nube que exceden la retención de cada cliente
   */
  public static async purgeAllClientsCloudRetentions(): Promise<{ totalCloudDeleted: number; freedMB: number }> {
    let totalCloudDeleted = 0;
    let freedBytes = 0;

    const clients = db.prepare('SELECT id, retention_days, retention_count FROM clients').all() as any[];

    for (const c of clients) {
      const res = await this.applyRetentionForClient(c.id, c.retention_days || 30, c.retention_count || 2);
      totalCloudDeleted += res.prunedCloud;
    }

    const cloudConfig = CloudService.getConfig();
    if (cloudConfig && cloudConfig.maxStorageGB && cloudConfig.maxStorageGB > 0) {
      const extraDeleted = await this.applyGlobalCloudQuota(cloudConfig.maxStorageGB);
      totalCloudDeleted += extraDeleted;
    }

    return {
      totalCloudDeleted,
      freedMB: Number((freedBytes / (1024 * 1024)).toFixed(2))
    };
  }
}
