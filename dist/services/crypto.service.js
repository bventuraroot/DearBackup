"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CryptoService = void 0;
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const promises_1 = require("stream/promises");
const FILE_ALGORITHM = 'aes-256-cbc';
const OPENSSL_HEADER = Buffer.from('Salted__', 'utf8');
const PBKDF2_ITERATIONS = 100000;
class CryptoService {
    /**
     * Calcula el checksum SHA-256 de un archivo en disco
     */
    static async calculateFileSHA256(filePath) {
        return new Promise((resolve, reject) => {
            const hash = crypto_1.default.createHash('sha256');
            const stream = fs_1.default.createReadStream(filePath);
            stream.on('data', (data) => hash.update(data));
            stream.on('end', () => resolve(hash.digest('hex')));
            stream.on('error', (err) => reject(err));
        });
    }
    /**
     * Cifra un archivo en disco usando el formato ESTÁNDAR DE OPENSSL (Salted__ + PBKDF2 100k iter + AES-256-CBC)
     * Esto permite descifrarlo tanto con Node como directamente desde la terminal con:
     * openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -in archivo.enc -out archivo.tar.gz -k "CLAVE"
     */
    static async encryptFile(inputPath, outputPath, keyPhrase) {
        const salt = crypto_1.default.randomBytes(8);
        // OpenSSL PBKDF2 deriva 32 bytes (Key) + 16 bytes (IV) = 48 bytes
        const derived = crypto_1.default.pbkdf2Sync(keyPhrase, salt, PBKDF2_ITERATIONS, 48, 'sha256');
        const key = derived.subarray(0, 32);
        const iv = derived.subarray(32, 48);
        const cipher = crypto_1.default.createCipheriv(FILE_ALGORITHM, key, iv);
        const readStream = fs_1.default.createReadStream(inputPath);
        const writeStream = fs_1.default.createWriteStream(outputPath);
        // Escribir el encabezado estándar de OpenSSL: "Salted__" (8 bytes) + Salt (8 bytes) = 16 bytes
        writeStream.write(OPENSSL_HEADER);
        writeStream.write(salt);
        await (0, promises_1.pipeline)(readStream, cipher, writeStream);
    }
    /**
     * Descifra un archivo cifrado en disco con compatibilidad total OpenSSL y formatos previos
     */
    static async decryptFile(inputPath, outputPath, keyPhrase) {
        const fd = fs_1.default.openSync(inputPath, 'r');
        const headerBuffer = Buffer.alloc(16);
        fs_1.default.readSync(fd, headerBuffer, 0, 16, 0);
        fs_1.default.closeSync(fd);
        let key;
        let iv;
        // Verificar si tiene el encabezado estándar de OpenSSL ("Salted__")
        if (headerBuffer.subarray(0, 8).equals(OPENSSL_HEADER)) {
            const salt = headerBuffer.subarray(8, 16);
            const derived = crypto_1.default.pbkdf2Sync(keyPhrase, salt, PBKDF2_ITERATIONS, 48, 'sha256');
            key = derived.subarray(0, 32);
            iv = derived.subarray(32, 48);
        }
        else {
            // Formato legacy: primeros 16 bytes son IV directo, key = sha256(keyPhrase)
            key = crypto_1.default.createHash('sha256').update(keyPhrase).digest();
            iv = headerBuffer;
        }
        const decipher = crypto_1.default.createDecipheriv(FILE_ALGORITHM, key, iv);
        // Leer el archivo saltando los 16 bytes de encabezado
        const readStream = fs_1.default.createReadStream(inputPath, { start: 16 });
        const writeStream = fs_1.default.createWriteStream(outputPath);
        await (0, promises_1.pipeline)(readStream, decipher, writeStream);
    }
}
exports.CryptoService = CryptoService;
