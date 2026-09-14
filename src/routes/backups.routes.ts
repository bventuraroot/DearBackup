import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { exec } from 'child_process';
import { db } from '../db/database';
import { requireAuth, AuthRequest } from './auth.routes';
import { BackupService, ClientData } from '../services/backup.service';
import { CryptoService } from '../services/crypto.service';
import { CloudService } from '../services/cloud.service';
import { VaultService } from '../services/vault.service';
import { RetentionService } from '../services/retention.service';

const router = Router();

/**
 * Disparar respaldo de un cliente manualmente y retornar su backupId de inmediato
 */
router.post('/run/:clientId', requireAuth, async (req: AuthRequest, res: Response) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.clientId) as ClientData | undefined;
  if (!client) {
    return res.status(404).json({ error: 'Cliente no encontrado.' });
  }

  const backupId = crypto.randomUUID();

  // Ejecutar el proceso en background
  BackupService.runBackup(client, `manual_by_${req.user?.username || 'admin'}`, backupId);

  res.json({
    success: true,
    backupId,
    clientName: client.name,
    message: `Respaldo iniciado para "${client.name}". Sigue el progreso en tiempo real.`
  });
});

/**
 * Disparar respaldo masivo de todos los clientes activos
 */
router.post('/run-all', requireAuth, async (req: AuthRequest, res: Response) => {
  const clients = db.prepare('SELECT * FROM clients WHERE is_active = 1').all() as ClientData[];
  
  if (clients.length === 0) {
    return res.status(400).json({ error: 'No hay clientes activos para respaldar.' });
  }

  // Lanzar en secuencia
  (async () => {
    for (const client of clients) {
      await BackupService.runBackup(client, `batch_all_by_${req.user?.username || 'admin'}`);
    }
  })();

  res.json({
    success: true,
    message: `Se ha iniciado el respaldo en lote de ${clients.length} clientes.`
  });
});

/**
 * Listar historial de respaldos con nombres de clientes resueltos
 */
