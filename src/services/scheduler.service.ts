import cron from 'node-cron';
import { db } from '../db/database';
import { BackupService, ClientData } from './backup.service';
import { SelfBackupService } from './self-backup.service';

export class SchedulerService {
  private static tasks: Map<string, cron.ScheduledTask> = new Map();

  /**
   * Inicializa el scheduler cargando todos los clientes activos
   */
  public static init(): void {
    console.log('⏰ Inicializando motor de programación Cron de DearBackup...');
    this.reloadAllSchedules();
  }

  /**
   * Recarga todas las tareas programadas desde la base de datos
   */
  public static reloadAllSchedules(): void {
    // Cancelar tareas existentes
    for (const [id, task] of this.tasks.entries()) {
      task.stop();
    }
    this.tasks.clear();

    const clients = db.prepare('SELECT * FROM clients WHERE is_active = 1').all() as ClientData[];

    for (const client of clients) {
      if (client.cron_schedule && cron.validate(client.cron_schedule)) {
        try {
          const scheduledTask = cron.schedule(client.cron_schedule, async () => {
            console.log(`⏰ Ejecutando respaldo programado para: ${client.name} (${client.id})`);
            await BackupService.runBackup(client, 'cron_scheduler');
          });

          this.tasks.set(client.id, scheduledTask);
          console.log(`  ✓ Tarea programada para "${client.name}": [${client.cron_schedule}]`);
        } catch (err) {
          console.error(`Error programando cron para ${client.name}:`, err);
        }
      }
    }

    // Programar auto-respaldo diario de la base de datos de DearBackup (03:00 AM)
    try {
      const selfBackupTask = cron.schedule('0 3 * * *', async () => {
        console.log('⏰ Ejecutando auto-respaldo nocturno de la base de datos de DearBackup...');
        try {
          await SelfBackupService.runSelfBackup();
        } catch (err: any) {
          console.error('Error en auto-respaldo programado de base de datos:', err.message);
        }
      });
      this.tasks.set('__system_self_backup__', selfBackupTask);
      console.log('  ✓ Auto-respaldo nocturno de DearBackup programado: [0 3 * * *]');
    } catch (err: any) {
      console.error('Error programando cron de auto-respaldo del sistema:', err.message);
    }
  }

  /**
   * Actualiza o registra la tarea cron de un cliente individual
   */
  public static updateClientSchedule(client: ClientData): void {
    if (this.tasks.has(client.id)) {
      this.tasks.get(client.id)?.stop();
      this.tasks.delete(client.id);
    }

    if (client.is_active && client.cron_schedule && cron.validate(client.cron_schedule)) {
      try {
        const scheduledTask = cron.schedule(client.cron_schedule, async () => {
          console.log(`⏰ Ejecutando respaldo programado para: ${client.name} (${client.id})`);
          await BackupService.runBackup(client, 'cron_scheduler');
        });
        this.tasks.set(client.id, scheduledTask);
      } catch (err) {
        console.error(`Error programando cron para ${client.name}:`, err);
      }
    }
  }

  /**
   * Elimina la tarea de un cliente
   */
  public static removeClientSchedule(clientId: string): void {
    if (this.tasks.has(clientId)) {
      this.tasks.get(clientId)?.stop();
      this.tasks.delete(clientId);
    }
  }
}
