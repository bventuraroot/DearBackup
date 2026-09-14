import { Router, Response } from 'express';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { db } from '../db/database';
import { requireAuth, AuthRequest } from './auth.routes';
import { VaultService } from '../services/vault.service';
import { NotifyService } from '../services/notify.service';
import { CloudService } from '../services/cloud.service';
import { ConfigBackupService } from '../services/config-backup.service';
import { SelfBackupService } from '../services/self-backup.service';

const router = Router();

/**
 * Obtener Llave Pública SSH del Sistema
 */
router.get('/ssh-key', requireAuth, (req: AuthRequest, res: Response) => {
  const keys = VaultService.getOrCreateSystemSSHKey();
  res.json({
    publicKey: keys.publicKey,
    instruction: 'Copia esta llave pública y agrégala al archivo ~/.ssh/authorized_keys en cada servidor cliente.'
  });
});

/**
 * Configuración SMTP
 */
router.get('/smtp', requireAuth, (req: AuthRequest, res: Response) => {
  const config = NotifyService.getSMTPConfig();
  if (!config) {
    return res.json({
      host: '',
      port: 587,
      encryptionType: 'tls',
      secure: false,
      user: '',
      pass: '',
      fromName: 'DearBackup Notifier',
      fromEmail: 'backups@tudominio.com',
      isEnabled: false
    });
  }

  res.json({
    ...config,
    encryptionType: config.encryptionType || (Number(config.port) === 465 ? 'ssl' : 'tls'),
    pass: config.pass ? '********' : ''
  });
});

router.post('/smtp', requireAuth, (req: AuthRequest, res: Response) => {
  const existing = NotifyService.getSMTPConfig();
  const { host, port, encryptionType, secure, user, pass, fromName, fromEmail, isEnabled } = req.body;

  let finalPass = existing?.pass || '';
  if (pass && pass !== '********') {
    finalPass = pass;
  }

  const portNum = Number(port) || 587;
  const encType = encryptionType || (portNum === 465 ? 'ssl' : 'tls');

  NotifyService.saveSMTPConfig({
    host,
    port: portNum,
    encryptionType: encType,
    secure: encType === 'ssl' || !!secure,
    user,
    pass: finalPass,
    fromName: fromName || 'DearBackup',
    fromEmail: fromEmail || user,
    isEnabled: !!isEnabled
  });

  res.json({ success: true, message: 'Configuración SMTP guardada con éxito.' });
});

router.post('/smtp/test', requireAuth, async (req: AuthRequest, res: Response) => {
  const existing = NotifyService.getSMTPConfig();
  const { host, port, encryptionType, secure, user, pass, fromName, fromEmail, testEmail } = req.body;

  let finalPass = existing?.pass || '';
  if (pass && pass !== '********') {
    finalPass = pass;
  }

  if (!host || !user || !finalPass || !testEmail) {
    return res.status(400).json({ error: 'Faltan datos requeridos para probar SMTP.' });
  }

  const portNum = Number(port) || 587;
  const encType = encryptionType || (portNum === 465 ? 'ssl' : 'tls');

  const result = await NotifyService.testSMTP({
    host,
    port: portNum,
    encryptionType: encType,
    secure: encType === 'ssl' || !!secure,
    user,
    pass: finalPass,
    fromName: fromName || 'DearBackup',
    fromEmail: fromEmail || user,
    isEnabled: true
  }, testEmail);

  res.json(result);
});

/**
 * Configuración Telegram
 */
router.get('/telegram', requireAuth, (req: AuthRequest, res: Response) => {
  const config = NotifyService.getTelegramConfig();
  if (!config) {
    return res.json({
      botToken: '',
      chatId: '',
      isEnabled: false
    });
  }

  res.json({
    ...config,
    botToken: config.botToken ? '********' : ''
  });
});

router.post('/telegram', requireAuth, (req: AuthRequest, res: Response) => {
  const existing = NotifyService.getTelegramConfig();
  const { botToken, chatId, isEnabled } = req.body;

  let finalToken = existing?.botToken || '';
  if (botToken && botToken !== '********') {
    finalToken = botToken;
  }

  NotifyService.saveTelegramConfig({
    botToken: finalToken,
    chatId: chatId ? chatId.trim() : '',
    isEnabled: !!isEnabled
  });

  res.json({ success: true, message: 'Configuración de Telegram guardada con éxito.' });
});

router.post('/telegram/test', requireAuth, async (req: AuthRequest, res: Response) => {
  const existing = NotifyService.getTelegramConfig();
  const { botToken, chatId } = req.body;

  let finalToken = existing?.botToken || '';
  if (botToken && botToken !== '********') {
    finalToken = botToken;
  }

  if (!finalToken || !chatId) {
    return res.status(400).json({ error: 'Token del bot y Chat ID son requeridos.' });
  }

  const result = await NotifyService.testTelegram({
    botToken: finalToken,
    chatId: chatId.trim(),
    isEnabled: true
  });

  res.json(result);
});

