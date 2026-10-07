import { Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { db } from '../../database/client';
import { agentStructures } from '../../database/schema';
import type { AuditStrategy } from '@aigov/shared-types';

@Injectable()
export class AgentStructuresService {
  async list(organizationId?: string | null) {
    if (organizationId) {
      return db
        .select()
        .from(agentStructures)
        .where(eq(agentStructures.organizationId, organizationId))
        .orderBy(desc(agentStructures.createdAt));
    }
    return db.select().from(agentStructures).orderBy(desc(agentStructures.createdAt));
  }

  async getById(id: string) {
    const [s] = await db
      .select()
      .from(agentStructures)
      .where(eq(agentStructures.id, id))
      .limit(1);
    return s ?? null;
  }

  async create(input: {
    name: string;
    description?: string | null;
    organizationId?: string | null;
    strategy: AuditStrategy;
  }) {
    const [s] = await db
      .insert(agentStructures)
      .values({
        name: input.name,
        description: input.description ?? null,
        organizationId: input.organizationId ?? null,
        strategy: input.strategy,
      })
      .returning();
    return s;
  }

  async update(
    id: string,
    input: {
      name?: string;
      description?: string | null;
      strategy?: AuditStrategy;
      isActive?: boolean;
    },
  ) {
    const [s] = await db
      .update(agentStructures)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(agentStructures.id, id))
      .returning();
    if (!s) throw new NotFoundException('Agent structure ' + id + ' not found');
    return s;
  }

  async remove(id: string) {
    await db.delete(agentStructures).where(eq(agentStructures.id, id));
    return { id };
  }
}
