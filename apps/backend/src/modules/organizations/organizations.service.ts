import { Injectable, NotFoundException } from '@nestjs/common';
import { db } from '../../database/client';
import { organizations, enforcementEvents } from '../../database/schema';
import { eq } from 'drizzle-orm';
import { EnforcementMode } from '@aigov/shared-types';

@Injectable()
export class OrganizationsService {
  async create(name: string, slug: string) {
    const [org] = await db
      .insert(organizations)
      .values({ name, slug })
      .returning();
    return org;
  }

  async getById(id: string) {
    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, id))
      .limit(1);

    if (!org) throw new NotFoundException(`Organization ${id} not found`);
    return org;
  }

  async getBySlug(slug: string) {
    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.slug, slug))
      .limit(1);

    if (!org) throw new NotFoundException(`Organization with slug "${slug}" not found`);
    return org;
  }

  async updateEnforcementMode(
    orgId: string,
    newMode: EnforcementMode,
    changedBy: string,
  ) {
    const org = await this.getById(orgId);
    const previousMode = org.enforcementMode as EnforcementMode;

    await db
      .update(organizations)
      .set({ enforcementMode: newMode, updatedAt: new Date() })
      .where(eq(organizations.id, orgId));

    await db.insert(enforcementEvents).values({
      organizationId: orgId,
      previousMode,
      newMode,
      changedBy,
    });

    return {
      previousMode,
      newMode,
      message: `Enforcement mode changed from ${previousMode} to ${newMode}`,
    };
  }
}
