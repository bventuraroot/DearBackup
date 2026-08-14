import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { db } from '../db/database';
import { VaultService } from '../services/vault.service';
import { PasskeyService } from '../services/passkey.service';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dearbackup-jwt-secret-key-32b';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    username: string;
    role: string;
  };
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const token = (authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : undefined) 
    || req.cookies?.token 
    || (req.query?.token as string);

  if (!token) {
    return res.status(401).json({ error: 'Acceso no autorizado. Inicie sesión.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Sesión expirada o token inválido.' });
  }
}

/**
 * Estado general de autenticación del sistema
 */
router.get('/status', (req: Request, res: Response) => {
  const userCount = (db.prepare('SELECT COUNT(*) as count FROM users').get() as any).count;
  const passkeyCount = (db.prepare('SELECT COUNT(*) as count FROM passkeys').get() as any).count;
  const isVaultConfigured = VaultService.isConfigured();
  const isVaultUnlocked = VaultService.isUnlocked();

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
router.post('/setup', async (req: Request, res: Response) => {
  const userCount = (db.prepare('SELECT COUNT(*) as count FROM users').get() as any).count;
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
    VaultService.initializeMasterKey(masterKeyPhrase);

    const userId = crypto.randomUUID();
    const passwordHash = await bcrypt.hash(password, 10);

    db.prepare(`
      INSERT INTO users (id, username, password_hash, role)
      VALUES (?, ?, ?, 'admin')
    `).run(userId, username.trim().toLowerCase(), passwordHash);

    VaultService.getOrCreateSystemSSHKey();

    const token = jwt.sign({ id: userId, username, role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      success: true,
      message: '¡Plataforma y Vault configurados correctamente!',
      token,
      user: { id: userId, username, role: 'admin' }
    });
  } catch (err: any) {
    res.status(500).json({ error: `Error en la configuración: ${err.message}` });
  }
});

/**
 * Iniciar Sesión (Paso 1: Usuario + Contraseña)
 */
router.post('/login', async (req: Request, res: Response) => {
  const { username, password, masterKeyPhrase } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Usuario y contraseña requeridos.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim().toLowerCase()) as any;
  if (!user) {
    return res.status(401).json({ error: 'Credenciales inválidas.' });
  }

  const passwordValid = await bcrypt.compare(password, user.password_hash);
  if (!passwordValid) {
    return res.status(401).json({ error: 'Credenciales inválidas.' });
  }

  if (user.two_factor_enabled && user.two_factor_secret) {
    const tempToken = jwt.sign({ id: user.id, is2FAPending: true }, JWT_SECRET, { expiresIn: '5m' });
    return res.json({
      require2FA: true,
      tempToken,
      message: 'Ingresa el código 2FA de tu aplicación autenticadora.'
    });
  }

  if (masterKeyPhrase) {
    const unlocked = VaultService.initializeMasterKey(masterKeyPhrase);
    if (!unlocked) {
      return res.status(400).json({ error: 'Frase de Llave Maestra incorrecta.' });
    }
  }

  const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });

  res.json({
    success: true,
    token,
    user: { id: user.id, username: user.username, role: user.role },
    vaultUnlocked: VaultService.isUnlocked()
  });
});

/**
 * Iniciar Sesión (Paso 2: Validación 2FA)
 */
router.post('/login-2fa', async (req: Request, res: Response) => {
  const { tempToken, code, masterKeyPhrase } = req.body;

  if (!tempToken || !code) {
    return res.status(400).json({ error: 'Código 2FA requerido.' });
  }

  try {
    const decoded = jwt.verify(tempToken, JWT_SECRET) as any;
    if (!decoded.is2FAPending || !decoded.id) {
      return res.status(401).json({ error: 'Token 2FA inválido o expirado.' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.id) as any;
    if (!user || !user.two_factor_secret) {
      return res.status(401).json({ error: 'Usuario no encontrado.' });
    }

    const isValid = PasskeyService.verify2FAToken(code, user.two_factor_secret);
    if (!isValid) {
      return res.status(401).json({ error: 'Código 2FA incorrecto o expirado.' });
    }

    if (masterKeyPhrase) {
      VaultService.initializeMasterKey(masterKeyPhrase);
    }

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      success: true,
      token,
      user: { id: user.id, username: user.username, role: user.role },
      vaultUnlocked: VaultService.isUnlocked()
    });
  } catch (err) {
    return res.status(401).json({ error: 'Sesión 2FA expirada. Inicie sesión nuevamente.' });
  }
});

// =========================================================================
// CAMBIO DE CONTRASEÑA Y CAMBIO DE FRASE SECRETA DEL VAULT
// =========================================================================

/**
 * Cambiar Contraseña del Administrador
 */
router.post('/change-password', requireAuth, async (req: AuthRequest, res: Response) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Todos los campos son requeridos.' });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user!.id) as any;
  const isValid = await bcrypt.compare(currentPassword, user.password_hash);
  if (!isValid) {
    return res.status(400).json({ error: 'La contraseña actual es incorrecta.' });
  }

  const newHash = await bcrypt.hash(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(newHash, req.user!.id);

  res.json({ success: true, message: '¡Contraseña actualizada correctamente!' });
});

/**
 * Cambiar Frase Secreta del Vault (Master Key) - Re-cifra todas las credenciales
 */
