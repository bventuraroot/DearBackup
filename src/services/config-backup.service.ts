import crypto from 'crypto';
import { db } from '../db/database';
import { VaultService } from './vault.service';

const PBKDF2_ITERATIONS = 100000;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const ALGORITHM = 'aes-256-gcm';
const MAGIC_HEADER = 'DEARBACKUP_CONFIG_PACKAGE';

export interface ExportedClient {
  id: string;
  name: string;
  tags?: string | null;
  ssh_host: string;
  ssh_port: number;
  ssh_user: string;
  ssh_auth_type: string;
  ssh_password?: string | null;
  ssh_private_key?: string | null;
  ssh_passphrase?: string | null;
  db_type: string;
  db_connection_mode: string;
  db_docker_container?: string | null;
  db_host: string;
  db_port: number;
  db_name?: string | null;
  db_user?: string | null;
  db_pass?: string | null;
  dtes_path?: string | null;
  cron_schedule: string;
  retention_days: number;
  retention_count: number;
  is_active: number;
  notify_email?: string | null;
  notify_telegram: number;
  created_at?: string;
  updated_at?: string;
}

export interface ExportedSetting {
  key: string;
  value: string;
  is_encrypted: number;
}

export interface ExportedUser {
  id: string;
  username: string;
  password_hash: string;
  role: string;
  two_factor_secret?: string | null;
  two_factor_enabled?: number;
  created_at?: string;
}

export interface ExportPayload {
  magic: string;
  version: number;
  createdAt: string;
  clientCount: number;
  clients: ExportedClient[];
  settings: ExportedSetting[];
  users?: ExportedUser[];
}

export interface EncryptedPackage {
  magic: string;
  version: number;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
  exportedAt: string;
  summary: {
    clientCount: number;
    hasSystemSSHKey: boolean;
    hasCloudConfig: boolean;
    hasSmtpConfig: boolean;
    hasTelegramConfig: boolean;
    userCount: number;
    settingCount: number;
  };
}

export interface ImportOptions {
  preserveUsernames?: string[];
  importUsers?: boolean;
}

export interface ImportResult {
  importedClients: number;
  importedSettings: number;
  importedUsers: number;
  hasCloud: boolean;
  hasSmtp: boolean;
  hasTelegram: boolean;
  hasSshKey: boolean;
}

