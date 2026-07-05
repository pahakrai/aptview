import { Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { db } from '../../database/client';
import { repositories } from '../../database/schema';
import { eq, and } from 'drizzle-orm';

@Injectable()
export class RepositoriesService {
  async create(input: {
    organizationId: string;
    name: string;
    fullName: string;
    provider?: string;
  }) {
    const webhookSecret = randomBytes(16).toString('hex');

    const [repo] = await db
      .insert(repositories)
      .values({
        ...input,
        provider: input.provider || 'github',
        webhookSecret,
      })
      .returning();

    return repo;
  }

  async listByOrg(organizationId: string) {
    return db
      .select()
      .from(repositories)
      .where(eq(repositories.organizationId, organizationId));
  }

  async getById(id: string) {
    const [repo] = await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, id))
      .limit(1);

    if (!repo) throw new NotFoundException(`Repository ${id} not found`);
    return repo;
  }

  async update(id: string, data: { isActive?: boolean; webhookSecret?: string }) {
    await this.getById(id); // throws if not found

    const [updated] = await db
      .update(repositories)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(repositories.id, id))
      .returning();

    return updated;
  }
}
