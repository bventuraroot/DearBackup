import nodemailer from 'nodemailer';
import { db } from '../db/database';
import { VaultService } from './vault.service';

export type SMTPEncryptionType = 'tls' | 'ssl' | 'none';

export interface SMTPConfig {
  host: string;
  port: number;
  encryptionType: SMTPEncryptionType;
  secure?: boolean;
  user: string;
  pass: string;
  fromName: string;
  fromEmail: string;
  isEnabled: boolean;
}

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  isEnabled: boolean;
}

export interface BackupNotificationData {
  clientName: string;
  status: 'success' | 'failed' | 'warning';
  durationSeconds: number;
  fileSizeBytes: number;
  fileName?: string;
  downloadUrl?: string;
  errorMessage?: string;
  checksum?: string;
}

export class NotifyService {
  /**
   * Obtiene la configuración SMTP guardada
   */
  public static getSMTPConfig(): SMTPConfig | null {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('smtp_config') as { value: string } | undefined;
    if (!row) return null;

    try {
      const parsed = JSON.parse(row.value);
      if (parsed.pass) parsed.pass = VaultService.decrypt(parsed.pass);
      if (!parsed.encryptionType) {
        parsed.encryptionType = Number(parsed.port) === 465 ? 'ssl' : 'tls';
      }
      return parsed;
    } catch {
      return null;
    }
  }

  public static saveSMTPConfig(config: SMTPConfig): void {
    const toSave = {
      ...config,
      encryptionType: config.encryptionType || (Number(config.port) === 465 ? 'ssl' : 'tls'),
      pass: VaultService.encrypt(config.pass)
    };
    db.prepare('INSERT OR REPLACE INTO settings (key, value, is_encrypted) VALUES (?, ?, 1)')
      .run('smtp_config', JSON.stringify(toSave));
  }

  /**
   * Obtiene la configuración de Telegram guardada
   */
  public static getTelegramConfig(): TelegramConfig | null {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('telegram_config') as { value: string } | undefined;
    if (!row) return null;

    try {
      const parsed = JSON.parse(row.value);
      if (parsed.botToken) parsed.botToken = VaultService.decrypt(parsed.botToken);
      return parsed;
    } catch {
      return null;
    }
  }

  public static saveTelegramConfig(config: TelegramConfig): void {
    const toSave = {
      ...config,
      botToken: VaultService.encrypt(config.botToken)
    };
    db.prepare('INSERT OR REPLACE INTO settings (key, value, is_encrypted) VALUES (?, ?, 1)')
      .run('telegram_config', JSON.stringify(toSave));
  }

  /**
   * Crea un transportador nodemailer con soporte para SSL, TLS/STARTTLS o Ninguno
   */
  private static createTransportInstance(config: SMTPConfig) {
    const port = Number(config.port);
    const encType = config.encryptionType || (port === 465 ? 'ssl' : 'tls');
    
    let isSecure = false;
    let requireTLS = false;
    let ignoreTLS = false;

    if (encType === 'ssl' || port === 465) {
      isSecure = true;
    } else if (encType === 'tls') {
      isSecure = false;
      requireTLS = true;
    } else if (encType === 'none') {
      isSecure = false;
      ignoreTLS = true;
    }

    return nodemailer.createTransport({
      host: config.host.trim(),
      port,
      secure: isSecure,
      requireTLS,
      ignoreTLS,
      auth: config.user ? {
        user: config.user.trim(),
        pass: config.pass
      } : undefined,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
      tls: {
        rejectUnauthorized: false
      }
    });
  }

