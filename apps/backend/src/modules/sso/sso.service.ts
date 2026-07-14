import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { db } from '../../database/client';
import {
  ssoUsers,
  oauthClients,
  oauthAuthorizationCodes,
} from '../../database/schema';
import { eq, and, lt } from 'drizzle-orm';
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const randomBytesAsync = promisify(randomBytes);

/**
 * SsoService — OAuth 2.0 / OpenID Connect Authorization Server logic.
 *
 * Handles:
 *   - User authentication (email + password with scrypt hashing)
 *   - OAuth client validation
 *   - Authorization code generation (single-use, 5-minute expiry)
 *   - JWT minting with RS256 + user attributes as claims
 */

@Injectable()
export class SsoService {
  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
  ) {}

  // =========================================================================
  // User authentication
  // =========================================================================

  /**
   * Verify email + password, return user if valid.
   */
  async authenticateUser(email: string, password: string) {
    const [user] = await db
      .select()
      .from(ssoUsers)
      .where(and(eq(ssoUsers.email, email), eq(ssoUsers.isActive, true)))
      .limit(1);

    if (!user) return null;

    const [salt, hash] = user.passwordHash.split(':');
    const derived = scryptSync(password, salt, 64).toString('hex');

    if (
      hash.length === derived.length &&
      timingSafeEqual(Buffer.from(hash), Buffer.from(derived))
    ) {
      // Update last login
      await db
        .update(ssoUsers)
        .set({ lastLoginAt: new Date() })
        .where(eq(ssoUsers.id, user.id));

      return { id: user.id, email: user.email, attributes: user.attributes };
    }

    return null;
  }

  // =========================================================================
  // OAuth client validation
  // =========================================================================

  /**
   * Validate client credentials and redirect URI.
   */
  async validateClient(
    clientId: string,
    clientSecret: string,
    redirectUri: string,
  ): Promise<boolean> {
    const [client] = await db
      .select()
      .from(oauthClients)
      .where(
        and(
          eq(oauthClients.clientId, clientId),
          eq(oauthClients.isActive, true),
        ),
      )
      .limit(1);

    if (!client) return false;

    // Verify client secret
    const [salt, hash] = client.clientSecretHash.split(':');
    const derived = scryptSync(clientSecret, salt, 64).toString('hex');
    if (
      hash.length !== derived.length ||
      !timingSafeEqual(Buffer.from(hash), Buffer.from(derived))
    ) {
      return false;
    }

    // Verify redirect URI is allowed
    const allowed = client.allowedRedirectUris || [];
    return allowed.some((uri) => redirectUri.startsWith(uri));
  }

  /**
   * Validate that a clientId + redirectUri pair is registered.
   * Used by the authorize endpoint (no client secret needed).
   */
  async validateClientRedirect(
    clientId: string,
    redirectUri: string,
  ): Promise<boolean> {
    const [client] = await db
      .select()
      .from(oauthClients)
      .where(
        and(
          eq(oauthClients.clientId, clientId),
          eq(oauthClients.isActive, true),
        ),
      )
      .limit(1);

    if (!client) return false;

    const allowed = client.allowedRedirectUris || [];
    return allowed.some((uri) => redirectUri.startsWith(uri));
  }

  // =========================================================================
  // Authorization code
  // =========================================================================

  /**
   * Generate a single-use authorization code valid for 5 minutes.
   */
  async generateAuthorizationCode(
    userId: string,
    clientId: string,
    redirectUri: string,
  ): Promise<string> {
    // Clean up expired codes first
    await db
      .delete(oauthAuthorizationCodes)
      .where(lt(oauthAuthorizationCodes.expiresAt, new Date()));

    const code = (await randomBytesAsync(16)).toString('hex');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    await db.insert(oauthAuthorizationCodes).values({
      code,
      userId,
      clientId,
      redirectUri,
      expiresAt,
    });

    return code;
  }

  /**
   * Validate and consume an authorization code.
   * Returns the user ID associated with the code, or null.
   */
  async consumeAuthorizationCode(code: string): Promise<{
    userId: string;
    clientId: string;
  } | null> {
    const [record] = await db
      .select()
      .from(oauthAuthorizationCodes)
      .where(eq(oauthAuthorizationCodes.code, code))
      .limit(1);

    if (!record) return null;
    if (record.isUsed) return null;
    if (new Date() > record.expiresAt) return null;

    // Mark as used (one-time use)
    await db
      .update(oauthAuthorizationCodes)
      .set({ isUsed: true })
      .where(eq(oauthAuthorizationCodes.id, record.id));

    return { userId: record.userId, clientId: record.clientId };
  }

  // =========================================================================
  // JWT minting (RS256)
  // =========================================================================

  /**
   * Mint a JWT access token with user attributes as claims.
   * Signed with RS256 (asymmetric) so Nginx can verify independently.
   */
  async mintAccessToken(user: {
    id: string;
    email: string;
    attributes: Record<string, unknown>;
  }): Promise<{ accessToken: string; expiresIn: number }> {
    const expiresIn = 3600; // 1 hour

    const payload = {
      sub: user.id,
      email: user.email,
      role: user.attributes.role || 'user',
      department: user.attributes.department || '',
      clearanceLevel: user.attributes.clearanceLevel || 0,
      userId: user.attributes.userId || user.id,
    };

    const accessToken = await this.jwtService.signAsync(payload, {
      expiresIn,
    });

    return { accessToken, expiresIn };
  }

  /**
   * Verify a JWT token and return its payload.
   */
  async verifyToken(token: string): Promise<Record<string, unknown> | null> {
    try {
      return await this.jwtService.verifyAsync(token);
    } catch {
      return null;
    }
  }
}
