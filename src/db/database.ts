import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';

const DB_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const DB_PATH = path.join(DB_DIR, 'dearbackup.db');

let _db = new Database(DB_PATH);
_db.pragma('journal_mode = WAL');
_db.pragma('foreign_keys = ON');

export const db: Database.Database = new Proxy({} as Database.Database, {
  get(_target, prop) {
    const val = (_db as any)[prop];
    if (typeof val === 'function') {
      return val.bind(_db);
    }
    return val;
  }
});

export function closeDatabase(): void {
  try {
    _db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (_) {}
  try {
    _db.close();
  } catch (_) {}
}

export function reopenDatabase(): void {
  try {
    _db.close();
  } catch (_) {}
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
}

export interface RestoredDatabaseResult {
  clientCount: number;
  userCount: number;
  users: Array<{ id: string; username: string; role: string }>;
  restoredVaultKey: boolean;
}

/**
 * Reemplaza de forma atómica y segura el archivo dearbackup.db cerrando
 * previamente la conexión para evitar errores EBUSY en Windows 11.
 */
export function replaceDatabaseFile(buffer: Buffer): RestoredDatabaseResult {
  let dbBuffer = buffer;
  let restoredVaultKey = false;

  // Si es un archivo .tar.gz (GZIP)
  if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    const tempExtractDir = path.join(DB_DIR, `temp_extract_${Date.now()}`);
    fs.mkdirSync(tempExtractDir, { recursive: true });
    const tempTarPath = path.join(tempExtractDir, 'archive.tar.gz');
    fs.writeFileSync(tempTarPath, buffer);

    try {
      execSync(`tar -xzf "${tempTarPath}" -C "${tempExtractDir}"`, { stdio: 'ignore' });

      // Buscar dearbackup.db
      const candidatePaths = [
        path.join(tempExtractDir, 'data', 'dearbackup.db'),
        path.join(tempExtractDir, 'dearbackup.db'),
      ];
      let foundDbPath = candidatePaths.find(p => fs.existsSync(p));

      if (!foundDbPath) {
        const findDbRecursive = (dir: string): string | null => {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              const res = findDbRecursive(full);
              if (res) return res;
            } else if (entry.isFile() && (entry.name.endsWith('.db') || entry.name.endsWith('.sqlite'))) {
              return full;
            }
          }
          return null;
        };
        foundDbPath = findDbRecursive(tempExtractDir) || undefined;
      }

      if (!foundDbPath) {
        throw new Error('El archivo .tar.gz no contiene una base de datos válida (dearbackup.db).');
      }

      dbBuffer = fs.readFileSync(foundDbPath);

      // Si el tar contiene .vault_key, restaurarlo también
      const candidateVaultKeys = [
        path.join(tempExtractDir, 'data', '.vault_key'),
        path.join(tempExtractDir, '.vault_key')
      ];
      const foundVaultKey = candidateVaultKeys.find(p => fs.existsSync(p));
      if (foundVaultKey) {
        fs.copyFileSync(foundVaultKey, path.join(DB_DIR, '.vault_key'));
        restoredVaultKey = true;
      }
    } finally {
      try {
        fs.rmSync(tempExtractDir, { recursive: true, force: true });
      } catch (_) {}
    }
  }

  // Validar cabecera SQLite
  if (dbBuffer.length < 100 || dbBuffer.subarray(0, 15).toString() !== 'SQLite format 3') {
    throw new Error('El archivo no es una base de datos SQLite válida (cabecera no coincide).');
  }

  // Escribir archivo temporal para validar integridad y estructura
  const tempValidate = path.join(DB_DIR, `validate_temp_${Date.now()}.db`);
  fs.writeFileSync(tempValidate, dbBuffer);

  let userCount = 0;
  let clientCount = 0;
  let users: Array<{ id: string; username: string; role: string }> = [];

  try {
    const testDb = new Database(tempValidate, { readonly: true });
    try {
      users = testDb.prepare('SELECT id, username, role FROM users').all() as any[];
      userCount = users.length;
    } catch (_) {
      users = [];
      userCount = 0;
    }
    try {
      clientCount = (testDb.prepare('SELECT count(*) as count FROM clients').get() as any)?.count ?? 0;
    } catch (_) {
      clientCount = 0;
    }
    testDb.close();
  } catch (testErr: any) {
    try { fs.unlinkSync(tempValidate); } catch (_) {}
    throw new Error(`La base de datos está dañada o no es compatible: ${testErr.message}`);
  }

  // 1. Checkpoint y cerrar conexión actual para liberar locks de Windows (EBUSY)
  closeDatabase();

  // 2. Crear respaldo previo de seguridad
  const preRestoreBak = path.join(DB_DIR, `dearbackup_backup_pre_restore_${Date.now()}.db.bak`);
  if (fs.existsSync(DB_PATH)) {
    try { fs.copyFileSync(DB_PATH, preRestoreBak); } catch (_) {}
  }

  // 3. Eliminar WAL y SHM antiguos
  const walPath = `${DB_PATH}-wal`;
  const shmPath = `${DB_PATH}-shm`;
  try { if (fs.existsSync(walPath)) fs.unlinkSync(walPath); } catch (_) {}
  try { if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath); } catch (_) {}

  // 4. Copiar nueva base de datos hacia DB_PATH
  try {
    fs.copyFileSync(tempValidate, DB_PATH);
    try { fs.unlinkSync(tempValidate); } catch (_) {}
  } catch (copyErr: any) {
    if (fs.existsSync(preRestoreBak)) {
      try { fs.copyFileSync(preRestoreBak, DB_PATH); } catch (_) {}
    }
    reopenDatabase();
    throw copyErr;
  }

  // 5. Reabrir conexión SQLite limpia
  reopenDatabase();

  // 6. Aplicar posibles migraciones de esquema
  initDatabase();

  return { clientCount, userCount, users, restoredVaultKey };
}