export class ConfigBackupService {
  /**
   * Exporta absolutamente toda la infraestructura, clientes, configuraciones (correo, cloud, telegram, llaves SSH)
   * y usuarios a un paquete cifrado con AES-256-GCM y derivación PBKDF2.
   */
  public static exportConfig(passphrase: string): EncryptedPackage {
    if (!passphrase || passphrase.length < 6) {
      throw new Error('La contraseña de cifrado debe tener al menos 6 caracteres.');
    }

    if (!VaultService.isUnlocked()) {
      VaultService.tryAutoUnlock();
    }

    if (!VaultService.isUnlocked()) {
      throw new Error('El Vault se encuentra bloqueado. Desbloquéalo con tu Frase Maestra antes de exportar la configuración.');
    }

    // 1. Obtener y descifrar clientes completos en memoria
    const rawClients = db.prepare('SELECT * FROM clients').all() as any[];
    const exportedClients: ExportedClient[] = rawClients.map(c => ({
      id: c.id,
      name: c.name,
      tags: c.tags || null,
      ssh_host: c.ssh_host,
      ssh_port: c.ssh_port || 22,
      ssh_user: c.ssh_user,
      ssh_auth_type: c.ssh_auth_type || 'key',
      ssh_password: c.ssh_password ? VaultService.decrypt(c.ssh_password) : null,
      ssh_private_key: c.ssh_private_key ? VaultService.decrypt(c.ssh_private_key) : null,
      ssh_passphrase: c.ssh_passphrase ? VaultService.decrypt(c.ssh_passphrase) : null,
      db_type: c.db_type || 'mysql',
      db_connection_mode: c.db_connection_mode || 'ssh_tunnel',
      db_docker_container: c.db_docker_container || null,
      db_host: c.db_host || '127.0.0.1',
      db_port: c.db_port || 3306,
      db_name: c.db_name || null,
      db_user: c.db_user || null,
      db_pass: c.db_pass ? VaultService.decrypt(c.db_pass) : null,
      dtes_path: c.dtes_path || null,
      cron_schedule: c.cron_schedule || '0 2 * * *',
      retention_days: c.retention_days !== undefined ? c.retention_days : 30,
      retention_count: c.retention_count !== undefined ? c.retention_count : 14,
      is_active: c.is_active !== undefined ? c.is_active : 1,
      notify_email: c.notify_email || null,
      notify_telegram: c.notify_telegram !== undefined ? c.notify_telegram : 1,
      created_at: c.created_at || new Date().toISOString(),
      updated_at: c.updated_at || new Date().toISOString()
    }));

    // 2. Obtener configuraciones globales (excluyendo hashes locales de verificación del vault)
    const rawSettings = db.prepare(`
      SELECT key, value, is_encrypted 
      FROM settings 
      WHERE key NOT IN ('master_vault_salt', 'master_vault_check')
    `).all() as any[];

    let hasSystemSSHKey = false;
    let hasCloudConfig = false;
    let hasSmtpConfig = false;
    let hasTelegramConfig = false;

    const exportedSettings: ExportedSetting[] = rawSettings.map(s => {
      // 2.1 Configuración de correo SMTP
      if (s.key === 'smtp_config') {
        hasSmtpConfig = true;
        try {
          const parsed = JSON.parse(s.value);
          if (parsed.pass) {
            parsed.pass = VaultService.decrypt(parsed.pass);
          }
          return {
            key: s.key,
            value: JSON.stringify(parsed),
            is_encrypted: 1
          };
        } catch {
          return {
            key: s.key,
            value: s.value,
            is_encrypted: s.is_encrypted
          };
        }
      }

      // 2.2 Configuración de Almacenamiento Cloud (S3 / R2 / B2)
      if (s.key === 'cloud_s3_config') {
        hasCloudConfig = true;
        try {
          const parsed = JSON.parse(s.value);
          if (parsed.secretAccessKey) {
            parsed.secretAccessKey = VaultService.decrypt(parsed.secretAccessKey);
          }
          return {
            key: s.key,
            value: JSON.stringify(parsed),
            is_encrypted: 1
          };
        } catch {
          return {
            key: s.key,
            value: s.value,
            is_encrypted: s.is_encrypted
          };
        }
      }

      // 2.3 Configuración de Telegram
      if (s.key === 'telegram_config') {
        hasTelegramConfig = true;
        try {
          const parsed = JSON.parse(s.value);
          if (parsed.botToken) {
            parsed.botToken = VaultService.decrypt(parsed.botToken);
          }
          return {
            key: s.key,
            value: JSON.stringify(parsed),
            is_encrypted: 1
          };
        } catch {
          return {
            key: s.key,
            value: s.value,
            is_encrypted: s.is_encrypted
          };
        }
      }

      // 2.4 Llave SSH Privada del Sistema
      if (s.key === 'system_ssh_key_priv') {
        hasSystemSSHKey = true;
        const decryptedPriv = VaultService.decrypt(s.value);
        return {
          key: s.key,
          value: decryptedPriv,
          is_encrypted: 1
        };
      }

      // 2.5 Llave SSH Pública del Sistema
      if (s.key === 'system_ssh_key_pub') {
        hasSystemSSHKey = true;
        return {
          key: s.key,
          value: s.value,
          is_encrypted: 0
        };
      }

      // 2.6 Otras configuraciones genéricas
      if (s.is_encrypted === 1 || (typeof s.value === 'string' && s.value.split(':').length === 3)) {
        const dec = VaultService.decrypt(s.value);
        return {
          key: s.key,
          value: dec || s.value,
          is_encrypted: 1
        };
      }

      return {
        key: s.key,
        value: s.value,
        is_encrypted: s.is_encrypted || 0
      };
    });

    // 3. Obtener usuarios para copia exacta completa
    const rawUsers = db.prepare('SELECT id, username, password_hash, role, two_factor_secret, two_factor_enabled, created_at FROM users').all() as any[];
    const exportedUsers: ExportedUser[] = rawUsers.map(u => ({
      id: u.id,
      username: u.username,
      password_hash: u.password_hash,
      role: u.role || 'admin',
      two_factor_secret: u.two_factor_secret || null,
      two_factor_enabled: u.two_factor_enabled || 0,
      created_at: u.created_at || new Date().toISOString()
    }));

    const payload: ExportPayload = {
      magic: MAGIC_HEADER,
      version: 2,
      createdAt: new Date().toISOString(),
      clientCount: exportedClients.length,
      clients: exportedClients,
      settings: exportedSettings,
      users: exportedUsers
    };

    // 4. Cifrar todo el payload con AES-256-GCM + PBKDF2
    const jsonStr = JSON.stringify(payload);
    const salt = crypto.randomBytes(SALT_LENGTH);
    const key = crypto.pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
    const iv = crypto.randomBytes(IV_LENGTH);

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let ciphertext = cipher.update(jsonStr, 'utf8', 'hex');
    ciphertext += cipher.final('hex');
    const tag = cipher.getAuthTag();

    return {
      magic: MAGIC_HEADER,
      version: 2,
      salt: salt.toString('hex'),
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      ciphertext,
      exportedAt: payload.createdAt,
      summary: {
        clientCount: exportedClients.length,
        hasSystemSSHKey,
        hasCloudConfig,
        hasSmtpConfig,
        hasTelegramConfig,
        userCount: exportedUsers.length,
        settingCount: exportedSettings.length
      }
    };
  }

