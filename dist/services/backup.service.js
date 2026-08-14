"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BackupService = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const child_process_1 = require("child_process");
const ssh2_1 = require("ssh2");
const database_1 = require("../db/database");
const ssh_service_1 = require("./ssh.service");
const vault_service_1 = require("./vault.service");
const crypto_service_1 = require("./crypto.service");
const cloud_service_1 = require("./cloud.service");
const notify_service_1 = require("./notify.service");
const retention_service_1 = require("./retention.service");
class BackupService {
    static activeJobs = new Map();
    static logListeners = new Map();
    static onLog(backupId, listener) {
        if (!this.logListeners.has(backupId)) {
            this.logListeners.set(backupId, []);
        }
        this.logListeners.get(backupId).push(listener);
        return () => {
            const arr = this.logListeners.get(backupId);
            if (arr) {
                this.logListeners.set(backupId, arr.filter(l => l !== listener));
            }
        };
    }
    static emitLog(backupId, logText, logAccumulator) {
        const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
        const formatted = `[${timestamp}] ${logText}`;
        logAccumulator.text += formatted + '\n';
        // Persistir log en tiempo real en la base de datos para visualización inmediata
        try {
            database_1.db.prepare('UPDATE backup_logs SET log_output = ? WHERE id = ?').run(logAccumulator.text, backupId);
        }
        catch { }
        const listeners = this.logListeners.get(backupId);
        if (listeners) {
            listeners.forEach(l => l(formatted));
        }
    }
    /**
     * Ejecuta el respaldo completo para un cliente
     */
    static async runBackup(client, triggerSource = 'manual', explicitBackupId) {
        const backupId = explicitBackupId || crypto_1.default.randomUUID();
        const startTime = new Date();
        const startIso = startTime.toISOString();
        const logAccumulator = { text: '' };
        const backupsBaseDir = process.env.BACKUPS_DIR || path_1.default.join(process.cwd(), 'backups');
        const clientBackupDir = path_1.default.join(backupsBaseDir, client.id);
        if (!fs_1.default.existsSync(clientBackupDir)) {
            fs_1.default.mkdirSync(clientBackupDir, { recursive: true });
        }
        const tempDir = path_1.default.join(clientBackupDir, `.temp_${backupId}`);
        fs_1.default.mkdirSync(tempDir, { recursive: true });
        // 1. Insertar registro inicial con client_name
        database_1.db.prepare(`
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
                const dbPass = client.db_pass ? vault_service_1.VaultService.decrypt(client.db_pass) : '';
                const finalDbHost = client.db_host?.trim() || client.ssh_host;
                const finalDbPort = Number(client.db_port) || (client.db_type === 'mysql' ? 3306 : 5432);
                const finalDbUser = client.db_user?.trim() || 'root';
                sqlDumpPath = path_1.default.join(tempDir, `database_${client.db_name}.sql.gz`);
                let directDumpCmd = '';
                if (client.db_type === 'mysql') {
                    const passFlag = dbPass ? `-p'${dbPass.replace(/'/g, "'\\''")}'` : '';
                    directDumpCmd = `mysqldump --single-transaction --quick --routines --triggers --hex-blob -h "${finalDbHost}" -P ${finalDbPort} -u "${finalDbUser}" ${passFlag} "${client.db_name}" | gzip -c > "${sqlDumpPath}"`;
                }
                else if (client.db_type === 'postgres') {
                    const passEnv = dbPass ? `PGPASSWORD='${dbPass.replace(/'/g, "'\\''")}' ` : '';
                    directDumpCmd = `${passEnv}pg_dump -h "${finalDbHost}" -p ${finalDbPort} -U "${finalDbUser}" "${client.db_name}" | gzip -c > "${sqlDumpPath}"`;
                }
                await new Promise((resolve, reject) => {
                    (0, child_process_1.exec)(directDumpCmd, (err, stdout, stderr) => {
                        if (err)
                            return reject(new Error(`Fallo en dump directo TCP: ${stderr || err.message}`));
                        if (fs_1.default.existsSync(sqlDumpPath) && fs_1.default.statSync(sqlDumpPath).size > 0) {
                            resolve();
                        }
                        else {
                            reject(new Error(`Archivo de volcado vacío en dump TCP directo`));
                        }
                    });
                });
                const dumpSizeMB = (fs_1.default.statSync(sqlDumpPath).size / (1024 * 1024)).toFixed(2);
                this.emitLog(backupId, `✅ Base de datos extraída y comprimida correctamente vía TCP (${dumpSizeMB} MB).`, logAccumulator);
            }
            // Si requiere SSH (para Túnel de BD, Contenedor Docker o DTEs)
            if (connMode !== 'direct_tcp' || hasDtes) {
                this.emitLog(backupId, `📡 Conectando por SSH a ${client.ssh_user}@${client.ssh_host}:${client.ssh_port}...`, logAccumulator);
                const sshConfig = {
                    host: client.ssh_host,
                    port: client.ssh_port,
                    username: client.ssh_user,
                    authType: client.ssh_auth_type,
                    password: client.ssh_password,
                    privateKey: client.ssh_private_key,
                    passphrase: client.ssh_passphrase
                };
                const conn = new ssh2_1.Client();
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => {
                        try {
                            conn.end();
                        }
                        catch { }
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
                    conn.connect(ssh_service_1.SSHService.buildConnectConfig(sshConfig));
                });
                this.emitLog(backupId, `✅ Conexión SSH establecida exitosamente.`, logAccumulator);
                // Extracción de Base de Datos vía SSH (si no se extrajo por TCP directo)
                if (hasDb && connMode !== 'direct_tcp') {
                    const dbPass = client.db_pass ? vault_service_1.VaultService.decrypt(client.db_pass) : '';
                    const finalDbHost = client.db_host?.trim() || '127.0.0.1';
                    const finalDbPort = Number(client.db_port) || (client.db_type === 'mysql' ? 3306 : 5432);
                    const finalDbUser = client.db_user?.trim() || 'root';
                    sqlDumpPath = path_1.default.join(tempDir, `database_${client.db_name}.sql.gz`);
                    let dumpCmd = '';
                    if (connMode === 'docker_container') {
                        const container = client.db_docker_container?.trim() || 'mysql';
                        this.emitLog(backupId, `🐳 Extrayendo Base de Datos desde Contenedor Docker "${container}"...`, logAccumulator);
                        if (client.db_type === 'mysql') {
                            const passFlag = dbPass ? `-p'${dbPass.replace(/'/g, "'\\''")}'` : '';
                            dumpCmd = `docker exec "${container}" mysqldump --single-transaction --quick --routines --triggers --hex-blob -u "${finalDbUser}" ${passFlag} "${client.db_name}" | gzip -c`;
                        }
                        else if (client.db_type === 'postgres') {
                            dumpCmd = `docker exec -e PGPASSWORD='${dbPass.replace(/'/g, "'\\''")}' "${container}" pg_dump -U "${finalDbUser}" "${client.db_name}" | gzip -c`;
                        }
                    }
                    else {
                        // Túnel SSH Local
                        this.emitLog(backupId, `💾 Extrayendo Base de Datos ${client.db_type.toUpperCase()} localmente vía SSH ("${client.db_name}")...`, logAccumulator);
                        if (client.db_type === 'mysql') {
                            const passFlag = dbPass ? `-p'${dbPass.replace(/'/g, "'\\''")}'` : '';
                            dumpCmd = `mysqldump --single-transaction --quick --routines --triggers --hex-blob --max_allowed_packet=512M -h "${finalDbHost}" -P ${finalDbPort} -u "${finalDbUser}" ${passFlag} "${client.db_name}" | gzip -c`;
                        }
                        else if (client.db_type === 'postgres') {
                            const passEnv = dbPass ? `PGPASSWORD='${dbPass.replace(/'/g, "'\\''")}' ` : '';
                            dumpCmd = `${passEnv}pg_dump -h "${finalDbHost}" -p ${finalDbPort} -U "${finalDbUser}" "${client.db_name}" | gzip -c`;
                        }
                    }
                    await new Promise((resolve, reject) => {
                        conn.exec(dumpCmd, (err, stream) => {
                            if (err)
                                return reject(new Error(`Error al iniciar dump de BD: ${err.message}`));
                            const writeStream = fs_1.default.createWriteStream(sqlDumpPath);
                            let stderrData = '';
                            stream.pipe(writeStream);
                            stream.stderr.on('data', (d) => { stderrData += d.toString(); });
                            stream.on('close', (code) => {
                                writeStream.close();
                                if (code === 0 && fs_1.default.existsSync(sqlDumpPath) && fs_1.default.statSync(sqlDumpPath).size > 0) {
                                    resolve();
                                }
                                else {
                                    reject(new Error(`Fallo en dump de BD (Código ${code}): ${stderrData}`));
                                }
                            });
                        });
                    });
                    const dumpSizeMB = (fs_1.default.statSync(sqlDumpPath).size / (1024 * 1024)).toFixed(2);
                    this.emitLog(backupId, `✅ Base de datos extraída y comprimida correctamente (${dumpSizeMB} MB).`, logAccumulator);
                }
                // Extracción de Carpeta de DTEs / Documentos de Facturación
                let dtesTarPath = '';
                if (hasDtes) {
                    this.emitLog(backupId, `📁 Empaquetando carpeta remota de DTEs: "${client.dtes_path}"...`, logAccumulator);
                    dtesTarPath = path_1.default.join(tempDir, `dtes_storage.tar.gz`);
                    const dtesCmd = `tar -czf - -C "$(dirname "${client.dtes_path}")" "$(basename "${client.dtes_path}")" 2>/dev/null`;
                    await new Promise((resolve, reject) => {
                        conn.exec(dtesCmd, (err, stream) => {
                            if (err)
                                return reject(new Error(`Error empaquetando DTEs: ${err.message}`));
                            const writeStream = fs_1.default.createWriteStream(dtesTarPath);
                            let stderrData = '';
                            stream.pipe(writeStream);
                            stream.stderr.on('data', (d) => { stderrData += d.toString(); });
                            stream.on('close', (code) => {
                                writeStream.close();
                                if (code === 0 && fs_1.default.existsSync(dtesTarPath) && fs_1.default.statSync(dtesTarPath).size > 0) {
                                    resolve();
                                }
                                else {
                                    this.emitLog(backupId, `⚠️ Aviso al sincronizar DTEs (o carpeta vacía): ${stderrData}`, logAccumulator);
                                    resolve();
                                }
                            });
                        });
                    });
                    if (fs_1.default.existsSync(dtesTarPath) && fs_1.default.statSync(dtesTarPath).size > 0) {
                        const dtesSizeMB = (fs_1.default.statSync(dtesTarPath).size / (1024 * 1024)).toFixed(2);
                        this.emitLog(backupId, `✅ Carpeta de DTEs extraída y empaquetada (${dtesSizeMB} MB).`, logAccumulator);
                    }
                }
                conn.end();
            }
            // 5. Empaquetar todo el contenido en un archivo .tar maestro
            this.emitLog(backupId, `📦 Creando paquete consolidado del respaldo...`, logAccumulator);
            const timestampStr = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
            const safeClientName = client.name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
            const unencryptedTarPath = path_1.default.join(clientBackupDir, `${safeClientName}_${timestampStr}.tar.gz`);
            (0, child_process_1.execSync)(`tar -czf "${unencryptedTarPath}" -C "${tempDir}" .`, { stdio: 'pipe' });
            // 6. Cifrado AES-256-CBC
            this.emitLog(backupId, `🔒 Cifrando paquete final con AES-256...`, logAccumulator);
            const finalEncryptedFile = `${unencryptedTarPath}.enc`;
            const encKeyPhrase = vault_service_1.VaultService.getEncryptionSecret();
            await crypto_service_1.CryptoService.encryptFile(unencryptedTarPath, finalEncryptedFile, encKeyPhrase);
            // Eliminar archivos temporales no cifrados
            try {
                fs_1.default.unlinkSync(unencryptedTarPath);
                fs_1.default.rmSync(tempDir, { recursive: true, force: true });
            }
            catch (e) { }
            // 7. Calcular Checksum SHA-256 & Métricas
            const finalStats = fs_1.default.statSync(finalEncryptedFile);
            const finalSizeMB = (finalStats.size / (1024 * 1024)).toFixed(2);
            const sha256Checksum = await crypto_service_1.CryptoService.calculateFileSHA256(finalEncryptedFile);
            this.emitLog(backupId, `🛡️ Respaldo cifrado generado con éxito: ${path_1.default.basename(finalEncryptedFile)} (${finalSizeMB} MB)`, logAccumulator);
            this.emitLog(backupId, `🔑 Integridad SHA-256: ${sha256Checksum}`, logAccumulator);
            // 8. Replicación Opcional a la Nube (Cloudflare R2 / S3 / Backblaze)
            let isReplicatedCloud = 0;
            let cloudTarget = 'none';
            let cloudPath = null;
            const cloudConfig = cloud_service_1.CloudService.getConfig();
            if (cloudConfig && cloudConfig.isEnabled) {
                try {
                    this.emitLog(backupId, `☁️ Replicando respaldo cifrado hacia almacenamiento en la nube...`, logAccumulator);
                    cloudTarget = cloudConfig.provider || 's3';
                    const remoteKey = `${client.id}/${path_1.default.basename(finalEncryptedFile)}`;
                    await cloud_service_1.CloudService.uploadFile(finalEncryptedFile, remoteKey);
                    isReplicatedCloud = 1;
                    cloudPath = remoteKey;
                    this.emitLog(backupId, `✅ Replicación a la nube completada exitosamente.`, logAccumulator);
                }
                catch (cloudErr) {
                    this.emitLog(backupId, `⚠️ Advertencia en replicación Cloud: ${cloudErr.message}`, logAccumulator);
                }
            }
            const endTime = new Date();
            const durationSeconds = Math.round((endTime.getTime() - startTime.getTime()) / 1000);
            // 9. Actualizar registro en BD como exitoso
            database_1.db.prepare(`
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
          cloud_path = ?,
          log_output = ?,
          end_time = ?
        WHERE id = ?
      `).run(path_1.default.basename(finalEncryptedFile), finalEncryptedFile, finalStats.size, sha256Checksum, durationSeconds, hasDb ? 1 : 0, hasDtes ? 1 : 0, isReplicatedCloud, cloudTarget, cloudPath, logAccumulator.text, endTime.toISOString(), backupId);
            // 10. Aplicar Políticas de Retención (Limpieza de copias viejas en Local y en la Nube)
            this.emitLog(backupId, `🧹 Ejecutando políticas de retención (Límite: ${client.retention_count || 2} copias, ${client.retention_days || 30} días)...`, logAccumulator);
            const pruneRes = await retention_service_1.RetentionService.applyRetentionForClient(client.id, client.retention_days || 30, client.retention_count || 2);
            if (pruneRes.prunedCloud > 0 || pruneRes.prunedLocal > 0) {
                this.emitLog(backupId, `🗑️ Retención aplicada: ${pruneRes.prunedCloud} copias eliminadas de la Nube, ${pruneRes.prunedLocal} del disco local.`, logAccumulator);
            }
            this.emitLog(backupId, `🎉 ¡Proceso de Respaldo Finalizado con Éxito en ${durationSeconds} segundos!`, logAccumulator);
            // 11. Enviar Notificaciones (Email y Telegram)
            await notify_service_1.NotifyService.notifyBackupResult(client.notify_email, !!client.notify_telegram, {
                clientName: client.name,
                status: 'success',
                durationSeconds,
                fileSizeBytes: finalStats.size,
                fileName: path_1.default.basename(finalEncryptedFile),
                checksum: sha256Checksum
            });
            return { success: true, logId: backupId };
        }
        catch (err) {
            const endTime = new Date();
            const durationSeconds = Math.round((endTime.getTime() - startTime.getTime()) / 1000);
            this.emitLog(backupId, `❌ ERROR CRÍTICO DURANTE EL RESPALDO: ${err.message}`, logAccumulator);
            // Limpiar temporales en fallo
            try {
                fs_1.default.rmSync(tempDir, { recursive: true, force: true });
            }
            catch (e) { }
            database_1.db.prepare(`
        UPDATE backup_logs SET
          status = 'failed',
          duration_seconds = ?,
          error_message = ?,
          log_output = ?,
          end_time = ?
        WHERE id = ?
      `).run(durationSeconds, err.message, logAccumulator.text, endTime.toISOString(), backupId);
            // Notificaciones de fallo
            await notify_service_1.NotifyService.notifyBackupResult(client.notify_email, !!client.notify_telegram, {
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
exports.BackupService = BackupService;
