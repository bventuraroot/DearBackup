# 🛡️ DearBackup

> **Orquestador Moderno, Seguro y Contenerizado de Respaldos Multi-Servidor**  
> Especializado en **Bases de Datos (MySQL / MariaDB / PostgreSQL)** y **Facturación Electrónica (DTEs, XMLs, PDFs y Certificados)** con Cifrado AES-256, Multi-Cloud y Alertas en Tiempo Real.

---

## ✨ Características Principales

- **Conexión SSH sin Agentes:** No necesitas instalar software en tus clientes. Solo agregas la llave pública de DearBackup al `authorized_keys` del cliente.
- **Doble Respaldo Sincronizado:** Vuelca la base de datos de facturación (`mysqldump` / `pg_dump` con streaming) y empaqueta las carpetas de DTEs/XMLs/PDFs en un solo paquete maestro.
- **Seguridad de Grado Bancario:**
  - **Vault de Credenciales:** Contraseñas de bases de datos y llaves privadas SSH cifradas con **AES-256-GCM**.
  - **Cifrado de Respaldos:** Archivos `.tar.gz.enc` cifrados en reposo antes de almacenarse o enviarse a la nube.
  - **Integridad Matemática:** Cálculo y verificación de Checksums **SHA-256** para cada copia de seguridad.
- **Multi-Destino en la Nube:** Sincronización automática con **Cloudflare R2** ($0 por egress/descarga), **Amazon S3**, **Backblaze B2**, **Wasabi** o servidores **MinIO**.
- **Notificaciones & Alertas:**
  - **Email (SMTP):** Reportes visuales HTML con botón de descarga segura temporal.
  - **Telegram Bot:** Alertas instantáneas al móvil con estado de éxito o fallos críticos.
- **Enlaces de Descarga Seguros y Temporales:** Genera enlaces públicos protegidos con token y tiempo de expiración (24h/48h) para que los clientes o tú descarguen sus backups con 1 clic.
- **Consola / Terminal en Tiempo Real:** Streaming por **WebSockets** para ver el progreso paso a paso de cada backup en vivo.
- **Diagnóstico en 1 Clic:** Botón para probar la conexión SSH y la base de datos remota antes de guardar un cliente.
- **Políticas de Retención Automática:** Purga automática de respaldos antiguos (por días o cantidad de copias) tanto en el VPS local como en la nube.

---

## 🚀 Despliegue Rápido con Docker (Recomendado)

### 1. Clonar o subir a tu VPS
```bash
cd /opt/DearBackup
```

### 2. Configurar variables (Opcional)
```bash
cp .env.example .env
```

### 3. Iniciar con Docker Compose
```bash
docker compose up -d --build
```

¡Listo! Abre tu navegador en `http://tu-ip-o-dominio:3000`.

---

## 💻 Instalación Local o Directa con Node.js

Si prefieres ejecutarlo sin Docker en tu servidor:

```bash
# 1. Instalar dependencias
npm install

# 2. Compilar TypeScript
npm run build

# 3. Iniciar en producción (o usar PM2)
npm start
```

Con PM2:
```bash
pm2 start dist/index.js --name dearbackup
pm2 save
```

---

## 📦 Migración, Exportación y Restauración de Base de Datos

Si vas a migrar DearBackup a otra computadora o laptop (Windows 11, Linux o macOS), sigue cualquiera de estos métodos.

### 1. Exportar en la máquina actual
- **Desde la Terminal:**
  ```bash
  npm run export-db
  ```
  Genera un paquete consolidado `.tar.gz` en `backups/system_exports/` que incluye la base de datos `dearbackup.db`, la clave del Vault `.vault_key` y el archivo `.env`.
- **Desde la Web:** Ve a **Ajustes > Descargar Base de Datos (dearbackup.db)**.

---

### 2. Restaurar en la nueva computadora (Por Terminal - Método Rápido y 100% Seguro)

> [!IMPORTANT]
> **En Windows 11**: Si tienes abierto `npm run dev` o `npm start`, presiona `Ctrl + C` para detener el servidor antes de importar por terminal. Esto evita errores de bloqueo de archivo (`EBUSY: resource busy or locked`).

