"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_routes_1 = require("./auth.routes");
const vault_service_1 = require("../services/vault.service");
const notify_service_1 = require("../services/notify.service");
const cloud_service_1 = require("../services/cloud.service");
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
exports.default = router;
