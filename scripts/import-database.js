const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');

const rootDir = path.resolve(__dirname, '..');
const targetDataDir = process.env.DATA_DIR || path.join(rootDir, 'data');
if (!fs.existsSync(targetDataDir)) {
  fs.mkdirSync(targetDataDir, { recursive: true });
}

const args = process.argv.slice(2);
let inputFile = args[0];

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
  console.error('\n❌ Uso: npm run import-db -- <ruta-al-archivo>');
  console.error('Ejemplos:');
  console.error('  npm run import-db -- dearbackup_full_db_2026-09-13.tar.gz');
  console.error('  npm run import-db -- dearbackup.db\n');
  process.exit(1);
}

console.log(`⏳ Importando base de datos desde: ${inputFile}...`);

// Respaldar base de datos previa si existe
const liveDbPath = path.join(targetDataDir, 'dearbackup.db');
if (fs.existsSync(liveDbPath)) {
  const preBackupPath = path.join(targetDataDir, `dearbackup_backup_pre_import_${Date.now()}.db.bak`);
  try {
    fs.copyFileSync(liveDbPath, preBackupPath);
    console.log(`🛡️ Copia de seguridad previa guardada en: ${path.basename(preBackupPath)}`);
  } catch {}
}

if (inputFile.endsWith('.tar.gz')) {
  // Extraer archivo tar.gz
  execSync(`tar -xzf "${inputFile}" -C "${rootDir}"`, { stdio: 'inherit' });
} else if (inputFile.endsWith('.db')) {
  // Copiar archivo .db directamente
  fs.copyFileSync(inputFile, liveDbPath);
} else {
  console.error('❌ Formato no reconocido. Debe ser un archivo .tar.gz o .db');
  process.exit(1);
}

// Limpiar archivos WAL/SHM temporales antiguos para forzar apertura limpia del nuevo archivo
try {
  if (fs.existsSync(`${liveDbPath}-wal`)) fs.unlinkSync(`${liveDbPath}-wal`);
  if (fs.existsSync(`${liveDbPath}-shm`)) fs.unlinkSync(`${liveDbPath}-shm`);
} catch {}

// Verificar integridad de la base de datos importada
try {
  const db = new Database(liveDbPath);
  const check = db.prepare('PRAGMA integrity_check').get();
  const clientsCount = (db.prepare('SELECT COUNT(*) as c FROM clients').get()).c;
  const usersCount = (db.prepare('SELECT COUNT(*) as c FROM users').get()).c;
  db.close();

  console.log('\n======================================================');
  console.log('🎉 ¡BASE DE DATOS RESTAURADA Y VERIFICADA CON ÉXITO!');
  console.log('======================================================');
  console.log(`✓ Integridad SQLite: ${check.integrity_check || 'OK'}`);
  console.log(`✓ Clientes/Servidores disponibles: ${clientsCount}`);
  console.log(`✓ Usuarios registrados: ${usersCount}`);
  console.log('\n🚀 Ya puedes iniciar tu plataforma ejecutando:');
  console.log('   npm run dev');
  console.log('======================================================\n');
} catch (err) {
  console.error('❌ Error al validar la base de datos importada:', err.message);
  process.exit(1);
}
