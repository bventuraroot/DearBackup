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
  tags?: string;
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
}

export interface ExportedSetting {
  key: string;
  value: string;
  is_encrypted: number;
}

export interface ExportPayload {
  magic: string;
  version: number;
  createdAt: string;
  clientCount: number;
  clients: ExportedClient[];
  settings: ExportedSetting[];
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
  };
}

export class ConfigBackupService {
  /**
   * Exporta toda la infraestructura y credenciales a un paquete cifrado con contraseña
   */
  public static exportConfig(passphrase: string): EncryptedPackage {
    if (!passphrase || passphrase.length < 6) {
      throw new Error('La contraseña de cifrado debe tener al menos 6 caracteres.');
    }

    if (!VaultService.isUnlocked()) {
      throw new Error('El Vault se encuentra bloqueado. Desbloquéalo con tu Frase Maestra antes de exportar la configuración.');
    }

    // 1. Obtener y descifrar clientes en memoria
    const rawClients = db.prepare('SELECT * FROM clients').all() as any[];
    const exportedClients: ExportedClient[] = rawClients.map(c => ({
      id: c.id,
      name: c.name,
      tags: c.tags,
      ssh_host: c.ssh_host,
      ssh_port: c.ssh_port,
      ssh_user: c.ssh_user,
      ssh_auth_type: c.ssh_auth_type,
      ssh_password: c.ssh_password ? VaultService.decrypt(c.ssh_password) : null,
      ssh_private_key: c.ssh_private_key ? VaultService.decrypt(c.ssh_private_key) : null,
      ssh_passphrase: c.ssh_passphrase ? VaultService.decrypt(c.ssh_passphrase) : null,
      db_type: c.db_type,
      db_connection_mode: c.db_connection_mode,
      db_docker_container: c.db_docker_container,
      db_host: c.db_host,
      db_port: c.db_port,
      db_name: c.db_name,
      db_user: c.db_user,
      db_pass: c.db_pass ? VaultService.decrypt(c.db_pass) : null,
      dtes_path: c.dtes_path,
      cron_schedule: c.cron_schedule,
      retention_days: c.retention_days,
      retention_count: c.retention_count,
      is_active: c.is_active,
      notify_email: c.notify_email,
      notify_telegram: c.notify_telegram
    }));

    // 2. Obtener configuraciones globales (excluyendo datos locales de hash del vault)
    const rawSettings = db.prepare(`
      SELECT key, value, is_encrypted 
      FROM settings 
      WHERE key NOT IN ('master_vault_salt', 'master_vault_check')
    `).all() as any[];

    let hasSystemSSHKey = false;
    let hasCloudConfig = false;

    const exportedSettings: ExportedSetting[] = rawSettings.map(s => {
      if (s.key === 'system_ssh_key_priv' || s.is_encrypted === 1) {
        if (s.key === 'system_ssh_key_priv') hasSystemSSHKey = true;
        if (s.key === 'cloud_s3_config') hasCloudConfig = true;
        return {
          key: s.key,
          value: VaultService.decrypt(s.value),
          is_encrypted: 1
        };
      }
      if (s.key === 'system_ssh_key_pub') hasSystemSSHKey = true;
      if (s.key === 'cloud_s3_config') hasCloudConfig = true;
      return {
        key: s.key,
        value: s.value,
        is_encrypted: s.is_encrypted
      };
    });

    const payload: ExportPayload = {
      magic: MAGIC_HEADER,
      version: 1,
      createdAt: new Date().toISOString(),
      clientCount: exportedClients.length,
      clients: exportedClients,
      settings: exportedSettings
    };

    // 3. Cifrar todo el payload con AES-256-GCM + PBKDF2
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
      version: 1,
      salt: salt.toString('hex'),
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      ciphertext,
      exportedAt: payload.createdAt,
      summary: {
        clientCount: exportedClients.length,
        hasSystemSSHKey,
        hasCloudConfig
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
   * Restaura la configuración en un sistema activo (con Vault desbloqueado)
   */
  public static importConfig(packageData: EncryptedPackage | string, passphrase: string): { importedClients: number; importedSettings: number } {
    if (!VaultService.isUnlocked()) {
      throw new Error('El Vault del sistema actual está bloqueado. Desbloquéalo con tu Frase Maestra antes de importar.');
    }

    const payload = this.decryptPackage(packageData, passphrase);

    // Preparar inserciones en transacción SQLite
    const upsertClient = db.prepare(`
      INSERT INTO clients (
        id, name, tags, ssh_host, ssh_port, ssh_user, ssh_auth_type,
        ssh_password, ssh_private_key, ssh_passphrase,
        db_type, db_connection_mode, db_docker_container, db_host, db_port,
        db_name, db_user, db_pass, dtes_path, cron_schedule,
        retention_days, retention_count, is_active, notify_email, notify_telegram,
        updated_at
      ) VALUES (
        @id, @name, @tags, @ssh_host, @ssh_port, @ssh_user, @ssh_auth_type,
        @ssh_password, @ssh_private_key, @ssh_passphrase,
        @db_type, @db_connection_mode, @db_docker_container, @db_host, @db_port,
        @db_name, @db_user, @db_pass, @dtes_path, @cron_schedule,
        @retention_days, @retention_count, @is_active, @notify_email, @notify_telegram,
        CURRENT_TIMESTAMP
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

    let importedClients = 0;
    let importedSettings = 0;

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
          retention_days: client.retention_days || 30,
          retention_count: client.retention_count || 14,
          is_active: client.is_active !== undefined ? client.is_active : 1,
          notify_email: client.notify_email || null,
          notify_telegram: client.notify_telegram !== undefined ? client.notify_telegram : 1
        });
        importedClients++;
      }

      // 2. Re-cifrar e importar configuraciones globales
      if (Array.isArray(payload.settings)) {
        for (const setting of payload.settings) {
          let valueToStore = setting.value;
          if (setting.is_encrypted === 1 || setting.key === 'system_ssh_key_priv') {
            valueToStore = VaultService.encrypt(setting.value);
          }
          upsertSetting.run(setting.key, valueToStore, setting.is_encrypted);
          importedSettings++;
        }
      }
    });

    runImport();

    return { importedClients, importedSettings };
  }
}
