"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CloudService = void 0;
const client_s3_1 = require("@aws-sdk/client-s3");
const s3_request_presigner_1 = require("@aws-sdk/s3-request-presigner");
const fs_1 = __importDefault(require("fs"));
const database_1 = require("../db/database");
const vault_service_1 = require("./vault.service");
class CloudService {
    /**
     * Obtiene la configuración de Cloud S3 guardada
     */
    static getConfig() {
        const row = database_1.db.prepare('SELECT value FROM settings WHERE key = ?').get('cloud_s3_config');
        if (!row)
            return null;
        try {
            const parsed = JSON.parse(row.value);
            if (parsed.secretAccessKey) {
                parsed.secretAccessKey = vault_service_1.VaultService.decrypt(parsed.secretAccessKey);
            }
            return parsed;
        }
        catch {
            return null;
        }
    }
    /**
     * Guarda la configuración de Cloud S3 encriptando la clave secreta
     */
    static saveConfig(config) {
        const toSave = {
            ...config,
            secretAccessKey: vault_service_1.VaultService.encrypt(config.secretAccessKey)
        };
        database_1.db.prepare('INSERT OR REPLACE INTO settings (key, value, is_encrypted) VALUES (?, ?, 1)')
            .run('cloud_s3_config', JSON.stringify(toSave));
    }
    /**
     * Inicializa el cliente S3 según la configuración guardada
     */
    static getS3Client(config) {
        return new client_s3_1.S3Client({
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
    static async testConnection(config) {
        try {
            const client = this.getS3Client(config);
            const testKey = `.dearbackup_test_${Date.now()}.tmp`;
            // Subir archivo temporal de prueba
            await client.send(new client_s3_1.PutObjectCommand({
                Bucket: config.bucket,
                Key: testKey,
                Body: 'DearBackup Connection Test'
            }));
            // Borrar archivo temporal
            await client.send(new client_s3_1.DeleteObjectCommand({
                Bucket: config.bucket,
                Key: testKey
            }));
            return { success: true, message: `Conexión al bucket "${config.bucket}" exitosa con permisos de lectura/escritura.` };
        }
        catch (err) {
            return { success: false, message: `Error conectando al almacenamiento en la nube: ${err.message}` };
        }
    }
    /**
     * Sube un archivo de backup a la nube
     */
    static async uploadFile(localFilePath, remoteKey) {
        const config = this.getConfig();
        if (!config || !config.isEnabled) {
            throw new Error('Almacenamiento en la nube no configurado o deshabilitado');
        }
        const client = this.getS3Client(config);
        const fileStream = fs_1.default.createReadStream(localFilePath);
        const fileStats = fs_1.default.statSync(localFilePath);
        await client.send(new client_s3_1.PutObjectCommand({
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
    static async deleteFile(remoteKey) {
        const config = this.getConfig();
        if (!config || !config.isEnabled)
            return;
        try {
            const client = this.getS3Client(config);
            await client.send(new client_s3_1.DeleteObjectCommand({
                Bucket: config.bucket,
                Key: remoteKey
            }));
        }
        catch (err) {
            console.error(`Error eliminando archivo remoto ${remoteKey}:`, err);
        }
    }
    /**
     * Genera un enlace de descarga firmado (Presigned URL) expirable
     */
    static async generatePresignedUrl(remoteKey, expiresInSeconds = 3600) {
        const config = this.getConfig();
        if (!config || !config.isEnabled)
            return null;
        try {
            const client = this.getS3Client(config);
            const command = new client_s3_1.GetObjectCommand({
                Bucket: config.bucket,
                Key: remoteKey
            });
            return await (0, s3_request_presigner_1.getSignedUrl)(client, command, { expiresIn: expiresInSeconds });
        }
        catch (err) {
            console.error('Error generando URL firmada:', err);
            return null;
        }
    }
    /**
     * Lista los objetos existentes en el bucket (opcionalmente filtrados por prefijo)
     */
    static async listObjects(prefix) {
        const config = this.getConfig();
        if (!config || !config.isEnabled)
            return [];
        try {
            const client = this.getS3Client(config);
            const command = new client_s3_1.ListObjectsV2Command({
                Bucket: config.bucket,
                Prefix: prefix
            });
            const res = await client.send(command);
            if (!res.Contents)
                return [];
            return res.Contents.map(o => ({
                key: o.Key || '',
                size: o.Size || 0,
                lastModified: o.LastModified
            }));
        }
        catch (err) {
            console.error('Error listando objetos en S3/R2:', err.message);
            return [];
        }
    }
}
exports.CloudService = CloudService;
