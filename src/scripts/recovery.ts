import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { db, initDatabase } from '../db/database';
import { VaultService } from '../services/vault.service';
import { CryptoService } from '../services/crypto.service';

initDatabase();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query: string): Promise<string> {
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
    const salt = crypto.randomBytes(16);
    const derivedKey = crypto.pbkdf2Sync(newPhrase, salt, 100000, 32, 'sha256');
    const testHash = crypto.createHmac('sha256', derivedKey).update('DEAR_BACKUP_VAULT_TEST').digest('hex');

    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('master_vault_salt', salt.toString('hex'));
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('master_vault_check', testHash);

    // Regenerar llave SSH del sistema con la nueva frase
    VaultService.setMasterKeyDirect(derivedKey, newPhrase);
    VaultService.getOrCreateSystemSSHKey();

    console.log('\n✅ ¡Frase Secreta del Vault restablecida exitosamente!');
    console.log('👉 Tus configuraciones se conservan y ahora puedes ingresar al panel con tu nueva frase.');

  } else if (choice === '2') {
    console.log('\n--- RESTABLECER CONTRASEÑA DE ADMINISTRADOR ---');
    const username = (await question('Nombre de usuario (ej: admin): ')).trim() || 'admin';
    const newPass = await question('Nueva contraseña (min. 8 caracteres): ');

    if (!newPass || newPass.length < 8) {
      console.log('❌ Error: La contraseña debe tener al menos 8 caracteres.');
      rl.close();
      return;
    }

    const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username.toLowerCase()) as any;
    if (!user) {
      console.log(`❌ Error: El usuario "${username}" no existe.`);
      rl.close();
      return;
    }

    const newHash = await bcrypt.hash(newPass, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, user.id);

    console.log(`\n✅ ¡Contraseña de "${username}" restablecida correctamente!`);

  } else if (choice === '3') {
    console.log('\n--- DESACTIVAR 2FA Y PASSKEYS DE EMERGENCIA ---');
    const username = (await question('Nombre de usuario (ej: admin): ')).trim() || 'admin';
    const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username.toLowerCase()) as any;

    if (!user) {
      console.log(`❌ Error: El usuario "${username}" no existe.`);
      rl.close();
      return;
    }

    db.prepare('UPDATE users SET two_factor_secret = NULL, two_factor_enabled = 0 WHERE id = ?').run(user.id);
    db.prepare('DELETE FROM passkeys WHERE user_id = ?').run(user.id);

    console.log(`\n✅ ¡2FA y Passkeys desactivados para el usuario "${username}"! Ahora puedes iniciar con solo tu contraseña.`);

  } else if (choice === '4') {
    console.log('\n--- 🔓 DESCIFRAR ARCHIVO DE RESPALDO (.enc) ---');
    const defaultSecret = process.env.APP_SECRET || 'dearbackup_ultra_secure_master_token_2026_change_me';
    
    // Buscar archivos .enc en /app/backups
    const backupsDir = process.env.BACKUPS_DIR || path.join(process.cwd(), 'backups');
    const foundFiles: string[] = [];

    const scanDir = (dir: string) => {
      if (fs.existsSync(dir)) {
        fs.readdirSync(dir).forEach(f => {
          const full = path.join(dir, f);
          if (fs.statSync(full).isDirectory()) {
            scanDir(full);
          } else if (full.endsWith('.enc')) {
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
        console.log(`  [${i + 1}] ${path.basename(f)} (${(fs.statSync(f).size / (1024 * 1024)).toFixed(2)} MB)`);
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

    if (!fs.existsSync(targetEncFile)) {
      console.log(`❌ Error: El archivo "${targetEncFile}" no existe.`);
      rl.close();
      return;
    }

    const keyChoice = await question(`Frase secreta de cifrado [Enter para usar la actual del sistema]: `);
    const keyPhrase = keyChoice.trim() || defaultSecret;

    const outputTarGz = targetEncFile.replace(/\.enc$/, '');
    console.log(`\n⏳ Descifrando archivo hacia: ${outputTarGz}...`);

    try {
      await CryptoService.decryptFile(targetEncFile, outputTarGz, keyPhrase);
      const sizeMB = (fs.statSync(outputTarGz).size / (1024 * 1024)).toFixed(2);
      console.log(`\n🎉 ¡Archivo descifrado con éxito!`);
      console.log(`📦 Ubicación: ${outputTarGz} (${sizeMB} MB)`);
      console.log(`👉 Puedes descomprimirlo con: tar -xzvf "${outputTarGz}"`);
    } catch (err: any) {
      console.log(`\n❌ Fallo al descifrar: ${err.message}`);
      console.log(`💡 Verifica que la clave ingresada sea la correcta.`);
    }

  } else if (choice === '5') {
    console.log('\n⚠️ ADVERTENCIA: Esta acción eliminará toda la configuración, usuarios y llaves del sistema.');
    const confirm = await question('¿Estás seguro de continuar? Escribe "RESET" para confirmar: ');

    if (confirm === 'RESET') {
      db.prepare('DELETE FROM passkeys').run();
      db.prepare('DELETE FROM users').run();
      db.prepare('DELETE FROM settings').run();
      db.prepare('DELETE FROM clients').run();
      db.prepare('DELETE FROM backup_logs').run();
      db.prepare('DELETE FROM share_links').run();

      console.log('\n✅ ¡Sistema reiniciado de cero! Accede a http://localhost:3000 para volver a configurar la plataforma.');
    } else {
      console.log('Operación cancelada.');
    }
  }

  rl.close();
}

main().catch(err => {
  console.error('Error fatal en recuperación:', err);
  rl.close();
});
