import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, createHash } from 'crypto';
import { db } from '../../database/client';
import { apiKeys } from '../../database/schema';
import { eq } from 'drizzle-orm';

@Injectable()
export class AuthService {
  constructor(private readonly jwtService: JwtService) {}

  /**
   * Create a new API key for an organization.
   */
  async createApiKey(organizationId: string, name: string) {
    const rawKey = `aigov_${randomBytes(24).toString('hex')}`;
    const prefix = rawKey.slice(0, 12);
    const hash = createHash('sha256').update(rawKey).digest('hex');

    await db.insert(apiKeys).values({
      organizationId,
      name,
      keyHash: hash,
      keyPrefix: prefix,
    });

    return {
      apiKey: rawKey,
      prefix,
      message: 'Store this key securely — it will not be shown again.',
    };
  }

  /**
   * Revoke an existing API key.
   */
  async revokeApiKey(keyId: string) {
    await db
      .update(apiKeys)
      .set({ isRevoked: true })
      .where(eq(apiKeys.id, keyId));

    return { revoked: true };
  }

  /**
   * Validate an API key hash. Returns the organization ID if valid.
   */
  async validateApiKey(rawKey: string): Promise<{ organizationId: string } | null> {
    const hash = createHash('sha256').update(rawKey).digest('hex');

    const [key] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, hash))
      .limit(1);

    if (!key || key.isRevoked) return null;
    if (key.expiresAt && new Date(key.expiresAt) < new Date()) return null;

    // Update last used timestamp
    await db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, key.id));

    return { organizationId: key.organizationId };
  }
}
