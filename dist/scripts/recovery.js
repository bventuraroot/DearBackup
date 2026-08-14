"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const crypto_1 = __importDefault(require("crypto"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const readline_1 = __importDefault(require("readline"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const database_1 = require("../db/database");
const vault_service_1 = require("../services/vault.service");
const crypto_service_1 = require("../services/crypto.service");
(0, database_1.initDatabase)();
const rl = readline_1.default.createInterface({
    input: process.stdin,
    output: process.stdout
});
function question(query) {
    return new Promise((resolve) => rl.question(query, resolve));
}
async function main() {
    console.log(`
  ╔══════════════════════════════════════════════════════════════════════╗
  ║                                                                      ║
  ║   🛡️  DEARBACKUP - HERRAMIENTA DE RECUPERACIÓN DE EMERGENCIA        ║
  ║                                                                      ║
  ╚══════════════════════════════════════════════════════════════════════╝
  `);
    console.log('Selecciona la acción que deseas realizar:');
    console.log('  1. 🔐 Restablecer Frase Secreta del Vault (Nueva Master Key)');
    console.log('  2. 🔑 Restablecer Contraseña de Administrador');
    console.log('  3. 📲 Desactivar 2FA / Passkeys de emergencia');
    console.log('  4. 🔓 Descifrar un archivo de respaldo (.enc)');
    console.log('  5. 🗑️ Reiniciar plataforma de cero (Borrar todo y volver al Setup)');
    console.log('  6. 🚪 Salir\n');
    const choice = await question('Ingresa una opción (1-6): ');
    if (choice === '1') {
        console.log('\n--- RESTABLECER FRASE SECRETA DEL VAULT ---');
        console.log('⚠️ Nota: Los campos cifrados anteriores se limpiarán y podrás reingresar las contraseñas en la UI.');
        const newPhrase = await question('Ingresa la NUEVA Frase Secreta del Vault (min. 8 caracteres): ');
        if (!newPhrase || newPhrase.length < 8) {
            console.log('❌ Error: La frase debe tener al menos 8 caracteres.');
            rl.close();
            return;
        }
        // Generar nuevo salt y hash de verificación
        const salt = crypto_1.default.randomBytes(16);
        const derivedKey = crypto_1.default.pbkdf2Sync(newPhrase, salt, 100000, 32, 'sha256');
        const testHash = crypto_1.default.createHmac('sha256', derivedKey).update('DEAR_BACKUP_VAULT_TEST').digest('hex');
        database_1.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('master_vault_salt', salt.toString('hex'));
        database_1.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('master_vault_check', testHash);
        // Regenerar llave SSH del sistema con la nueva frase
        vault_service_1.VaultService.setMasterKeyDirect(derivedKey, newPhrase);
        vault_service_1.VaultService.getOrCreateSystemSSHKey();
        console.log('\n✅ ¡Frase Secreta del Vault restablecida exitosamente!');
        console.log('👉 Tus configuraciones se conservan y ahora puedes ingresar al panel con tu nueva frase.');
    }
    else if (choice === '2') {
        console.log('\n--- RESTABLECER CONTRASEÑA DE ADMINISTRADOR ---');
        const username = (await question('Nombre de usuario (ej: admin): ')).trim() || 'admin';
        const newPass = await question('Nueva contraseña (min. 8 caracteres): ');
        if (!newPass || newPass.length < 8) {
            console.log('❌ Error: La contraseña debe tener al menos 8 caracteres.');
            rl.close();
            return;
        }
        const user = database_1.db.prepare('SELECT id FROM users WHERE username = ?').get(username.toLowerCase());
        if (!user) {
            console.log(`❌ Error: El usuario "${username}" no existe.`);
            rl.close();
            return;
        }
        const newHash = await bcryptjs_1.default.hash(newPass, 10);
        database_1.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, user.id);
        console.log(`\n✅ ¡Contraseña de "${username}" restablecida correctamente!`);
    }
    else if (choice === '3') {
        console.log('\n--- DESACTIVAR 2FA Y PASSKEYS DE EMERGENCIA ---');
        const username = (await question('Nombre de usuario (ej: admin): ')).trim() || 'admin';
        const user = database_1.db.prepare('SELECT id FROM users WHERE username = ?').get(username.toLowerCase());
        if (!user) {
            console.log(`❌ Error: El usuario "${username}" no existe.`);
            rl.close();
            return;
        }
        database_1.db.prepare('UPDATE users SET two_factor_secret = NULL, two_factor_enabled = 0 WHERE id = ?').run(user.id);
        database_1.db.prepare('DELETE FROM passkeys WHERE user_id = ?').run(user.id);
        console.log(`\n✅ ¡2FA y Passkeys desactivados para el usuario "${username}"! Ahora puedes iniciar con solo tu contraseña.`);
    }
    else if (choice === '4') {
        console.log('\n--- 🔓 DESCIFRAR ARCHIVO DE RESPALDO (.enc) ---');
        const defaultSecret = process.env.APP_SECRET || 'dearbackup_ultra_secure_master_token_2026_change_me';
        // Buscar archivos .enc en /app/backups
        const backupsDir = process.env.BACKUPS_DIR || path_1.default.join(process.cwd(), 'backups');
        const foundFiles = [];
        const scanDir = (dir) => {
            if (fs_1.default.existsSync(dir)) {
                fs_1.default.readdirSync(dir).forEach(f => {
                    const full = path_1.default.join(dir, f);
                    if (fs_1.default.statSync(full).isDirectory()) {
                        scanDir(full);
                    }
                    else if (full.endsWith('.enc')) {
                        foundFiles.push(full);
                    }
                });
            }
        };
        scanDir(backupsDir);
        let targetEncFile = '';
        if (foundFiles.length > 0) {
            console.log('\nArchivos respaldados encontrados:');
            foundFiles.forEach((f, i) => {
                console.log(`  [${i + 1}] ${path_1.default.basename(f)} (${(fs_1.default.statSync(f).size / (1024 * 1024)).toFixed(2)} MB)`);
            });
            console.log(`  [0] Escribir otra ruta manualmente\n`);
            const fileChoice = await question('Elige el número de archivo (o 0): ');
            const idx = parseInt(fileChoice, 10) - 1;
            if (idx >= 0 && idx < foundFiles.length) {
                targetEncFile = foundFiles[idx];
            }
        }
        if (!targetEncFile) {
            targetEncFile = await question('Ruta completa del archivo .enc: ');
        }
        if (!fs_1.default.existsSync(targetEncFile)) {
            console.log(`❌ Error: El archivo "${targetEncFile}" no existe.`);
            rl.close();
            return;
        }
        const keyChoice = await question(`Frase secreta de cifrado [Enter para usar la actual del sistema]: `);
        const keyPhrase = keyChoice.trim() || defaultSecret;
        const outputTarGz = targetEncFile.replace(/\.enc$/, '');
        console.log(`\n⏳ Descifrando archivo hacia: ${outputTarGz}...`);
        try {
            await crypto_service_1.CryptoService.decryptFile(targetEncFile, outputTarGz, keyPhrase);
            const sizeMB = (fs_1.default.statSync(outputTarGz).size / (1024 * 1024)).toFixed(2);
            console.log(`\n🎉 ¡Archivo descifrado con éxito!`);
            console.log(`📦 Ubicación: ${outputTarGz} (${sizeMB} MB)`);
            console.log(`👉 Puedes descomprimirlo con: tar -xzvf "${outputTarGz}"`);
        }
        catch (err) {
            console.log(`\n❌ Fallo al descifrar: ${err.message}`);
            console.log(`💡 Verifica que la clave ingresada sea la correcta.`);
        }
    }
    else if (choice === '5') {
        console.log('\n⚠️ ADVERTENCIA: Esta acción eliminará toda la configuración, usuarios y llaves del sistema.');
        const confirm = await question('¿Estás seguro de continuar? Escribe "RESET" para confirmar: ');
        if (confirm === 'RESET') {
            database_1.db.prepare('DELETE FROM passkeys').run();
            database_1.db.prepare('DELETE FROM users').run();
            database_1.db.prepare('DELETE FROM settings').run();
            database_1.db.prepare('DELETE FROM clients').run();
            database_1.db.prepare('DELETE FROM backup_logs').run();
            database_1.db.prepare('DELETE FROM share_links').run();
            console.log('\n✅ ¡Sistema reiniciado de cero! Accede a http://localhost:3000 para volver a configurar la plataforma.');
        }
        else {
            console.log('Operación cancelada.');
        }
    }
    rl.close();
}
main().catch(err => {
    console.error('Error fatal en recuperación:', err);
    rl.close();
});
