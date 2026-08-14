import crypto from 'crypto';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { db } from '../db/database';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const KEY_LENGTH = 32;
const ITERATIONS = 100000;

export class VaultService {
  private static masterKey: Buffer | null = null;
  private static secretPhrase: string | null = null;

  /**
   * Inicializa o verifica la llave maestra del sistema
   */
  public static initializeMasterKey(secretPhrase: string): boolean {
    const saltRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('master_vault_salt') as { value: string } | undefined;
    
    let salt: Buffer;
    if (!saltRow) {
      salt = crypto.randomBytes(SALT_LENGTH);
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('master_vault_salt', salt.toString('hex'));
      
      const derivedKey = crypto.pbkdf2Sync(secretPhrase, salt, ITERATIONS, KEY_LENGTH, 'sha256');
      this.masterKey = derivedKey;
      this.secretPhrase = secretPhrase;
      const testHash = crypto.createHmac('sha256', derivedKey).update('DEAR_BACKUP_VAULT_TEST').digest('hex');
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('master_vault_check', testHash);
      return true;
    } else {
      salt = Buffer.from(saltRow.value, 'hex');
      const derivedKey = crypto.pbkdf2Sync(secretPhrase, salt, ITERATIONS, KEY_LENGTH, 'sha256');
      const testCheck = db.prepare('SELECT value FROM settings WHERE key = ?').get('master_vault_check') as { value: string } | undefined;
      
      if (testCheck) {
        const expectedHash = crypto.createHmac('sha256', derivedKey).update('DEAR_BACKUP_VAULT_TEST').digest('hex');
        if (expectedHash !== testCheck.value) {
          return false; // Contraseña incorrecta
        }
      }
      this.masterKey = derivedKey;
      this.secretPhrase = secretPhrase;
      return true;
    }
  }

  public static isUnlocked(): boolean {
    return this.masterKey !== null;
  }

  public static isConfigured(): boolean {
    const check = db.prepare('SELECT value FROM settings WHERE key = ?').get('master_vault_check');
    return !!check;
  }

  public static setMasterKeyDirect(key: Buffer, phrase?: string) {
    this.masterKey = key;
    if (phrase) this.secretPhrase = phrase;
  }

  public static getEncryptionSecret(): string {
    return this.secretPhrase || process.env.APP_SECRET || 'dearbackup_ultra_secure_master_token_2026_change_me';
  }

