"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAuth = requireAuth;
const express_1 = require("express");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const crypto_1 = __importDefault(require("crypto"));
const database_1 = require("../db/database");
const vault_service_1 = require("../services/vault.service");
const passkey_service_1 = require("../services/passkey.service");
const router = (0, express_1.Router)();
const JWT_SECRET = process.env.JWT_SECRET || 'dearbackup-jwt-secret-key-32b';
function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    const token = (authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : undefined)
        || req.cookies?.token
        || req.query?.token;
    if (!token) {
        return res.status(401).json({ error: 'Acceso no autorizado. Inicie sesión.' });
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    }
    catch (err) {
        return res.status(401).json({ error: 'Sesión expirada o token inválido.' });
    }
}
/**
 * Estado general de autenticación del sistema
 */
router.get('/status', (req, res) => {
    const userCount = database_1.db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    const passkeyCount = database_1.db.prepare('SELECT COUNT(*) as count FROM passkeys').get().count;
    const isVaultConfigured = vault_service_1.VaultService.isConfigured();
    const isVaultUnlocked = vault_service_1.VaultService.isUnlocked();
    res.json({
        initialized: userCount > 0,
        vaultConfigured: isVaultConfigured,
        vaultUnlocked: isVaultUnlocked,
        hasPasskeys: passkeyCount > 0
    });
});
/**
 * Setup Wizard inicial
 */
router.post('/setup', async (req, res) => {
    const userCount = database_1.db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    if (userCount > 0) {
        return res.status(400).json({ error: 'El sistema ya ha sido inicializado previamente.' });
    }
    const { username, password, masterKeyPhrase } = req.body;
    if (!username || !password || !masterKeyPhrase) {
        return res.status(400).json({ error: 'Todos los campos son obligatorios.' });
    }
    if (password.length < 8) {
        return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' });
    }
    try {
        vault_service_1.VaultService.initializeMasterKey(masterKeyPhrase);
        const userId = crypto_1.default.randomUUID();
        const passwordHash = await bcryptjs_1.default.hash(password, 10);
        database_1.db.prepare(`
      INSERT INTO users (id, username, password_hash, role)
      VALUES (?, ?, ?, 'admin')
    `).run(userId, username.trim().toLowerCase(), passwordHash);
        vault_service_1.VaultService.getOrCreateSystemSSHKey();
        const token = jsonwebtoken_1.default.sign({ id: userId, username, role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
        res.json({
            success: true,
            message: '¡Plataforma y Vault configurados correctamente!',
            token,
            user: { id: userId, username, role: 'admin' }
        });
    }
    catch (err) {
        res.status(500).json({ error: `Error en la configuración: ${err.message}` });
    }
});
/**
 * Iniciar Sesión (Paso 1: Usuario + Contraseña)
 */
router.post('/login', async (req, res) => {
    const { username, password, masterKeyPhrase } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Usuario y contraseña requeridos.' });
    }
    const user = database_1.db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim().toLowerCase());
    if (!user) {
        return res.status(401).json({ error: 'Credenciales inválidas.' });
    }
    const passwordValid = await bcryptjs_1.default.compare(password, user.password_hash);
    if (!passwordValid) {
        return res.status(401).json({ error: 'Credenciales inválidas.' });
    }
    if (user.two_factor_enabled && user.two_factor_secret) {
        const tempToken = jsonwebtoken_1.default.sign({ id: user.id, is2FAPending: true }, JWT_SECRET, { expiresIn: '5m' });
        return res.json({
            require2FA: true,
            tempToken,
            message: 'Ingresa el código 2FA de tu aplicación autenticadora.'
        });
    }
    if (masterKeyPhrase) {
        const unlocked = vault_service_1.VaultService.initializeMasterKey(masterKeyPhrase);
        if (!unlocked) {
            return res.status(400).json({ error: 'Frase de Llave Maestra incorrecta.' });
        }
    }
    const token = jsonwebtoken_1.default.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
        success: true,
        token,
        user: { id: user.id, username: user.username, role: user.role },
        vaultUnlocked: vault_service_1.VaultService.isUnlocked()
    });
});
/**
 * Iniciar Sesión (Paso 2: Validación 2FA)
 */
