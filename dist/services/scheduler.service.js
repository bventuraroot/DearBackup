"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SchedulerService = void 0;
const node_cron_1 = __importDefault(require("node-cron"));
const database_1 = require("../db/database");
const backup_service_1 = require("./backup.service");
class SchedulerService {
    static tasks = new Map();
    /**
     * Inicializa el scheduler cargando todos los clientes activos
     */
    static init() {
        console.log('⏰ Inicializando motor de programación Cron de DearBackup...');
        this.reloadAllSchedules();
    }
    /**
     * Recarga todas las tareas programadas desde la base de datos
     */
    static reloadAllSchedules() {
        // Cancelar tareas existentes
        for (const [id, task] of this.tasks.entries()) {
            task.stop();
        }
        this.tasks.clear();
        const clients = database_1.db.prepare('SELECT * FROM clients WHERE is_active = 1').all();
        for (const client of clients) {
            if (client.cron_schedule && node_cron_1.default.validate(client.cron_schedule)) {
                try {
                    const scheduledTask = node_cron_1.default.schedule(client.cron_schedule, async () => {
                        console.log(`⏰ Ejecutando respaldo programado para: ${client.name} (${client.id})`);
                        await backup_service_1.BackupService.runBackup(client, 'cron_scheduler');
                    });
                    this.tasks.set(client.id, scheduledTask);
                    console.log(`  ✓ Tarea programada para "${client.name}": [${client.cron_schedule}]`);
                }
                catch (err) {
                    console.error(`Error programando cron para ${client.name}:`, err);
                }
            }
        }
    }
    /**
     * Actualiza o registra la tarea cron de un cliente individual
     */
    static updateClientSchedule(client) {
        if (this.tasks.has(client.id)) {
            this.tasks.get(client.id)?.stop();
            this.tasks.delete(client.id);
        }
        if (client.is_active && client.cron_schedule && node_cron_1.default.validate(client.cron_schedule)) {
            try {
                const scheduledTask = node_cron_1.default.schedule(client.cron_schedule, async () => {
                    console.log(`⏰ Ejecutando respaldo programado para: ${client.name} (${client.id})`);
                    await backup_service_1.BackupService.runBackup(client, 'cron_scheduler');
                });
                this.tasks.set(client.id, scheduledTask);
            }
            catch (err) {
                console.error(`Error programando cron para ${client.name}:`, err);
            }
        }
    }
    /**
     * Elimina la tarea de un cliente
     */
    static removeClientSchedule(clientId) {
        if (this.tasks.has(clientId)) {
            this.tasks.get(clientId)?.stop();
            this.tasks.delete(clientId);
        }
    }
}
exports.SchedulerService = SchedulerService;
