"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const path_1 = __importDefault(require("path"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const ws_1 = require("ws");
// Cargar variables de entorno
dotenv_1.default.config();
// Inicializar base de datos
const database_1 = require("./db/database");
(0, database_1.initDatabase)();
// Servicios
const vault_service_1 = require("./services/vault.service");
const scheduler_service_1 = require("./services/scheduler.service");
const backup_service_1 = require("./services/backup.service");
// Rutas
const auth_routes_1 = __importDefault(require("./routes/auth.routes"));
const clients_routes_1 = __importDefault(require("./routes/clients.routes"));
const backups_routes_1 = __importDefault(require("./routes/backups.routes"));
const settings_routes_1 = __importDefault(require("./routes/settings.routes"));
const stats_routes_1 = __importDefault(require("./routes/stats.routes"));
const app = (0, express_1.default)();
const server = http_1.default.createServer(app);
const wss = new ws_1.WebSocketServer({ server, path: '/ws' });
// Middlewares
app.use((0, cors_1.default)());
app.use(express_1.default.json({ limit: '50mb' }));
app.use(express_1.default.urlencoded({ extended: true, limit: '50mb' }));
// Servir frontend estático
const publicPath = path_1.default.join(__dirname, 'public');
app.use(express_1.default.static(publicPath));
// Rutas API
app.use('/api/auth', auth_routes_1.default);
app.use('/api/clients', clients_routes_1.default);
app.use('/api/backups', backups_routes_1.default);
app.use('/api/settings', settings_routes_1.default);
app.use('/api/stats', stats_routes_1.default);
// Fallback SPA
app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/ws')) {
        return next();
    }
    res.sendFile(path_1.default.join(publicPath, 'index.html'));
});
// Manejo de conexiones WebSockets para streaming de logs y eventos en tiempo real
const connectedSockets = new Set();
wss.on('connection', (ws) => {
    connectedSockets.add(ws);
    ws.send(JSON.stringify({ type: 'connected', message: 'Conectado al bus de eventos de DearBackup' }));
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());
            if (data.type === 'subscribe_logs' && data.backupId) {
                // Suscribirse a los logs en tiempo real de una tarea específica
                backup_service_1.BackupService.onLog(data.backupId, (logLine) => {
                    if (ws.readyState === ws_1.WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'log', backupId: data.backupId, log: logLine }));
                    }
                });
            }
        }
        catch (e) {
            console.error('Error parseando mensaje WS:', e);
        }
    });
    ws.on('close', () => {
        connectedSockets.delete(ws);
    });
});
// Inicializar servicios de fondo
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`
  ╔══════════════════════════════════════════════════════════════════════╗
  ║                                                                      ║
  ║   🛡️  DEARBACKUP - Orquestador de Respaldos Multi-Servidor          ║
  ║   🚀  Servidor activo en: http://localhost:${PORT}                    ║
  ║   📂  DTEs & Bases de Datos Cifradas AES-256                          ║
  ║                                                                      ║
  ╚══════════════════════════════════════════════════════════════════════╝
  `);
    // Intentar auto-desbloqueo seguro del Vault (desde .vault_key o variable de entorno)
    try {
        vault_service_1.VaultService.tryAutoUnlock();
    }
    catch (e) {
        console.warn('Aviso auto-desbloqueo:', e.message);
    }
    // Inicializar llave SSH por defecto
    try {
        vault_service_1.VaultService.getOrCreateSystemSSHKey();
    }
    catch (e) {
        console.error('Nota: Vault pendiente de inicialización en primer inicio');
    }
    // Inicializar programador de tareas
    scheduler_service_1.SchedulerService.init();
});
// Protección contra caídas abruptas del servidor por errores no controlados
process.on('uncaughtException', (err) => {
    console.error('⚠️ Error no capturado (uncaughtException):', err.message);
});
process.on('unhandledRejection', (reason) => {
    console.error('⚠️ Promesa rechazada no capturada (unhandledRejection):', reason?.message || reason);
});