export function initDatabase() {
  db.exec(`
    -- 1. Tabla de Usuarios y Seguridad
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      two_factor_secret TEXT,
      two_factor_enabled INTEGER DEFAULT 0,
      role TEXT DEFAULT 'admin',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 2. Tabla de Passkeys (WebAuthn / Biometría)
    CREATE TABLE IF NOT EXISTS passkeys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT DEFAULT 'Mi Dispositivo',
      public_key TEXT NOT NULL,
      counter INTEGER DEFAULT 0,
      device_type TEXT DEFAULT 'singleDevice',
      backed_up INTEGER DEFAULT 0,
      transports TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_used_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- 3. Tabla de Desafíos Temporales de Autenticación
    CREATE TABLE IF NOT EXISTS auth_challenges (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      challenge TEXT NOT NULL,
      type TEXT NOT NULL, -- 'registration' | 'authentication'
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 4. Tabla de Clientes / Servidores a Respaldar
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      tags TEXT,
      -- Acceso SSH
      ssh_host TEXT NOT NULL,
      ssh_port INTEGER DEFAULT 22,
      ssh_user TEXT NOT NULL,
      ssh_auth_type TEXT DEFAULT 'key', -- 'key' | 'custom_key' | 'password'
      ssh_password TEXT,                -- Cifrado con AES-256-GCM
      ssh_private_key TEXT,             -- Cifrado con AES-256-GCM
      ssh_passphrase TEXT,              -- Cifrado con AES-256-GCM
      -- Base de Datos
      db_type TEXT DEFAULT 'mysql',     -- 'mysql' | 'postgres' | 'none'
      db_connection_mode TEXT DEFAULT 'ssh_tunnel', -- 'ssh_tunnel' | 'docker_container' | 'direct_tcp'
      db_docker_container TEXT,         -- Nombre del contenedor Docker en el VPS remoto
      db_host TEXT DEFAULT '127.0.0.1',
      db_port INTEGER DEFAULT 3306,
      db_name TEXT,
      db_user TEXT,
      db_pass TEXT,                     -- Cifrado con AES-256-GCM
      -- DTEs & Facturación Electrónica
      dtes_path TEXT,                   -- Ruta remota de archivos XML/PDF de DTEs
      -- Programación & Retención
      cron_schedule TEXT DEFAULT '0 2 * * *',
      retention_days INTEGER DEFAULT 30,
      retention_count INTEGER DEFAULT 14,
      is_active INTEGER DEFAULT 1,
      -- Notificaciones por cliente
      notify_email TEXT,
      notify_telegram INTEGER DEFAULT 1,
      -- Timestamps
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 5. Tabla de Registros / Historial de Respaldos
    CREATE TABLE IF NOT EXISTS backup_logs (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      client_name TEXT,
      status TEXT NOT NULL,            -- 'running' | 'success' | 'failed' | 'warning'
      file_name TEXT,
      file_path TEXT,
      file_size_bytes INTEGER DEFAULT 0,
      checksum_sha256 TEXT,
      duration_seconds INTEGER DEFAULT 0,
      db_dump_success INTEGER DEFAULT 0,
      dtes_sync_success INTEGER DEFAULT 0,
      is_encrypted INTEGER DEFAULT 1,
      is_replicated_cloud INTEGER DEFAULT 0,
      cloud_target TEXT,               -- 'r2' | 's3' | 'b2' | 'none'
      log_output TEXT,
      error_message TEXT,
      start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      end_time DATETIME,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    );

    -- 6. Tabla de Enlaces Seguros Temporales de Descarga
    CREATE TABLE IF NOT EXISTS share_links (
      id TEXT PRIMARY KEY,
      backup_log_id TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expires_at DATETIME NOT NULL,
      downloads_remaining INTEGER DEFAULT 3,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (backup_log_id) REFERENCES backup_logs(id) ON DELETE CASCADE
    );

    -- 7. Tabla de Configuraciones Globales
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      is_encrypted INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Migraciones automáticas seguras para todas las columnas de todas las tablas
  try {
    const checkAndAddColumn = (table: string, column: string, typeDef: string) => {
      const info = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
      const cols = info.map(c => c.name);
      if (!cols.includes(column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeDef};`);
      }
    };

    // Columnas en clients
    checkAndAddColumn('clients', 'ssh_passphrase', 'TEXT');
    checkAndAddColumn('clients', 'db_connection_mode', "TEXT DEFAULT 'ssh_tunnel'");
    checkAndAddColumn('clients', 'db_docker_container', 'TEXT');
    checkAndAddColumn('clients', 'notify_email', 'TEXT');
    checkAndAddColumn('clients', 'notify_telegram', 'INTEGER DEFAULT 1');

    // Columnas en backup_logs
    checkAndAddColumn('backup_logs', 'client_name', 'TEXT');
    checkAndAddColumn('backup_logs', 'checksum_sha256', 'TEXT');
    checkAndAddColumn('backup_logs', 'db_dump_success', 'INTEGER DEFAULT 0');
    checkAndAddColumn('backup_logs', 'dtes_sync_success', 'INTEGER DEFAULT 0');
    checkAndAddColumn('backup_logs', 'is_encrypted', 'INTEGER DEFAULT 1');
    checkAndAddColumn('backup_logs', 'is_replicated_cloud', 'INTEGER DEFAULT 0');
    checkAndAddColumn('backup_logs', 'cloud_target', 'TEXT');
    checkAndAddColumn('backup_logs', 'cloud_path', 'TEXT');
    checkAndAddColumn('backup_logs', 'log_output', 'TEXT');
    checkAndAddColumn('backup_logs', 'error_message', 'TEXT');
    checkAndAddColumn('backup_logs', 'duration_seconds', 'INTEGER DEFAULT 0');

    // Limpiar respaldos huérfanos que hayan quedado en estado 'running' por reinicios
    try {
      db.prepare(`
        UPDATE backup_logs
        SET status = 'failed',
            error_message = 'Proceso interrumpido por reinicio o detención del servicio.',
            log_output = COALESCE(log_output, '') || '\n[AVISO] Proceso marcado como interrumpido por reinicio del sistema.'
        WHERE status = 'running'
      `).run();
    } catch {}
  } catch (e: any) {
    console.error('Aviso migración de esquema:', e.message);
  }

  console.log('✓ Base de datos SQLite y esquema de seguridad inicializados correctamente.');
}
