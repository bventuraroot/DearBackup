import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import QRCode from 'qrcode';
import crypto from 'crypto';
import { db } from '../db/database';

// Alfabeto Base32 para TOTP (RFC 4648)
const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export class PasskeyService {
  private static getRPInfo(reqHostname: string = 'localhost', reqProtocol: string = 'http'): { rpID: string; rpName: string; origin: string } {
    const appUrl = process.env.APP_URL;
    let rpID = reqHostname || 'localhost';
    let origin = `${reqProtocol}://${reqHostname}`;

    if (appUrl) {
      try {
        const parsed = new URL(appUrl);
        rpID = parsed.hostname;
        origin = parsed.origin;
      } catch {}
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

  public static async generatePasskeyRegistrationOptions(userId: string, username: string, hostname: string, protocol: string) {
    const { rpID, rpName } = this.getRPInfo(hostname, protocol);

    const existingPasskeys = db.prepare('SELECT id, transports FROM passkeys WHERE user_id = ?').all(userId) as any[];

    const excludeCredentials = existingPasskeys.map(p => ({
      id: p.id,
      transports: p.transports ? JSON.parse(p.transports) : undefined
    }));

    const options = await generateRegistrationOptions({
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

    const challengeId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    db.prepare('DELETE FROM auth_challenges WHERE user_id = ? AND type = ?').run(userId, 'registration');
    db.prepare('INSERT INTO auth_challenges (id, user_id, challenge, type, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(challengeId, userId, options.challenge, 'registration', expiresAt);

    return options;
  }

  public static async verifyPasskeyRegistration(
    userId: string,
    response: RegistrationResponseJSON,
    deviceName: string = 'Mi Dispositivo',
    hostname: string,
    protocol: string
  ): Promise<{ verified: boolean; error?: string }> {
    const { rpID, origin } = this.getRPInfo(hostname, protocol);

    const challengeRow = db.prepare(`
      SELECT challenge, expires_at FROM auth_challenges 
      WHERE user_id = ? AND type = 'registration'
      ORDER BY expires_at DESC LIMIT 1
    `).get(userId) as any;

    if (!challengeRow || new Date() > new Date(challengeRow.expires_at)) {
      return { verified: false, error: 'El desafío de seguridad ha expirado. Inténtalo de nuevo.' };
    }

    try {
      const verification = await verifyRegistrationResponse({
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

        db.prepare(`
          INSERT INTO passkeys (id, user_id, name, public_key, counter, device_type, backed_up, transports)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          credential.id,
          userId,
          deviceName || 'Biometría / Passkey',
          pubKeyBase64,
          credential.counter,
          verification.registrationInfo.credentialDeviceType || 'singleDevice',
          verification.registrationInfo.credentialBackedUp ? 1 : 0,
          transportsJson
        );

        db.prepare('DELETE FROM auth_challenges WHERE user_id = ? AND type = ?').run(userId, 'registration');

        return { verified: true };
      }

      return { verified: false, error: 'Verificación de Passkey fallida.' };
    } catch (err: any) {
      return { verified: false, error: err.message };
    }
  }

  public static async generatePasskeyAuthOptions(hostname: string, protocol: string) {
    const { rpID } = this.getRPInfo(hostname, protocol);

    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'preferred'
    });

    const challengeId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO auth_challenges (id, challenge, type, expires_at) VALUES (?, ?, ?, ?)')
      .run(challengeId, options.challenge, 'authentication', expiresAt);

    return options;
  }

  public static async verifyPasskeyAuth(
    response: AuthenticationResponseJSON,
    hostname: string,
    protocol: string
  ): Promise<{ verified: boolean; user?: any; error?: string }> {
    const { rpID, origin } = this.getRPInfo(hostname, protocol);

    const passkey = db.prepare('SELECT * FROM passkeys WHERE id = ?').get(response.id) as any;
    if (!passkey) {
      return { verified: false, error: 'Passkey no encontrada o no registrada en el sistema.' };
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(passkey.user_id) as any;
    if (!user) {
      return { verified: false, error: 'Usuario no encontrado.' };
    }

    const challengeRow = db.prepare(`
      SELECT id, challenge, expires_at FROM auth_challenges 
      WHERE type = 'authentication'
      ORDER BY expires_at DESC LIMIT 1
    `).get() as any;

    if (!challengeRow || new Date() > new Date(challengeRow.expires_at)) {
      return { verified: false, error: 'El desafío de inicio de sesión ha expirado.' };
    }

    try {
      const publicKeyBuffer = Buffer.from(passkey.public_key, 'base64url');

      const verification = await verifyAuthenticationResponse({
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
        db.prepare('UPDATE passkeys SET counter = ?, last_used_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(verification.authenticationInfo.newCounter, passkey.id);

        db.prepare('DELETE FROM auth_challenges WHERE id = ?').run(challengeRow.id);

        return { verified: true, user };
      }

      return { verified: false, error: 'Autenticación con Passkey fallida.' };
    } catch (err: any) {
      return { verified: false, error: err.message };
    }
  }

  // =========================================================================
  // 2. SEGUNDO FACTOR (2FA / TOTP RFC 6238)
  // =========================================================================

  private static base32Encode(buffer: Buffer): string {
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

  private static base32Decode(base32Str: string): Buffer {
    const cleanStr = base32Str.toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bits = 0;
    let value = 0;
    const output: number[] = [];

    for (let i = 0; i < cleanStr.length; i++) {
      const val = BASE32_CHARS.indexOf(cleanStr[i]);
      if (val === -1) continue;
      value = (value << 5) | val;
      bits += 5;
      if (bits >= 8) {
        output.push((value >>> (bits - 8)) & 255);
        bits -= 8;
      }
    }

    return Buffer.from(output);
  }

  private static generateTOTPCode(secret: string, timeStep: number = Math.floor(Date.now() / 30000)): string {
    const key = this.base32Decode(secret);
    const timeBuffer = Buffer.alloc(8);
    timeBuffer.writeBigInt64BE(BigInt(timeStep));

    const hmac = crypto.createHmac('sha1', key).update(timeBuffer).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const binary =
      ((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff);

    const otp = binary % 1000000;
    return otp.toString().padStart(6, '0');
  }

  public static async generate2FASecret(username: string): Promise<{ secret: string; qrCodeDataUrl: string; otpauthUrl: string }> {
    const randomBytes = crypto.randomBytes(20);
    const secret = this.base32Encode(randomBytes);
    const issuer = 'DearBackup';
    const otpauthUrl = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(username)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);

    return {
      secret,
      qrCodeDataUrl,
      otpauthUrl
    };
  }

  public static verify2FAToken(token: string, secret: string): boolean {
    if (!token || !secret || token.length !== 6) return false;
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
