import fs from 'fs';
import { db } from '../db/database';
import { CloudService } from './cloud.service';

export class RetentionService {
  /**
   * Ejecuta la política de retención para un cliente específico
   */
  public static async applyRetentionForClient(clientId: string, retentionDays: number, retentionCount: number): Promise<void> {
    try {
      // 1. Obtener todos los backups exitosos ordenados de más reciente a más antiguo
      const logs = db.prepare(`
        SELECT id, file_path, cloud_path, start_time 
        FROM backup_logs 
        WHERE client_id = ? AND status = 'success' 
        ORDER BY start_time DESC
      `).all(clientId) as Array<{ id: string; file_path: string; cloud_path?: string; start_time: string }>;

      if (logs.length <= retentionCount) {
        return; // No sobrepasa el límite de copias permitidas
      }

      // Los que exceden el retentionCount
      const logsToPrune = logs.slice(retentionCount);

      // Fecha límite para retención por días
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

      for (const log of logsToPrune) {
        const logDate = new Date(log.start_time);
        
        // Purgar si excede el conteo o excede los días
        if (logDate < cutoffDate || logs.length > retentionCount) {
          // Borrar archivo local
          if (log.file_path && fs.existsSync(log.file_path)) {
            try {
              fs.unlinkSync(log.file_path);
            } catch (e) {
              console.error(`Error borrando archivo local ${log.file_path}:`, e);
            }
          }

          // Borrar archivo en la nube si existía
          if (log.cloud_path) {
            try {
              await CloudService.deleteFile(log.cloud_path);
            } catch (e) {
              console.error(`Error borrando archivo en nube ${log.cloud_path}:`, e);
            }
          }

          // Actualizar registro en BD
          db.prepare(`
            UPDATE backup_logs 
            SET file_path = NULL, cloud_path = NULL, status = 'purged', error_message = 'Eliminado por política de retención' 
            WHERE id = ?
          `).run(log.id);
        }
      }
    } catch (err) {
      console.error(`Error aplicando retención para cliente ${clientId}:`, err);
    }
  }
}
