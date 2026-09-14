import express from 'express';
import http from 'http';
import path from 'path';
import cors from 'cors';
import dotenv from 'dotenv';
import { WebSocketServer, WebSocket } from 'ws';

// Cargar variables de entorno
dotenv.config();

// Inicializar base de datos
import { initDatabase } from './db/database';
initDatabase();

// Servicios
import { VaultService } from './services/vault.service';
import { SchedulerService } from './services/scheduler.service';
import { BackupService } from './services/backup.service';

// Rutas
import authRoutes from './routes/auth.routes';
import clientsRoutes from './routes/clients.routes';
import backupsRoutes from './routes/backups.routes';
import settingsRoutes from './routes/settings.routes';
import statsRoutes from './routes/stats.routes';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Middlewares
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Servir frontend estático
const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));

// Rutas API
app.use('/api/auth', authRoutes);
app.use('/api/clients', clientsRoutes);
app.use('/api/backups', backupsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/stats', statsRoutes);

// Fallback SPA
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/ws')) {
    return next();
  }
  res.sendFile(path.join(publicPath, 'index.html'));
});

// Manejo de conexiones WebSockets para streaming de logs y eventos en tiempo real
const connectedSockets = new Set<WebSocket>();

wss.on('connection', (ws: WebSocket) => {
  connectedSockets.add(ws);

  ws.send(JSON.stringify({ type: 'connected', message: 'Conectado al bus de eventos de DearBackup' }));

  ws.on('message', (message: string) => {
    try {
      const data = JSON.parse(message.toString());
      if (data.type === 'subscribe_logs' && data.backupId) {
        // Suscribirse a los logs en tiempo real de una tarea específica
        BackupService.onLog(data.backupId, (logLine) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'log', backupId: data.backupId, log: logLine }));
          }
        });
      }
    } catch (e) {
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
    VaultService.tryAutoUnlock();
  } catch (e: any) {
    console.warn('Aviso auto-desbloqueo:', e.message);
  }

  // Inicializar llave SSH por defecto
  try {
    VaultService.getOrCreateSystemSSHKey();
  } catch (e) {
    console.error('Nota: Vault pendiente de inicialización en primer inicio');
  }

  // Inicializar programador de tareas
  SchedulerService.init();
});
