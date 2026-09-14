import { Router, Response } from 'express';
import crypto from 'crypto';
import { db } from '../db/database';
import { requireAuth, AuthRequest } from './auth.routes';
import { VaultService } from '../services/vault.service';
import { SSHService } from '../services/ssh.service';
import { SchedulerService } from '../services/scheduler.service';

const router = Router();

/**
 * Listar todos los clientes con métricas de su último backup
 */
router.get('/', requireAuth, (req: AuthRequest, res: Response) => {
  try {
    const clients = db.prepare(`
      SELECT 
        c.id, c.name, c.tags, c.ssh_host, c.ssh_port, c.ssh_user, c.ssh_auth_type,
        c.db_type, c.db_connection_mode, c.db_docker_container, c.db_host, c.db_port, c.db_name, c.db_user,
        c.dtes_path, c.cron_schedule, c.retention_days, c.retention_count,
        c.is_active, c.notify_email, c.notify_telegram, c.created_at, c.updated_at,
        (SELECT status FROM backup_logs WHERE client_id = c.id ORDER BY start_time DESC LIMIT 1) as last_backup_status,
        (SELECT start_time FROM backup_logs WHERE client_id = c.id ORDER BY start_time DESC LIMIT 1) as last_backup_date,
        (SELECT file_size_bytes FROM backup_logs WHERE client_id = c.id AND status = 'success' ORDER BY start_time DESC LIMIT 1) as last_backup_size,
        (SELECT COUNT(*) FROM backup_logs WHERE client_id = c.id AND status = 'success') as total_success_backups
      FROM clients c
      ORDER BY c.name ASC
    `).all();

    res.json(clients);
  } catch (err: any) {
    console.error('💥 Error al consultar /api/clients:', err);
    res.status(500).json({ error: `Error al listar clientes: ${err.message}` });
  }
});

/**
 * Obtener un cliente específico
 */
router.get('/:id', requireAuth, (req: AuthRequest, res: Response) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id) as any;
  if (!client) {
    return res.status(404).json({ error: 'Cliente no encontrado.' });
  }

  // Ocultar contraseñas en claro
  const safeClient = {
    ...client,
    ssh_password: client.ssh_password ? '********' : '',
    ssh_passphrase: client.ssh_passphrase ? '********' : '',
    db_pass: client.db_pass ? '********' : '',
    has_ssh_private_key: !!client.ssh_private_key
  };

  res.json(safeClient);
});

/**
 * Probar conexión SSH y Base de Datos (Diagnóstico en 1 Clic)
 */
