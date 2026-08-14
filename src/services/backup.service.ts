import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { exec, execSync } from 'child_process';
import { Client as SSHClient } from 'ssh2';
import { db } from '../db/database';
import { SSHService, SSHClientConfig } from './ssh.service';
import { VaultService } from './vault.service';
import { CryptoService } from './crypto.service';
import { CloudService } from './cloud.service';
import { NotifyService } from './notify.service';
import { RetentionService } from './retention.service';

export interface ClientData {
  id: string;
  name: string;
  tags?: string;
  ssh_host: string;
  ssh_port: number;
  ssh_user: string;
  ssh_auth_type: 'key' | 'custom_key' | 'password';
  ssh_password?: string;
  ssh_private_key?: string;
  ssh_passphrase?: string;
  db_type: 'mysql' | 'postgres' | 'none';
  db_connection_mode?: 'ssh_tunnel' | 'docker_container' | 'direct_tcp';
  db_docker_container?: string;
  db_host: string;
  db_port: number;
  db_name: string;
  db_user: string;
  db_pass?: string;
  dtes_path?: string;
  cron_schedule?: string;
  retention_days: number;
  retention_count: number;
  is_active: number;
  notify_email?: string;
  notify_telegram: number;
}

export class BackupService {
  private static activeJobs: Map<string, { status: string; cancel: () => void }> = new Map();
  private static logListeners: Map<string, Array<(log: string) => void>> = new Map();

  public static onLog(backupId: string, listener: (log: string) => void): () => void {
    if (!this.logListeners.has(backupId)) {
      this.logListeners.set(backupId, []);
    }
    this.logListeners.get(backupId)!.push(listener);
    return () => {
      const arr = this.logListeners.get(backupId);
      if (arr) {
        this.logListeners.set(backupId, arr.filter(l => l !== listener));
      }
    };
  }

  private static emitLog(backupId: string, logText: string, logAccumulator: { text: string }) {
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const formatted = `[${timestamp}] ${logText}`;
    logAccumulator.text += formatted + '\n';

    // Persistir log en tiempo real en la base de datos para visualización inmediata
    try {
      db.prepare('UPDATE backup_logs SET log_output = ? WHERE id = ?').run(logAccumulator.text, backupId);
    } catch {}

    const listeners = this.logListeners.get(backupId);
    if (listeners) {
      listeners.forEach(l => l(formatted));
    }
  }

