import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { SsoService } from './sso.service';
import { SsoController } from './sso.controller';
import { SsoGuard } from './sso.guard';
import { readFileSync } from 'fs';

/**
 * SsoModule — OAuth 2.0 / OpenID Connect SSO.
 *
 * JWT signing uses RS256 (asymmetric RSA). The private key is loaded from
 * SSO_PRIVATE_KEY_PATH or SSO_PRIVATE_KEY env var. If neither is set,
 * falls back to HS256 with JWT_SECRET (development only).
 */

@Module({
  imports: [
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: () => {
        const privateKeyPath = process.env.SSO_PRIVATE_KEY_PATH;
        const privateKey = process.env.SSO_PRIVATE_KEY;

        // If the private key path is set (K8s mount), read from file
        if (privateKeyPath) {
          try {
            const key = readFileSync(privateKeyPath, 'utf-8').trim();
            if (key.includes('BEGIN RSA PRIVATE KEY') || key.includes('BEGIN PRIVATE KEY')) {
              console.log('[SSO] Using RS256 with mounted private key');
              return {
                privateKey: key,
                signOptions: { algorithm: 'RS256' },
              };
            }
          } catch {
            console.warn(
              `[SSO] Cannot read private key at ${privateKeyPath}. Trying env var fallback.`,
            );
          }
        }

        // If the private key is set directly via env var
        if (privateKey) {
          console.log('[SSO] Using RS256 with env var private key');
          return {
            secret: privateKey,
            signOptions: { algorithm: 'RS256' },
          };
        }

        // Fallback: symmetric HS256 for development
        console.warn('[SSO] No RSA private key configured. Using HS256 (dev only).');
        return {
          secret: process.env.JWT_SECRET || 'sso-dev-secret-change-in-production',
          signOptions: { algorithm: 'HS256' },
        };
      },
    }),
  ],
  controllers: [SsoController],
  providers: [SsoService, SsoGuard],
  exports: [SsoService, SsoGuard],
})
export class SsoModule {}