router.post('/change-vault-phrase', requireAuth, async (req: AuthRequest, res: Response) => {
  const { adminPassword, currentPhrase, newPhrase } = req.body;

  if (!adminPassword || !currentPhrase || !newPhrase) {
    return res.status(400).json({ error: 'Contraseña, frase actual y nueva frase son requeridas.' });
  }

  if (newPhrase.length < 8) {
    return res.status(400).json({ error: 'La nueva Frase Secreta debe tener al menos 8 caracteres.' });
  }

  // 1. Validar contraseña del administrador
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user!.id) as any;
  const isValid = await bcrypt.compare(adminPassword, user.password_hash);
  if (!isValid) {
    return res.status(400).json({ error: 'Contraseña de administrador incorrecta.' });
  }

  // 2. Ejecutar rotación y re-cifrado atómico del Vault
  const ok = VaultService.rotateMasterKey(currentPhrase, newPhrase);
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

router.post('/passkey/register-options', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const hostname = req.hostname;
    const protocol = req.protocol;
    const options = await PasskeyService.generatePasskeyRegistrationOptions(
      req.user!.id,
      req.user!.username,
      hostname,
      protocol
    );
    res.json(options);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/passkey/register-verify', requireAuth, async (req: AuthRequest, res: Response) => {
  const { response, deviceName } = req.body;
  try {
    const hostname = req.hostname;
    const protocol = req.protocol;
    const result = await PasskeyService.verifyPasskeyRegistration(
      req.user!.id,
      response,
      deviceName,
      hostname,
      protocol
    );

    if (result.verified) {
      res.json({ success: true, message: '¡Passkey registrada exitosamente!' });
    } else {
      res.status(400).json({ error: result.error || 'No se pudo verificar la Passkey.' });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/passkey/auth-options', async (req: Request, res: Response) => {
  try {
    const hostname = req.hostname;
    const protocol = req.protocol;
    const options = await PasskeyService.generatePasskeyAuthOptions(hostname, protocol);
    res.json(options);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/passkey/auth-verify', async (req: Request, res: Response) => {
  const { response, masterKeyPhrase } = req.body;
  try {
    const hostname = req.hostname;
    const protocol = req.protocol;
    const result = await PasskeyService.verifyPasskeyAuth(response, hostname, protocol);

    if (result.verified && result.user) {
      if (masterKeyPhrase) {
        VaultService.initializeMasterKey(masterKeyPhrase);
      }

      const token = jwt.sign(
        { id: result.user.id, username: result.user.username, role: result.user.role },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

      res.json({
        success: true,
        token,
        user: { id: result.user.id, username: result.user.username, role: result.user.role },
        vaultUnlocked: VaultService.isUnlocked(),
        message: '¡Inicio de sesión biométrico exitoso!'
      });
    } else {
      res.status(401).json({ error: result.error || 'Autenticación con Passkey fallida.' });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/passkey/list', requireAuth, (req: AuthRequest, res: Response) => {
  const passkeys = db.prepare(`
    SELECT id, name, device_type, created_at, last_used_at 
    FROM passkeys 
    WHERE user_id = ? 
    ORDER BY created_at DESC
  `).all(req.user!.id);
  res.json(passkeys);
});

router.delete('/passkey/:id', requireAuth, (req: AuthRequest, res: Response) => {
  db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').run(req.params.id, req.user!.id);
  res.json({ success: true, message: 'Passkey eliminada correctamente.' });
});

// =========================================================================
// ENDPOINTS DE 2FA (TOTP / GOOGLE AUTHENTICATOR)
// =========================================================================

router.post('/2fa/setup', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const result = await PasskeyService.generate2FASecret(req.user!.username);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/2fa/enable', requireAuth, (req: AuthRequest, res: Response) => {
  const { secret, code } = req.body;
  if (!secret || !code) {
    return res.status(400).json({ error: 'Secreto y código de 6 dígitos requeridos.' });
  }

  const isValid = PasskeyService.verify2FAToken(code, secret);
  if (!isValid) {
    return res.status(400).json({ error: 'Código de verificación incorrecto. Inténtalo de nuevo.' });
  }

  db.prepare('UPDATE users SET two_factor_secret = ?, two_factor_enabled = 1 WHERE id = ?')
    .run(secret, req.user!.id);

  res.json({ success: true, message: '¡Autenticación de Dos Factores (2FA) activada con éxito!' });
});

router.post('/2fa/disable', requireAuth, async (req: AuthRequest, res: Response) => {
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: 'Ingresa tu contraseña para desactivar 2FA.' });
  }

  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user!.id) as any;
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return res.status(400).json({ error: 'Contraseña incorrecta.' });
  }

  db.prepare('UPDATE users SET two_factor_secret = NULL, two_factor_enabled = 0 WHERE id = ?')
    .run(req.user!.id);

  res.json({ success: true, message: '2FA desactivado correctamente.' });
});

router.get('/me', requireAuth, (req: AuthRequest, res: Response) => {
  const user = db.prepare('SELECT id, username, role, two_factor_enabled FROM users WHERE id = ?').get(req.user!.id) as any;
  const passkeyCount = (db.prepare('SELECT COUNT(*) as count FROM passkeys WHERE user_id = ?').get(req.user!.id) as any).count;

  res.json({
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      twoFactorEnabled: !!user.two_factor_enabled,
      passkeysCount: passkeyCount
    },
    vaultUnlocked: VaultService.isUnlocked()
  });
});

export default router;