  /**
   * Ejecuta el respaldo completo para un cliente
   */
  public static async runBackup(client: ClientData, triggerSource: string = 'manual', explicitBackupId?: string): Promise<{ success: boolean; logId: string; error?: string }> {
    const backupId = explicitBackupId || crypto.randomUUID();
    const startTime = new Date();
    const startIso = startTime.toISOString();
    const logAccumulator = { text: '' };

    const backupsBaseDir = process.env.BACKUPS_DIR || path.join(process.cwd(), 'backups');
    const clientBackupDir = path.join(backupsBaseDir, client.id);
    if (!fs.existsSync(clientBackupDir)) {
      fs.mkdirSync(clientBackupDir, { recursive: true });
    }

    const tempDir = path.join(clientBackupDir, `.temp_${backupId}`);
    fs.mkdirSync(tempDir, { recursive: true });

    // 1. Insertar registro inicial con client_name
    db.prepare(`
      INSERT INTO backup_logs (id, client_id, client_name, status, start_time, log_output)
      VALUES (?, ?, ?, 'running', ?, ?)
    `).run(backupId, client.id, client.name, startIso, `Iniciando respaldo (${triggerSource})...\n`);

    this.emitLog(backupId, `🚀 Iniciando proceso de respaldo para cliente: "${client.name}" (${client.id})`, logAccumulator);

    try {
      const connMode = client.db_connection_mode || 'ssh_tunnel';
      const hasDb = client.db_type !== 'none' && !!client.db_name;
      const hasDtes = !!client.dtes_path && client.dtes_path.trim().length > 0;
      let sqlDumpPath = '';

      // Si es conexión Directa TCP/IP a BD y NO tiene DTEs, podemos hacer el dump directo desde el orquestador
      if (hasDb && connMode === 'direct_tcp') {
        this.emitLog(backupId, `🌐 Extrayendo Base de Datos ${client.db_type.toUpperCase()} mediante Conexión Directa TCP ("${client.db_name}")...`, logAccumulator);
        const dbPass = client.db_pass ? VaultService.decrypt(client.db_pass) : '';
        const finalDbHost = client.db_host?.trim() || client.ssh_host;
        const finalDbPort = Number(client.db_port) || (client.db_type === 'mysql' ? 3306 : 5432);
        const finalDbUser = client.db_user?.trim() || 'root';
        sqlDumpPath = path.join(tempDir, `database_${client.db_name}.sql.gz`);

        let directDumpCmd = '';
        if (client.db_type === 'mysql') {
          const passFlag = dbPass ? `-p'${dbPass.replace(/'/g, "'\\''")}'` : '';
          directDumpCmd = `mysqldump --single-transaction --quick --routines --triggers --hex-blob -h "${finalDbHost}" -P ${finalDbPort} -u "${finalDbUser}" ${passFlag} "${client.db_name}" | gzip -c > "${sqlDumpPath}"`;
        } else if (client.db_type === 'postgres') {
          const passEnv = dbPass ? `PGPASSWORD='${dbPass.replace(/'/g, "'\\''")}' ` : '';
          directDumpCmd = `${passEnv}pg_dump -h "${finalDbHost}" -p ${finalDbPort} -U "${finalDbUser}" "${client.db_name}" | gzip -c > "${sqlDumpPath}"`;
        }

        await new Promise<void>((resolve, reject) => {
          exec(directDumpCmd, (err, stdout, stderr) => {
            if (err) return reject(new Error(`Fallo en dump directo TCP: ${stderr || err.message}`));
            if (fs.existsSync(sqlDumpPath) && fs.statSync(sqlDumpPath).size > 0) {
              resolve();
            } else {
              reject(new Error(`Archivo de volcado vacío en dump TCP directo`));
            }
          });
        });

        const dumpSizeMB = (fs.statSync(sqlDumpPath).size / (1024 * 1024)).toFixed(2);
        this.emitLog(backupId, `✅ Base de datos extraída y comprimida correctamente vía TCP (${dumpSizeMB} MB).`, logAccumulator);
      }

      // Si requiere SSH (para Túnel de BD, Contenedor Docker o DTEs)
      if (connMode !== 'direct_tcp' || hasDtes) {
        this.emitLog(backupId, `📡 Conectando por SSH a ${client.ssh_user}@${client.ssh_host}:${client.ssh_port}...`, logAccumulator);
        
        const sshConfig: SSHClientConfig = {
          host: client.ssh_host,
          port: client.ssh_port,
          username: client.ssh_user,
          authType: client.ssh_auth_type,
          password: client.ssh_password,
          privateKey: client.ssh_private_key,
          passphrase: client.ssh_passphrase
        };

        const conn = new SSHClient();
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            try { conn.end(); } catch {}
            reject(new Error(`Tiempo de espera agotado conectando por SSH a ${client.ssh_host}:${client.ssh_port} (45s)`));
          }, 45000);

          conn.on('ready', () => {
            clearTimeout(timer);
            resolve();
          });
          conn.on('error', (err) => {
            clearTimeout(timer);
            reject(new Error(`Error de conexión SSH: ${err.message}`));
          });
          conn.connect(SSHService.buildConnectConfig(sshConfig));
        });

        this.emitLog(backupId, `✅ Conexión SSH establecida exitosamente.`, logAccumulator);

        // Extracción de Base de Datos vía SSH (si no se extrajo por TCP directo)
        if (hasDb && connMode !== 'direct_tcp') {
          const dbPass = client.db_pass ? VaultService.decrypt(client.db_pass) : '';
          const finalDbHost = client.db_host?.trim() || '127.0.0.1';
          const finalDbPort = Number(client.db_port) || (client.db_type === 'mysql' ? 3306 : 5432);
          const finalDbUser = client.db_user?.trim() || 'root';
          sqlDumpPath = path.join(tempDir, `database_${client.db_name}.sql.gz`);

          let dumpCmd = '';

          if (connMode === 'docker_container') {
            const container = client.db_docker_container?.trim() || 'mysql';
            this.emitLog(backupId, `🐳 Extrayendo Base de Datos desde Contenedor Docker "${container}"...`, logAccumulator);
            if (client.db_type === 'mysql') {
              const passFlag = dbPass ? `-p'${dbPass.replace(/'/g, "'\\''")}'` : '';
              dumpCmd = `docker exec "${container}" mysqldump --single-transaction --quick --routines --triggers --hex-blob -u "${finalDbUser}" ${passFlag} "${client.db_name}" | gzip -c`;
            } else if (client.db_type === 'postgres') {
              dumpCmd = `docker exec -e PGPASSWORD='${dbPass.replace(/'/g, "'\\''")}' "${container}" pg_dump -U "${finalDbUser}" "${client.db_name}" | gzip -c`;
            }
          } else {
            // Túnel SSH Local
            this.emitLog(backupId, `💾 Extrayendo Base de Datos ${client.db_type.toUpperCase()} localmente vía SSH ("${client.db_name}")...`, logAccumulator);
            if (client.db_type === 'mysql') {
              const passFlag = dbPass ? `-p'${dbPass.replace(/'/g, "'\\''")}'` : '';
              dumpCmd = `mysqldump --single-transaction --quick --routines --triggers --hex-blob --max_allowed_packet=512M -h "${finalDbHost}" -P ${finalDbPort} -u "${finalDbUser}" ${passFlag} "${client.db_name}" | gzip -c`;
            } else if (client.db_type === 'postgres') {
              const passEnv = dbPass ? `PGPASSWORD='${dbPass.replace(/'/g, "'\\''")}' ` : '';
              dumpCmd = `${passEnv}pg_dump -h "${finalDbHost}" -p ${finalDbPort} -U "${finalDbUser}" "${client.db_name}" | gzip -c`;
            }
          }

          await new Promise<void>((resolve, reject) => {
            conn.exec(dumpCmd, (err, stream) => {
              if (err) return reject(new Error(`Error al iniciar dump de BD: ${err.message}`));

              const writeStream = fs.createWriteStream(sqlDumpPath);
              let stderrData = '';

              stream.pipe(writeStream);
              stream.stderr.on('data', (d: Buffer) => { stderrData += d.toString(); });

              stream.on('close', (code: number) => {
                writeStream.close();
                if (code === 0 && fs.existsSync(sqlDumpPath) && fs.statSync(sqlDumpPath).size > 0) {
                  resolve();
                } else {
                  reject(new Error(`Fallo en dump de BD (Código ${code}): ${stderrData}`));
                }
              });
            });
          });

          const dumpSizeMB = (fs.statSync(sqlDumpPath).size / (1024 * 1024)).toFixed(2);
          this.emitLog(backupId, `✅ Base de datos extraída y comprimida correctamente (${dumpSizeMB} MB).`, logAccumulator);
        }

        // Extracción de Carpeta de DTEs / Documentos de Facturación
        let dtesTarPath = '';
        if (hasDtes) {
          this.emitLog(backupId, `📁 Empaquetando carpeta remota de DTEs: "${client.dtes_path}"...`, logAccumulator);
          dtesTarPath = path.join(tempDir, `dtes_storage.tar.gz`);

          const dtesCmd = `tar -czf - -C "$(dirname "${client.dtes_path}")" "$(basename "${client.dtes_path}")" 2>/dev/null`;

          await new Promise<void>((resolve, reject) => {
            conn.exec(dtesCmd, (err, stream) => {
              if (err) return reject(new Error(`Error empaquetando DTEs: ${err.message}`));

              const writeStream = fs.createWriteStream(dtesTarPath);
              let stderrData = '';

              stream.pipe(writeStream);
              stream.stderr.on('data', (d: Buffer) => { stderrData += d.toString(); });

              stream.on('close', (code: number) => {
                writeStream.close();
                if (code === 0 && fs.existsSync(dtesTarPath) && fs.statSync(dtesTarPath).size > 0) {
                  resolve();
                } else {
                  this.emitLog(backupId, `⚠️ Aviso al sincronizar DTEs (o carpeta vacía): ${stderrData}`, logAccumulator);
                  resolve();
                }
              });
            });
          });

          if (fs.existsSync(dtesTarPath) && fs.statSync(dtesTarPath).size > 0) {
            const dtesSizeMB = (fs.statSync(dtesTarPath).size / (1024 * 1024)).toFixed(2);
            this.emitLog(backupId, `✅ Carpeta de DTEs extraída y empaquetada (${dtesSizeMB} MB).`, logAccumulator);
          }
        }

        conn.end();
      }

      // 5. Empaquetar todo el contenido en un archivo .tar maestro
      this.emitLog(backupId, `📦 Creando paquete consolidado del respaldo...`, logAccumulator);
      const timestampStr = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
      const safeClientName = client.name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
      
      const unencryptedTarPath = path.join(clientBackupDir, `${safeClientName}_${timestampStr}.tar.gz`);
      execSync(`tar -czf "${unencryptedTarPath}" -C "${tempDir}" .`, { stdio: 'pipe' });

      // 6. Cifrado AES-256-CBC
      this.emitLog(backupId, `🔒 Cifrando paquete final con AES-256...`, logAccumulator);
      const finalEncryptedFile = `${unencryptedTarPath}.enc`;
      const encKeyPhrase = VaultService.getEncryptionSecret();
      await CryptoService.encryptFile(unencryptedTarPath, finalEncryptedFile, encKeyPhrase);

      // Eliminar archivos temporales no cifrados
      try {
        fs.unlinkSync(unencryptedTarPath);
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (e) {}

      // 7. Calcular Checksum SHA-256 & Métricas
      const finalStats = fs.statSync(finalEncryptedFile);
      const finalSizeMB = (finalStats.size / (1024 * 1024)).toFixed(2);
      const sha256Checksum = await CryptoService.calculateFileSHA256(finalEncryptedFile);

      this.emitLog(backupId, `🛡️ Respaldo cifrado generado con éxito: ${path.basename(finalEncryptedFile)} (${finalSizeMB} MB)`, logAccumulator);
      this.emitLog(backupId, `🔑 Integridad SHA-256: ${sha256Checksum}`, logAccumulator);

      // 8. Replicación Opcional a la Nube (Cloudflare R2 / S3 / Backblaze)
      let isReplicatedCloud = 0;
      let cloudTarget = 'none';

      const cloudConfig = CloudService.getConfig();
      if (cloudConfig && cloudConfig.isEnabled) {
        try {
          this.emitLog(backupId, `☁️ Replicando respaldo cifrado hacia almacenamiento en la nube...`, logAccumulator);
          cloudTarget = cloudConfig.provider || 's3';
          const remoteKey = `${client.id}/${path.basename(finalEncryptedFile)}`;

          await CloudService.uploadFile(finalEncryptedFile, remoteKey);
          isReplicatedCloud = 1;
          this.emitLog(backupId, `✅ Replicación a la nube completada exitosamente.`, logAccumulator);
        } catch (cloudErr: any) {
          this.emitLog(backupId, `⚠️ Advertencia en replicación Cloud: ${cloudErr.message}`, logAccumulator);
        }
      }

      // 9. Aplicar Políticas de Retención (Limpieza de copias viejas)
      this.emitLog(backupId, `🧹 Ejecutando políticas de retención (Máx: ${client.retention_count} copias, ${client.retention_days} días)...`, logAccumulator);
      await RetentionService.applyRetentionForClient(client.id, client.retention_days, client.retention_count);

      const endTime = new Date();
      const durationSeconds = Math.round((endTime.getTime() - startTime.getTime()) / 1000);

      // 10. Actualizar registro en BD
      db.prepare(`
        UPDATE backup_logs SET
          status = 'success',
          file_name = ?,
          file_path = ?,
          file_size_bytes = ?,
          checksum_sha256 = ?,
          duration_seconds = ?,
          db_dump_success = ?,
          dtes_sync_success = ?,
          is_encrypted = 1,
          is_replicated_cloud = ?,
          cloud_target = ?,
          log_output = ?,
          end_time = ?
        WHERE id = ?
      `).run(
        path.basename(finalEncryptedFile),
        finalEncryptedFile,
        finalStats.size,
        sha256Checksum,
        durationSeconds,
        hasDb ? 1 : 0,
        hasDtes ? 1 : 0,
        isReplicatedCloud,
        cloudTarget,
        logAccumulator.text,
        endTime.toISOString(),
        backupId
      );

      this.emitLog(backupId, `🎉 ¡Proceso de Respaldo Finalizado con Éxito en ${durationSeconds} segundos!`, logAccumulator);

      // 11. Enviar Notificaciones (Email y Telegram)
      await NotifyService.notifyBackupResult(client.notify_email, !!client.notify_telegram, {
        clientName: client.name,
        status: 'success',
        durationSeconds,
        fileSizeBytes: finalStats.size,
        fileName: path.basename(finalEncryptedFile),
        checksum: sha256Checksum
      });

      return { success: true, logId: backupId };

    } catch (err: any) {
      const endTime = new Date();
      const durationSeconds = Math.round((endTime.getTime() - startTime.getTime()) / 1000);

      this.emitLog(backupId, `❌ ERROR CRÍTICO DURANTE EL RESPALDO: ${err.message}`, logAccumulator);

      // Limpiar temporales en fallo
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (e) {}

      db.prepare(`
        UPDATE backup_logs SET
          status = 'failed',
          duration_seconds = ?,
          error_message = ?,
          log_output = ?,
          end_time = ?
        WHERE id = ?
      `).run(
        durationSeconds,
        err.message,
        logAccumulator.text,
        endTime.toISOString(),
        backupId
      );

      // Notificaciones de fallo
      await NotifyService.notifyBackupResult(client.notify_email, !!client.notify_telegram, {
        clientName: client.name,
        status: 'failed',
        durationSeconds,
        fileSizeBytes: 0,
        errorMessage: err.message
      });

      return { success: false, logId: backupId, error: err.message };
    }
  }
}
