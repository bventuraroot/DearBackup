"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RetentionService = void 0;
const fs_1 = __importDefault(require("fs"));
const database_1 = require("../db/database");
const cloud_service_1 = require("./cloud.service");
class RetentionService {
    /**
     * Ejecuta la política de retención para un cliente específico
     */
    static async applyRetentionForClient(clientId, retentionDays, retentionCount) {
        try {
            // 1. Obtener todos los backups exitosos ordenados de más reciente a más antiguo
            const logs = database_1.db.prepare(`
        SELECT id, file_path, cloud_path, start_time 
        FROM backup_logs 
        WHERE client_id = ? AND status = 'success' 
        ORDER BY start_time DESC
      `).all(clientId);
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
                    if (log.file_path && fs_1.default.existsSync(log.file_path)) {
                        try {
                            fs_1.default.unlinkSync(log.file_path);
                        }
                        catch (e) {
                            console.error(`Error borrando archivo local ${log.file_path}:`, e);
                        }
                    }
                    // Borrar archivo en la nube si existía
                    if (log.cloud_path) {
                        try {
                            await cloud_service_1.CloudService.deleteFile(log.cloud_path);
                        }
                        catch (e) {
                            console.error(`Error borrando archivo en nube ${log.cloud_path}:`, e);
                        }
                    }
                    // Actualizar registro en BD
                    database_1.db.prepare(`
            UPDATE backup_logs 
            SET file_path = NULL, cloud_path = NULL, status = 'purged', error_message = 'Eliminado por política de retención' 
            WHERE id = ?
          `).run(log.id);
                }
            }
        }
        catch (err) {
            console.error(`Error aplicando retención para cliente ${clientId}:`, err);
        }
    }
}
exports.RetentionService = RetentionService;