  /**
   * Cifra un texto plano con AES-256-GCM
   */
  public static encrypt(plainText: string): string {
    if (!plainText) return '';
    const key = this.masterKey || crypto.createHash('sha256').update(this.getEncryptionSecret()).digest();
    
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(plainText, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`;
  }

  /**
   * Descifra un texto cifrado con AES-256-GCM
   */
  public static decrypt(cipherText: string): string {
    if (!cipherText) return '';
    
    const parts = cipherText.split(':');
    if (parts.length !== 3) {
      return cipherText; // No está cifrado en formato GCM
    }

    const [ivHex, tagHex, encryptedHex] = parts;
    const key = this.masterKey || crypto.createHash('sha256').update(this.getEncryptionSecret()).digest();

    try {
      const iv = Buffer.from(ivHex, 'hex');
      const tag = Buffer.from(tagHex, 'hex');
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch (e: any) {
      console.error('Error al descifrar secreto del Vault:', e.message);
      return '';
    }
  }

  /**
   * Obtiene o genera la llave SSH por defecto del sistema
   */
  public static getOrCreateSystemSSHKey(): { publicKey: string; privateKey: string } {
    const pubRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('system_ssh_key_pub') as { value: string } | undefined;
    const privRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('system_ssh_key_priv') as { value: string } | undefined;

    if (pubRow && privRow) {
      return {
        publicKey: pubRow.value,
        privateKey: this.decrypt(privRow.value)
      };
    }

    // Generar nuevo par de llaves nativo OpenSSH usando ssh-keygen
    try {
      const tmpDir = os.tmpdir();
      const keyPath = path.join(tmpDir, `dearbackup_ssh_${Date.now()}`);
      
      let keyGenerated = false;
      try {
        execSync(`ssh-keygen -t ed25519 -N "" -C "dearbackup-system@vault" -f "${keyPath}" -q`);
        keyGenerated = true;
      } catch (e) {
        // Fallback a RSA 4096 si ed25519 no estuviera disponible
        execSync(`ssh-keygen -t rsa -b 4096 -N "" -C "dearbackup-system@vault" -f "${keyPath}" -q`);
        keyGenerated = true;
      }

      if (keyGenerated && fs.existsSync(keyPath) && fs.existsSync(`${keyPath}.pub`)) {
        const privateKey = fs.readFileSync(keyPath, 'utf8');
        const publicKey = fs.readFileSync(`${keyPath}.pub`, 'utf8').trim();

        // Limpiar archivos temporales
        try {
          fs.unlinkSync(keyPath);
          fs.unlinkSync(`${keyPath}.pub`);
        } catch (e) {}

        const encryptedPriv = this.encrypt(privateKey);

        db.prepare('INSERT OR REPLACE INTO settings (key, value, is_encrypted) VALUES (?, ?, 0)').run('system_ssh_key_pub', publicKey);
        db.prepare('INSERT OR REPLACE INTO settings (key, value, is_encrypted) VALUES (?, ?, 1)').run('system_ssh_key_priv', encryptedPriv);

        return { publicKey, privateKey };
      }
    } catch (cmdErr) {
      console.warn('ssh-keygen no disponible en el host, usando generador interno crypto');
    }

    // Fallback: generador interno crypto
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 4096,
      publicKeyEncoding: {
        type: 'pkcs1',
        format: 'pem'
      },
      privateKeyEncoding: {
        type: 'pkcs1',
        format: 'pem'
      }
    });

    const encryptedPriv = this.encrypt(privateKey);

    db.prepare('INSERT OR REPLACE INTO settings (key, value, is_encrypted) VALUES (?, ?, 0)').run('system_ssh_key_pub', publicKey);
    db.prepare('INSERT OR REPLACE INTO settings (key, value, is_encrypted) VALUES (?, ?, 1)').run('system_ssh_key_priv', encryptedPriv);

    return { publicKey, privateKey };
  }

  /**
   * Re-cifra todos los secretos de la base de datos con una nueva frase secreta
   */
  public static rotateMasterKey(currentPhrase: string, newPhrase: string): boolean {
    if (!this.initializeMasterKey(currentPhrase)) {
      return false; // Frase actual incorrecta
    }

    const oldKey = this.masterKey;
    if (!oldKey) return false;

    // Obtener todos los secretos actuales y descifrarlos en memoria
    const clients = db.prepare('SELECT id, ssh_password, ssh_private_key, ssh_passphrase, db_pass FROM clients').all() as any[];
    const decryptedClients = clients.map(c => ({
      id: c.id,
      ssh_password: c.ssh_password ? this.decrypt(c.ssh_password) : null,
      ssh_private_key: c.ssh_private_key ? this.decrypt(c.ssh_private_key) : null,
      ssh_passphrase: c.ssh_passphrase ? this.decrypt(c.ssh_passphrase) : null,
      db_pass: c.db_pass ? this.decrypt(c.db_pass) : null
    }));

    const encryptedSettings = db.prepare('SELECT key, value FROM settings WHERE is_encrypted = 1').all() as any[];
    const decryptedSettings = encryptedSettings.map(s => ({
      key: s.key,
      value: this.decrypt(s.value)
    }));

    // Generar nuevo salt y derivar nueva clave
    const newSalt = crypto.randomBytes(SALT_LENGTH);
    const newMasterKey = crypto.pbkdf2Sync(newPhrase, newSalt, ITERATIONS, KEY_LENGTH, 'sha256');
    const newTestHash = crypto.createHmac('sha256', newMasterKey).update('DEAR_BACKUP_VAULT_TEST').digest('hex');

    // Cambiar a la nueva clave
    this.masterKey = newMasterKey;
    this.secretPhrase = newPhrase;

    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('master_vault_salt', newSalt.toString('hex'));
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('master_vault_check', newTestHash);

    // Re-cifrar clientes con la nueva clave
    const updateClient = db.prepare(`
      UPDATE clients SET
        ssh_password = ?,
        ssh_private_key = ?,
        ssh_passphrase = ?,
        db_pass = ?
      WHERE id = ?
    `);

    for (const c of decryptedClients) {
      updateClient.run(
        c.ssh_password ? this.encrypt(c.ssh_password) : null,
        c.ssh_private_key ? this.encrypt(c.ssh_private_key) : null,
        c.ssh_passphrase ? this.encrypt(c.ssh_passphrase) : null,
        c.db_pass ? this.encrypt(c.db_pass) : null,
        c.id
      );
    }

    // Re-cifrar configuraciones de settings
    const updateSetting = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
    for (const s of decryptedSettings) {
      updateSetting.run(this.encrypt(s.value), s.key);
    }

    return true;
  }
}
