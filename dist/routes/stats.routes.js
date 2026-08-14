"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const database_1 = require("../db/database");
const auth_routes_1 = require("./auth.routes");
const cloud_service_1 = require("../services/cloud.service");
const router = (0, express_1.Router)();
router.get('/dashboard', auth_routes_1.requireAuth, (req, res) => {
    // 1. Conteo de clientes
    const totalClients = database_1.db.prepare('SELECT COUNT(*) as count FROM clients').get().count;
    const activeClients = database_1.db.prepare('SELECT COUNT(*) as count FROM clients WHERE is_active = 1').get().count;
    // 2. Conteo de backups
    const totalBackups = database_1.db.prepare('SELECT COUNT(*) as count FROM backup_logs').get().count;
    const successBackups = database_1.db.prepare("SELECT COUNT(*) as count FROM backup_logs WHERE status = 'success'").get().count;
    const failedBackups = database_1.db.prepare("SELECT COUNT(*) as count FROM backup_logs WHERE status = 'failed'").get().count;
    const runningBackups = database_1.db.prepare("SELECT COUNT(*) as count FROM backup_logs WHERE status = 'running'").get().count;
    // 3. Almacenamiento Local (Disco del Host y carpeta ./backups)
    const backupsDir = process.env.BACKUPS_DIR || path_1.default.join(process.cwd(), 'backups');
    let diskTotalBytes = 0;
    let diskFreeBytes = 0;
    let diskUsedBytes = 0;
    let diskUsagePercent = 0;
    try {
        if (fs_1.default.statfsSync) {
            const stat = fs_1.default.statfsSync(backupsDir);
            diskTotalBytes = stat.bsize * stat.blocks;
            diskFreeBytes = stat.bsize * stat.bavail;
            diskUsedBytes = diskTotalBytes - (stat.bsize * stat.bfree);
            diskUsagePercent = diskTotalBytes > 0 ? Math.round((diskUsedBytes / diskTotalBytes) * 100) : 0;
        }
    }
    catch (e) {
        console.error('Error calculando statfs:', e);
    }
    const localBackupsBytes = database_1.db.prepare("SELECT SUM(file_size_bytes) as total FROM backup_logs WHERE status = 'success' AND file_path IS NOT NULL").get().total || 0;
    // 4. Almacenamiento en la Nube (Cloudflare R2 / S3)
    const cloudConfig = cloud_service_1.CloudService.getConfig();
    const cloudEnabled = !!(cloudConfig && cloudConfig.isEnabled);
    const cloudMaxStorageGB = (cloudConfig && cloudConfig.maxStorageGB) || 10;
    const cloudMaxStorageBytes = cloudMaxStorageGB * 1024 * 1024 * 1024;
    const cloudUsedBytes = database_1.db.prepare("SELECT SUM(file_size_bytes) as total FROM backup_logs WHERE status = 'success' AND is_replicated_cloud = 1").get().total || 0;
    const cloudRemainingBytes = Math.max(0, cloudMaxStorageBytes - cloudUsedBytes);
    const cloudUsagePercent = cloudMaxStorageBytes > 0 ? Math.min(100, Math.round((cloudUsedBytes / cloudMaxStorageBytes) * 100)) : 0;
    // 5. Últimos 10 respaldos con nombres resueltos
    const recentLogs = database_1.db.prepare(`
    SELECT 
      b.id, b.client_id, COALESCE(c.name, b.client_name, 'Cliente') as client_name,
      b.status, b.start_time, b.duration_seconds, b.file_size_bytes, b.error_message, b.is_replicated_cloud
    FROM backup_logs b
    LEFT JOIN clients c ON b.client_id = c.id
    ORDER BY b.start_time DESC
    LIMIT 10
  `).all();
    // 6. Estadísticas de los últimos 7 días
    const sevenDaysStats = database_1.db.prepare(`
    SELECT 
      strftime('%Y-%m-%d', start_time) as date,
      COUNT(CASE WHEN status = 'success' THEN 1 END) as success_count,
      COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_count
    FROM backup_logs
    WHERE start_time >= datetime('now', '-7 days')
    GROUP BY strftime('%Y-%m-%d', start_time)
    ORDER BY date ASC
  `).all();
    const successRate = totalBackups > 0 ? Math.round((successBackups / totalBackups) * 100) : 100;
    res.json({
        clients: {
            total: totalClients,
            active: activeClients
        },
        backups: {
            total: totalBackups,
            success: successBackups,
            failed: failedBackups,
            running: runningBackups,
            successRate
        },
        storage: {
            totalBytes: localBackupsBytes,
            totalMB: (localBackupsBytes / (1024 * 1024)).toFixed(2),
            totalGB: (localBackupsBytes / (1024 * 1024 * 1024)).toFixed(2),
            local: {
                backupsBytes: localBackupsBytes,
                backupsMB: (localBackupsBytes / (1024 * 1024)).toFixed(2),
                backupsGB: (localBackupsBytes / (1024 * 1024 * 1024)).toFixed(2),
                diskTotalBytes,
                diskTotalGB: (diskTotalBytes / (1024 * 1024 * 1024)).toFixed(2),
                diskFreeBytes,
                diskFreeGB: (diskFreeBytes / (1024 * 1024 * 1024)).toFixed(2),
                diskUsedBytes,
                diskUsedGB: (diskUsedBytes / (1024 * 1024 * 1024)).toFixed(2),
                diskUsagePercent
            },
            cloud: {
                enabled: cloudEnabled,
                provider: cloudConfig?.provider || 'r2',
                usedBytes: cloudUsedBytes,
                usedMB: (cloudUsedBytes / (1024 * 1024)).toFixed(2),
                usedGB: (cloudUsedBytes / (1024 * 1024 * 1024)).toFixed(2),
                maxStorageGB: cloudMaxStorageGB,
                maxStorageBytes: cloudMaxStorageBytes,
                remainingBytes: cloudRemainingBytes,
                remainingGB: (cloudRemainingBytes / (1024 * 1024 * 1024)).toFixed(2),
                usagePercent: cloudUsagePercent
            }
        },
        recentLogs,
        sevenDaysStats
    });
});
exports.default = router;
