import crypto from 'crypto';
import fs from 'fs';
import { pipeline } from 'stream/promises';

const FILE_ALGORITHM = 'aes-256-cbc';
const OPENSSL_HEADER = Buffer.from('Salted__', 'utf8');
const PBKDF2_ITERATIONS = 100000;

export class CryptoService {
  /**
   * Calcula el checksum SHA-256 de un archivo en disco
   */
  public static async calculateFileSHA256(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
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
  public static async encryptFile(inputPath: string, outputPath: string, keyPhrase: string): Promise<void> {
    const salt = crypto.randomBytes(8);
    // OpenSSL PBKDF2 deriva 32 bytes (Key) + 16 bytes (IV) = 48 bytes
    const derived = crypto.pbkdf2Sync(keyPhrase, salt, PBKDF2_ITERATIONS, 48, 'sha256');
    const key = derived.subarray(0, 32);
    const iv = derived.subarray(32, 48);

    const cipher = crypto.createCipheriv(FILE_ALGORITHM, key, iv);
    const readStream = fs.createReadStream(inputPath);
    const writeStream = fs.createWriteStream(outputPath);

    // Escribir el encabezado estándar de OpenSSL: "Salted__" (8 bytes) + Salt (8 bytes) = 16 bytes
    writeStream.write(OPENSSL_HEADER);
    writeStream.write(salt);

    await pipeline(readStream, cipher, writeStream);
  }

  /**
   * Descifra un archivo cifrado en disco con compatibilidad total OpenSSL y formatos previos
   */
  public static async decryptFile(inputPath: string, outputPath: string, keyPhrase: string): Promise<void> {
    const fd = fs.openSync(inputPath, 'r');
    const headerBuffer = Buffer.alloc(16);
    fs.readSync(fd, headerBuffer, 0, 16, 0);
    fs.closeSync(fd);

    let key: Buffer;
    let iv: Buffer;

    // Verificar si tiene el encabezado estándar de OpenSSL ("Salted__")
    if (headerBuffer.subarray(0, 8).equals(OPENSSL_HEADER)) {
      const salt = headerBuffer.subarray(8, 16);
      const derived = crypto.pbkdf2Sync(keyPhrase, salt, PBKDF2_ITERATIONS, 48, 'sha256');
      key = derived.subarray(0, 32);
      iv = derived.subarray(32, 48);
    } else {
      // Formato legacy: primeros 16 bytes son IV directo, key = sha256(keyPhrase)
      key = crypto.createHash('sha256').update(keyPhrase).digest();
      iv = headerBuffer;
    }

    const decipher = crypto.createDecipheriv(FILE_ALGORITHM, key, iv);
    // Leer el archivo saltando los 16 bytes de encabezado
    const readStream = fs.createReadStream(inputPath, { start: 16 });
    const writeStream = fs.createWriteStream(outputPath);

    await pipeline(readStream, decipher, writeStream);
  }
}
