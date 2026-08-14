const fs = require('fs');
const path = require('path');

const srcPublic = path.join(__dirname, '..', 'src', 'public');
const distPublic = path.join(__dirname, '..', 'dist', 'public');

if (fs.existsSync(srcPublic)) {
  fs.cpSync(srcPublic, distPublic, { recursive: true });
  console.log('✓ Archivos estáticos de src/public copiados a dist/public');
}