router.post('/login-2fa', async (req, res) => {
    const { tempToken, code, masterKeyPhrase } = req.body;
    if (!tempToken || !code) {
        return res.status(400).json({ error: 'Código 2FA requerido.' });
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(tempToken, JWT_SECRET);
        if (!decoded.is2FAPending || !decoded.id) {
            return res.status(401).json({ error: 'Token 2FA inválido o expirado.' });
        }
        const user = database_1.db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.id);
        if (!user || !user.two_factor_secret) {
            return res.status(401).json({ error: 'Usuario no encontrado.' });
        }
        const isValid = passkey_service_1.PasskeyService.verify2FAToken(code, user.two_factor_secret);
        if (!isValid) {
            return res.status(401).json({ error: 'Código 2FA incorrecto o expirado.' });
        }
        if (masterKeyPhrase) {
            vault_service_1.VaultService.initializeMasterKey(masterKeyPhrase);
        }
        const token = jsonwebtoken_1.default.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
        res.json({
            success: true,
            token,
            user: { id: user.id, username: user.username, role: user.role },
            vaultUnlocked: vault_service_1.VaultService.isUnlocked()
        });
    }
    catch (err) {
        return res.status(401).json({ error: 'Sesión 2FA expirada. Inicie sesión nuevamente.' });
    }
});
// =========================================================================
// CAMBIO DE CONTRASEÑA Y CAMBIO DE FRASE SECRETA DEL VAULT
// =========================================================================
/**
 * Cambiar Contraseña del Administrador
 */
router.post('/change-password', requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: 'Todos los campos son requeridos.' });
    }
    if (newPassword.length < 8) {
        return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres.' });
    }
    const user = database_1.db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const isValid = await bcryptjs_1.default.compare(currentPassword, user.password_hash);
    if (!isValid) {
        return res.status(400).json({ error: 'La contraseña actual es incorrecta.' });
    }
    const newHash = await bcryptjs_1.default.hash(newPassword, 10);
    database_1.db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(newHash, req.user.id);
    res.json({ success: true, message: '¡Contraseña actualizada correctamente!' });
});
/**
 * Cambiar Frase Secreta del Vault (Master Key) - Re-cifra todas las credenciales
 */