  /**
   * Descifra y valida el archivo de configuración con la contraseña provista
   */
  public static decryptPackage(packageData: EncryptedPackage | string, passphrase: string): ExportPayload {
    let pkg: EncryptedPackage;
    if (typeof packageData === 'string') {
      try {
        pkg = JSON.parse(packageData);
      } catch (e) {
        throw new Error('El archivo proporcionado no tiene un formato JSON válido.');
      }
    } else {
      pkg = packageData;
    }

    if (pkg.magic !== MAGIC_HEADER) {
      throw new Error('El archivo no corresponde a un paquete de configuración válido de DearBackup (.dearconfig).');
    }

    if (!pkg.salt || !pkg.iv || !pkg.tag || !pkg.ciphertext) {
      throw new Error('El archivo de configuración está incompleto o corrupto.');
    }

    const salt = Buffer.from(pkg.salt, 'hex');
    const iv = Buffer.from(pkg.iv, 'hex');
    const tag = Buffer.from(pkg.tag, 'hex');
    const key = crypto.pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');

    try {
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      let decrypted = decipher.update(pkg.ciphertext, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      const payload: ExportPayload = JSON.parse(decrypted);
      if (payload.magic !== MAGIC_HEADER || !Array.isArray(payload.clients)) {
        throw new Error('Contenido del paquete de configuración inválido.');
      }
      return payload;
    } catch (err: any) {
      throw new Error('Contraseña incorrecta o archivo de configuración dañado / alterado.');
    }
  }

  /**
   * Restaura la configuración en un sistema activo (con Vault desbloqueado),
   * re-cifrando de forma limpia clientes, credenciales de correo, nube, telegram y llaves SSH.
   */
  public static importConfig(
    packageData: EncryptedPackage | string,
    passphrase: string,
    options?: ImportOptions
  ): ImportResult {
    if (!VaultService.isUnlocked()) {
      VaultService.tryAutoUnlock();
    }

    if (!VaultService.isUnlocked()) {
      throw new Error('El Vault del sistema actual está bloqueado. Desbloquéalo con tu Frase Maestra antes de importar.');
    }

    const payload = this.decryptPackage(packageData, passphrase);

    // Preparar sentencias en transacción SQLite
    const upsertClient = db.prepare(`
      INSERT INTO clients (
        id, name, tags, ssh_host, ssh_port, ssh_user, ssh_auth_type,
        ssh_password, ssh_private_key, ssh_passphrase,
        db_type, db_connection_mode, db_docker_container, db_host, db_port,
        db_name, db_user, db_pass, dtes_path, cron_schedule,
        retention_days, retention_count, is_active, notify_email, notify_telegram,
        created_at, updated_at
      ) VALUES (
        @id, @name, @tags, @ssh_host, @ssh_port, @ssh_user, @ssh_auth_type,
        @ssh_password, @ssh_private_key, @ssh_passphrase,
        @db_type, @db_connection_mode, @db_docker_container, @db_host, @db_port,
        @db_name, @db_user, @db_pass, @dtes_path, @cron_schedule,
        @retention_days, @retention_count, @is_active, @notify_email, @notify_telegram,
        COALESCE(@created_at, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        tags = excluded.tags,
        ssh_host = excluded.ssh_host,
        ssh_port = excluded.ssh_port,
        ssh_user = excluded.ssh_user,
        ssh_auth_type = excluded.ssh_auth_type,
        ssh_password = excluded.ssh_password,
        ssh_private_key = excluded.ssh_private_key,
        ssh_passphrase = excluded.ssh_passphrase,
        db_type = excluded.db_type,
        db_connection_mode = excluded.db_connection_mode,
        db_docker_container = excluded.db_docker_container,
        db_host = excluded.db_host,
        db_port = excluded.db_port,
        db_name = excluded.db_name,
        db_user = excluded.db_user,
        db_pass = excluded.db_pass,
        dtes_path = excluded.dtes_path,
        cron_schedule = excluded.cron_schedule,
        retention_days = excluded.retention_days,
        retention_count = excluded.retention_count,
        is_active = excluded.is_active,
        notify_email = excluded.notify_email,
        notify_telegram = excluded.notify_telegram,
        updated_at = CURRENT_TIMESTAMP
    `);

    const upsertSetting = db.prepare(`
      INSERT INTO settings (key, value, is_encrypted, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        is_encrypted = excluded.is_encrypted,
        updated_at = CURRENT_TIMESTAMP
    `);

    const upsertUser = db.prepare(`
      INSERT INTO users (
        id, username, password_hash, role, two_factor_secret, two_factor_enabled, created_at, updated_at
      ) VALUES (
        @id, @username, @password_hash, @role, @two_factor_secret, @two_factor_enabled,
        COALESCE(@created_at, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP
      )
      ON CONFLICT(username) DO UPDATE SET
        role = excluded.role,
        updated_at = CURRENT_TIMESTAMP
    `);

    let importedClients = 0;
    let importedSettings = 0;
    let importedUsers = 0;
    let hasCloud = false;
    let hasSmtp = false;
    let hasTelegram = false;
    let hasSshKey = false;

    const runImport = db.transaction(() => {
      // 1. Re-cifrar e importar clientes
      for (const client of payload.clients) {
        upsertClient.run({
          id: client.id,
          name: client.name,
          tags: client.tags || null,
          ssh_host: client.ssh_host,
          ssh_port: client.ssh_port || 22,
          ssh_user: client.ssh_user,
          ssh_auth_type: client.ssh_auth_type || 'key',
          ssh_password: client.ssh_password ? VaultService.encrypt(client.ssh_password) : null,
          ssh_private_key: client.ssh_private_key ? VaultService.encrypt(client.ssh_private_key) : null,
          ssh_passphrase: client.ssh_passphrase ? VaultService.encrypt(client.ssh_passphrase) : null,
          db_type: client.db_type || 'mysql',
          db_connection_mode: client.db_connection_mode || 'ssh_tunnel',
          db_docker_container: client.db_docker_container || null,
          db_host: client.db_host || '127.0.0.1',
          db_port: client.db_port || 3306,
          db_name: client.db_name || null,
          db_user: client.db_user || null,
          db_pass: client.db_pass ? VaultService.encrypt(client.db_pass) : null,
          dtes_path: client.dtes_path || null,
          cron_schedule: client.cron_schedule || '0 2 * * *',
          retention_days: client.retention_days !== undefined ? client.retention_days : 30,
          retention_count: client.retention_count !== undefined ? client.retention_count : 14,
          is_active: client.is_active !== undefined ? client.is_active : 1,
          notify_email: client.notify_email || null,
          notify_telegram: client.notify_telegram !== undefined ? client.notify_telegram : 1,
          created_at: client.created_at || null
        });
        importedClients++;
      }

      // 2. Re-cifrar e importar configuraciones globales
      if (Array.isArray(payload.settings)) {
        for (const setting of payload.settings) {
          // 2.1 Configuración SMTP
          if (setting.key === 'smtp_config') {
            hasSmtp = true;
            let valueToStore = setting.value;
            try {
              const parsed = JSON.parse(setting.value);
              if (parsed.pass) {
                parsed.pass = VaultService.encrypt(parsed.pass);
              }
              valueToStore = JSON.stringify(parsed);
            } catch {}
            upsertSetting.run(setting.key, valueToStore, 1);
            importedSettings++;
            continue;
          }

          // 2.2 Configuración Cloud S3/R2/B2
          if (setting.key === 'cloud_s3_config') {
            hasCloud = true;
            let valueToStore = setting.value;
            try {
              const parsed = JSON.parse(setting.value);
              if (parsed.secretAccessKey) {
                parsed.secretAccessKey = VaultService.encrypt(parsed.secretAccessKey);
              }
              valueToStore = JSON.stringify(parsed);
            } catch {}
            upsertSetting.run(setting.key, valueToStore, 1);
            importedSettings++;
            continue;
          }

          // 2.3 Configuración Telegram
          if (setting.key === 'telegram_config') {
            hasTelegram = true;
            let valueToStore = setting.value;
            try {
              const parsed = JSON.parse(setting.value);
              if (parsed.botToken) {
                parsed.botToken = VaultService.encrypt(parsed.botToken);
              }
              valueToStore = JSON.stringify(parsed);
            } catch {}
            upsertSetting.run(setting.key, valueToStore, 1);
            importedSettings++;
            continue;
          }

          // 2.4 Llave SSH Privada del Sistema
          if (setting.key === 'system_ssh_key_priv') {
            hasSshKey = true;
            const encryptedPriv = VaultService.encrypt(setting.value);
            upsertSetting.run(setting.key, encryptedPriv, 1);
            importedSettings++;
            continue;
          }

          // 2.5 Llave SSH Pública del Sistema
          if (setting.key === 'system_ssh_key_pub') {
            hasSshKey = true;
            upsertSetting.run(setting.key, setting.value, 0);
            importedSettings++;
            continue;
          }

          // 2.6 Otras configuraciones genéricas
          let valueToStore = setting.value;
          if (setting.is_encrypted === 1) {
            // Si el valor no está ya cifrado en formato GCM, cifrarlo con la clave actual
            if (typeof valueToStore === 'string' && valueToStore.split(':').length !== 3) {
              valueToStore = VaultService.encrypt(valueToStore);
            }
          }
          upsertSetting.run(setting.key, valueToStore, setting.is_encrypted || 0);
          importedSettings++;
        }
      }

      // 3. Importar usuarios si vienen en el paquete y no se deshabilitó
      if (Array.isArray(payload.users) && options?.importUsers !== false) {
        const preserveList = (options?.preserveUsernames || []).map(u => u.toLowerCase());
        for (const user of payload.users) {
          if (preserveList.includes(user.username.toLowerCase())) {
            // No sobreescribir el usuario preservado (ej. admin actual en sesión)
            continue;
          }
          upsertUser.run({
            id: user.id,
            username: user.username.toLowerCase(),
            password_hash: user.password_hash,
            role: user.role || 'admin',
            two_factor_secret: user.two_factor_secret || null,
            two_factor_enabled: user.two_factor_enabled || 0,
            created_at: user.created_at || null
          });
          importedUsers++;
        }
      }
    });

    runImport();

    return {
      importedClients,
      importedSettings,
      importedUsers,
      hasCloud,
      hasSmtp,
      hasTelegram,
      hasSshKey
    };
  }
}
