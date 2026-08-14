import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import fs from 'fs';
import { db } from '../db/database';
import { VaultService } from './vault.service';

export interface CloudStorageConfig {
  provider: 's3' | 'r2' | 'b2' | 'wasabi' | 'custom';
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  isEnabled: boolean;
  maxStorageGB?: number;
}

export class CloudService {
  /**
   * Obtiene la configuración de Cloud S3 guardada
   */
  public static getConfig(): CloudStorageConfig | null {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('cloud_s3_config') as { value: string } | undefined;
    if (!row) return null;

    try {
      const parsed = JSON.parse(row.value);
      if (parsed.secretAccessKey) {
        parsed.secretAccessKey = VaultService.decrypt(parsed.secretAccessKey);
      }
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Guarda la configuración de Cloud S3 encriptando la clave secreta
   */
  public static saveConfig(config: CloudStorageConfig): void {
    const toSave = {
      ...config,
      secretAccessKey: VaultService.encrypt(config.secretAccessKey)
    };
    db.prepare('INSERT OR REPLACE INTO settings (key, value, is_encrypted) VALUES (?, ?, 1)')
      .run('cloud_s3_config', JSON.stringify(toSave));
  }

  /**
   * Inicializa el cliente S3 según la configuración guardada
   */
  private static getS3Client(config: CloudStorageConfig): S3Client {
    return new S3Client({
      region: config.region || 'auto',
      endpoint: config.endpoint || undefined,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey
      }
    });
  }

  /**
   * Prueba la conexión al bucket S3 / R2
   */
  public static async testConnection(config: CloudStorageConfig): Promise<{ success: boolean; message: string }> {
    try {
      const client = this.getS3Client(config);
      const testKey = `.dearbackup_test_${Date.now()}.tmp`;

      // Subir archivo temporal de prueba
      await client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: testKey,
        Body: 'DearBackup Connection Test'
      }));

      // Borrar archivo temporal
      await client.send(new DeleteObjectCommand({
        Bucket: config.bucket,
        Key: testKey
      }));

      return { success: true, message: `Conexión al bucket "${config.bucket}" exitosa con permisos de lectura/escritura.` };
    } catch (err: any) {
      return { success: false, message: `Error conectando al almacenamiento en la nube: ${err.message}` };
    }
  }

  /**
   * Sube un archivo de backup a la nube
   */
  public static async uploadFile(localFilePath: string, remoteKey: string): Promise<string> {
    const config = this.getConfig();
    if (!config || !config.isEnabled) {
      throw new Error('Almacenamiento en la nube no configurado o deshabilitado');
    }

    const client = this.getS3Client(config);
    const fileStream = fs.createReadStream(localFilePath);
    const fileStats = fs.statSync(localFilePath);

    await client.send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: remoteKey,
      Body: fileStream,
      ContentLength: fileStats.size
    }));

    return remoteKey;
  }

  /**
   * Elimina un archivo de la nube (usado por retención)
   */
  public static async deleteFile(remoteKey: string): Promise<void> {
    const config = this.getConfig();
    if (!config || !config.isEnabled) return;

    try {
      const client = this.getS3Client(config);
      await client.send(new DeleteObjectCommand({
        Bucket: config.bucket,
        Key: remoteKey
      }));
    } catch (err) {
      console.error(`Error eliminando archivo remoto ${remoteKey}:`, err);
    }
  }

  /**
   * Genera un enlace de descarga firmado (Presigned URL) expirable
   */
  public static async generatePresignedUrl(remoteKey: string, expiresInSeconds: number = 3600): Promise<string | null> {
    const config = this.getConfig();
    if (!config || !config.isEnabled) return null;

    try {
      const client = this.getS3Client(config);
      const command = new GetObjectCommand({
        Bucket: config.bucket,
        Key: remoteKey
      });

      return await getSignedUrl(client, command, { expiresIn: expiresInSeconds });
    } catch (err) {
      console.error('Error generando URL firmada:', err);
      return null;
    }
  }

  /**
   * Lista los objetos existentes en el bucket (opcionalmente filtrados por prefijo)
   */
  public static async listObjects(prefix?: string): Promise<Array<{ key: string; size: number; lastModified?: Date }>> {
    const config = this.getConfig();
    if (!config || !config.isEnabled) return [];

    try {
      const client = this.getS3Client(config);
      const command = new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: prefix
      });

      const res = await client.send(command);
      if (!res.Contents) return [];

      return res.Contents.map(o => ({
        key: o.Key || '',
        size: o.Size || 0,
        lastModified: o.LastModified
      }));
    } catch (err: any) {
      console.error('Error listando objetos en S3/R2:', err.message);
      return [];
    }
  }
}