router.post('/change-vault-phrase', requireAuth, async (req, res) => {
    const { adminPassword, currentPhrase, newPhrase } = req.body;
    if (!adminPassword || !currentPhrase || !newPhrase) {
        return res.status(400).json({ error: 'Contraseña, frase actual y nueva frase son requeridas.' });
    }
    if (newPhrase.length < 8) {
        return res.status(400).json({ error: 'La nueva Frase Secreta debe tener al menos 8 caracteres.' });
    }
    // 1. Validar contraseña del administrador
    const user = database_1.db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const isValid = await bcryptjs_1.default.compare(adminPassword, user.password_hash);
    if (!isValid) {
        return res.status(400).json({ error: 'Contraseña de administrador incorrecta.' });
    }
    // 2. Ejecutar rotación y re-cifrado atómico del Vault
    const ok = vault_service_1.VaultService.rotateMasterKey(currentPhrase, newPhrase);
    if (!ok) {
        return res.status(400).json({ error: 'La Frase Secreta actual es incorrecta o no coincide.' });
    }
    res.json({
        success: true,
        message: '¡Frase Secreta del Vault cambiada con éxito y todas las credenciales han sido re-cifradas!'
    });
});
// =========================================================================
// ENDPOINTS DE PASSKEYS (WEBAUTHN / BIOMETRÍA)
// =========================================================================
router.post('/passkey/register-options', requireAuth, async (req, res) => {
    try {
        const hostname = req.hostname;
        const protocol = req.protocol;
        const options = await passkey_service_1.PasskeyService.generatePasskeyRegistrationOptions(req.user.id, req.user.username, hostname, protocol);
        res.json(options);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
router.post('/passkey/register-verify', requireAuth, async (req, res) => {
    const { response, deviceName } = req.body;
    try {
        const hostname = req.hostname;
        const protocol = req.protocol;
        const result = await passkey_service_1.PasskeyService.verifyPasskeyRegistration(req.user.id, response, deviceName, hostname, protocol);
        if (result.verified) {
            res.json({ success: true, message: '¡Passkey registrada exitosamente!' });
        }
        else {
            res.status(400).json({ error: result.error || 'No se pudo verificar la Passkey.' });
        }
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
router.post('/passkey/auth-options', async (req, res) => {
    try {
        const hostname = req.hostname;
        const protocol = req.protocol;
        const options = await passkey_service_1.PasskeyService.generatePasskeyAuthOptions(hostname, protocol);
        res.json(options);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
router.post('/passkey/auth-verify', async (req, res) => {
    const { response, masterKeyPhrase } = req.body;
    try {
        const hostname = req.hostname;
        const protocol = req.protocol;
        const result = await passkey_service_1.PasskeyService.verifyPasskeyAuth(response, hostname, protocol);
        if (result.verified && result.user) {
            if (masterKeyPhrase) {
                vault_service_1.VaultService.initializeMasterKey(masterKeyPhrase);
            }
            const token = jsonwebtoken_1.default.sign({ id: result.user.id, username: result.user.username, role: result.user.role }, JWT_SECRET, { expiresIn: '7d' });
            res.json({
                success: true,
                token,
                user: { id: result.user.id, username: result.user.username, role: result.user.role },
                vaultUnlocked: vault_service_1.VaultService.isUnlocked(),
                message: '¡Inicio de sesión biométrico exitoso!'
            });
        }
        else {
            res.status(401).json({ error: result.error || 'Autenticación con Passkey fallida.' });
        }
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
router.get('/passkey/list', requireAuth, (req, res) => {
    const passkeys = database_1.db.prepare(`
    SELECT id, name, device_type, created_at, last_used_at 
    FROM passkeys 
    WHERE user_id = ? 
    ORDER BY created_at DESC
  `).all(req.user.id);
    res.json(passkeys);
});
router.delete('/passkey/:id', requireAuth, (req, res) => {
    database_1.db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
    res.json({ success: true, message: 'Passkey eliminada correctamente.' });
});
// =========================================================================
// ENDPOINTS DE 2FA (TOTP / GOOGLE AUTHENTICATOR)
// =========================================================================
router.post('/2fa/setup', requireAuth, async (req, res) => {
    try {
        const result = await passkey_service_1.PasskeyService.generate2FASecret(req.user.username);
        res.json(result);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
router.post('/2fa/enable', requireAuth, (req, res) => {
    const { secret, code } = req.body;
    if (!secret || !code) {
        return res.status(400).json({ error: 'Secreto y código de 6 dígitos requeridos.' });
    }
    const isValid = passkey_service_1.PasskeyService.verify2FAToken(code, secret);
    if (!isValid) {
        return res.status(400).json({ error: 'Código de verificación incorrecto. Inténtalo de nuevo.' });
    }
    database_1.db.prepare('UPDATE users SET two_factor_secret = ?, two_factor_enabled = 1 WHERE id = ?')
        .run(secret, req.user.id);
    res.json({ success: true, message: '¡Autenticación de Dos Factores (2FA) activada con éxito!' });
});
router.post('/2fa/disable', requireAuth, async (req, res) => {
    const { password } = req.body;
    if (!password) {
        return res.status(400).json({ error: 'Ingresa tu contraseña para desactivar 2FA.' });
    }
    const user = database_1.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    const valid = await bcryptjs_1.default.compare(password, user.password_hash);
    if (!valid) {
        return res.status(400).json({ error: 'Contraseña incorrecta.' });
    }
    database_1.db.prepare('UPDATE users SET two_factor_secret = NULL, two_factor_enabled = 0 WHERE id = ?')
        .run(req.user.id);
    res.json({ success: true, message: '2FA desactivado correctamente.' });
});
router.get('/me', requireAuth, (req, res) => {
    const user = database_1.db.prepare('SELECT id, username, role, two_factor_enabled FROM users WHERE id = ?').get(req.user.id);
    const passkeyCount = database_1.db.prepare('SELECT COUNT(*) as count FROM passkeys WHERE user_id = ?').get(req.user.id).count;
    res.json({
        user: {
            id: user.id,
            username: user.username,
            role: user.role,
            twoFactorEnabled: !!user.two_factor_enabled,
            passkeysCount: passkeyCount
        },
        vaultUnlocked: vault_service_1.VaultService.isUnlocked()
    });
});
exports.default = router;
