"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const database_1 = require("../db/database");
const auth_routes_1 = require("./auth.routes");
const vault_service_1 = require("../services/vault.service");
const notify_service_1 = require("../services/notify.service");
const cloud_service_1 = require("../services/cloud.service");
const config_backup_service_1 = require("../services/config-backup.service");
const self_backup_service_1 = require("../services/self-backup.service");
const router = (0, express_1.Router)();
/**
 * Obtener Llave Pública SSH del Sistema
 */
router.get('/ssh-key', auth_routes_1.requireAuth, (req, res) => {
    const keys = vault_service_1.VaultService.getOrCreateSystemSSHKey();
    res.json({
        publicKey: keys.publicKey,
        instruction: 'Copia esta llave pública y agrégala al archivo ~/.ssh/authorized_keys en cada servidor cliente.'
    });
});
/**
 * Configuración SMTP
 */
router.get('/smtp', auth_routes_1.requireAuth, (req, res) => {
    const config = notify_service_1.NotifyService.getSMTPConfig();
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
router.post('/smtp', auth_routes_1.requireAuth, (req, res) => {
    const existing = notify_service_1.NotifyService.getSMTPConfig();
    const { host, port, encryptionType, secure, user, pass, fromName, fromEmail, isEnabled } = req.body;
    let finalPass = existing?.pass || '';
    if (pass && pass !== '********') {
        finalPass = pass;
    }
    const portNum = Number(port) || 587;
    const encType = encryptionType || (portNum === 465 ? 'ssl' : 'tls');
    notify_service_1.NotifyService.saveSMTPConfig({
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
router.post('/smtp/test', auth_routes_1.requireAuth, async (req, res) => {
    const existing = notify_service_1.NotifyService.getSMTPConfig();
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
    const result = await notify_service_1.NotifyService.testSMTP({
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
router.get('/telegram', auth_routes_1.requireAuth, (req, res) => {
    const config = notify_service_1.NotifyService.getTelegramConfig();
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
router.post('/telegram', auth_routes_1.requireAuth, (req, res) => {
    const existing = notify_service_1.NotifyService.getTelegramConfig();
    const { botToken, chatId, isEnabled } = req.body;
    let finalToken = existing?.botToken || '';
    if (botToken && botToken !== '********') {
        finalToken = botToken;
    }
    notify_service_1.NotifyService.saveTelegramConfig({
        botToken: finalToken,
        chatId: chatId ? chatId.trim() : '',
        isEnabled: !!isEnabled
    });
    res.json({ success: true, message: 'Configuración de Telegram guardada con éxito.' });
});
router.post('/telegram/test', auth_routes_1.requireAuth, async (req, res) => {
    const existing = notify_service_1.NotifyService.getTelegramConfig();
    const { botToken, chatId } = req.body;
    let finalToken = existing?.botToken || '';
    if (botToken && botToken !== '********') {
        finalToken = botToken;
    }
    if (!finalToken || !chatId) {
        return res.status(400).json({ error: 'Token del bot y Chat ID son requeridos.' });
    }
    const result = await notify_service_1.NotifyService.testTelegram({
        botToken: finalToken,
        chatId: chatId.trim(),
        isEnabled: true
    });
    res.json(result);
});
/**
 * Detección Automática del Chat ID de Telegram mediante getUpdates
 */
router.post('/telegram/detect-chat-id', auth_routes_1.requireAuth, async (req, res) => {
    const existing = notify_service_1.NotifyService.getTelegramConfig();
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
        const data = await response.json();
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
    }
    catch (err) {
        res.status(500).json({ error: `Error conectando con Telegram: ${err.message}` });
    }
});
/**
 * Configuración Cloud S3 / Cloudflare R2 / Backblaze B2
 */
router.get('/cloud', auth_routes_1.requireAuth, (req, res) => {
    const config = cloud_service_1.CloudService.getConfig();
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
router.post('/cloud', auth_routes_1.requireAuth, (req, res) => {
    const existing = cloud_service_1.CloudService.getConfig();
    const { provider, endpoint, region, bucket, accessKeyId, secretAccessKey, isEnabled, maxStorageGB } = req.body;
    let finalSecret = existing?.secretAccessKey || '';
    if (secretAccessKey && secretAccessKey !== '********') {
        finalSecret = secretAccessKey;
    }
    cloud_service_1.CloudService.saveConfig({
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
router.post('/cloud/test', auth_routes_1.requireAuth, async (req, res) => {
    const existing = cloud_service_1.CloudService.getConfig();
    const { provider, endpoint, region, bucket, accessKeyId, secretAccessKey } = req.body;
    let finalSecret = existing?.secretAccessKey || '';
    if (secretAccessKey && secretAccessKey !== '********') {
        finalSecret = secretAccessKey;
    }
    if (!bucket || !accessKeyId || !finalSecret) {
        return res.status(400).json({ error: 'Bucket, Access Key ID y Secret Access Key son requeridos.' });
    }
    const result = await cloud_service_1.CloudService.testConnection({
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
router.post('/export-config', auth_routes_1.requireAuth, (req, res) => {
    try {
        const { passphrase } = req.body;
        if (!passphrase || passphrase.length < 6) {
            return res.status(400).json({ error: 'La contraseña de protección debe tener al menos 6 caracteres.' });
        }
        const encryptedPackage = config_backup_service_1.ConfigBackupService.exportConfig(passphrase);
        res.json({
            success: true,
            filename: `dearbackup-config-${new Date().toISOString().slice(0, 10)}.dearconfig`,
            package: encryptedPackage
        });
    }
    catch (err) {
        res.status(400).json({ error: err.message });
    }
});
/**
 * Importar Configuración Completa (.dearconfig)
 */
router.post('/import-config', auth_routes_1.requireAuth, (req, res) => {
    try {
        const { packageData, passphrase } = req.body;
        if (!packageData || !passphrase) {
            return res.status(400).json({ error: 'El archivo de configuración y la contraseña son requeridos.' });
        }
        const preserveUsernames = req.user?.username ? [req.user.username] : [];
        const result = config_backup_service_1.ConfigBackupService.importConfig(packageData, passphrase, { preserveUsernames });
        const components = [];
        if (result.importedClients > 0)
            components.push(`${result.importedClients} clientes`);
        if (result.hasSmtp)
            components.push('Correo SMTP');
        if (result.hasCloud)
            components.push('Cloud S3/R2');
        if (result.hasTelegram)
            components.push('Telegram');
        if (result.hasSshKey)
            components.push('Llaves SSH');
        if (result.importedUsers > 0)
            components.push(`${result.importedUsers} usuarios`);
        const detailsStr = components.length > 0 ? components.join(', ') : `${result.importedSettings} ajustes`;
        res.json({
            success: true,
            message: `¡Copia de configuración restaurada con éxito! Se sincronizaron: ${detailsStr}.`,
            result
        });
    }
    catch (err) {
        res.status(400).json({ error: err.message });
    }
});
/**
 * Descargar directamente la base de datos SQLite (.db) con checkpoint de WAL
 */
router.get('/download-database', auth_routes_1.requireAuth, (req, res) => {
    try {
        // Forzar checkpoint para vaciar cualquier cambio pendiente del archivo WAL a dearbackup.db
        database_1.db.pragma('wal_checkpoint(TRUNCATE)');
        const dbDir = process.env.DATA_DIR || path_1.default.join(process.cwd(), 'data');
        const dbPath = path_1.default.join(dbDir, 'dearbackup.db');
        if (!fs_1.default.existsSync(dbPath)) {
            return res.status(404).json({ error: 'El archivo de base de datos no existe.' });
        }
        const filename = `dearbackup-${new Date().toISOString().slice(0, 10)}.db`;
        res.download(dbPath, filename);
    }
    catch (err) {
        res.status(500).json({ error: `Error exportando base de datos: ${err.message}` });
    }
});
/**
 * Ejecutar Auto-Respaldo de Base de Datos y replicación Cloud de inmediato
 */
router.post('/auto-backup-now', auth_routes_1.requireAuth, async (req, res) => {
    try {
        const result = await self_backup_service_1.SelfBackupService.runSelfBackup();
        res.json(result);
    }
    catch (err) {
        res.status(500).json({ error: `Fallo en auto-respaldo: ${err.message}` });
    }
});
/**
 * Obtener estado del último auto-respaldo
 */
router.get('/self-backup-status', auth_routes_1.requireAuth, (req, res) => {
    const row = database_1.db.prepare('SELECT value FROM settings WHERE key = ?').get('last_self_backup_info');
    if (!row) {
        return res.json({ configured: true, lastRun: null });
    }
    try {
        res.json({ configured: true, ...JSON.parse(row.value) });
    }
    catch {
        res.json({ configured: true, lastRun: null });
    }
});
/**
 * Restaurar archivo de base de datos SQLite (.db o .tar.gz) subido desde la interfaz web
 */
router.post('/restore-database', auth_routes_1.requireAuth, async (req, res) => {
    try {
        const { dbBase64, newAdminPassword, vaultPassphrase } = req.body;
        if (!dbBase64) {
            return res.status(400).json({ error: 'No se envió ningún archivo de base de datos.' });
        }
        const buffer = Buffer.from(dbBase64, 'base64');
        const result = (0, database_1.replaceDatabaseFile)(buffer);
        // 1. Manejo de Vault
        let vaultUnlocked = false;
        if (vaultPassphrase) {
            vaultUnlocked = vault_service_1.VaultService.initializeMasterKey(vaultPassphrase, true);
        }
        else {
            vaultUnlocked = vault_service_1.VaultService.tryAutoUnlock();
        }
        // 2. Si se solicitó nueva contraseña para el administrador
        let passwordUpdated = false;
        let targetUsername = '';
        if (result.users.length > 0) {
            const adminUser = result.users.find(u => u.role === 'admin') || result.users[0];
            targetUsername = adminUser.username;
            if (newAdminPassword && newAdminPassword.length >= 8) {
                const newHash = await bcryptjs_1.default.hash(newAdminPassword, 10);
                database_1.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, adminUser.id);
                passwordUpdated = true;
            }
        }
        res.json({
            success: true,
            message: `¡Base de datos restaurada con éxito! Se cargaron ${result.clientCount} clientes y ${result.userCount} usuarios.`,
            clientCount: result.clientCount,
            userCount: result.userCount,
            users: result.users.map(u => ({ username: u.username, role: u.role })),
            targetUsername,
            passwordUpdated,
            vaultUnlocked
        });
    }
    catch (err) {
        res.status(500).json({ error: `Fallo al restaurar base de datos: ${err.message}` });
    }
});
exports.default = router;
