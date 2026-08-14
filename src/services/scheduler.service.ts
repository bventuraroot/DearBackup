import cron from 'node-cron';
import { db } from '../db/database';
import { BackupService, ClientData } from './backup.service';

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
