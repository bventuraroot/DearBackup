import { Router, Response } from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { db } from '../db/database';
import { requireAuth, AuthRequest } from './auth.routes';
import { CloudService } from '../services/cloud.service';

const router = Router();

router.get('/dashboard', requireAuth, (req: AuthRequest, res: Response) => {
  // 1. Conteo de clientes
  const totalClients = (db.prepare('SELECT COUNT(*) as count FROM clients').get() as any).count;
  const activeClients = (db.prepare('SELECT COUNT(*) as count FROM clients WHERE is_active = 1').get() as any).count;

  // 2. Conteo de backups
  const totalBackups = (db.prepare('SELECT COUNT(*) as count FROM backup_logs').get() as any).count;
  const successBackups = (db.prepare("SELECT COUNT(*) as count FROM backup_logs WHERE status = 'success'").get() as any).count;
  const failedBackups = (db.prepare("SELECT COUNT(*) as count FROM backup_logs WHERE status = 'failed'").get() as any).count;
  const runningBackups = (db.prepare("SELECT COUNT(*) as count FROM backup_logs WHERE status = 'running'").get() as any).count;

  // 3. Almacenamiento Local (Disco del Host y carpeta ./backups)
  const backupsDir = process.env.BACKUPS_DIR || path.join(process.cwd(), 'backups');
  let diskTotalBytes = 0;
  let diskFreeBytes = 0;
  let diskUsedBytes = 0;
  let diskUsagePercent = 0;

  try {
    if ((fs as any).statfsSync) {
      const stat = (fs as any).statfsSync(backupsDir);
      diskTotalBytes = stat.bsize * stat.blocks;
      diskFreeBytes = stat.bsize * stat.bavail;
      diskUsedBytes = diskTotalBytes - (stat.bsize * stat.bfree);
      diskUsagePercent = diskTotalBytes > 0 ? Math.round((diskUsedBytes / diskTotalBytes) * 100) : 0;
    }
  } catch (e) {
    console.error('Error calculando statfs:', e);
  }

  const localBackupsBytes = (db.prepare("SELECT SUM(file_size_bytes) as total FROM backup_logs WHERE status = 'success' AND file_path IS NOT NULL").get() as any).total || 0;

  // 4. Almacenamiento en la Nube (Cloudflare R2 / S3)
  const cloudConfig = CloudService.getConfig();
  const cloudEnabled = !!(cloudConfig && cloudConfig.isEnabled);
  const cloudMaxStorageGB = (cloudConfig && cloudConfig.maxStorageGB) || 10;
  const cloudMaxStorageBytes = cloudMaxStorageGB * 1024 * 1024 * 1024;
  const cloudUsedBytes = (db.prepare("SELECT SUM(file_size_bytes) as total FROM backup_logs WHERE status = 'success' AND is_replicated_cloud = 1").get() as any).total || 0;
  const cloudRemainingBytes = Math.max(0, cloudMaxStorageBytes - cloudUsedBytes);
  const cloudUsagePercent = cloudMaxStorageBytes > 0 ? Math.min(100, Math.round((cloudUsedBytes / cloudMaxStorageBytes) * 100)) : 0;

  // 5. Consumo de Memoria RAM y Recursos del Contenedor Docker / Sistema
  const memUsage = process.memoryUsage();
  const processRssMB = (memUsage.rss / (1024 * 1024)).toFixed(1);
  const processHeapUsedMB = (memUsage.heapUsed / (1024 * 1024)).toFixed(1);
  const systemTotalMemMB = (os.totalmem() / (1024 * 1024)).toFixed(0);
  const systemFreeMemMB = (os.freemem() / (1024 * 1024)).toFixed(0);
  const systemUsedMemMB = ((os.totalmem() - os.freemem()) / (1024 * 1024)).toFixed(0);
  const systemMemUsagePercent = Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100);
  const uptimeSeconds = Math.floor(process.uptime());

  // 6. Últimos 10 respaldos con nombres resueltos
  const recentLogs = db.prepare(`
    SELECT 
      b.id, b.client_id, COALESCE(c.name, b.client_name, 'Cliente') as client_name,
      b.status, b.start_time, b.duration_seconds, b.file_size_bytes, b.error_message, b.is_replicated_cloud
    FROM backup_logs b
    LEFT JOIN clients c ON b.client_id = c.id
    ORDER BY b.start_time DESC
    LIMIT 10
  `).all();

  // 7. Estadísticas de los últimos 7 días
  const sevenDaysStats = db.prepare(`
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
    system: {
      processRssMB: Number(processRssMB),
      processHeapUsedMB: Number(processHeapUsedMB),
      systemTotalMemMB: Number(systemTotalMemMB),
      systemFreeMemMB: Number(systemFreeMemMB),
      systemUsedMemMB: Number(systemUsedMemMB),
      systemMemUsagePercent,
      uptimeSeconds,
      nodeVersion: process.version,
      platform: `${os.platform()} (${os.arch()})`
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

/**
 * Forzar recolección de basura y liberación de memoria RAM en tiempo real
 */
router.post('/free-memory', requireAuth, (req: AuthRequest, res: Response) => {
  const beforeMem = process.memoryUsage().rss / (1024 * 1024);
  if ((global as any).gc) {
    try { (global as any).gc(); } catch {}
  }
  const afterMem = process.memoryUsage().rss / (1024 * 1024);
  const freedMB = Math.max(0, beforeMem - afterMem).toFixed(1);

  res.json({
    success: true,
    beforeMB: beforeMem.toFixed(1),
    afterMB: afterMem.toFixed(1),
    freedMB,
    message: `¡Memoria RAM liberada con éxito! Se recuperaron ${freedMB} MB (Consumo actual: ${afterMem.toFixed(1)} MB).`
  });
});

export default router;