  /**
   * Diagnóstico y prueba completa de servidor SMTP con SSL/TLS explícito
   */
  public static async testSMTP(
    config: SMTPConfig,
    testEmail: string
  ): Promise<{ success: boolean; message: string; diagnostic?: any }> {
    try {
      const transporter = this.createTransportInstance(config);

      // 1. Verificar Handshake y Autenticación SMTP
      await transporter.verify();

      const sendTime = new Date().toLocaleString();
      const encLabel = config.encryptionType === 'ssl'
        ? 'SSL / TLS Directo (Puerto 465)'
        : config.encryptionType === 'none'
        ? 'Sin Cifrado (Texto Plano)'
        : 'TLS / STARTTLS (Puerto 587)';

      // 2. Enviar Correo de Prueba con Plantilla HTML
      const info = await transporter.sendMail({
        from: `"${config.fromName || 'DearBackup Notifier'}" <${config.fromEmail || config.user}>`,
        to: testEmail.trim(),
        subject: '🔔 [DearBackup] Verificación de Notificaciones SMTP Exitosa',
        html: `
          <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #0b1329; color: #f1f5f9; padding: 32px; border-radius: 16px; max-width: 600px; margin: 0 auto; border: 1px solid rgba(255, 255, 255, 0.1);">
            <div style="text-align: center; margin-bottom: 24px;">
              <h1 style="color: #38bdf8; margin: 0; font-size: 26px;">🛡️ DearBackup</h1>
              <p style="color: #94a3b8; margin: 4px 0 0 0; font-size: 13px;">Orquestador Seguro de Respaldos y Facturación Electrónica</p>
            </div>

            <div style="background-color: #1e293b; border-left: 6px solid #10b981; padding: 20px; border-radius: 8px; margin-bottom: 24px;">
              <h2 style="color: #10b981; margin: 0 0 8px 0; font-size: 18px;">✅ Conexión SMTP Verificada</h2>
              <p style="margin: 0; font-size: 14px; color: #cbd5e1;">Tu servidor de correo está configurado correctamente con <strong>${encLabel}</strong> y listo para despachar alertas.</p>
            </div>

            <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px; font-size: 14px;">
              <tr style="border-bottom: 1px solid #334155;">
                <td style="padding: 10px 0; color: #94a3b8;">Servidor SMTP:</td>
                <td style="padding: 10px 0; font-weight: bold; text-align: right; color: #f8fafc;">${config.host}:${config.port}</td>
              </tr>
              <tr style="border-bottom: 1px solid #334155;">
                <td style="padding: 10px 0; color: #94a3b8;">Seguridad / Cifrado:</td>
                <td style="padding: 10px 0; font-weight: bold; text-align: right; color: #38bdf8;">${encLabel}</td>
              </tr>
              <tr style="border-bottom: 1px solid #334155;">
                <td style="padding: 10px 0; color: #94a3b8;">Usuario Emisor:</td>
                <td style="padding: 10px 0; font-weight: bold; text-align: right; color: #a5f3fc;">${config.user}</td>
              </tr>
              <tr style="border-bottom: 1px solid #334155;">
                <td style="padding: 10px 0; color: #94a3b8;">Destinatario de Prueba:</td>
                <td style="padding: 10px 0; font-weight: bold; text-align: right; color: #38bdf8;">${testEmail}</td>
              </tr>
              <tr>
                <td style="padding: 10px 0; color: #94a3b8;">Fecha y Hora:</td>
                <td style="padding: 10px 0; text-align: right; color: #f8fafc;">${sendTime}</td>
              </tr>
            </table>

            <div style="background: rgba(56, 189, 248, 0.08); border-radius: 8px; padding: 14px; text-align: center; margin-bottom: 20px;">
              <span style="color: #38bdf8; font-size: 13px; font-weight: 600;">✨ Tus respaldos automáticos de DTEs y Bases de Datos te mantendrán informado.</span>
            </div>

            <div style="border-top: 1px solid #334155; padding-top: 16px; text-align: center;">
              <p style="color: #64748b; font-size: 12px; margin: 0;">DearBackup • Resguardo garantizado ante caídas de proveedores de hosting</p>
            </div>
          </div>
        `
      });

      return {
        success: true,
        message: `¡Correo de prueba enviado con éxito usando ${encLabel} a "${testEmail}"! Revisa tu bandeja de entrada o spam.`,
        diagnostic: {
          encryption: encLabel,
          messageId: info.messageId,
          response: info.response,
          accepted: info.accepted
        }
      };

    } catch (err: any) {
      let advice = '';
      const errMsg = err.message || '';

      if (errMsg.includes('Invalid login') || errMsg.includes('535') || errMsg.includes('Username and Password not accepted')) {
        advice = '💡 Sugerencia: Si usas Gmail/Google Workspace, debes generar una "Contraseña de Aplicación" (App Password de 16 letras) en tu cuenta de Google y no usar tu contraseña habitual. Requiere tener verificación en 2 pasos activa.';
      } else if (errMsg.includes('ECONNREFUSED') || errMsg.includes('ETIMEDOUT') || errMsg.includes('wrong version number')) {
        advice = '💡 Sugerencia: Revisa el Tipo de Cifrado y Puerto. Si usas Puerto 465, selecciona "SSL / TLS Directo". Si usas Puerto 587, selecciona "TLS / STARTTLS".';
      }

      return {
        success: false,
        message: `Fallo en prueba SMTP: ${errMsg}${advice ? `\n\n${advice}` : ''}`,
        diagnostic: { error: errMsg }
      };
    }
  }

