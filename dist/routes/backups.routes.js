"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const child_process_1 = require("child_process");
const database_1 = require("../db/database");
const auth_routes_1 = require("./auth.routes");
const backup_service_1 = require("../services/backup.service");
const crypto_service_1 = require("../services/crypto.service");
const vault_service_1 = require("../services/vault.service");
const router = (0, express_1.Router)();
/**
 * Disparar respaldo de un cliente manualmente y retornar su backupId de inmediato
 */
router.post('/run/:clientId', auth_routes_1.requireAuth, async (req, res) => {
    const client = database_1.db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.clientId);
    if (!client) {
        return res.status(404).json({ error: 'Cliente no encontrado.' });
    }
    const backupId = crypto_1.default.randomUUID();
    // Ejecutar el proceso en background
    backup_service_1.BackupService.runBackup(client, `manual_by_${req.user?.username || 'admin'}`, backupId);
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
router.post('/run-all', auth_routes_1.requireAuth, async (req, res) => {
    const clients = database_1.db.prepare('SELECT * FROM clients WHERE is_active = 1').all();
    if (clients.length === 0) {
        return res.status(400).json({ error: 'No hay clientes activos para respaldar.' });
    }
    // Lanzar en secuencia
    (async () => {
        for (const client of clients) {
            await backup_service_1.BackupService.runBackup(client, `batch_all_by_${req.user?.username || 'admin'}`);
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
router.get('/logs', auth_routes_1.requireAuth, (req, res) => {
    const clientId = req.query.clientId;
    const status = req.query.status;
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
    const conditions = [];
    const params = [];
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
    const logs = database_1.db.prepare(query).all(...params);
    res.json(logs);
});
/**
 * Obtener detalle completo de un log (incluyendo terminal output y nombre de cliente)
 */
router.get('/logs/:id', auth_routes_1.requireAuth, (req, res) => {
    const log = database_1.db.prepare(`
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
router.get('/logs/:id/stream', auth_routes_1.requireAuth, (req, res) => {
    const backupId = req.params.id;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    // Enviar logs iniciales acumulados si ya existen
    const currentLog = database_1.db.prepare('SELECT log_output, status FROM backup_logs WHERE id = ?').get(backupId);
    if (currentLog && currentLog.log_output) {
        currentLog.log_output.split('\n').forEach((line) => {
            if (line)
                res.write(`data: ${JSON.stringify({ log: line })}\n\n`);
        });
    }
    // Suscribirse a nuevos eventos en vivo
    const unsubscribe = backup_service_1.BackupService.onLog(backupId, (logLine) => {
        res.write(`data: ${JSON.stringify({ log: logLine })}\n\n`);
    });
    req.on('close', () => {
        unsubscribe();
    });
});
/**
 * Inspeccionar y listar archivos internos de un respaldo en la web
 */
router.get('/inspect/:id', auth_routes_1.requireAuth, async (req, res) => {
    const log = database_1.db.prepare('SELECT * FROM backup_logs WHERE id = ?').get(req.params.id);
    if (!log) {
        return res.status(404).json({ error: 'Registro de respaldo no encontrado.' });
    }
    if (!log.file_path || !fs_1.default.existsSync(log.file_path)) {
        return res.status(404).json({ error: 'El archivo físico no está disponible en el servidor local.' });
    }
    const appSecret = vault_service_1.VaultService.getEncryptionSecret();
    const tempDecrypted = path_1.default.join(path_1.default.dirname(log.file_path), `.temp_inspect_${Date.now()}_tar.gz`);
    try {
        if (log.file_path.endsWith('.enc')) {
            await crypto_service_1.CryptoService.decryptFile(log.file_path, tempDecrypted, appSecret);
        }
        else {
            fs_1.default.copyFileSync(log.file_path, tempDecrypted);
        }
        (0, child_process_1.exec)(`tar -ztvf "${tempDecrypted}"`, (err, stdout, stderr) => {
            try {
                if (fs_1.default.existsSync(tempDecrypted))
                    fs_1.default.unlinkSync(tempDecrypted);
            }
            catch { }
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
    }
    catch (err) {
        try {
            if (fs_1.default.existsSync(tempDecrypted))
                fs_1.default.unlinkSync(tempDecrypted);
        }
        catch { }
        res.status(500).json({ error: `Error al inspeccionar respaldo: ${err.message}` });
    }
});
/**
 * Descarga directa autenticada (Panel Admin)
 * Si ?decrypt=true se descifra al vuelo antes de descargar
 */
router.get('/download/:id', auth_routes_1.requireAuth, async (req, res) => {
    const log = database_1.db.prepare('SELECT * FROM backup_logs WHERE id = ?').get(req.params.id);
    if (!log) {
        return res.status(404).json({ error: 'Registro de respaldo no encontrado.' });
    }
    if (!log.file_path || !fs_1.default.existsSync(log.file_path)) {
        return res.status(404).json({ error: 'El archivo físico no está disponible en el servidor local.' });
    }
    const decrypt = req.query.decrypt === 'true';
    if (decrypt && log.file_path.endsWith('.enc')) {
        // Descifrar a un archivo temporal y enviarlo con limpieza garantizada
        const cleanFileName = log.file_name.replace(/\.enc$/i, '');
        const tempDecrypted = path_1.default.join(path_1.default.dirname(log.file_path), `.temp_dec_${Date.now()}_${cleanFileName}`);
        const appSecret = vault_service_1.VaultService.getEncryptionSecret();
        try {
            await crypto_service_1.CryptoService.decryptFile(log.file_path, tempDecrypted, appSecret);
            res.download(tempDecrypted, cleanFileName, (err) => {
                // Limpieza segura después de 60 segundos para evitar cortar streams grandes
                setTimeout(() => {
                    try {
                        if (fs_1.default.existsSync(tempDecrypted))
                            fs_1.default.unlinkSync(tempDecrypted);
                    }
                    catch { }
                }, 60000);
            });
        }
        catch (e) {
            try {
                if (fs_1.default.existsSync(tempDecrypted))
                    fs_1.default.unlinkSync(tempDecrypted);
            }
            catch { }
            res.status(500).json({ error: `Error al descifrar archivo: ${e.message}` });
        }
    }
    else {
        // Descargar el archivo directamente (cifrado)
        res.download(log.file_path, log.file_name);
    }
});
/**
 * Generar un enlace temporal público para compartir
 */
router.post('/create-share-link', auth_routes_1.requireAuth, (req, res) => {
    const { backup_log_id, hours = 48, max_downloads = 5 } = req.body;
    const log = database_1.db.prepare('SELECT id FROM backup_logs WHERE id = ?').get(backup_log_id);
    if (!log) {
        return res.status(404).json({ error: 'Registro de respaldo no encontrado.' });
    }
    const token = crypto_1.default.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + Number(hours) * 3600 * 1000).toISOString();
    database_1.db.prepare(`
    INSERT INTO share_links (id, token, backup_log_id, expires_at, downloads_remaining)
    VALUES (?, ?, ?, ?, ?)
  `).run(crypto_1.default.randomUUID(), token, backup_log_id, expiresAt, Number(max_downloads));
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
router.get('/download-shared/:token', async (req, res) => {
    const token = req.params.token;
    const link = database_1.db.prepare('SELECT * FROM share_links WHERE token = ? AND is_active = 1').get(token);
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
    const log = database_1.db.prepare('SELECT * FROM backup_logs WHERE id = ?').get(link.backup_log_id);
    if (!log || !log.file_path || !fs_1.default.existsSync(log.file_path)) {
        return res.status(404).send('<h1>404 Archivo no encontrado</h1><p>El archivo de respaldo ya no se encuentra en el servidor.</p>');
    }
    // Descontar descarga
    database_1.db.prepare('UPDATE share_links SET downloads_remaining = downloads_remaining - 1 WHERE token = ?').run(token);
    // Descargar archivo
    res.download(log.file_path, log.file_name);
});
/**
 * Obtener estadísticas detalladas de almacenamiento local y en la nube
 */
router.get('/storage-info', auth_routes_1.requireAuth, (req, res) => {
    const backupsBaseDir = process.env.BACKUPS_DIR || path_1.default.join(process.cwd(), 'backups');
    let localBytes = 0;
    let cloudBackedBytes = 0;
    let tempBytes = 0;
    let totalLocalFiles = 0;
    const scanDir = (dir) => {
        if (!fs_1.default.existsSync(dir))
            return;
        const entries = fs_1.default.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const full = path_1.default.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name.startsWith('.temp_')) {
                    const getDirSize = (d) => {
                        let s = 0;
                        try {
                            fs_1.default.readdirSync(d).forEach(f => {
                                const fp = path_1.default.join(d, f);
                                try {
                                    const st = fs_1.default.statSync(fp);
                                    s += st.isDirectory() ? getDirSize(fp) : st.size;
                                }
                                catch { }
                            });
                        }
                        catch { }
                        return s;
                    };
                    tempBytes += getDirSize(full);
                }
                else {
                    scanDir(full);
                }
            }
            else if (entry.isFile()) {
                try {
                    const st = fs_1.default.statSync(full);
                    localBytes += st.size;
                    totalLocalFiles++;
                }
                catch { }
            }
        }
    };
    scanDir(backupsBaseDir);
    const cloudBackedLogs = database_1.db.prepare(`
    SELECT file_path, file_size_bytes FROM backup_logs
    WHERE is_replicated_cloud = 1 AND file_path IS NOT NULL AND status = 'success'
  `).all();
    for (const l of cloudBackedLogs) {
        if (l.file_path && fs_1.default.existsSync(l.file_path)) {
            try {
                cloudBackedBytes += fs_1.default.statSync(l.file_path).size;
            }
            catch { }
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
router.post('/purge-local', auth_routes_1.requireAuth, (req, res) => {
    const { mode = 'cloud_only' } = req.body;
    const backupsBaseDir = process.env.BACKUPS_DIR || path_1.default.join(process.cwd(), 'backups');
    let freedBytes = 0;
    let freedFiles = 0;
    // 1. Limpiar directorios temporales .temp_*
    const cleanTemp = (dir) => {
        if (!fs_1.default.existsSync(dir))
            return;
        const entries = fs_1.default.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path_1.default.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name.startsWith('.temp_')) {
                    try {
                        const getDirSize = (d) => {
                            let s = 0;
                            try {
                                fs_1.default.readdirSync(d).forEach(f => {
                                    const fp = path_1.default.join(d, f);
                                    try {
                                        const st = fs_1.default.statSync(fp);
                                        s += st.isDirectory() ? getDirSize(fp) : st.size;
                                    }
                                    catch { }
                                });
                            }
                            catch { }
                            return s;
                        };
                        freedBytes += getDirSize(fullPath);
                        fs_1.default.rmSync(fullPath, { recursive: true, force: true });
                        freedFiles++;
                    }
                    catch (e) { }
                }
                else {
                    cleanTemp(fullPath);
                }
            }
        }
    };
    cleanTemp(backupsBaseDir);
    // 2. Purgar copias locales según modo
    if (mode === 'cloud_only' || mode === 'all') {
        let logsToPurge = [];
        if (mode === 'cloud_only') {
            logsToPurge = database_1.db.prepare(`
        SELECT id, file_path, file_size_bytes FROM backup_logs
        WHERE is_replicated_cloud = 1 AND file_path IS NOT NULL AND status = 'success'
      `).all();
        }
        else if (mode === 'all') {
            logsToPurge = database_1.db.prepare(`
        SELECT id, file_path, file_size_bytes FROM backup_logs
        WHERE file_path IS NOT NULL AND status = 'success'
      `).all();
        }
        for (const log of logsToPurge) {
            if (log.file_path && fs_1.default.existsSync(log.file_path)) {
                try {
                    const stats = fs_1.default.statSync(log.file_path);
                    freedBytes += stats.size;
                    fs_1.default.unlinkSync(log.file_path);
                    freedFiles++;
                    // Actualizar el log: file_path pasa a NULL pero se preservan las métricas y el estado cloud
                    database_1.db.prepare('UPDATE backup_logs SET file_path = NULL WHERE id = ?').run(log.id);
                }
                catch (err) {
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
router.delete('/logs/:id', auth_routes_1.requireAuth, (req, res) => {
    const log = database_1.db.prepare('SELECT * FROM backup_logs WHERE id = ?').get(req.params.id);
    if (!log) {
        return res.status(404).json({ error: 'Registro no encontrado.' });
    }
    if (log.file_path && fs_1.default.existsSync(log.file_path)) {
        try {
            fs_1.default.unlinkSync(log.file_path);
        }
        catch (e) {
            console.error('Error borrando archivo:', e);
        }
    }
    database_1.db.prepare('DELETE FROM backup_logs WHERE id = ?').run(req.params.id);
    res.json({ success: true, message: 'Registro y archivo eliminados correctamente.' });
});
exports.default = router;
