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
     * Ejecuta la política de retención por cliente (elimina copias viejas en local y en la nube)
     */
    static async applyRetentionForClient(clientId, retentionDays, retentionCount) {
        let prunedLocal = 0;
        let prunedCloud = 0;
        const maxCopies = Number(retentionCount) > 0 ? Number(retentionCount) : 2;
        try {
            // 1. Obtener todos los backups exitosos ordenados del más reciente al más antiguo
            const logs = database_1.db.prepare(`
        SELECT id, client_id, file_name, file_path, cloud_path, is_replicated_cloud, start_time, file_size_bytes 
        FROM backup_logs 
        WHERE client_id = ? AND status = 'success' 
        ORDER BY start_time DESC
      `).all(clientId);
            // Si hay más copias en BD que el límite
            if (logs.length > maxCopies) {
                const logsToPrune = logs.slice(maxCopies);
                for (const log of logsToPrune) {
                    // A. Eliminar archivo local
                    if (log.file_path && fs_1.default.existsSync(log.file_path)) {
                        try {
                            fs_1.default.unlinkSync(log.file_path);
                            prunedLocal++;
                        }
                        catch (e) {
                            console.error(`Error borrando archivo local ${log.file_path}:`, e.message);
                        }
                    }
                    // B. Eliminar archivo en la nube
                    const remoteKey = log.cloud_path || (log.file_name ? `${log.client_id}/${log.file_name}` : null);
                    if (remoteKey) {
                        try {
                            await cloud_service_1.CloudService.deleteFile(remoteKey);
                            prunedCloud++;
                        }
                        catch (e) {
                            console.error(`Error borrando archivo en nube ${remoteKey}:`, e.message);
                        }
                    }
                    // C. Actualizar registro en BD
                    database_1.db.prepare(`
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
            // 2. Escanear directamente el Bucket Cloud para ese cliente para asegurar que no haya archivos huérfanos
            const cloudObjects = await cloud_service_1.CloudService.listObjects(`${clientId}/`);
            if (cloudObjects.length > maxCopies) {
                // Ordenar del más nuevo al más viejo
                cloudObjects.sort((a, b) => {
                    const dateA = a.lastModified ? a.lastModified.getTime() : 0;
                    const dateB = b.lastModified ? b.lastModified.getTime() : 0;
                    return dateB - dateA;
                });
                const extraCloudObjects = cloudObjects.slice(maxCopies);
                for (const obj of extraCloudObjects) {
                    try {
                        await cloud_service_1.CloudService.deleteFile(obj.key);
                        prunedCloud++;
                    }
                    catch (e) {
                        console.error(`Error purgando objeto huérfano en cloud ${obj.key}:`, e.message);
                    }
                }
            }
        }
        catch (err) {
            console.error(`Error aplicando retención para cliente ${clientId}:`, err.message);
        }
        return { prunedLocal, prunedCloud };
    }
    /**
     * Aplica límite de cuota global en la nube (elimina los respaldos más viejos en Cloud si se excede el límite en GB)
     */
    static async applyGlobalCloudQuota(maxStorageGB) {
        let deletedCount = 0;
        try {
            const maxBytes = maxStorageGB * 1024 * 1024 * 1024;
            const allCloudObjects = await cloud_service_1.CloudService.listObjects();
            let currentTotalBytes = allCloudObjects.reduce((acc, o) => acc + o.size, 0);
            if (currentTotalBytes <= maxBytes) {
                return deletedCount;
            }
            // Ordenar del más viejo al más nuevo para borrar los más antiguos primero
            allCloudObjects.sort((a, b) => {
                const dateA = a.lastModified ? a.lastModified.getTime() : 0;
                const dateB = b.lastModified ? b.lastModified.getTime() : 0;
                return dateA - dateB;
            });
            for (const obj of allCloudObjects) {
                if (currentTotalBytes <= maxBytes)
                    break;
                try {
                    await cloud_service_1.CloudService.deleteFile(obj.key);
                    deletedCount++;
                    currentTotalBytes -= obj.size;
                    database_1.db.prepare(`
            UPDATE backup_logs 
            SET cloud_path = NULL,
                is_replicated_cloud = 0
            WHERE cloud_path = ? OR file_name = ?
          `).run(obj.key, obj.key.split('/')[1] || obj.key);
                }
                catch (e) {
                    console.error(`Error eliminando archivo por cuota cloud ${obj.key}:`, e.message);
                }
            }
        }
        catch (err) {
            console.error('Error aplicando cuota global de la nube:', err.message);
        }
        return deletedCount;
    }
    /**
     * Purga forzada bajo demanda de respaldos viejos en la nube que exceden la retención de cada cliente
     */
    static async purgeAllClientsCloudRetentions() {
        let totalCloudDeleted = 0;
        let freedBytes = 0;
        // 1. Purgar por cada cliente registrado en la BD
        const clients = database_1.db.prepare('SELECT id, retention_days, retention_count FROM clients').all();
        for (const c of clients) {
            const limit = Number(c.retention_count) > 0 ? Number(c.retention_count) : 2;
            const res = await this.applyRetentionForClient(c.id, c.retention_days || 30, limit);
            totalCloudDeleted += res.prunedCloud;
        }
        // 2. Escanear todo el bucket para limpiar clientes eliminados o archivos fuera de retención
        const allCloudObjects = await cloud_service_1.CloudService.listObjects();
        const clientMap = new Map();
        for (const c of clients) {
            clientMap.set(c.id, Number(c.retention_count) > 0 ? Number(c.retention_count) : 2);
        }
        // Agrupar por prefijo (carpeta del cliente)
        const grouped = new Map();
        for (const obj of allCloudObjects) {
            const parts = obj.key.split('/');
            const clientId = parts[0];
            if (!grouped.has(clientId))
                grouped.set(clientId, []);
            grouped.get(clientId).push(obj);
        }
        for (const [clientId, objects] of grouped.entries()) {
            const allowedCount = clientMap.get(clientId) || 2; // Si no existe el cliente, retener máx 2
            if (objects.length > allowedCount) {
                objects.sort((a, b) => (b.lastModified?.getTime() || 0) - (a.lastModified?.getTime() || 0));
                const toDelete = objects.slice(allowedCount);
                for (const obj of toDelete) {
                    try {
                        await cloud_service_1.CloudService.deleteFile(obj.key);
                        totalCloudDeleted++;
                        freedBytes += obj.size;
                    }
                    catch { }
                }
            }
        }
        // 3. Aplicar cuota global de la nube si está configurada
        const cloudConfig = cloud_service_1.CloudService.getConfig();
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
exports.RetentionService = RetentionService;