  /**
   * Envía un mensaje de prueba a Telegram
   */
  public static async testTelegram(config: TelegramConfig): Promise<{ success: boolean; message: string }> {
    try {
      const text = `🔔 *[DearBackup]* 🚀\n\n¡Prueba de notificación exitosa!\nTu Bot de Telegram está conectado correctamente y te alertará de tus respaldos y estados de clientes.`;
      
      const res = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: config.chatId,
          text: text,
          parse_mode: 'Markdown'
        })
      });

      const data = await res.json() as any;
      if (data.ok) {
        return { success: true, message: 'Mensaje de prueba enviado exitosamente a Telegram' };
      } else {
        return { success: false, message: `Error de Telegram API: ${data.description}` };
      }
    } catch (err: any) {
      return { success: false, message: `Error al conectar con Telegram: ${err.message}` };
    }
  }

  /**
   * Envía notificaciones de backup tanto por Email como por Telegram
   */
  public static async notifyBackupResult(targetEmail: string | undefined, notifyTelegram: boolean, data: BackupNotificationData): Promise<void> {
    const isSuccess = data.status === 'success';
    const statusIcon = isSuccess ? '✅' : '❌';
    const statusText = isSuccess ? 'RESPALDO COMPLETADO' : 'ERROR EN RESPALDO';
    const statusColor = isSuccess ? '#10b981' : '#ef4444';
    const sizeMB = (data.fileSizeBytes / (1024 * 1024)).toFixed(2);

    // 1. Notificación Telegram
    if (notifyTelegram) {
      const telegramConfig = this.getTelegramConfig();
      if (telegramConfig && telegramConfig.isEnabled) {
        try {
          let message = `${statusIcon} *[DearBackup] ${statusText}*\n\n`;
          message += `🏢 *Cliente:* \`${data.clientName}\`\n`;
          message += `⏱️ *Duración:* \`${data.durationSeconds} seg\`\n`;
          
          if (isSuccess) {
            message += `📦 *Tamaño:* \`${sizeMB} MB\`\n`;
            message += `📄 *Archivo:* \`${data.fileName}\`\n`;
            if (data.checksum) {
              message += `🔐 *SHA-256:* \`${data.checksum.substring(0, 12)}...\`\n`;
            }
            if (data.downloadUrl) {
              message += `\n📥 [Descargar Respaldo Seguro](${data.downloadUrl})`;
            }
          } else {
            message += `⚠️ *Error:* \`${data.errorMessage || 'Error desconocido'}\``;
          }

          await fetch(`https://api.telegram.org/bot${telegramConfig.botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: telegramConfig.chatId,
              text: message,
              parse_mode: 'Markdown'
            })
          });
        } catch (err) {
          console.error('Error enviando notificación a Telegram:', err);
        }
      }
    }

    // 2. Notificación Email
    if (targetEmail) {
      const smtpConfig = this.getSMTPConfig();
      if (smtpConfig && smtpConfig.isEnabled) {
        try {
          const transporter = this.createTransportInstance(smtpConfig);

          const subject = `${statusIcon} [DearBackup] ${statusText} - ${data.clientName}`;

          const html = `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #0b1329; color: #f1f5f9; padding: 32px; border-radius: 16px; max-width: 600px; margin: 0 auto; border: 1px solid rgba(255, 255, 255, 0.1);">
              <div style="text-align: center; margin-bottom: 24px;">
                <h1 style="color: #38bdf8; margin: 0; font-size: 24px;">DearBackup</h1>
                <p style="color: #94a3b8; margin: 4px 0 0 0; font-size: 13px;">Orquestador de Respaldos y Facturación Electrónica</p>
              </div>

              <div style="background-color: #1e293b; border-left: 6px solid ${statusColor}; padding: 20px; border-radius: 8px; margin-bottom: 24px;">
                <h2 style="color: ${statusColor}; margin: 0 0 8px 0; font-size: 18px;">${statusIcon} ${statusText}</h2>
                <p style="margin: 0; font-size: 14px; color: #cbd5e1;">Cliente: <strong>${data.clientName}</strong></p>
              </div>

              <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px; font-size: 14px;">
                <tr style="border-bottom: 1px solid #334155;">
                  <td style="padding: 10px 0; color: #94a3b8;">Duración:</td>
                  <td style="padding: 10px 0; font-weight: bold; text-align: right; color: #f8fafc;">${data.durationSeconds} segundos</td>
                </tr>
                ${isSuccess ? `
                  <tr style="border-bottom: 1px solid #334155;">
                    <td style="padding: 10px 0; color: #94a3b8;">Tamaño del paquete:</td>
                    <td style="padding: 10px 0; font-weight: bold; text-align: right; color: #f8fafc;">${sizeMB} MB</td>
                  </tr>
                  <tr style="border-bottom: 1px solid #334155;">
                    <td style="padding: 10px 0; color: #94a3b8;">Archivo:</td>
                    <td style="padding: 10px 0; font-weight: bold; text-align: right; color: #38bdf8;">${data.fileName}</td>
                  </tr>
                  ${data.checksum ? `
                    <tr style="border-bottom: 1px solid #334155;">
                      <td style="padding: 10px 0; color: #94a3b8;">Integridad SHA-256:</td>
                      <td style="padding: 10px 0; font-family: monospace; font-size: 11px; text-align: right; color: #a5f3fc;">${data.checksum}</td>
                    </tr>
                  ` : ''}
                ` : `
                  <tr>
                    <td style="padding: 10px 0; color: #ef4444;">Detalle del error:</td>
                    <td style="padding: 10px 0; color: #fca5a5; text-align: right;">${data.errorMessage}</td>
                  </tr>
                `}
              </table>

              ${data.downloadUrl ? `
                <div style="text-align: center; margin: 30px 0;">
                  <a href="${data.downloadUrl}" style="background: linear-gradient(135deg, #0284c7, #2563eb); color: #ffffff; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-weight: bold; font-size: 15px; display: inline-block; box-shadow: 0 4px 14px rgba(37, 99, 235, 0.4);">
                    📥 Descargar Respaldo Seguro
                  </a>
                  <p style="color: #64748b; font-size: 12px; margin-top: 10px;">Este enlace es seguro y expirará en 48 horas.</p>
                </div>
              ` : ''}

              <div style="border-top: 1px solid #334155; padding-top: 16px; text-align: center;">
                <p style="color: #64748b; font-size: 12px; margin: 0;">DearBackup • Resguardo garantizado de DTEs y Bases de Datos</p>
              </div>
            </div>
          `;

          await transporter.sendMail({
            from: `"${smtpConfig.fromName || 'DearBackup Notifier'}" <${smtpConfig.fromEmail || smtpConfig.user}>`,
            to: targetEmail,
            subject,
            html
          });
        } catch (err) {
          console.error('Error enviando notificación por email:', err);
        }
      }
    }
  }
}
