import { Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { db } from '../../database/client';
import { notifications } from '../../database/schema';

@Injectable()
export class NotificationsService {
  async list(organizationId?: string | null) {
    if (organizationId) {
      return db
        .select()
        .from(notifications)
        .where(eq(notifications.organizationId, organizationId))
        .orderBy(desc(notifications.createdAt));
    }
    return db.select().from(notifications).orderBy(desc(notifications.createdAt));
  }

  async notify(organizationId: string, type: string, title: string, body: string) {
    await db.insert(notifications).values({ organizationId, type, title, body });
  }
}
