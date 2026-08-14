"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SSHService = void 0;
const ssh2_1 = require("ssh2");
const child_process_1 = require("child_process");
const vault_service_1 = require("./vault.service");
class SSHService {
    /**
     * Prepara la configuración de conexión SSH para ssh2 con soporte de Llaves Privadas personalizadas con Passphrase
     */
    static buildConnectConfig(config) {
        const connectConfig = {
            host: config.host.trim(),
            port: Number(config.port) || 22,
            username: config.username.trim(),
            readyTimeout: 45000,
            keepaliveInterval: 10000,
            tryKeyboard: true,
            algorithms: {
                kex: [
                    'curve25519-sha256',
                    'curve25519-sha256@libssh.org',
                    'ecdh-sha2-nistp256',
                    'ecdh-sha2-nistp384',
                    'ecdh-sha2-nistp521',
                    'diffie-hellman-group-exchange-sha256',
                    'diffie-hellman-group14-sha256',
                    'diffie-hellman-group14-sha1',
                    'diffie-hellman-group-exchange-sha1',
                    'diffie-hellman-group1-sha1'
                ],
                cipher: [
                    'chacha20-poly1305@openssh.com',
                    'aes128-ctr',
                    'aes192-ctr',
                    'aes256-ctr',
                    'aes128-gcm',
                    'aes128-gcm@openssh.com',
                    'aes256-gcm',
                    'aes256-gcm@openssh.com',
                    'aes256-cbc',
                    'aes192-cbc',
                    'aes128-cbc',
                    '3des-cbc'
                ],
                serverHostKey: [
                    'ssh-ed25519',
                    'ecdsa-sha2-nistp256',
                    'ecdsa-sha2-nistp384',
                    'ecdsa-sha2-nistp521',
                    'rsa-sha2-512',
                    'rsa-sha2-256',
                    'ssh-rsa',
                    'ssh-dss'
                ]
            }
        };
        if (config.authType === 'password' && config.password) {
            connectConfig.password = vault_service_1.VaultService.decrypt(config.password);
            connectConfig.tryKeyboard = true;
        }
        else if (config.authType === 'custom_key' || config.privateKey) {
            if (config.privateKey) {
                connectConfig.privateKey = vault_service_1.VaultService.decrypt(config.privateKey);
            }
            if (config.passphrase) {
                connectConfig.passphrase = vault_service_1.VaultService.decrypt(config.passphrase);
            }
            else if (config.password) {
                connectConfig.passphrase = vault_service_1.VaultService.decrypt(config.password);
            }
        }
        else {
            // Usar la llave SSH por defecto del sistema
            const systemKey = vault_service_1.VaultService.getOrCreateSystemSSHKey();
            connectConfig.privateKey = systemKey.privateKey;
        }
        return connectConfig;
    }
    /**
     * Diagnóstico y prueba de conectividad SSH con mensajes explicativos
     */
    static async testSSHConnection(config) {
        return new Promise((resolve) => {
            const conn = new ssh2_1.Client();
            let resolved = false;
            conn.on('ready', () => {
                conn.exec('uname -srm; whoami; uptime -p 2>/dev/null || uptime', (err, stream) => {
                    if (err) {
                        conn.end();
                        if (!resolved) {
                            resolved = true;
                            resolve({ success: false, message: `Conectó pero falló al ejecutar comando básico: ${err.message}` });
                        }
                        return;
                    }
                    let output = '';
                    stream.on('data', (data) => {
                        output += data.toString();
                    });
                    stream.on('close', () => {
                        conn.end();
                        if (!resolved) {
                            resolved = true;
                            resolve({
                                success: true,
                                message: '¡Conexión SSH exitosa y autorizada!',
                                osInfo: output.trim()
                            });
                        }
                    });
                });
            });
            conn.on('error', (err) => {
                if (!resolved) {
                    resolved = true;
                    let advice = '';
                    const errMsg = err.message || '';
                    if (errMsg.includes('Encrypted private OpenSSH key detected, but no passphrase given') || errMsg.includes('Cannot parse privateKey')) {
                        advice = '🔑 Causa: La llave privada SSH tiene contraseña (passphrase) y no fue ingresada o es incorrecta. Solución: Escribe la Passphrase de tu llave en el campo correspondiente.';
                    }
                    else if (errMsg.includes('All configured authentication methods failed') || errMsg.includes('Permission denied')) {
                        if (config.authType === 'key') {
                            advice = '🔑 Causa: El servidor cliente no tiene autorizada la Llave SSH del Sistema. Solución: Copia la Llave Pública de DearBackup en ~/.ssh/authorized_keys de tu cliente.';
                        }
                        else if (config.authType === 'custom_key') {
                            advice = '🔑 Causa: El servidor cliente rechazó tu Llave Privada Personalizada. Asegúrate de que la clave pública correspondiente esté agregada en ~/.ssh/authorized_keys.';
                        }
                        else {
                            advice = '🔑 Causa: Usuario o contraseña SSH incorrectos. Verifica que la contraseña del usuario en el servidor cliente sea correcta.';
                        }
                    }
                    else if (errMsg.includes('ECONNREFUSED')) {
                        advice = `🌐 Causa: Conexión rechazada en ${config.host}:${config.port}. Verifica que la IP/Host sea accesible y que el servicio OpenSSH esté activo en ese puerto.`;
                    }
                    else if (errMsg.includes('ETIMEDOUT') || errMsg.includes('timed out')) {
                        advice = `⏱️ Causa: Tiempo de espera agotado conectando a ${config.host}:${config.port}. Revisa que el firewall de tu VPS permita conexiones salientes/entrantes.`;
                    }
                    else if (errMsg.includes('ENOTFOUND')) {
                        advice = `🌐 Causa: No se pudo resolver el nombre de host "${config.host}". Verifica que el dominio o IP esté bien escrito.`;
                    }
                    resolve({
                        success: false,
                        message: advice || `Fallo de conexión SSH: ${errMsg}`
                    });
                }
            });
            conn.on('timeout', () => {
                if (!resolved) {
                    resolved = true;
                    resolve({
                        success: false,
                        message: `⏱️ Tiempo de espera agotado al conectar por SSH a ${config.host}:${config.port}. Revisa firewall y conectividad de red.`
                    });
                }
            });
            try {
                conn.connect(this.buildConnectConfig(config));
            }
            catch (err) {
                if (!resolved) {
                    resolved = true;
                    resolve({ success: false, message: `Error al inicializar cliente SSH: ${err.message}` });
                }
            }
        });
    }
    /**
     * Prueba la conectividad a la base de datos (SSH Tunnel, Docker Container o TCP Directo)
     */
    static async testDatabaseConnection(sshConfig, dbType, connectionMode = 'ssh_tunnel', dockerContainer = '', dbHost = '127.0.0.1', dbPort = 3306, dbName = '', dbUser = 'root', dbPassEncrypted = '') {
        if (dbType === 'none') {
            return { success: true, message: 'No se requiere base de datos para este cliente' };
        }
        const dbPass = vault_service_1.VaultService.decrypt(dbPassEncrypted);
        const finalDbHost = dbHost?.trim() || (connectionMode === 'direct_tcp' ? sshConfig.host : '127.0.0.1');
        const finalDbPort = Number(dbPort) || (dbType === 'mysql' ? 3306 : 5432);
        const finalDbUser = dbUser?.trim() || 'root';
        // MODO 1: Conexión Directa TCP/IP (sin SSH)
        if (connectionMode === 'direct_tcp') {
            return new Promise((resolve) => {
                let testCmd = '';
                if (dbType === 'mysql') {
                    const passFlag = dbPass ? `-p'${dbPass.replace(/'/g, "'\\''")}'` : '';
                    testCmd = `mysql --connect-timeout=8 -h "${finalDbHost}" -P ${finalDbPort} -u "${finalDbUser}" ${passFlag} -e "SELECT VERSION() as version;" ${dbName ? `"${dbName}"` : ''}`;
                }
                else if (dbType === 'postgres') {
                    const passEnv = dbPass ? `PGPASSWORD='${dbPass.replace(/'/g, "'\\''")}' ` : '';
                    testCmd = `${passEnv}psql --connect-timeout=8 -h "${finalDbHost}" -p ${finalDbPort} -U "${finalDbUser}" ${dbName ? `-d "${dbName}"` : ''} -c "SELECT version();"`;
                }
                (0, child_process_1.exec)(testCmd, (err, stdout, stderr) => {
                    if (err) {
                        resolve({
                            success: false,
                            message: `Fallo en Conexión Directa TCP a ${finalDbHost}:${finalDbPort}: ${stderr || err.message}`
                        });
                    }
                    else {
                        resolve({
                            success: true,
                            message: `Conexión Directa TCP a ${dbType.toUpperCase()} exitosa (${finalDbHost}:${finalDbPort})`,
                            version: stdout.trim()
                        });
                    }
                });
            });
        }
        // MODOS 2 & 3: A través de Túnel SSH (Local o Contenedor Docker)
        return new Promise((resolve) => {
            const conn = new ssh2_1.Client();
            let resolved = false;
            conn.on('ready', () => {
                let testCmd = '';
                if (connectionMode === 'docker_container') {
                    const container = dockerContainer.trim() || 'mysql';
                    if (dbType === 'mysql') {
                        const passFlag = dbPass ? `-p'${dbPass.replace(/'/g, "'\\''")}'` : '';
                        testCmd = `docker exec "${container}" mysql -u "${finalDbUser}" ${passFlag} -e "SELECT VERSION() as version;" ${dbName ? `"${dbName}"` : ''}`;
                    }
                    else if (dbType === 'postgres') {
                        const passEnv = dbPass ? `PGPASSWORD='${dbPass.replace(/'/g, "'\\''")}' ` : '';
                        testCmd = `docker exec -e PGPASSWORD='${dbPass.replace(/'/g, "'\\''")}' "${container}" psql -U "${finalDbUser}" ${dbName ? `-d "${dbName}"` : ''} -c "SELECT version();"`;
                    }
                }
                else {
                    // ssh_tunnel local
                    if (dbType === 'mysql') {
                        const passFlag = dbPass ? `-p'${dbPass.replace(/'/g, "'\\''")}'` : '';
                        testCmd = `mysql -h "${finalDbHost}" -P ${finalDbPort} -u "${finalDbUser}" ${passFlag} -e "SELECT VERSION() as version, DATABASE() as current_db;" ${dbName ? `"${dbName}"` : ''}`;
                    }
                    else if (dbType === 'postgres') {
                        const passEnv = dbPass ? `PGPASSWORD='${dbPass.replace(/'/g, "'\\''")}' ` : '';
                        testCmd = `${passEnv}psql -h "${finalDbHost}" -p ${finalDbPort} -U "${finalDbUser}" ${dbName ? `-d "${dbName}"` : ''} -c "SELECT version();"`;
                    }
                }
                conn.exec(testCmd, (err, stream) => {
                    if (err) {
                        conn.end();
                        if (!resolved) {
                            resolved = true;
                            resolve({ success: false, message: `Error al ejecutar prueba de BD: ${err.message}` });
                        }
                        return;
                    }
                    let stdout = '';
                    let stderr = '';
                    stream.on('data', (d) => { stdout += d.toString(); });
                    stream.stderr.on('data', (d) => { stderr += d.toString(); });
                    stream.on('close', (code) => {
                        conn.end();
                        if (!resolved) {
                            resolved = true;
                            if (code === 0) {
                                const modeLabel = connectionMode === 'docker_container' ? `Docker (${dockerContainer})` : 'Túnel SSH Local';
                                resolve({
                                    success: true,
                                    message: `Conexión a Base de Datos ${dbType.toUpperCase()} exitosa [Modo: ${modeLabel}]`,
                                    version: stdout.trim()
                                });
                            }
                            else {
                                let advice = '';
                                const combinedErr = (stderr || stdout).trim();
                                if (combinedErr.includes('Access denied for user')) {
                                    advice = '💡 Sugerencia: Usuario o contraseña de la base de datos incorrectos.';
                                }
                                else if (combinedErr.includes('Unknown database')) {
                                    advice = `💡 Sugerencia: La base de datos "${dbName}" no existe.`;
                                }
                                else if (combinedErr.includes('No such container')) {
                                    advice = `💡 Sugerencia: El contenedor Docker "${dockerContainer}" no existe en el servidor remoto. Revisa con "docker ps".`;
                                }
                                else if (combinedErr.includes('Can\'t connect to MySQL server') || combinedErr.includes('Connection refused')) {
                                    advice = `💡 Sugerencia: No se pudo conectar a ${finalDbHost}:${finalDbPort}. Revisa si MySQL está corriendo o si corre dentro de Docker.`;
                                }
                                resolve({
                                    success: false,
                                    message: `Fallo en prueba de BD: ${combinedErr}${advice ? `\n${advice}` : ''}`
                                });
                            }
                        }
                    });
                });
            });
            conn.on('error', (err) => {
                if (!resolved) {
                    resolved = true;
                    resolve({ success: false, message: `Error SSH al conectar para prueba de BD: ${err.message}` });
                }
            });
            try {
                conn.connect(this.buildConnectConfig(sshConfig));
            }
            catch (err) {
                if (!resolved) {
                    resolved = true;
                    resolve({ success: false, message: `Error al inicializar conexión SSH: ${err.message}` });
                }
            }
        });
    }
    /**
     * Ejecuta un comando en el servidor remoto con soporte para streaming de logs
     */
    static async executeCommand(config, command, onLog) {
        return new Promise((resolve, reject) => {
            const conn = new ssh2_1.Client();
            conn.on('ready', () => {
                onLog?.('info', `Conexión SSH establecida con ${config.host}:${config.port}`);
                conn.exec(command, (err, stream) => {
                    if (err) {
                        conn.end();
                        return reject(err);
                    }
                    let stdout = '';
                    let stderr = '';
                    stream.on('data', (data) => {
                        const str = data.toString();
                        stdout += str;
                        onLog?.('stdout', str);
                    });
                    stream.stderr.on('data', (data) => {
                        const str = data.toString();
                        stderr += str;
                        onLog?.('stderr', str);
                    });
                    stream.on('close', (code) => {
                        conn.end();
                        resolve({ code: code || 0, stdout, stderr });
                    });
                });
            });
            conn.on('error', (err) => {
                onLog?.('stderr', `Error SSH: ${err.message}`);
                reject(err);
            });
            conn.connect(this.buildConnectConfig(config));
        });
    }
}
exports.SSHService = SSHService;