/**
 * Detección Automática del Chat ID de Telegram mediante getUpdates
 */
router.post('/telegram/detect-chat-id', requireAuth, async (req: AuthRequest, res: Response) => {
  const existing = NotifyService.getTelegramConfig();
  const { botToken } = req.body;

  let finalToken = existing?.botToken || '';
  if (botToken && botToken !== '********') {
    finalToken = botToken;
  }

  if (!finalToken) {
    return res.status(400).json({ error: 'Ingresa primero el Bot Token de @BotFather.' });
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${finalToken}/getUpdates`);
    const data = await response.json() as any;

    if (!data.ok) {
      return res.status(400).json({ error: `Error de Telegram: ${data.description}` });
    }

    if (!data.result || data.result.length === 0) {
      return res.status(404).json({
        error: 'No se encontraron mensajes recientes. Abre tu bot en Telegram, presiona "Iniciar" o envíale un mensaje ("hola") e inténtalo nuevamente.'
      });
    }

    // Tomar el último mensaje recibido
    const lastUpdate = data.result[data.result.length - 1];
    const message = lastUpdate.message || lastUpdate.channel_post || lastUpdate.my_chat_member;

    if (!message || !message.chat) {
      return res.status(404).json({ error: 'No se pudo extraer el Chat ID de los mensajes recibidos.' });
    }

    const chatId = message.chat.id.toString();
    const chatTitle = message.chat.title || `${message.chat.first_name || ''} ${message.chat.last_name || ''}`.trim() || message.chat.username || 'Chat Privado';
    const chatType = message.chat.type;

    res.json({
      success: true,
      chatId,
      chatTitle,
      chatType,
      message: `¡Chat ID detectado (${chatType}): ${chatId} - ${chatTitle}!`
    });
  } catch (err: any) {
    res.status(500).json({ error: `Error conectando con Telegram: ${err.message}` });
  }
});

/**
 * Configuración Cloud S3 / Cloudflare R2 / Backblaze B2
 */
router.get('/cloud', requireAuth, (req: AuthRequest, res: Response) => {
  const config = CloudService.getConfig();
  if (!config) {
    return res.json({
      provider: 'r2',
      endpoint: '',
      region: 'auto',
      bucket: '',
      accessKeyId: '',
      secretAccessKey: '',
      isEnabled: false,
      maxStorageGB: 10
    });
  }

  res.json({
    ...config,
    maxStorageGB: config.maxStorageGB !== undefined ? config.maxStorageGB : 10,
    secretAccessKey: config.secretAccessKey ? '********' : ''
  });
});

router.post('/cloud', requireAuth, (req: AuthRequest, res: Response) => {
  const existing = CloudService.getConfig();
  const { provider, endpoint, region, bucket, accessKeyId, secretAccessKey, isEnabled, maxStorageGB } = req.body;

  let finalSecret = existing?.secretAccessKey || '';
  if (secretAccessKey && secretAccessKey !== '********') {
    finalSecret = secretAccessKey;
  }

  CloudService.saveConfig({
    provider,
    endpoint,
    region: region || 'auto',
    bucket,
    accessKeyId,
    secretAccessKey: finalSecret,
    isEnabled: !!isEnabled,
    maxStorageGB: maxStorageGB !== undefined ? Number(maxStorageGB) : 10
  });

  res.json({ success: true, message: 'Configuración de Almacenamiento en la Nube guardada con éxito.' });
});

router.post('/cloud/test', requireAuth, async (req: AuthRequest, res: Response) => {
  const existing = CloudService.getConfig();
  const { provider, endpoint, region, bucket, accessKeyId, secretAccessKey } = req.body;

  let finalSecret = existing?.secretAccessKey || '';
  if (secretAccessKey && secretAccessKey !== '********') {
    finalSecret = secretAccessKey;
  }

  if (!bucket || !accessKeyId || !finalSecret) {
    return res.status(400).json({ error: 'Bucket, Access Key ID y Secret Access Key son requeridos.' });
  }

  const result = await CloudService.testConnection({
    provider,
    endpoint,
    region: region || 'auto',
    bucket,
    accessKeyId,
    secretAccessKey: finalSecret,
    isEnabled: true
  });

  res.json(result);
});

/**
 * Exportar Configuración Completa (.dearconfig)
 */
router.post('/export-config', requireAuth, (req: AuthRequest, res: Response) => {
  try {
    const { passphrase } = req.body;
    if (!passphrase || passphrase.length < 6) {
      return res.status(400).json({ error: 'La contraseña de protección debe tener al menos 6 caracteres.' });
    }

    const encryptedPackage = ConfigBackupService.exportConfig(passphrase);
    res.json({
      success: true,
      filename: `dearbackup-config-${new Date().toISOString().slice(0, 10)}.dearconfig`,
      package: encryptedPackage
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Importar Configuración Completa (.dearconfig)
 */
router.post('/import-config', requireAuth, (req: AuthRequest, res: Response) => {
  try {
    const { packageData, passphrase } = req.body;
    if (!packageData || !passphrase) {
      return res.status(400).json({ error: 'El archivo de configuración y la contraseña son requeridos.' });
    }

    const result = ConfigBackupService.importConfig(packageData, passphrase);
    res.json({
      success: true,
      message: `¡Configuración restaurada con éxito! Se importaron ${result.importedClients} clientes y ${result.importedSettings} configuraciones del sistema.`,
      result
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Descargar directamente la base de datos SQLite (.db) con checkpoint de WAL
 */
router.get('/download-database', requireAuth, (req: AuthRequest, res: Response) => {
  try {
    // Forzar checkpoint para vaciar cualquier cambio pendiente del archivo WAL a dearbackup.db
    db.pragma('wal_checkpoint(TRUNCATE)');
    const dbDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
    const dbPath = path.join(dbDir, 'dearbackup.db');
    if (!fs.existsSync(dbPath)) {
      return res.status(404).json({ error: 'El archivo de base de datos no existe.' });
    }
    const filename = `dearbackup-${new Date().toISOString().slice(0, 10)}.db`;
    res.download(dbPath, filename);
  } catch (err: any) {
    res.status(500).json({ error: `Error exportando base de datos: ${err.message}` });
  }
});

/**
 * Ejecutar Auto-Respaldo de Base de Datos y replicación Cloud de inmediato
 */
router.post('/auto-backup-now', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const result = await SelfBackupService.runSelfBackup();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: `Fallo en auto-respaldo: ${err.message}` });
  }
});

/**
 * Obtener estado del último auto-respaldo
 */
router.get('/self-backup-status', requireAuth, (req: AuthRequest, res: Response) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('last_self_backup_info') as { value: string } | undefined;
  if (!row) {
    return res.json({ configured: true, lastRun: null });
  }
  try {
    res.json({ configured: true, ...JSON.parse(row.value) });
  } catch {
    res.json({ configured: true, lastRun: null });
  }
});

/**
 * Restaurar archivo de base de datos SQLite (.db) subido desde la interfaz web
 */
router.post('/restore-database', requireAuth, (req: AuthRequest, res: Response) => {
  try {
    const { dbBase64 } = req.body;
    if (!dbBase64) {
      return res.status(400).json({ error: 'No se envió ningún archivo de base de datos.' });
    }

    const buffer = Buffer.from(dbBase64, 'base64');
    if (buffer.length < 100 || buffer.subarray(0, 15).toString() !== 'SQLite format 3') {
      return res.status(400).json({ error: 'El archivo subido no es una base de datos SQLite válida (cabecera no coincide).' });
    }

    const dbDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
    const dbPath = path.join(dbDir, 'dearbackup.db');
    const backupOldPath = path.join(dbDir, `dearbackup-backup-pre-restore-${Date.now()}.db`);

    // 1. Checkpoint actual
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}

    // 2. Backup de seguridad antes de sobreescribir
    if (fs.existsSync(dbPath)) {
      fs.copyFileSync(dbPath, backupOldPath);
    }

    // 3. Escribir temporalmente y validar tablas
    const tempRestore = path.join(dbDir, `restore-temp-${Date.now()}.db`);
    fs.writeFileSync(tempRestore, buffer);

    let clientCount = 0;
    let userCount = 0;
    try {
      const testDb = new Database(tempRestore, { readonly: true });
      userCount = (testDb.prepare('SELECT count(*) as count FROM users').get() as any)?.count ?? 0;
      clientCount = (testDb.prepare('SELECT count(*) as count FROM clients').get() as any)?.count ?? 0;
      testDb.close();
    } catch (testErr: any) {
      if (fs.existsSync(tempRestore)) fs.unlinkSync(tempRestore);
      return res.status(400).json({ error: `La base de datos está dañada o incompatible: ${testErr.message}` });
    }

    // 4. Limpiar WAL/SHM antiguos
    const walPath = path.join(dbDir, 'dearbackup.db-wal');
    const shmPath = path.join(dbDir, 'dearbackup.db-shm');
    if (fs.existsSync(walPath)) try { fs.unlinkSync(walPath); } catch (_) {}
    if (fs.existsSync(shmPath)) try { fs.unlinkSync(shmPath); } catch (_) {}

    // 5. Sobreescribir archivo principal
    fs.copyFileSync(tempRestore, dbPath);
    try { fs.unlinkSync(tempRestore); } catch (_) {}

    // 6. Refrescar WAL
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}

    res.json({
      success: true,
      message: `¡Base de datos restaurada con éxito! Se cargaron ${clientCount} clientes y ${userCount} usuarios registrados.`,
      clientCount,
      userCount
    });
  } catch (err: any) {
    res.status(500).json({ error: `Fallo al restaurar base de datos: ${err.message}` });
  }
});

export default router;
