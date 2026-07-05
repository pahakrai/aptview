// ============================================================================
// Database seed — development data
// ============================================================================
// Usage: yarn workspace backend db:seed

import { db } from './client';
import { organizations, repositories, codeGuidelines, apiKeys } from './schema';
import { eq } from 'drizzle-orm';

async function seed() {
  console.log('🌱 Seeding development data...');

  // Create a demo organization
  const [org] = await db
    .insert(organizations)
    .values({
      name: 'Demo Corp',
      slug: 'demo-corp',
      enforcementMode: 'advisory',
    })
    .onConflictDoNothing()
    .returning();

  if (!org) {
    console.log('  Demo org already exists, re-using.');
    const existing = await db
      .select()
      .from(organizations)
      .where(eq(organizations.slug, 'demo-corp'))
      .limit(1);

    if (!existing[0]) {
      throw new Error('Failed to find or create demo organization');
    }

    // Still seed the rest using the existing org
    await seedForOrg(existing[0].id);
    return;
  }

  console.log(`  Created organization: ${org.name} (${org.id})`);
  await seedForOrg(org.id);
}

async function seedForOrg(orgId: string) {
  // Demo repository
  const [repo] = await db
    .insert(repositories)
    .values({
      organizationId: orgId,
      name: 'demo-api',
      fullName: 'demo-corp/demo-api',
      provider: 'github',
      isActive: true,
    })
    .onConflictDoNothing()
    .returning();

  if (repo) {
    console.log(`  Created repository: ${repo.fullName}`);
  }

  // Default code guidelines
  const guidelines = [
    {
      organizationId: orgId,
      name: 'No console.log in production',
      description: 'Prevent debug logging from reaching production code.',
      pattern: 'console\\.(log|debug|warn)\\(',
      severity: 'warning' as const,
      category: 'code-quality',
    },
    {
      organizationId: orgId,
      name: 'Avoid hardcoded secrets',
      description: 'Detect API keys, tokens, and passwords in source.',
      pattern: '(api_key|password|secret|token)\\s*=\\s*[\'"][^\'"]{8,}[\'"]',
      severity: 'error' as const,
      category: 'security',
    },
    {
      organizationId: orgId,
      name: 'Max function length',
      description: 'Functions should not exceed 50 lines (approximate).',
      pattern: '^\\s*(export\\s+)?(async\\s+)?function\\s+\\w+',
      severity: 'info' as const,
      category: 'style',
    },
    {
      organizationId: orgId,
      name: 'No TODO without ticket',
      description: 'TODOs must reference a ticket: TODO(JIRA-123).',
      pattern: '//\\s*TODO(?!\\([A-Z]+-\\d+\\))',
      severity: 'warning' as const,
      category: 'process',
    },
    {
      organizationId: orgId,
      name: 'Avoid any type',
      description: 'TypeScript `any` bypasses type safety.',
      pattern: ':\\s*any\\b',
      severity: 'warning' as const,
      category: 'type-safety',
    },
  ];

  for (const g of guidelines) {
    await db
      .insert(codeGuidelines)
      .values(g)
      .onConflictDoNothing();
  }

  console.log(`  Created ${guidelines.length} code guidelines`);

  // Demo API key
  await db
    .insert(apiKeys)
    .values({
      organizationId: orgId,
      name: 'Development Key',
      keyHash: 'dev-key-hash-placeholder',
      keyPrefix: 'aigov_dev_',
    })
    .onConflictDoNothing();

  console.log('  Created demo API key');
  console.log('✅ Seed complete!');
}

seed()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
