import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../../database/client';
import { activeFlowRuns, activeFlows, experiments } from '../../database/schema';
import type { AuditVerdict, ReviewDecisionAction } from '@aigov/shared-types';

/**
 * PromotionsService — the "plugin": active flows (promotion, resolution,
 * rollback) and the active_flow_runs that feed the post-promotion flywheel.
 */
@Injectable()
export class PromotionsService {
  async promote(
    experimentId: string,
    input: {
      variantId: string;
      scope: 'org' | 'repo';
      organizationId?: string;
      repositoryId?: string;
      promotedBy?: string;
    },
  ) {
    const [exp] = await db
      .select()
      .from(experiments)
      .where(eq(experiments.id, experimentId))
      .limit(1);
    if (!exp) throw new NotFoundException('Experiment ' + experimentId + ' not found');

    const index =
      input.variantId === 'control' ? -1 : Number(input.variantId.split('-')[1]) - 1;
    const variant = index === -1 ? exp.controlStrategy : exp.treatmentStrategies[index];
    if (!variant) throw new NotFoundException('Variant ' + input.variantId + ' not found');

    let organizationId: string | null = null;
    let repositoryId: string | null = null;
    if (input.scope === 'org') {
      organizationId = input.organizationId ?? exp.organizationId;
      if (!organizationId) throw new BadRequestException('org scope requires an organization');
    } else {
      repositoryId = input.repositoryId ?? null;
      if (!repositoryId) throw new BadRequestException('repo scope requires repositoryId');
    }

    const scopeWhere =
      input.scope === 'org'
        ? and(eq(activeFlows.organizationId, organizationId!), isNull(activeFlows.repositoryId))
        : eq(activeFlows.repositoryId, repositoryId!);

    const [current] = await db
      .select()
      .from(activeFlows)
      .where(scopeWhere)
      .orderBy(desc(activeFlows.promotedAt))
      .limit(1);

    const version = (current?.version ?? 0) + 1;
    const [row] = await db
      .insert(activeFlows)
      .values({
        organizationId,
        repositoryId,
        variant,
        version,
        promotedBy: input.promotedBy ?? 'admin',
        promotedAt: new Date(),
        previousId: current?.id ?? null,
      })
      .returning();
    return row;
  }

  async resolveActiveFlow(organizationId: string, repositoryId?: string | null) {
    if (repositoryId) {
      const [repoFlow] = await db
        .select()
        .from(activeFlows)
        .where(eq(activeFlows.repositoryId, repositoryId))
        .orderBy(desc(activeFlows.promotedAt))
        .limit(1);
      if (repoFlow) return repoFlow;
    }
    const [orgFlow] = await db
      .select()
      .from(activeFlows)
      .where(and(eq(activeFlows.organizationId, organizationId), isNull(activeFlows.repositoryId)))
      .orderBy(desc(activeFlows.promotedAt))
      .limit(1);
    return orgFlow ?? null;
  }

  async listActiveFlows() {
    return db.select().from(activeFlows).orderBy(desc(activeFlows.promotedAt));
  }

  async revertActiveFlow(id: string) {
    const [flow] = await db
      .select()
      .from(activeFlows)
      .where(eq(activeFlows.id, id))
      .limit(1);
    if (!flow) throw new NotFoundException('Active flow ' + id + ' not found');
    if (!flow.previousId) throw new BadRequestException('No previous flow to revert to');
    const [prev] = await db
      .select()
      .from(activeFlows)
      .where(eq(activeFlows.id, flow.previousId))
      .limit(1);
    if (!prev) throw new NotFoundException('Previous flow ' + flow.previousId + ' not found');
    const [row] = await db
      .insert(activeFlows)
      .values({
        organizationId: prev.organizationId,
        repositoryId: prev.repositoryId,
        variant: prev.variant,
        version: flow.version + 1,
        promotedBy: 'revert',
        promotedAt: new Date(),
        previousId: flow.id,
      })
      .returning();
    return row;
  }

  async recordActiveFlowRun(input: {
    activeFlowId: string;
    repositoryFullName: string;
    prNumber: number;
    flow: string;
    verdict: AuditVerdict;
    complianceScore: number | null;
    efficiencyScore: number | null;
    coverageScore: number | null;
    latencyMs: number;
    promptTokens: number;
    completionTokens: number;
    toolCalls: number;
  }) {
    await db
      .insert(activeFlowRuns)
      .values({
        activeFlowId: input.activeFlowId,
        repositoryFullName: input.repositoryFullName,
        prNumber: input.prNumber,
        verdict: input.verdict,
        complianceScore: input.complianceScore,
        efficiencyScore: input.efficiencyScore,
        coverageScore: input.coverageScore,
        latencyMs: input.latencyMs,
        promptTokens: input.promptTokens,
        completionTokens: input.completionTokens,
        toolCalls: input.toolCalls,
        flow: input.flow,
      })
      .onConflictDoUpdate({
        target: [
          activeFlowRuns.activeFlowId,
          activeFlowRuns.repositoryFullName,
          activeFlowRuns.prNumber,
        ],
        set: {
          verdict: input.verdict,
          complianceScore: input.complianceScore,
          efficiencyScore: input.efficiencyScore,
          coverageScore: input.coverageScore,
          latencyMs: input.latencyMs,
          promptTokens: input.promptTokens,
          completionTokens: input.completionTokens,
          toolCalls: input.toolCalls,
          flow: input.flow,
        },
      });
  }

  async listActiveFlowRuns(activeFlowId: string) {
    return db
      .select()
      .from(activeFlowRuns)
      .where(eq(activeFlowRuns.activeFlowId, activeFlowId))
      .orderBy(desc(activeFlowRuns.createdAt));
  }

  async foldHumanDecision(
    repositoryFullName: string,
    prNumber: number,
    action: ReviewDecisionAction,
    humanAccepted: boolean | null,
    revisionCount: number,
  ) {
    await db
      .update(activeFlowRuns)
      .set({
        humanDecision: action,
        humanAccepted,
        revisionCount,
        ...(action === 'approve' ? { acceptedAt: new Date() } : {}),
      })
      .where(
        and(
          eq(activeFlowRuns.repositoryFullName, repositoryFullName),
          eq(activeFlowRuns.prNumber, prNumber),
        ),
      );
  }
}
