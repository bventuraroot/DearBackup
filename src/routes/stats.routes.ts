import { Router, Response } from 'express';
import { db } from '../db/database';
import { requireAuth, AuthRequest } from './auth.routes';

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

  // 3. Espacio total usado en disco
  const totalSizeBytes = (db.prepare("SELECT SUM(file_size_bytes) as total FROM backup_logs WHERE status = 'success' AND file_path IS NOT NULL").get() as any).total || 0;

  // 4. Últimos 10 respaldos con nombres resueltos
  const recentLogs = db.prepare(`
    SELECT 
      b.id, b.client_id, COALESCE(c.name, b.client_name, 'Cliente') as client_name,
      b.status, b.start_time, b.duration_seconds, b.file_size_bytes, b.error_message, b.is_replicated_cloud
    FROM backup_logs b
    LEFT JOIN clients c ON b.client_id = c.id
    ORDER BY b.start_time DESC
    LIMIT 10
  `).all();

  // 5. Estadísticas de los últimos 7 días
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
    storage: {
      totalBytes: totalSizeBytes,
      totalMB: (totalSizeBytes / (1024 * 1024)).toFixed(2),
      totalGB: (totalSizeBytes / (1024 * 1024 * 1024)).toFixed(2)
    },
    recentLogs,
    sevenDaysStats
  });
});

export default router;