router.get('/logs', requireAuth, (req: AuthRequest, res: Response) => {
  const clientId = req.query.clientId as string | undefined;
  const status = req.query.status as string | undefined;
  const limit = Math.min(Number(req.query.limit) || 50, 200);

  let query = `
    SELECT 
      b.id, b.client_id, COALESCE(c.name, b.client_name, 'Cliente') as client_name,
      b.status, b.start_time, b.end_time, b.duration_seconds,
      b.file_name, b.file_size_bytes, b.checksum_sha256,
      b.is_encrypted, b.is_replicated_cloud, b.error_message, b.created_at
    FROM backup_logs b
    LEFT JOIN clients c ON b.client_id = c.id
  `;
  const conditions: string[] = [];
  const params: any[] = [];

  if (clientId) {
    conditions.push('b.client_id = ?');
    params.push(clientId);
  }
  if (status) {
    conditions.push('b.status = ?');
    params.push(status);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ' ORDER BY b.start_time DESC LIMIT ?';
  params.push(limit);

  const logs = db.prepare(query).all(...params);
  res.json(logs);
});

/**
 * Obtener detalle completo de un log (incluyendo terminal output y nombre de cliente)
 */
router.get('/logs/:id', requireAuth, (req: AuthRequest, res: Response) => {
  const log = db.prepare(`
    SELECT b.*, COALESCE(c.name, b.client_name, 'Cliente') as client_name
    FROM backup_logs b
    LEFT JOIN clients c ON b.client_id = c.id
    WHERE b.id = ?
  `).get(req.params.id);

  if (!log) {
    return res.status(404).json({ error: 'Registro de respaldo no encontrado.' });
  }
  res.json(log);
});

/**
 * Server-Sent Events (SSE) Stream de logs en tiempo real para respaldo
 */
router.get('/logs/:id/stream', requireAuth, (req: AuthRequest, res: Response) => {
  const backupId = req.params.id;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Enviar logs iniciales acumulados si ya existen
  const currentLog = db.prepare('SELECT log_output, status FROM backup_logs WHERE id = ?').get(backupId) as any;
  if (currentLog && currentLog.log_output) {
    currentLog.log_output.split('\n').forEach((line: string) => {
      if (line) res.write(`data: ${JSON.stringify({ log: line })}\n\n`);
    });
  }

  // Suscribirse a nuevos eventos en vivo
  const unsubscribe = BackupService.onLog(backupId, (logLine) => {
    res.write(`data: ${JSON.stringify({ log: logLine })}\n\n`);
  });

  req.on('close', () => {
    unsubscribe();
  });
});

/**
 * Inspeccionar y listar archivos internos de un respaldo en la web
 */
router.get('/inspect/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const log = db.prepare('SELECT * FROM backup_logs WHERE id = ?').get(req.params.id) as any;
  if (!log) {
    return res.status(404).json({ error: 'Registro de respaldo no encontrado.' });
  }

  if (!log.file_path || !fs.existsSync(log.file_path)) {
    return res.status(404).json({ error: 'El archivo físico no está disponible en el servidor local.' });
  }

  const appSecret = VaultService.getEncryptionSecret();
  const tempDecrypted = path.join(path.dirname(log.file_path), `.temp_inspect_${Date.now()}_tar.gz`);

  try {
    if (log.file_path.endsWith('.enc')) {
      await CryptoService.decryptFile(log.file_path, tempDecrypted, appSecret);
    } else {
      fs.copyFileSync(log.file_path, tempDecrypted);
    }

    exec(`tar -ztvf "${tempDecrypted}"`, (err, stdout, stderr) => {
      try { if (fs.existsSync(tempDecrypted)) fs.unlinkSync(tempDecrypted); } catch {}

      if (err) {
        return res.status(500).json({ error: `Error leyendo contenido del paquete: ${stderr || err.message}` });
      }

      const files = stdout.split('\n').filter(Boolean).map(line => {
        // Formato tar: -rw-r--r-- root/root 311820 2026-08-13 23:04 ./database.sql.gz
        const parts = line.trim().split(/\s+/);
        const permissions = parts[0];
        const sizeBytes = Number(parts[2]) || 0;
        const fileName = parts.slice(5).join(' ').replace(/^\.\//, '');
        return {
          fileName,
          sizeBytes,
          sizeFormatted: sizeBytes > 1024 * 1024 ? `${(sizeBytes / (1024 * 1024)).toFixed(2)} MB` : `${(sizeBytes / 1024).toFixed(1)} KB`,
          permissions
        };
      }).filter(f => f.fileName && f.fileName !== '.');

      res.json({
        success: true,
        backupFileName: log.file_name,
        fileSizeFormatted: (log.file_size_bytes / (1024 * 1024)).toFixed(2) + ' MB',
        files
      });
    });
  } catch (err: any) {
    try { if (fs.existsSync(tempDecrypted)) fs.unlinkSync(tempDecrypted); } catch {}
    res.status(500).json({ error: `Error al inspeccionar respaldo: ${err.message}` });
  }
});

/**
 * Descarga directa autenticada (Panel Admin)
 * Si ?decrypt=true se descifra al vuelo antes de descargar
 */
router.get('/download/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const log = db.prepare('SELECT * FROM backup_logs WHERE id = ?').get(req.params.id) as any;
  if (!log) {
    return res.status(404).json({ error: 'Registro de respaldo no encontrado.' });
  }

  if (!log.file_path || !fs.existsSync(log.file_path)) {
    return res.status(404).json({ error: 'El archivo físico no está disponible en el servidor local.' });
  }

  const decrypt = req.query.decrypt === 'true';

  if (decrypt && log.file_path.endsWith('.enc')) {
    // Descifrar a un archivo temporal y enviarlo con limpieza garantizada
    const cleanFileName = log.file_name.replace(/\.enc$/i, '');
    const tempDecrypted = path.join(path.dirname(log.file_path), `.temp_dec_${Date.now()}_${cleanFileName}`);
    const appSecret = VaultService.getEncryptionSecret();
    
    try {
      await CryptoService.decryptFile(log.file_path, tempDecrypted, appSecret);
      
      res.download(tempDecrypted, cleanFileName, (err) => {
        // Limpieza segura después de 60 segundos para evitar cortar streams grandes
        setTimeout(() => {
          try { if (fs.existsSync(tempDecrypted)) fs.unlinkSync(tempDecrypted); } catch {}
        }, 60000);
      });
    } catch (e: any) {
      try { if (fs.existsSync(tempDecrypted)) fs.unlinkSync(tempDecrypted); } catch {}
      res.status(500).json({ error: `Error al descifrar archivo: ${e.message}` });
    }
  } else {
    // Descargar el archivo directamente (cifrado)
    res.download(log.file_path, log.file_name);
  }
});

/**
 * Generar un enlace temporal público para compartir
 */