Pasa el archivo descargado (`.db` o `.tar.gz`) a la carpeta de DearBackup en tu nuevo equipo y ejecuta:

```bash
# Opción A: Restaurar manteniendo tus credenciales originales
npm run import-db -- "ruta/al/archivo.db"

# Opción B: Si tienes un archivo .tar.gz exportado
npm run import-db -- "dearbackup_full_db_2026-09-14T01-40-15.tar.gz"

# Opción C: Restaurar y definir de una vez una NUEVA contraseña de admin
npm run import-db -- "dearbackup.db" --reset-pass "MiNuevaClave2026"
```

El script verificará la integridad SQLite, listará los nombres de usuario exactos registrados en la base de datos (por ejemplo: `brianv`) y te confirmará el estado del Vault.

Luego inicia el servidor:
```bash
npm run dev
```

---

### 3. Herramienta de Recuperación de Emergencia (CLI Interactivo)

Si no recuerdas la contraseña de administrador, tu usuario o la frase secreta del Vault, usa la herramienta integrada:

```bash
npm run recovery
```

Menú disponible:
1. `🔐 Restablecer Frase Secreta del Vault`: Deriva una nueva Master Key y actualiza `data/.vault_key`.
2. `🔑 Ver y Restablecer Contraseña de Administrador`: Lista los usuarios reales del sistema (`brianv`) y te permite cambiar su contraseña en segundos.
3. `📲 Desactivar 2FA / Passkeys`: Permite entrar con solo contraseña si perdiste tu autenticador.
4. `🔓 Descifrar un archivo de respaldo (.enc)`: Descifra copias de clientes protegidas.
5. `📥 Restaurar Base de Datos desde archivo`: Permite cargar un `.db` o `.tar.gz` de forma guiada.
6. `🗑️ Reiniciar plataforma de cero`: Limpia todos los datos para volver al asistente inicial.

---

### 4. Restauración Directa vía Web

- **Al instalar en un equipo nuevo:** En la pantalla de bienvenida (Setup), haz clic en **"🗄️ ¿Tienes un respaldo (.db / .tar.gz)? Restaurar aquí"**, sube tu archivo y (opcionalmente) asigna una nueva contraseña para ingresar de inmediato.
- **Con la plataforma activa:** Ve a **Ajustes > Subir y Restaurar dearbackup.db**, selecciona el archivo e ingresa tu clave si deseas renovarla.

---

## 🛠️ Flujo de Configuración en 3 Pasos

1. **Paso 1: Asistente Inicial (Setup Wizard):**  
   Al abrir la plataforma por primera vez, crea tu usuario administrador y define la **Frase Maestra del Vault (Master Key)**.
2. **Paso 2: Autorizar Llave SSH en el Cliente:**  
   Haz clic en **"Ver Llave SSH Pública"** en la barra superior y cópiala en tu servidor cliente:
   ```bash
   echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5..." >> ~/.ssh/authorized_keys
   chmod 600 ~/.ssh/authorized_keys
   ```
3. **Paso 3: Agregar Cliente y Probar Conexión:**  
   Ingresa los datos de conexión SSH, base de datos y ruta de DTEs (ej: `/var/www/facturacion/storage/dtes`), haz clic en **"Probar Conexión en 1 Clic"** y guarda.

---

## 🔒 Arquitectura de Seguridad

```
[ Servidor Remoto ] ──(Túnel SSH)──> [ Extracción Stream ]
                                            │
                                            ▼
                                   [ Checksum SHA-256 ]
                                            │
                                            ▼
                                  [ Cifrado AES-256-CBC ]
                                            │
                    ┌───────────────────────┴───────────────────────┐
                    ▼                                               ▼
         [ Almacén Local VPS ]                            [ Cloudflare R2 / S3 ]
```

---

## 📄 Licencia
MIT License • Creado para máxima resiliencia y disponibilidad ante caídas de proveedores de hosting.