router.post('/test-connection', requireAuth, async (req: AuthRequest, res: Response) => {
  const {
    ssh_host,
    ssh_port = 22,
    ssh_user,
    ssh_auth_type = 'key',
    ssh_password,
    ssh_private_key,
    ssh_passphrase,
    db_type = 'none',
    db_connection_mode = 'ssh_tunnel',
    db_docker_container = '',
    db_host = '127.0.0.1',
    db_port = 3306,
    db_name,
    db_user,
    db_pass,
    client_id
  } = req.body;

  let finalSshPass = ssh_password;
  let finalSshKey = ssh_private_key;
  let finalSshPassphrase = ssh_passphrase;
  let finalDbPass = db_pass;

  // Si estamos editando y viene '********', recuperar del registro actual
  if (client_id && (finalSshPass === '********' || finalSshPassphrase === '********' || finalDbPass === '********' || !finalSshKey || finalSshKey === '********')) {
    const existing = db.prepare('SELECT ssh_password, ssh_private_key, ssh_passphrase, db_pass FROM clients WHERE id = ?').get(client_id) as any;
    if (existing) {
      if (finalSshPass === '********') finalSshPass = existing.ssh_password ? VaultService.decrypt(existing.ssh_password) : '';
      if (finalSshPassphrase === '********') finalSshPassphrase = existing.ssh_passphrase ? VaultService.decrypt(existing.ssh_passphrase) : '';
      if (finalDbPass === '********') finalDbPass = existing.db_pass ? VaultService.decrypt(existing.db_pass) : '';
      if ((!finalSshKey || finalSshKey === '********') && existing.ssh_private_key) {
        finalSshKey = VaultService.decrypt(existing.ssh_private_key);
        if (!finalSshKey && !VaultService.isUnlocked()) {
          return res.status(400).json({
            error: 'El Vault se encuentra bloqueado. Por favor ingresa la Frase del Vault para desbloquear tus credenciales antes de probar la conexión.'
          });
        }
      }
    }
  }

  try {
    let sshTest: { success: boolean; message: string; osInfo?: string } = {
      success: true,
      message: 'No se requiere SSH para conexión TCP directa',
      osInfo: 'Direct TCP'
    };
    
    // Probar SSH si el modo de BD es ssh_tunnel o docker_container, o si se especificaron credenciales SSH
    if (db_connection_mode !== 'direct_tcp' || (ssh_host && ssh_user)) {
      if (!ssh_host || !ssh_user) {
        return res.status(400).json({ error: 'Host SSH y usuario son requeridos para este modo de conexión.' });
      }

      sshTest = await SSHService.testSSHConnection({
        host: ssh_host,
        port: Number(ssh_port),
        username: ssh_user,
        authType: ssh_auth_type,
        password: finalSshPass ? VaultService.encrypt(finalSshPass) : undefined,
        privateKey: finalSshKey ? VaultService.encrypt(finalSshKey) : undefined,
        passphrase: finalSshPassphrase ? VaultService.encrypt(finalSshPassphrase) : undefined
      });

      if (!sshTest.success && db_connection_mode !== 'direct_tcp') {
        return res.json({
          sshSuccess: false,
          sshMessage: sshTest.message,
          dbSuccess: false,
          dbMessage: 'No se pudo probar la base de datos porque la conexión SSH falló.',
          message: sshTest.message
        });
      }
    }

    // 2. Probar Base de Datos si está configurada
    let dbTest = { success: true, message: 'Base de datos no requerida (Solo archivos/DTEs)' };
    if (db_type !== 'none' && db_name) {
      dbTest = await SSHService.testDatabaseConnection(
        {
          host: ssh_host || db_host,
          port: Number(ssh_port),
          username: ssh_user || 'root',
          authType: ssh_auth_type,
          password: finalSshPass ? VaultService.encrypt(finalSshPass) : undefined,
          privateKey: finalSshKey ? VaultService.encrypt(finalSshKey) : undefined,
          passphrase: finalSshPassphrase ? VaultService.encrypt(finalSshPassphrase) : undefined
        },
        db_type,
        db_connection_mode,
        db_docker_container,
        db_host,
        Number(db_port),
        db_name,
        db_user || 'root',
        finalDbPass ? VaultService.encrypt(finalDbPass) : ''
      );
    }

    res.json({
      sshSuccess: sshTest.success,
      sshMessage: sshTest.message,
      osInfo: sshTest.osInfo,
      dbSuccess: dbTest.success,
      dbMessage: dbTest.message
    });
  } catch (err: any) {
    res.status(500).json({ error: `Error en diagnóstico: ${err.message}` });
  }
});

/**
 * Crear un nuevo cliente
 */
router.post('/', requireAuth, (req: AuthRequest, res: Response) => {
  const {
    name,
    tags = '',
    ssh_host = '',
    ssh_port = 22,
    ssh_user = '',
    ssh_auth_type = 'key',
    ssh_password,
    ssh_private_key,
    ssh_passphrase,
    db_type = 'mysql',
    db_connection_mode = 'ssh_tunnel',
    db_docker_container = '',
    db_host = '127.0.0.1',
    db_port = 3306,
    db_name = '',
    db_user = '',
    db_pass = '',
    dtes_path = '',
    cron_schedule = '0 2 * * *',
    retention_days = 30,
    retention_count = 14,
    is_active = 1,
    notify_email = '',
    notify_telegram = 1
  } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'El nombre del cliente es obligatorio.' });
  }

  const id = crypto.randomUUID();
  const encryptedSshPass = ssh_password ? VaultService.encrypt(ssh_password) : null;
  const encryptedSshKey = ssh_private_key ? VaultService.encrypt(ssh_private_key) : null;
  const encryptedSshPassphrase = ssh_passphrase ? VaultService.encrypt(ssh_passphrase) : null;
  const encryptedDbPass = db_pass ? VaultService.encrypt(db_pass) : null;

  db.prepare(`
    INSERT INTO clients (
      id, name, tags, ssh_host, ssh_port, ssh_user, ssh_auth_type, ssh_password, ssh_private_key, ssh_passphrase,
      db_type, db_connection_mode, db_docker_container, db_host, db_port, db_name, db_user, db_pass, dtes_path,
      cron_schedule, retention_days, retention_count, is_active, notify_email, notify_telegram
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?
    )
  `).run(
    id, name, tags, ssh_host, Number(ssh_port), ssh_user, ssh_auth_type, encryptedSshPass, encryptedSshKey, encryptedSshPassphrase,
    db_type, db_connection_mode, db_docker_container, db_host, Number(db_port), db_name, db_user, encryptedDbPass, dtes_path,
    cron_schedule, Number(retention_days), Number(retention_count), is_active ? 1 : 0, notify_email, notify_telegram ? 1 : 0
  );

  const newClient = db.prepare('SELECT * FROM clients WHERE id = ?').get(id) as any;
  SchedulerService.updateClientSchedule(newClient);

  res.status(201).json({ success: true, client: newClient });
});