router.post('/create-share-link', requireAuth, (req: AuthRequest, res: Response) => {
  const { backup_log_id, hours = 48, max_downloads = 5 } = req.body;

  const log = db.prepare('SELECT id FROM backup_logs WHERE id = ?').get(backup_log_id);
  if (!log) {
    return res.status(404).json({ error: 'Registro de respaldo no encontrado.' });
  }

  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + Number(hours) * 3600 * 1000).toISOString();

  db.prepare(`
    INSERT INTO share_links (id, token, backup_log_id, expires_at, downloads_remaining)
    VALUES (?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), token, backup_log_id, expiresAt, Number(max_downloads));

  const baseUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  const downloadUrl = `${baseUrl}/api/backups/download-shared/${token}`;

  res.json({
    success: true,
    token,
    downloadUrl,
    expiresAt,
    maxDownloads: max_downloads
  });
});

/**
 * Descarga pública mediante enlace seguro temporal (Token)
 */
router.get('/download-shared/:token', async (req: Request, res: Response) => {
  const token = req.params.token;
  const link = db.prepare('SELECT * FROM share_links WHERE token = ? AND is_active = 1').get(token) as any;

  if (!link) {
    return res.status(404).send('<h1>404 Enlace no válido</h1><p>El enlace de descarga no existe o ha sido revocado.</p>');
  }

  const now = new Date();
  const expiresAt = new Date(link.expires_at);

  if (now > expiresAt) {
    return res.status(410).send('<h1>410 Enlace expirado</h1><p>Este enlace de descarga ha caducado por motivos de seguridad.</p>');
  }

  if (link.downloads_remaining <= 0) {
    return res.status(403).send('<h1>403 Límite alcanzado</h1><p>Se ha alcanzado el límite máximo de descargas para este enlace.</p>');
  }

  const log = db.prepare('SELECT * FROM backup_logs WHERE id = ?').get(link.backup_log_id) as any;
  if (!log || !log.file_path || !fs.existsSync(log.file_path)) {
    return res.status(404).send('<h1>404 Archivo no encontrado</h1><p>El archivo de respaldo ya no se encuentra en el servidor.</p>');
  }

  // Descontar descarga
  db.prepare('UPDATE share_links SET downloads_remaining = downloads_remaining - 1 WHERE token = ?').run(token);

  // Descargar archivo
  res.download(log.file_path, log.file_name);
});

/**
 * Obtener estadísticas detalladas de almacenamiento local y en la nube
 */
router.get('/storage-info', requireAuth, (req: AuthRequest, res: Response) => {
  const backupsBaseDir = process.env.BACKUPS_DIR || path.join(process.cwd(), 'backups');
  let localBytes = 0;
  let cloudBackedBytes = 0;
  let tempBytes = 0;
  let totalLocalFiles = 0;

  const scanDir = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.temp_')) {
          const getDirSize = (d: string): number => {
            let s = 0;
            try {
              fs.readdirSync(d).forEach(f => {
                const fp = path.join(d, f);
                try {
                  const st = fs.statSync(fp);
                  s += st.isDirectory() ? getDirSize(fp) : st.size;
                } catch {}
              });
            } catch {}
            return s;
          };
          tempBytes += getDirSize(full);
        } else {
          scanDir(full);
        }
      } else if (entry.isFile()) {
        try {
          const st = fs.statSync(full);
          localBytes += st.size;
          totalLocalFiles++;
        } catch {}
      }
    }
  };

  scanDir(backupsBaseDir);

  const cloudBackedLogs = db.prepare(`
    SELECT file_path, file_size_bytes FROM backup_logs
    WHERE is_replicated_cloud = 1 AND file_path IS NOT NULL AND status = 'success'
  `).all() as any[];

  for (const l of cloudBackedLogs) {
    if (l.file_path && fs.existsSync(l.file_path)) {
      try {
        cloudBackedBytes += fs.statSync(l.file_path).size;
      } catch {}
    }
  }

  res.json({
    localBytes,
    localMB: (localBytes / (1024 * 1024)).toFixed(2),
    cloudBackedBytes,
    cloudBackedMB: (cloudBackedBytes / (1024 * 1024)).toFixed(2),
    tempBytes,
    tempMB: (tempBytes / (1024 * 1024)).toFixed(2),
    totalLocalFiles
  });
});

/**
 * Liberar / Purgar espacio de almacenamiento local
 */
router.post('/purge-local', requireAuth, (req: AuthRequest, res: Response) => {
  const { mode = 'cloud_only' } = req.body;
  const backupsBaseDir = process.env.BACKUPS_DIR || path.join(process.cwd(), 'backups');
  let freedBytes = 0;
  let freedFiles = 0;

  // 1. Limpiar directorios temporales .temp_*
  const cleanTemp = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.temp_')) {
          try {
            const getDirSize = (d: string): number => {
              let s = 0;
              try {
                fs.readdirSync(d).forEach(f => {
                  const fp = path.join(d, f);
                  try {
                    const st = fs.statSync(fp);
                    s += st.isDirectory() ? getDirSize(fp) : st.size;
                  } catch {}
                });
              } catch {}
              return s;
            };
            freedBytes += getDirSize(fullPath);
            fs.rmSync(fullPath, { recursive: true, force: true });
            freedFiles++;
          } catch (e) {}
        } else {
          cleanTemp(fullPath);
        }
      }
    }
  };

  cleanTemp(backupsBaseDir);

  // 2. Purgar copias locales según modo
  if (mode === 'cloud_only' || mode === 'all') {
    let logsToPurge: any[] = [];
    if (mode === 'cloud_only') {
      logsToPurge = db.prepare(`
        SELECT id, file_path, file_size_bytes FROM backup_logs
        WHERE is_replicated_cloud = 1 AND file_path IS NOT NULL AND status = 'success'
      `).all() as any[];
    } else if (mode === 'all') {
      logsToPurge = db.prepare(`
        SELECT id, file_path, file_size_bytes FROM backup_logs
        WHERE file_path IS NOT NULL AND status = 'success'
      `).all() as any[];
    }

    for (const log of logsToPurge) {
      if (log.file_path && fs.existsSync(log.file_path)) {
        try {
          const stats = fs.statSync(log.file_path);
          freedBytes += stats.size;
          fs.unlinkSync(log.file_path);
          freedFiles++;

          // Actualizar el log: file_path pasa a NULL pero se preservan las métricas y el estado cloud
          db.prepare('UPDATE backup_logs SET file_path = NULL WHERE id = ?').run(log.id);
        } catch (err) {
          console.error(`Error purgando archivo local ${log.file_path}:`, err);
        }
      }
    }
  }

  const freedMB = (freedBytes / (1024 * 1024)).toFixed(2);
  const freedGB = (freedBytes / (1024 * 1024 * 1024)).toFixed(2);
  const displayFreed = Number(freedMB) > 1024 ? `${freedGB} GB` : `${freedMB} MB`;

  res.json({
    success: true,
    freedBytes,
    freedMB,
    freedFiles,
    message: `¡Espacio local liberado con éxito! Se recuperaron ${displayFreed} (${freedFiles} archivos/carpetas eliminados).`
  });
});

/**
 * Eliminar un log de respaldo y su archivo físico
 */
router.delete('/logs/:id', requireAuth, (req: AuthRequest, res: Response) => {
  const log = db.prepare('SELECT * FROM backup_logs WHERE id = ?').get(req.params.id) as any;
  if (!log) {
    return res.status(404).json({ error: 'Registro no encontrado.' });
  }

  if (log.file_path && fs.existsSync(log.file_path)) {
    try {
      fs.unlinkSync(log.file_path);
    } catch (e) {
      console.error('Error borrando archivo:', e);
    }
  }

  db.prepare('DELETE FROM backup_logs WHERE id = ?').run(req.params.id);
  res.json({ success: true, message: 'Registro y archivo eliminados correctamente.' });
});

/**
 * Vaciar / Limpiar todo el historial de respaldos y logs
 */
router.post('/clear-logs', requireAuth, (req: AuthRequest, res: Response) => {
  try {
    const totalDeleted = (db.prepare('SELECT COUNT(*) as count FROM backup_logs').get() as any)?.count || 0;
    
    try {
      db.prepare('DELETE FROM share_links').run();
    } catch (_) {}

    db.prepare('DELETE FROM backup_logs').run();

    res.json({
      success: true,
      deletedCount: totalDeleted,
      message: `¡Historial vaciado con éxito! Se eliminaron ${totalDeleted} registros. La vista está lista para registrar nuevas ejecuciones.`
    });
  } catch (err: any) {
    res.status(500).json({ error: `Error vaciando historial: ${err.message}` });
  }
});

router.delete('/logs', requireAuth, (req: AuthRequest, res: Response) => {
  try {
    const totalDeleted = (db.prepare('SELECT COUNT(*) as count FROM backup_logs').get() as any)?.count || 0;
    try {
      db.prepare('DELETE FROM share_links').run();
    } catch (_) {}

    db.prepare('DELETE FROM backup_logs').run();

    res.json({
      success: true,
      deletedCount: totalDeleted,
      message: `¡Historial vaciado con éxito! Se eliminaron ${totalDeleted} registros.`
    });
  } catch (err: any) {
    res.status(500).json({ error: `Error vaciando historial: ${err.message}` });
  }
});

/**
 * Forzar purga y aplicación estricta de retención de respaldos en la nube (R2 / S3)
 */
router.post('/purge-cloud', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const result = await RetentionService.purgeAllClientsCloudRetentions();
    res.json({
      success: true,
      totalCloudDeleted: result.totalCloudDeleted,
      message: `¡Limpieza en la nube completada! Se eliminaron ${result.totalCloudDeleted} copias antiguas que excedían el límite de retención.`
    });
  } catch (err: any) {
    res.status(500).json({ error: `Error durante la purga en la nube: ${err.message}` });
  }
});

export default router;
