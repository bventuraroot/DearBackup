"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PasskeyService = void 0;
const server_1 = require("@simplewebauthn/server");
const qrcode_1 = __importDefault(require("qrcode"));
const crypto_1 = __importDefault(require("crypto"));
const database_1 = require("../db/database");
// Alfabeto Base32 para TOTP (RFC 4648)
const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
class PasskeyService {
    static getRPInfo(reqHostname = 'localhost', reqProtocol = 'http') {
        const appUrl = process.env.APP_URL;
        let rpID = reqHostname || 'localhost';
        let origin = `${reqProtocol}://${reqHostname}`;
        if (appUrl) {
            try {
                const parsed = new URL(appUrl);
                rpID = parsed.hostname;
                origin = parsed.origin;
            }
            catch { }
        }
        return {
            rpID,
            rpName: 'DearBackup Security',
            origin
        };
    }
    // =========================================================================
    // 1. WEBAUTHN / PASSKEYS
    // =========================================================================
    static async generatePasskeyRegistrationOptions(userId, username, hostname, protocol) {
        const { rpID, rpName } = this.getRPInfo(hostname, protocol);
        const existingPasskeys = database_1.db.prepare('SELECT id, transports FROM passkeys WHERE user_id = ?').all(userId);
        const excludeCredentials = existingPasskeys.map(p => ({
            id: p.id,
            transports: p.transports ? JSON.parse(p.transports) : undefined
        }));
        const options = await (0, server_1.generateRegistrationOptions)({
            rpName,
            rpID,
            userID: Buffer.from(userId),
            userName: username,
            attestationType: 'none',
            excludeCredentials,
            authenticatorSelection: {
                residentKey: 'preferred',
                userVerification: 'preferred',
                authenticatorAttachment: 'platform'
            }
        });
        const challengeId = crypto_1.default.randomUUID();
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
        database_1.db.prepare('DELETE FROM auth_challenges WHERE user_id = ? AND type = ?').run(userId, 'registration');
        database_1.db.prepare('INSERT INTO auth_challenges (id, user_id, challenge, type, expires_at) VALUES (?, ?, ?, ?, ?)')
            .run(challengeId, userId, options.challenge, 'registration', expiresAt);
        return options;
    }
    static async verifyPasskeyRegistration(userId, response, deviceName = 'Mi Dispositivo', hostname, protocol) {
        const { rpID, origin } = this.getRPInfo(hostname, protocol);
        const challengeRow = database_1.db.prepare(`
      SELECT challenge, expires_at FROM auth_challenges 
      WHERE user_id = ? AND type = 'registration'
      ORDER BY expires_at DESC LIMIT 1
    `).get(userId);
        if (!challengeRow || new Date() > new Date(challengeRow.expires_at)) {
            return { verified: false, error: 'El desafío de seguridad ha expirado. Inténtalo de nuevo.' };
        }
        try {
            const verification = await (0, server_1.verifyRegistrationResponse)({
                response,
                expectedChallenge: challengeRow.challenge,
                expectedOrigin: [origin, `http://${hostname}:3000`, `http://localhost:3000`],
                expectedRPID: [rpID, 'localhost', hostname],
                requireUserVerification: false
            });
            if (verification.verified && verification.registrationInfo) {
                const { credential } = verification.registrationInfo;
                const transportsJson = response.response.transports ? JSON.stringify(response.response.transports) : null;
                const pubKeyBase64 = Buffer.from(credential.publicKey).toString('base64url');
                database_1.db.prepare(`
          INSERT INTO passkeys (id, user_id, name, public_key, counter, device_type, backed_up, transports)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(credential.id, userId, deviceName || 'Biometría / Passkey', pubKeyBase64, credential.counter, verification.registrationInfo.credentialDeviceType || 'singleDevice', verification.registrationInfo.credentialBackedUp ? 1 : 0, transportsJson);
                database_1.db.prepare('DELETE FROM auth_challenges WHERE user_id = ? AND type = ?').run(userId, 'registration');
                return { verified: true };
            }
            return { verified: false, error: 'Verificación de Passkey fallida.' };
        }
        catch (err) {
            return { verified: false, error: err.message };
        }
    }
    static async generatePasskeyAuthOptions(hostname, protocol) {
        const { rpID } = this.getRPInfo(hostname, protocol);
        const options = await (0, server_1.generateAuthenticationOptions)({
            rpID,
            userVerification: 'preferred'
        });
        const challengeId = crypto_1.default.randomUUID();
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
        database_1.db.prepare('INSERT INTO auth_challenges (id, challenge, type, expires_at) VALUES (?, ?, ?, ?)')
            .run(challengeId, options.challenge, 'authentication', expiresAt);
        return options;
    }
    static async verifyPasskeyAuth(response, hostname, protocol) {
        const { rpID, origin } = this.getRPInfo(hostname, protocol);
        const passkey = database_1.db.prepare('SELECT * FROM passkeys WHERE id = ?').get(response.id);
        if (!passkey) {
            return { verified: false, error: 'Passkey no encontrada o no registrada en el sistema.' };
        }
        const user = database_1.db.prepare('SELECT * FROM users WHERE id = ?').get(passkey.user_id);
        if (!user) {
            return { verified: false, error: 'Usuario no encontrado.' };
        }
        const challengeRow = database_1.db.prepare(`
      SELECT id, challenge, expires_at FROM auth_challenges 
      WHERE type = 'authentication'
      ORDER BY expires_at DESC LIMIT 1
    `).get();
        if (!challengeRow || new Date() > new Date(challengeRow.expires_at)) {
            return { verified: false, error: 'El desafío de inicio de sesión ha expirado.' };
        }
        try {
            const publicKeyBuffer = Buffer.from(passkey.public_key, 'base64url');
            const verification = await (0, server_1.verifyAuthenticationResponse)({
                response,
                expectedChallenge: challengeRow.challenge,
                expectedOrigin: [origin, `http://${hostname}:3000`, `http://localhost:3000`],
                expectedRPID: [rpID, 'localhost', hostname],
                credential: {
                    id: passkey.id,
                    publicKey: publicKeyBuffer,
                    counter: passkey.counter,
                    transports: passkey.transports ? JSON.parse(passkey.transports) : undefined
                },
                requireUserVerification: false
            });
            if (verification.verified) {
                database_1.db.prepare('UPDATE passkeys SET counter = ?, last_used_at = CURRENT_TIMESTAMP WHERE id = ?')
                    .run(verification.authenticationInfo.newCounter, passkey.id);
                database_1.db.prepare('DELETE FROM auth_challenges WHERE id = ?').run(challengeRow.id);
                return { verified: true, user };
            }
            return { verified: false, error: 'Autenticación con Passkey fallida.' };
        }
        catch (err) {
            return { verified: false, error: err.message };
        }
    }
    // =========================================================================
    // 2. SEGUNDO FACTOR (2FA / TOTP RFC 6238)
    // =========================================================================
    static base32Encode(buffer) {
        let bits = 0;
        let value = 0;
        let output = '';
        for (let i = 0; i < buffer.length; i++) {
            value = (value << 8) | buffer[i];
            bits += 8;
            while (bits >= 5) {
                output += BASE32_CHARS[(value >>> (bits - 5)) & 31];
                bits -= 5;
            }
        }
        if (bits > 0) {
            output += BASE32_CHARS[(value << (5 - bits)) & 31];
        }
        return output;
    }
    static base32Decode(base32Str) {
        const cleanStr = base32Str.toUpperCase().replace(/[^A-Z2-7]/g, '');
        let bits = 0;
        let value = 0;
        const output = [];
        for (let i = 0; i < cleanStr.length; i++) {
            const val = BASE32_CHARS.indexOf(cleanStr[i]);
            if (val === -1)
                continue;
            value = (value << 5) | val;
            bits += 5;
            if (bits >= 8) {
                output.push((value >>> (bits - 8)) & 255);
                bits -= 8;
            }
        }
        return Buffer.from(output);
    }
    static generateTOTPCode(secret, timeStep = Math.floor(Date.now() / 30000)) {
        const key = this.base32Decode(secret);
        const timeBuffer = Buffer.alloc(8);
        timeBuffer.writeBigInt64BE(BigInt(timeStep));
        const hmac = crypto_1.default.createHmac('sha1', key).update(timeBuffer).digest();
        const offset = hmac[hmac.length - 1] & 0x0f;
        const binary = ((hmac[offset] & 0x7f) << 24) |
            ((hmac[offset + 1] & 0xff) << 16) |
            ((hmac[offset + 2] & 0xff) << 8) |
            (hmac[offset + 3] & 0xff);
        const otp = binary % 1000000;
        return otp.toString().padStart(6, '0');
    }
    static async generate2FASecret(username) {
        const randomBytes = crypto_1.default.randomBytes(20);
        const secret = this.base32Encode(randomBytes);
        const issuer = 'DearBackup';
        const otpauthUrl = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(username)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
        const qrCodeDataUrl = await qrcode_1.default.toDataURL(otpauthUrl);
        return {
            secret,
            qrCodeDataUrl,
            otpauthUrl
        };
    }
    static verify2FAToken(token, secret) {
        if (!token || !secret || token.length !== 6)
            return false;
        const cleanToken = token.trim();
        const currentStep = Math.floor(Date.now() / 30000);
        // Permitir ventana de tolerancia de +- 1 paso (30 segundos antes / 30 segundos después)
        for (let step = currentStep - 1; step <= currentStep + 1; step++) {
            if (this.generateTOTPCode(secret, step) === cleanToken) {
                return true;
            }
        }
        return false;
    }
}
exports.PasskeyService = PasskeyService;