/**
 * Actualizar cliente existente
 */
router.put('/:id', requireAuth, (req: AuthRequest, res: Response) => {
  const clientId = req.params.id;
  const existing = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId) as any;
  if (!existing) {
    return res.status(404).json({ error: 'Cliente no encontrado.' });
  }

  const {
    name,
    tags,
    ssh_host,
    ssh_port,
    ssh_user,
    ssh_auth_type,
    ssh_password,
    ssh_private_key,
    ssh_passphrase,
    db_type,
    db_connection_mode,
    db_docker_container,
    db_host,
    db_port,
    db_name,
    db_user,
    db_pass,
    dtes_path,
    cron_schedule,
    retention_days,
    retention_count,
    is_active,
    notify_email,
    notify_telegram
  } = req.body;

  let encryptedSshPass = existing.ssh_password;
  if (ssh_password && ssh_password !== '********') {
    encryptedSshPass = VaultService.encrypt(ssh_password);
  }

  let encryptedSshKey = existing.ssh_private_key;
  if (ssh_private_key && ssh_private_key !== '********' && ssh_private_key.trim().length > 0) {
    encryptedSshKey = VaultService.encrypt(ssh_private_key);
  }

  let encryptedSshPassphrase = existing.ssh_passphrase;
  if (ssh_passphrase && ssh_passphrase !== '********') {
    encryptedSshPassphrase = VaultService.encrypt(ssh_passphrase);
  }

  let encryptedDbPass = existing.db_pass;
  if (db_pass && db_pass !== '********') {
    encryptedDbPass = VaultService.encrypt(db_pass);
  }

  db.prepare(`
    UPDATE clients SET
      name = ?, tags = ?, ssh_host = ?, ssh_port = ?, ssh_user = ?, ssh_auth_type = ?,
      ssh_password = ?, ssh_private_key = ?, ssh_passphrase = ?, db_type = ?,
      db_connection_mode = ?, db_docker_container = ?, db_host = ?, db_port = ?,
      db_name = ?, db_user = ?, db_pass = ?, dtes_path = ?, cron_schedule = ?,
      retention_days = ?, retention_count = ?, is_active = ?, notify_email = ?, notify_telegram = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    name || existing.name,
    tags !== undefined ? tags : existing.tags,
    ssh_host !== undefined ? ssh_host : existing.ssh_host,
    ssh_port !== undefined ? Number(ssh_port) : existing.ssh_port,
    ssh_user !== undefined ? ssh_user : existing.ssh_user,
    ssh_auth_type || existing.ssh_auth_type,
    encryptedSshPass,
    encryptedSshKey,
    encryptedSshPassphrase,
    db_type || existing.db_type,
    db_connection_mode || existing.db_connection_mode || 'ssh_tunnel',
    db_docker_container !== undefined ? db_docker_container : existing.db_docker_container,
    db_host !== undefined ? db_host : existing.db_host,
    db_port !== undefined ? Number(db_port) : existing.db_port,
    db_name !== undefined ? db_name : existing.db_name,
    db_user !== undefined ? db_user : existing.db_user,
    encryptedDbPass,
    dtes_path !== undefined ? dtes_path : existing.dtes_path,
    cron_schedule || existing.cron_schedule,
    retention_days !== undefined ? Number(retention_days) : existing.retention_days,
    retention_count !== undefined ? Number(retention_count) : existing.retention_count,
    is_active !== undefined ? (is_active ? 1 : 0) : existing.is_active,
    notify_email !== undefined ? notify_email : existing.notify_email,
    notify_telegram !== undefined ? (notify_telegram ? 1 : 0) : existing.notify_telegram,
    clientId
  );

  const updatedClient = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId) as any;
  SchedulerService.updateClientSchedule(updatedClient);

  res.json({ success: true, client: updatedClient });
});

/**
 * Eliminar cliente
 */
router.delete('/:id', requireAuth, (req: AuthRequest, res: Response) => {
  const clientId = req.params.id;
  SchedulerService.removeClientSchedule(clientId);
  db.prepare('DELETE FROM clients WHERE id = ?').run(clientId);
  res.json({ success: true, message: 'Cliente eliminado correctamente.' });
});

export default router;
