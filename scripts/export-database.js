const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');

const rootDir = path.resolve(__dirname, '..');
const dataDir = process.env.DATA_DIR || path.join(rootDir, 'data');
const liveDbPath = path.join(dataDir, 'dearbackup.db');

if (!fs.existsSync(liveDbPath)) {
  console.error('❌ Error: No se encontró la base de datos en: ' + liveDbPath);
  process.exit(1);
}

console.log('⏳ Forzando checkpoint de SQLite para asegurar que todo esté en disco...');
try {
  const db = new Database(liveDbPath);
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
} catch (e) {
  console.warn('Aviso checkpoint:', e.message);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const exportDir = path.join(rootDir, 'backups', 'system_exports');
if (!fs.existsSync(exportDir)) {
  fs.mkdirSync(exportDir, { recursive: true });
}

const outTar = path.join(exportDir, `dearbackup_full_db_${timestamp}.tar.gz`);

console.log('📦 Empaquetando base de datos y llaves...');

// Crear lista de archivos a incluir
const itemsToInclude = ['data/dearbackup.db'];
if (fs.existsSync(path.join(rootDir, 'data', '.vault_key'))) {
  itemsToInclude.push('data/.vault_key');
}
if (fs.existsSync(path.join(rootDir, '.env'))) {
  itemsToInclude.push('.env');
}

const tarCmd = `tar -czf "${outTar}" ${itemsToInclude.join(' ')}`;
execSync(tarCmd, { cwd: rootDir, stdio: 'inherit' });

const stats = fs.statSync(outTar);
const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);

console.log('\n======================================================');
console.log('🎉 ¡EXPORTACIÓN DE BASE DE DATOS COMPLETADA CON ÉXITO!');
console.log('======================================================');
console.log(`📦 Archivo generado: ${outTar} (${sizeMB} MB)`);
console.log('\n👉 Para restaurar este archivo en otra máquina:');
console.log(`   1. Pasa el archivo "${path.basename(outTar)}" a la otra laptop.`);
console.log(`   2. En la carpeta DearBackup de la otra laptop ejecuta:`);
console.log(`      npm run import-db -- "${path.basename(outTar)}"`);
console.log('======================================================\n');
