import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { db } from '../../database/client';
import { aiAudits, scopeViolations } from '../../database/schema';
import { eq, desc, sql, and, gte } from 'drizzle-orm';
import { AuditRequest } from '@aigov/shared-types';
import { paginate } from '@aigov/utils';

@Injectable()
export class AuditsService {
  constructor(
    @InjectQueue('audits') private readonly auditQueue: Queue,
  ) {}

  /**
   * Enqueue an audit job into the Redis-backed BullMQ queue.
   */
  async enqueueAudit(request: AuditRequest) {
    const job = await this.auditQueue.add('audit-code', request, {
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 86400 },
      deduplication: {
        id: `${request.organizationId}:${request.prNumber}:${request.commitSha}`,
      },
    });

    return {
      jobId: job.id,
      status: 'queued',
      message: 'Audit job enqueued. Results will be stored when complete.',
    };
  }

  /**
   * Get an audit by ID.
   */
  async getById(id: string) {
    const [audit] = await db
      .select()
      .from(aiAudits)
      .where(eq(aiAudits.id, id))
      .limit(1);

    if (!audit) throw new NotFoundException(`Audit ${id} not found`);
    return audit;
  }

  /**
   * Get the three percentage scores for a specific audit.
   */
  async getScores(id: string) {
    const audit = await this.getById(id);

    return {
      auditId: audit.id,
      complianceScore: audit.complianceScore,
      efficiencyScore: audit.efficiencyScore,
      coverageScore: audit.coverageScore,
      verdict: audit.verdict,
    };
  }

  /**
   * List audits for a repository, paginated.
   */
  async listByRepo(repositoryId: string, page: number, pageSize: number) {
    const offset = (page - 1) * pageSize;

    const [data, totalResult] = await Promise.all([
      db
        .select()
        .from(aiAudits)
        .where(eq(aiAudits.repositoryId, repositoryId))
        .orderBy(desc(aiAudits.createdAt))
        .limit(pageSize)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)` })
        .from(aiAudits)
        .where(eq(aiAudits.repositoryId, repositoryId)),
    ]);

    const total = Number(totalResult[0]?.count ?? 0);

    return {
      data,
      ...paginate(total, page, pageSize),
    };
  }

  /**
   * Get scope violations for an audit.
   */
  async getViolations(auditId: string) {
    return db
      .select()
      .from(scopeViolations)
      .where(eq(scopeViolations.auditId, auditId));
  }

  /**
   * Get aggregate stats for an organization.
   */
  async getOrgStats(organizationId: string) {
    const [result] = await db
      .select({
        totalAudits: sql<number>`count(*)::int`,
        passed: sql<number>`sum(case when verdict = 'pass' then 1 else 0 end)::int`,
        failed: sql<number>`sum(case when verdict = 'fail' then 1 else 0 end)::int`,
        warnings: sql<number>`sum(case when verdict = 'warning' then 1 else 0 end)::int`,
        scopeCreepDetected: sql<number>`sum(case when scope_creep_detected = true then 1 else 0 end)::int`,
        avgDurationMs: sql<number>`avg(audit_duration_ms)::int`,
        avgCompliance: sql<number>`avg(compliance_score)::int`,
        avgEfficiency: sql<number>`avg(efficiency_score)::int`,
        avgCoverage: sql<number>`avg(coverage_score)::int`,
      })
      .from(aiAudits)
      .where(eq(aiAudits.organizationId, organizationId));

    return result ?? {
      totalAudits: 0, passed: 0, failed: 0, warnings: 0,
      scopeCreepDetected: 0, avgDurationMs: 0,
      avgCompliance: null, avgEfficiency: null, avgCoverage: null,
    };
  }

  /**
   * Get score trends over time for an organization.
   * Returns weekly averages for compliance, efficiency, and coverage scores.
   * Defaults to last 12 weeks.
   */
  async getScoreTrends(organizationId: string, weeks = 12) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - weeks * 7);

    const rows = await db
      .select({
        week: sql<string>`date_trunc('week', created_at)::date`,
        avgCompliance: sql<number>`avg(compliance_score)::int`,
        avgEfficiency: sql<number>`avg(efficiency_score)::int`,
        avgCoverage: sql<number>`avg(coverage_score)::int`,
        auditCount: sql<number>`count(*)::int`,
      })
      .from(aiAudits)
      .where(
        and(
          eq(aiAudits.organizationId, organizationId),
          gte(aiAudits.createdAt, cutoff),
        ),
      )
      .groupBy(sql`date_trunc('week', created_at)`)
      .orderBy(sql`date_trunc('week', created_at)`);

    return {
      organizationId,
      weeks,
      trends: rows.map((r) => ({
        week: r.week,
        avgCompliance: r.avgCompliance,
        avgEfficiency: r.avgEfficiency,
        avgCoverage: r.avgCoverage,
        auditCount: r.auditCount,
      })),
    };
  }
}
