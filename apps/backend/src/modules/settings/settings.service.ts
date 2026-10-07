import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { db } from '../../database/client';
import { settings } from '../../database/schema';

@Injectable()
export class SettingsService {
  async get(key: string): Promise<string | null> {
    const [row] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, key))
      .limit(1);
    return row?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await db
      .insert(settings)
      .values({ key, value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  }

  async getBoolean(key: string): Promise<boolean | null> {
    const v = await this.get(key);
    if (v === null || v === undefined) return null;
    return v === 'true';
  }
}
