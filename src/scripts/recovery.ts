import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { db, initDatabase, replaceDatabaseFile } from '../db/database';
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
  console.log('  2. 🔑 Ver y Restablecer Contraseña de Administrador');
  console.log('  3. 📲 Desactivar 2FA / Passkeys de emergencia');
  console.log('  4. 🔓 Descifrar un archivo de respaldo (.enc)');
  console.log('  5. 📥 Restaurar Base de Datos desde archivo (.db o .tar.gz)');
  console.log('  6. 🗑️ Reiniciar plataforma de cero (Borrar todo y volver al Setup)');
  console.log('  7. 🚪 Salir\n');

  const choice = (await question('Ingresa una opción (1-7): ')).trim();

  if (choice === '1') {
    console.log('\n--- 🔐 RESTABLECER FRASE SECRETA DEL VAULT ---');
    console.log('ℹ️ Esta frase permite derivar la clave que cifra y descifra las contraseñas.');
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

    // Regenerar llave SSH del sistema con la nueva frase y persistir .vault_key
    VaultService.setMasterKeyDirect(derivedKey, newPhrase, true);
    VaultService.persistKey(newPhrase);
    VaultService.getOrCreateSystemSSHKey();

    console.log('\n✅ ¡Frase Secreta del Vault restablecida exitosamente!');
    console.log('👉 Se actualizó el archivo .vault_key para desbloqueo automático.');
    console.log('👉 Ahora puedes ingresar al panel con tu nueva frase.');

  } else if (choice === '2') {
    console.log('\n--- 🔑 VER Y RESTABLECER CONTRASEÑA DE ADMINISTRADOR ---');
    const allUsers = db.prepare('SELECT id, username, role FROM users').all() as any[];

    let targetUser: any = null;
    if (allUsers.length === 0) {
      console.log('⚠️ No hay usuarios registrados en la base de datos.');
      const create = await question('¿Deseas crear un usuario administrador ahora? (s/n): ');
      if (create.toLowerCase() === 's') {
        const newUsername = (await question('Nombre de usuario (ej: admin): ')).trim().toLowerCase() || 'admin';
        const newPass = await question('Nueva contraseña (min. 8 caracteres): ');
        if (!newPass || newPass.length < 8) {
          console.log('❌ Error: La contraseña debe tener al menos 8 caracteres.');
          rl.close();
          return;
        }
        const newHash = await bcrypt.hash(newPass, 10);
        const newId = crypto.randomUUID();
        db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, "admin")').run(newId, newUsername, newHash);
        console.log(`\n✅ ¡Usuario administrador "${newUsername}" creado exitosamente!`);
      }
      rl.close();
      return;
    }

    console.log('Usuarios encontrados en la base de datos:');
    allUsers.forEach((u, i) => {
      console.log(`  [${i + 1}] ${u.username} (Rol: ${u.role})`);
    });

    const userSelect = (await question(`\nSelecciona el número de usuario o escribe el nombre [1]: `)).trim() || '1';
    const numIdx = parseInt(userSelect, 10) - 1;
    if (numIdx >= 0 && numIdx < allUsers.length) {
      targetUser = allUsers[numIdx];
    } else {
      targetUser = allUsers.find(u => u.username.toLowerCase() === userSelect.toLowerCase());
    }

    if (!targetUser) {
      console.log(`❌ Error: Usuario "${userSelect}" no encontrado.`);
      rl.close();
      return;
    }

    const newPass = await question(`Nueva contraseña para "${targetUser.username}" (min. 8 caracteres): `);
    if (!newPass || newPass.length < 8) {
      console.log('❌ Error: La contraseña debe tener al menos 8 caracteres.');
      rl.close();
      return;
    }

    const newHash = await bcrypt.hash(newPass, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, targetUser.id);

    console.log(`\n✅ ¡Contraseña de "${targetUser.username}" restablecida correctamente!`);
    console.log(`👉 Ahora puedes iniciar sesión con:`);
    console.log(`   Usuario: ${targetUser.username}`);
    console.log(`   Contraseña: <la que acabas de escribir>`);

  } else if (choice === '3') {
    console.log('\n--- 📲 DESACTIVAR 2FA Y PASSKEYS DE EMERGENCIA ---');
    const allUsers = db.prepare('SELECT id, username FROM users').all() as any[];
    if (allUsers.length === 0) {
      console.log('⚠️ No hay usuarios registrados.');
      rl.close();
      return;
    }

    allUsers.forEach((u, i) => console.log(`  [${i + 1}] ${u.username}`));
    const userSelect = (await question('\nSelecciona el número de usuario o escribe el nombre [1]: ')).trim() || '1';
    const numIdx = parseInt(userSelect, 10) - 1;
    const user = (numIdx >= 0 && numIdx < allUsers.length)
      ? allUsers[numIdx]
      : allUsers.find(u => u.username.toLowerCase() === userSelect.toLowerCase());

    if (!user) {
      console.log(`❌ Error: El usuario no existe.`);
      rl.close();
      return;
    }

    db.prepare('UPDATE users SET two_factor_secret = NULL, two_factor_enabled = 0 WHERE id = ?').run(user.id);
    db.prepare('DELETE FROM passkeys WHERE user_id = ?').run(user.id);

    console.log(`\n✅ ¡2FA y Passkeys desactivados para "${user.username}"! Ahora puedes iniciar con solo tu contraseña.`);

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
    console.log('\n--- 📥 RESTAURAR BASE DE DATOS (.db o .tar.gz) ---');
    const filePath = (await question('Ruta del archivo (.db o .tar.gz): ')).trim();
    if (!filePath || !fs.existsSync(filePath)) {
      console.log(`❌ Error: El archivo "${filePath}" no existe.`);
      rl.close();
      return;
    }

    try {
      const buffer = fs.readFileSync(filePath);
      const res = replaceDatabaseFile(buffer);
      console.log(`\n🎉 ¡Base de datos restaurada con éxito!`);
      console.log(`✓ Clientes registrados: ${res.clientCount}`);
      console.log(`✓ Usuarios registrados: ${res.userCount}`);
      res.users.forEach(u => console.log(`   - Usuario: "${u.username}" (Rol: ${u.role})`));

      if (res.restoredVaultKey) {
        console.log('✓ Archivo .vault_key detectado y montado automáticamente.');
      }

      if (res.users.length > 0) {
        const resetPass = await question('\n¿Deseas asignar una NUEVA contraseña al usuario administrador ahora? (s/n): ');
        if (resetPass.toLowerCase() === 's') {
          const adminUser = res.users.find(u => u.role === 'admin') || res.users[0];
          const newPass = await question(`Nueva contraseña para "${adminUser.username}" (min. 8 caracteres): `);
          if (newPass && newPass.length >= 8) {
            const newHash = await bcrypt.hash(newPass, 10);
            db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, adminUser.id);
            console.log(`✅ ¡Contraseña actualizada! Inicia sesión con "${adminUser.username}" y tu nueva clave.`);
          }
        }
      }

      const unlockVault = await question('\n¿Deseas ingresar la Frase Secreta del Vault ahora? (s/n): ');
      if (unlockVault.toLowerCase() === 's') {
        const vPhrase = await question('Frase del Vault: ');
        if (vPhrase) {
          const ok = VaultService.initializeMasterKey(vPhrase, true);
          if (ok) {
            console.log('✅ ¡Vault desbloqueado exitosamente y clave guardada en .vault_key!');
          } else {
            console.log('⚠️ La frase no coincide con el registro del vault en este archivo.');
          }
        }
      }

    } catch (e: any) {
      console.log(`❌ Error al restaurar: ${e.message}`);
    }

  } else if (choice === '6') {
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
