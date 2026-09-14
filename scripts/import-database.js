const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const rootDir = path.resolve(__dirname, '..');
const targetDataDir = process.env.DATA_DIR || path.join(rootDir, 'data');
if (!fs.existsSync(targetDataDir)) {
  fs.mkdirSync(targetDataDir, { recursive: true });
}

const args = process.argv.slice(2);
let inputFile = null;
let newPasswordArg = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--reset-pass' && args[i + 1]) {
    newPasswordArg = args[i + 1];
    i++;
  } else if (!inputFile && !args[i].startsWith('--')) {
    inputFile = args[i];
  }
}

if (!inputFile) {
  // Buscar archivos de exportación en backups/system_exports
  const exportDir = path.join(rootDir, 'backups', 'system_exports');
  if (fs.existsSync(exportDir)) {
    const files = fs.readdirSync(exportDir)
      .filter(f => f.endsWith('.tar.gz') || f.endsWith('.db'))
      .map(f => ({ name: f, time: fs.statSync(path.join(exportDir, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time);

    if (files.length > 0) {
      inputFile = path.join(exportDir, files[0].name);
      console.log(`ℹ️ No se especificó archivo. Usando el respaldo más reciente: ${files[0].name}`);
    }
  }
}

if (!inputFile || !fs.existsSync(inputFile)) {
  console.error('\n❌ Uso: npm run import-db -- <ruta-al-archivo> [--reset-pass <nueva-clave>]');
  console.error('Ejemplos:');
  console.error('  npm run import-db -- dearbackup_full_db_2026-09-14T01-40-15.tar.gz');
  console.error('  npm run import-db -- dearbackup.db --reset-pass MiClaveSegura2026');
  console.error('  npm run import-db -- data/dearbackup.db\n');
  process.exit(1);
}

console.log(`⏳ Importando base de datos desde: ${inputFile}...`);

const liveDbPath = path.join(targetDataDir, 'dearbackup.db');

// Respaldar base de datos previa si existe
if (fs.existsSync(liveDbPath)) {
  const preBackupPath = path.join(targetDataDir, `dearbackup_backup_pre_import_${Date.now()}.db.bak`);
  try {
    fs.copyFileSync(liveDbPath, preBackupPath);
    console.log(`🛡️ Copia de seguridad previa guardada en: ${path.basename(preBackupPath)}`);
  } catch (err) {
    if (err.code === 'EBUSY' || err.message.includes('EBUSY') || err.message.includes('resource busy')) {
      console.error('\n❌ ERROR: La base de datos está bloqueada por otro proceso (DearBackup está corriendo).');
      console.error('💡 En Windows, debes detener el servidor antes de reemplazar la base de datos.');
      console.error('👉 Ve a la terminal donde ejecutaste "npm run dev" o "npm start", presiona Ctrl+C para detenerlo, y vuelve a ejecutar este comando.\n');
      process.exit(1);
    }
  }
}

try {
  if (inputFile.endsWith('.tar.gz')) {
    // Extraer archivo tar.gz
    execSync(`tar -xzf "${inputFile}" -C "${rootDir}"`, { stdio: 'inherit' });
  } else if (inputFile.endsWith('.db') || inputFile.endsWith('.sqlite')) {
    // Copiar archivo .db directamente
    fs.copyFileSync(inputFile, liveDbPath);
  } else {
    console.error('❌ Formato no reconocido. Debe ser un archivo .tar.gz o .db');
    process.exit(1);
  }
} catch (err) {
  if (err.code === 'EBUSY' || err.message.includes('EBUSY') || err.message.includes('resource busy')) {
    console.error('\n❌ ERROR: La base de datos está bloqueada por otro proceso (DearBackup está corriendo).');
    console.error('💡 En Windows, debes detener el servidor antes de reemplazar la base de datos.');
    console.error('👉 Ve a la terminal donde ejecutaste "npm run dev" o "npm start", presiona Ctrl+C para detenerlo, y vuelve a ejecutar este comando.\n');
    process.exit(1);
  }
  console.error('❌ Error copiando o extrayendo el archivo:', err.message);
  process.exit(1);
}

// Limpiar archivos WAL/SHM temporales antiguos para forzar apertura limpia del nuevo archivo
try {
  if (fs.existsSync(`${liveDbPath}-wal`)) fs.unlinkSync(`${liveDbPath}-wal`);
  if (fs.existsSync(`${liveDbPath}-shm`)) fs.unlinkSync(`${liveDbPath}-shm`);
} catch (err) {
  if (err.code === 'EBUSY') {
    console.warn('Aviso: WAL/SHM bloqueados por un proceso activo.');
  }
}

// Verificar integridad de la base de datos importada
try {
  const db = new Database(liveDbPath);
  const check = db.prepare('PRAGMA integrity_check').get();
  const clientsCount = (db.prepare('SELECT COUNT(*) as c FROM clients').get()).c;
  const users = db.prepare('SELECT id, username, role FROM users').all();
  
  console.log('\n======================================================');
  console.log('🎉 ¡BASE DE DATOS RESTAURADA Y VERIFICADA CON ÉXITO!');
  console.log('======================================================');
  console.log(`✓ Integridad SQLite: ${check.integrity_check || 'OK'}`);
  console.log(`✓ Clientes/Servidores disponibles: ${clientsCount}`);
  console.log(`✓ Total de usuarios registrados: ${users.length}`);

  console.log('\n👤 Usuarios encontrados para iniciar sesión:');
  users.forEach((u, i) => {
    console.log(`   [${i + 1}] Usuario: "${u.username}" (Rol: ${u.role})`);
  });

  // Si se proporcionó argumento --reset-pass, actualizar la contraseña
  if (newPasswordArg && users.length > 0) {
    if (newPasswordArg.length < 8) {
      console.log('\n⚠️ Aviso: La contraseña proporcionada en --reset-pass debe tener al menos 8 caracteres.');
    } else {
      const adminUser = users.find(u => u.role === 'admin') || users[0];
      const newHash = bcrypt.hashSync(newPasswordArg, 10);
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, adminUser.id);
      console.log(`\n🔑 Contraseña de administrador actualizada para "${adminUser.username}": "${newPasswordArg}"`);
    }
  }

  // Verificar estado del Vault
  const vaultKeyPath = path.join(targetDataDir, '.vault_key');
  if (fs.existsSync(vaultKeyPath)) {
    console.log('🔐 Frase del Vault: Detectada automáticamente en data/.vault_key.');
  } else {
    console.log('ℹ️ Frase del Vault: No se detectó data/.vault_key. Al iniciar sesión se solicitará la Frase Maestra para descifrar clientes.');
  }

  db.close();

  console.log('\n🚀 Ya puedes iniciar tu plataforma ejecutando:');
  console.log('   npm run dev');
  console.log('======================================================\n');
} catch (err) {
  console.error('❌ Error al validar la base de datos importada:', err.message);
  process.exit(1);
}
