import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { db } from '../../database/client';
import { aiAudits, scopeViolations, codeGuidelines } from '../../database/schema';
import { eq } from 'drizzle-orm';
import {
  AuditRequest,
  AuditVerdict,
  AuditStrategy,
  PromptVariant,
} from '@aigov/shared-types';
import { SandboxService } from './sandbox.service';
import { formatChangedFilesForPrompt } from './diff-parser';
import { callDeepSeekChat } from './llm-deepseek';
import { ExperimentsService, ResolvedArm } from '../experiments/experiments.service';
import { PromotionsService } from '../experiments/promotions.service';
import { FlowRunnerService } from '../flow-runner/flow-runner.service';

/**
 * AuditProcessor — BullMQ worker for code review jobs.
 *
 * Supports three analysis modes:
 *   - INLINE (default): Runs regex pattern matching in-process. Fast and
 *     config-free. Suitable for dev and pattern-only audits.
 *   - SDK: Uses Claude Agent SDK in-process for AI-powered semantic analysis.
 *     Zero infrastructure overhead, fast startup. Set AUDIT_MODE=sdk.
 *   - SANDBOX: Spawns an ephemeral K8s Job running CodeWhale for AI-powered
 *     semantic analysis with full container isolation. Set AUDIT_MODE=sandbox.
 *
 * All modes compute three percentage scores:
 *   - complianceScore (0–100): % of guidelines the code passed
 *   - efficiencyScore (0–100): code size vs estimate (penalizes over-engineering)
 *   - coverageScore  (0–100): requirement coverage (AI-only, null in inline)
 */

interface ViolationEntry {
  guideline: string;
  severity: string;
  line: number;
  match: string;
}

/** Normalized result of any audit engine, used to feed experiment runs. */
interface AuditOutcome {
  auditId: string;
  verdict: AuditVerdict;
  complianceScore: number | null;
  efficiencyScore: number | null;
  coverageScore: number | null;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  parseOk?: boolean;
}

@Processor('audits')
export class AuditProcessor extends WorkerHost {
  private readonly auditMode: 'inline' | 'sandbox' | 'sdk';

  constructor(
    private readonly sandboxService: SandboxService,
    private readonly configService: ConfigService,
    private readonly experimentsService: ExperimentsService,
    private readonly flowRunner: FlowRunnerService,
    private readonly promotionsService: PromotionsService,
  ) {
    super();
    const mode = this.configService.get<string>('AUDIT_MODE');
    if (mode === 'sandbox') this.auditMode = 'sandbox';
    else if (mode === 'sdk') this.auditMode = 'sdk';
    else this.auditMode = 'inline';
  }

  async process(job: Job<AuditRequest>): Promise<{ auditId: string }> {
    // Feature-flagged experiment routing. Resolves a deterministic arm
    // (control vs treatment); otherwise the production path is unchanged.
    const arm = await this.experimentsService.resolveArm(
      job.data.organizationId,
      job.data.prNumber,
      job.data.repositoryFullName,
    );

    if (arm) {
      const outcome = await this.processWithStrategy(job, arm);
      await this.experimentsService.recordRun({
        experimentId: arm.experimentId,
        variantId: arm.variantId,
        auditId: outcome.auditId,
        prNumber: job.data.prNumber,
        repositoryFullName: job.data.repositoryFullName ?? null,
        strategy: arm.strategy,
        verdict: outcome.verdict,
        complianceScore: outcome.complianceScore,
        efficiencyScore: outcome.efficiencyScore,
        coverageScore: outcome.coverageScore,
        latencyMs: outcome.latencyMs,
        promptTokens: outcome.promptTokens,
        completionTokens: outcome.completionTokens,
        agreedWithInline: await this.computeAgreedWithInline(job, outcome.verdict),
        parseOk: outcome.parseOk ?? null,
      });
      return { auditId: outcome.auditId };
    }

    // Plugin: a promoted active flow (repo overrides org). Runs the chosen
    // architecture (sequential or orchestrator) for live reviews.
    const activeFlow = await this.promotionsService.resolveActiveFlow(
      job.data.organizationId,
      job.data.repositoryId,
    );
    if (activeFlow) {
      return this.processViaFlow(job, activeFlow.variant, activeFlow.id);
    }

    if (this.auditMode === 'sandbox') return this.processViaSandbox(job);
    if (this.auditMode === 'sdk') return this.processViaSDK(job);
    return this.processInline(job);
  }

  /**
   * Run a live review through the promoted flow architecture (the "plugin").
   * Persists the audit + scope violations just like the other engines.
   */
  private async processViaFlow(
    job: Job<AuditRequest>,
    strategy: AuditStrategy,
    activeFlowId: string,
  ): Promise<AuditOutcome> {
    const start = Date.now();
    const {
      organizationId,
      repositoryId,
      prNumber,
      prTitle,
      commitSha,
      diffContent,
      taskDescription,
    } = job.data;

    const guidelines = await db
      .select()
      .from(codeGuidelines)
      .where(eq(codeGuidelines.organizationId, organizationId));
    const activeGuidelines = guidelines.filter((g) => g.isEnabled);

    const outcome = await this.flowRunner.run(strategy, {
      prTitle: prTitle ?? 'PR ' + prNumber,
      diffContent,
      taskDescription,
      tenantId: organizationId,
      guidelines: activeGuidelines.map((g) => ({
        name: g.name,
        description: g.description,
        pattern: g.pattern,
        severity: g.severity,
      })),
    });

    const durationMs = Date.now() - start;

    const [audit] = await db
      .insert(aiAudits)
      .values({
        organizationId,
        repositoryId,
        prNumber,
        prTitle,
        commitSha,
        verdict: outcome.verdict,
        totalViolations: outcome.totalViolations,
        errorCount: outcome.errorCount,
        warningCount: outcome.warningCount,
        scopeCreepDetected: outcome.scopeCreepDetected,
        complianceScore: outcome.complianceScore,
        efficiencyScore: outcome.efficiencyScore,
        coverageScore: outcome.coverageScore,
        actualLoc: outcome.actualLoc,
        estimatedLoc: outcome.estimatedLoc,
        auditDurationMs: durationMs,
        completedAt: new Date(),
      })
      .returning();

    if (outcome.scopeCreepDetected) {
      await db.insert(scopeViolations).values({
        auditId: audit.id,
        filePath: 'N/A (flow runner)',
        violationType: 'loc_explosion',
        description:
          'Flow runner detected scope creep. Actual LOC (' +
          outcome.actualLoc +
          ') vs estimated (' +
          outcome.estimatedLoc +
          ').',
        actualLoc: outcome.actualLoc,
        expectedLoc: outcome.estimatedLoc,
      });
    }

    // Flywheel: record this promoted-flow review so its live HITL acceptance
    // keeps accumulating after promotion.
    if (job.data.repositoryFullName) {
      await this.promotionsService.recordActiveFlowRun({
        activeFlowId,
        repositoryFullName: job.data.repositoryFullName,
        prNumber,
        flow: strategy.flow ?? 'sequential',
        verdict: outcome.verdict,
        complianceScore: outcome.complianceScore,
        efficiencyScore: outcome.efficiencyScore,
        coverageScore: outcome.coverageScore,
        latencyMs: durationMs,
        promptTokens: outcome.promptTokens,
        completionTokens: outcome.completionTokens,
        toolCalls: outcome.toolCalls,
      });
    }

    return {
      auditId: audit.id,
      verdict: outcome.verdict,
      complianceScore: outcome.complianceScore,
      efficiencyScore: outcome.efficiencyScore,
      coverageScore: outcome.coverageScore,
      latencyMs: durationMs,
      promptTokens: outcome.promptTokens,
      completionTokens: outcome.completionTokens,
      parseOk: outcome.parseOk,
    };
  }

  /**
   * Dispatch an audit to an engine based on the assigned experiment arm.
   */
  private async processWithStrategy(
    job: Job<AuditRequest>,
    arm: ResolvedArm,
  ): Promise<AuditOutcome> {
    switch (arm.strategy.engine) {
      case 'deepseek':
        return this.processViaDeepSeek(job, arm.strategy);
      case 'sandbox':
        return this.processViaSandbox(job);
      case 'sdk':
        return this.processViaSDK(job);
      case 'inline':
      default:
        return this.processInline(job);
    }
  }

  /**
   * Does the arm's verdict agree with the deterministic inline (regex) engine?
   * Used as an inter-model agreement signal, distinct from human acceptance.
   */
  private async computeAgreedWithInline(
    job: Job<AuditRequest>,
    verdict: AuditVerdict,
  ): Promise<boolean> {
    return (await this.computeInlineVerdict(job)) === verdict;
  }

  /**
   * Run the same guideline-pattern verdict logic as the inline engine,
   * without persisting an audit row.
   */
  private async computeInlineVerdict(
    job: Job<AuditRequest>,
  ): Promise<AuditVerdict> {
    const guidelines = await db
      .select()
      .from(codeGuidelines)
      .where(eq(codeGuidelines.organizationId, job.data.organizationId));

    const lines = job.data.diffContent.split('\n');
    let errorCount = 0;
    let warningCount = 0;

    for (const guideline of guidelines) {
      if (!guideline.isEnabled) continue;
      try {
        const pattern = new RegExp(guideline.pattern, 'gi');
        for (const line of lines) {
          if (pattern.exec(line)) {
            if (guideline.severity === 'error') errorCount += 1;
            else if (guideline.severity === 'warning') warningCount += 1;
          }
        }
      } catch {
        // Skip invalid regex patterns.
      }
    }

    if (errorCount > 0) return AuditVerdict.FAIL;
    if (warningCount > 0) return AuditVerdict.WARNING;
    return AuditVerdict.PASS;
  }

  // =========================================================================
  // SANDBOX MODE — K8s Job via CodeWhale
  // =========================================================================

  private async processViaSandbox(
    job: Job<AuditRequest>,
  ): Promise<AuditOutcome> {
    const startTime = Date.now();
    const {
      organizationId,
      repositoryId,
      prNumber,
      prTitle,
      commitSha,
      diffContent,
      changedFiles = {},
      taskDescription,
    } = job.data;

    // Load org guidelines for the prompt
    const guidelines = await db
      .select()
      .from(codeGuidelines)
      .where(eq(codeGuidelines.organizationId, organizationId));

    const activeGuidelines = guidelines.filter((g) => g.isEnabled);

    // Build the analysis prompt
    const prompt = this.buildAuditPrompt({
      prTitle,
      diffContent,
      changedFiles,
      taskDescription,
      guidelines: activeGuidelines,
    });

    // Submit to K8s sandbox
    const jobId = job.id || `direct-${Date.now()}`;
    const result = await this.sandboxService.runAudit({
      jobId,
      prompt,
    });

    const durationMs = Date.now() - startTime;

    // Parse CodeWhale's JSON output
    const sv = result.parsed as SandboxOutput | null;

    const verdict: AuditVerdict = sv?.verdict ?? AuditVerdict.WARNING;
    const totalViolations = sv?.totalViolations ?? 0;
    const errorCount = sv?.errorCount ?? 0;
    const warningCount = sv?.warningCount ?? 0;
    const scopeCreepDetected = sv?.scopeCreepDetected ?? false;
    const actualLoc = sv?.actualLoc ?? 0;
    const estimatedLoc = sv?.estimatedLoc ?? 150;

    // Scores from AI — validated to 0–100 range
    const complianceScore = this.clampScore(sv?.complianceScore ?? null);
    const efficiencyScore = this.clampScore(sv?.efficiencyScore ?? null);
    const coverageScore = this.clampScore(sv?.coverageScore ?? null);

    // Persist audit record
    const [audit] = await db
      .insert(aiAudits)
      .values({
        organizationId,
        repositoryId,
        prNumber,
        prTitle,
        commitSha,
        verdict,
        totalViolations,
        errorCount,
        warningCount,
        scopeCreepDetected,
        complianceScore,
        efficiencyScore,
        coverageScore,
        actualLoc,
        estimatedLoc,
        auditDurationMs: durationMs,
        completedAt: new Date(),
      })
      .returning();

    // Insert scope violations if detected
    if (scopeCreepDetected) {
      await db.insert(scopeViolations).values({
        auditId: audit.id,
        filePath: sv?.scopeFile ?? 'N/A',
        violationType: 'loc_explosion',
        description: sv?.scopeDescription ??
          `AI analysis detected scope creep. Actual LOC (${actualLoc}) vs estimated (${estimatedLoc}).`,
        actualLoc,
        expectedLoc: estimatedLoc,
      });
    }

    console.log(
      `Sandbox audit ${audit.id}: ${verdict}, ${totalViolations}v, scores c=${complianceScore} e=${efficiencyScore} cov=${coverageScore}, ${durationMs}ms`,
    );

    return {
      auditId: audit.id,
      verdict,
      complianceScore,
      efficiencyScore,
      coverageScore,
      latencyMs: durationMs,
      parseOk: sv !== null,
    };
  }

  // =========================================================================
  // INLINE MODE — Regex pattern matching
  // =========================================================================

  private async processInline(
    job: Job<AuditRequest>,
  ): Promise<AuditOutcome> {
    const startTime = Date.now();
    const {
      organizationId,
      repositoryId,
      prNumber,
      prTitle,
      commitSha,
      diffContent,
    } = job.data;

    // Load org's active guidelines
    const guidelines = await db
      .select()
      .from(codeGuidelines)
      .where(eq(codeGuidelines.organizationId, organizationId));

    const activeGuidelines = guidelines.filter((g) => g.isEnabled);

    // Run pattern analysis against the diff content
    const violations: ViolationEntry[] = [];
    const lines = diffContent.split('\n');

    // Track which guidelines were violated (by name, for compliance score)
    const violatedGuidelineNames = new Set<string>();

    for (const guideline of guidelines) {
      if (!guideline.isEnabled) continue;
      try {
        const pattern = new RegExp(guideline.pattern, 'gi');
        for (let i = 0; i < lines.length; i++) {
          const match = pattern.exec(lines[i]);
          if (match) {
            violations.push({
              guideline: guideline.name,
              severity: guideline.severity,
              line: i + 1,
              match: match[0],
            });
            violatedGuidelineNames.add(guideline.name);
          }
        }
      } catch {
        // Skip invalid regex patterns
      }
    }

    // Compute verdict
    const errorCount = violations.filter((v) => v.severity === 'error').length;
    const warningCount = violations.filter((v) => v.severity === 'warning').length;
    const totalViolations = violations.length;

    let verdict: AuditVerdict;
    if (errorCount > 0) {
      verdict = AuditVerdict.FAIL;
    } else if (warningCount > 0) {
      verdict = AuditVerdict.WARNING;
    } else {
      verdict = AuditVerdict.PASS;
    }

    // Compute scope creep
    const addedLines = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    const removedLines = lines.filter((l) => l.startsWith('-') && !l.startsWith('---'));
    const actualLoc = addedLines.length + removedLines.length;
    const estimatedLoc = 150;
    const scopeCreepDetected = actualLoc > estimatedLoc * 2;

    // -----------------------------------------------------------------------
    // Compute percentage scores
    // -----------------------------------------------------------------------

    // Compliance: % of active guidelines that passed (no violation detected)
    const complianceScore =
      activeGuidelines.length > 0
        ? Math.round(
            ((activeGuidelines.length - violatedGuidelineNames.size) /
              activeGuidelines.length) *
              100,
          )
        : null;

    // Efficiency: penalizes over-engineering (actualLoc >> estimatedLoc)
    const efficiencyScore =
      estimatedLoc > 0
        ? actualLoc <= estimatedLoc
          ? 100
          : Math.max(0, Math.round((estimatedLoc / actualLoc) * 100))
        : null;

    // Coverage: requires AI analysis — not computable in inline mode
    const coverageScore = null;

    const durationMs = Date.now() - startTime;

    // Persist
    const [audit] = await db
      .insert(aiAudits)
      .values({
        organizationId,
        repositoryId,
        prNumber,
        prTitle,
        commitSha,
        verdict,
        totalViolations,
        errorCount,
        warningCount,
        scopeCreepDetected,
        complianceScore,
        efficiencyScore,
        coverageScore,
        actualLoc,
        estimatedLoc,
        auditDurationMs: durationMs,
        completedAt: new Date(),
      })
      .returning();

    if (scopeCreepDetected) {
      await db.insert(scopeViolations).values({
        auditId: audit.id,
        filePath: 'N/A (scope creep by LOC)',
        violationType: 'loc_explosion',
        description: `Actual LOC (${actualLoc}) exceeded estimated (${estimatedLoc}) by >2x. Scope creep detected.`,
        actualLoc,
        expectedLoc: estimatedLoc,
      });
    }

    console.log(
      `Audit ${audit.id}: ${verdict}, ${totalViolations}v, scores c=${complianceScore} e=${efficiencyScore}, ${durationMs}ms`,
    );

    return {
      auditId: audit.id,
      verdict,
      complianceScore,
      efficiencyScore,
      coverageScore,
      latencyMs: durationMs,
      parseOk: true,
    };
  }

  // =========================================================================
  // SDK MODE — Claude Agent SDK harness in-process
  // =========================================================================

  private async processViaSDK(
    job: Job<AuditRequest>,
  ): Promise<AuditOutcome> {
    const startTime = Date.now();
    const {
      organizationId,
      repositoryId,
      prNumber,
      prTitle,
      commitSha,
      diffContent,
      changedFiles = {},
      taskDescription,
    } = job.data;

    // Load guidelines
    const guidelines = await db
      .select()
      .from(codeGuidelines)
      .where(eq(codeGuidelines.organizationId, organizationId));

    const activeGuidelines = guidelines.filter((g) => g.isEnabled);

    // Build the same prompt used by sandbox mode
    const prompt = this.buildAuditPrompt({
      prTitle,
      diffContent,
      changedFiles,
      taskDescription,
      guidelines: activeGuidelines,
    });

    // -----------------------------------------------------------------------
    // Run via Claude Agent SDK — it handles the entire agent loop
    // -----------------------------------------------------------------------
    type SDKResult = { content: Array<{ type: 'text'; text: string }> };
    const sdkResult: SDKResult = { content: [] };

    // Accumulate all text content from the streaming agent
    for await (const message of query({
      prompt,
      options: {
        allowedTools: ['Read', 'Grep', 'Glob'],
        permissionMode: 'default',
        maxTurns: 15,
        model: this.configService.get<string>('SDK_MODEL') || 'claude-sonnet-4-20250514',
        systemPrompt: [
          'You are a code reviewer for an automated governance platform.',
          'Read the provided files and diff, check against the coding standards,',
          'and return a JSON verdict. Do NOT modify any files. Do NOT run commands.',
          'Only use Read, Grep, and Glob tools to explore the code you were given.',
        ].join(' '),
      },
    })) {
      // Collect all assistant text blocks
      const msg = message as {
        type: string;
        message?: { content: Array<{ type: string; text?: string }> };
      };
      if (
        msg.type === 'assistant' &&
        msg.message?.content
      ) {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text) {
            (sdkResult.content as Array<{ type: 'text'; text: string }>).push({
              type: 'text',
              text: block.text,
            });
          }
        }
      }
    }

    // Combine accumulated text and parse JSON
    const rawText = sdkResult.content.map((c) => c.text).join('\n');
    const sd = this.parseAgentJson(rawText) as SandboxOutput | null;

    const durationMs = Date.now() - startTime;

    // Extract scores
    const verdict: AuditVerdict = sd?.verdict ?? AuditVerdict.WARNING;
    const totalViolations = sd?.totalViolations ?? 0;
    const errorCount = sd?.errorCount ?? 0;
    const warningCount = sd?.warningCount ?? 0;
    const scopeCreepDetected = sd?.scopeCreepDetected ?? false;
    const actualLoc = sd?.actualLoc ?? 0;
    const estimatedLoc = sd?.estimatedLoc ?? 150;
    const complianceScore = this.clampScore(sd?.complianceScore ?? null);
    const efficiencyScore = this.clampScore(sd?.efficiencyScore ?? null);
    const coverageScore = this.clampScore(sd?.coverageScore ?? null);

    // Persist
    const [audit] = await db
      .insert(aiAudits)
      .values({
        organizationId,
        repositoryId,
        prNumber,
        prTitle,
        commitSha,
        verdict,
        totalViolations,
        errorCount,
        warningCount,
        scopeCreepDetected,
        complianceScore,
        efficiencyScore,
        coverageScore,
        actualLoc,
        estimatedLoc,
        auditDurationMs: durationMs,
        completedAt: new Date(),
      })
      .returning();

    if (scopeCreepDetected) {
      await db.insert(scopeViolations).values({
        auditId: audit.id,
        filePath: sd?.scopeFile ?? 'N/A',
        violationType: 'loc_explosion',
        description: sd?.scopeDescription ??
          `SDK analysis detected scope creep. Actual LOC (${actualLoc}) vs estimated (${estimatedLoc}).`,
        actualLoc,
        expectedLoc: estimatedLoc,
      });
    }

    console.log(
      `SDK audit ${audit.id}: ${verdict}, ${totalViolations}v, scores c=${complianceScore} e=${efficiencyScore} cov=${coverageScore}, ${durationMs}ms`,
    );

    return {
      auditId: audit.id,
      verdict,
      complianceScore,
      efficiencyScore,
      coverageScore,
      latencyMs: durationMs,
      parseOk: sd !== null,
    };
  }

  // =========================================================================
  // DEEPSEEK MODE — direct DeepSeek chat API (additive engine)
  // =========================================================================

  private async processViaDeepSeek(
    job: Job<AuditRequest>,
    strategy: AuditStrategy,
  ): Promise<AuditOutcome> {
    const startTime = Date.now();
    const {
      organizationId,
      repositoryId,
      prNumber,
      prTitle,
      commitSha,
      diffContent,
      changedFiles = {},
      taskDescription,
    } = job.data;

    const apiKey = this.configService.get<string>('DEEPSEEK_API_KEY');
    if (!apiKey) {
      throw new Error('DEEPSEEK_API_KEY is required for the deepseek engine');
    }

    // Load org guidelines for the prompt
    const guidelines = await db
      .select()
      .from(codeGuidelines)
      .where(eq(codeGuidelines.organizationId, organizationId));
    const activeGuidelines = guidelines.filter((g) => g.isEnabled);

    const userPrompt = this.buildPromptForStrategy(
      {
        prTitle,
        diffContent,
        changedFiles,
        taskDescription,
        guidelines: activeGuidelines,
      },
      strategy.promptVariant,
    );

    const { content, promptTokens, completionTokens } = await callDeepSeekChat({
      apiKey,
      model: strategy.modelId,
      temperature: strategy.temperature,
      maxTokens: strategy.maxTokens,
      systemPrompt:
        'You are a code reviewer for an automated governance platform.',
      userPrompt,
    });

    const sd = this.parseAgentJson(content) as SandboxOutput | null;
    const parseOk = sd !== null;
    const durationMs = Date.now() - startTime;

    // Extract scores (same shape as sandbox/SDK output)
    const verdict: AuditVerdict = sd?.verdict ?? AuditVerdict.WARNING;
    const totalViolations = sd?.totalViolations ?? 0;
    const errorCount = sd?.errorCount ?? 0;
    const warningCount = sd?.warningCount ?? 0;
    const scopeCreepDetected = sd?.scopeCreepDetected ?? false;
    const actualLoc = sd?.actualLoc ?? 0;
    const estimatedLoc = sd?.estimatedLoc ?? 150;
    const complianceScore = this.clampScore(sd?.complianceScore ?? null);
    const efficiencyScore = this.clampScore(sd?.efficiencyScore ?? null);
    const coverageScore = this.clampScore(sd?.coverageScore ?? null);

    // Persist
    const [audit] = await db
      .insert(aiAudits)
      .values({
        organizationId,
        repositoryId,
        prNumber,
        prTitle,
        commitSha,
        verdict,
        totalViolations,
        errorCount,
        warningCount,
        scopeCreepDetected,
        complianceScore,
        efficiencyScore,
        coverageScore,
        actualLoc,
        estimatedLoc,
        auditDurationMs: durationMs,
        completedAt: new Date(),
      })
      .returning();

    if (scopeCreepDetected) {
      await db.insert(scopeViolations).values({
        auditId: audit.id,
        filePath: sd?.scopeFile ?? 'N/A',
        violationType: 'loc_explosion',
        description:
          sd?.scopeDescription ??
          `AI analysis detected scope creep. Actual LOC (${actualLoc}) vs estimated (${estimatedLoc}).`,
        actualLoc,
        expectedLoc: estimatedLoc,
      });
    }

    console.log(
      `DeepSeek audit ${audit.id}: ${verdict}, ${totalViolations}v, scores c=${complianceScore} e=${efficiencyScore} cov=${coverageScore}, ${durationMs}ms`,
    );

    return {
      auditId: audit.id,
      verdict,
      complianceScore,
      efficiencyScore,
      coverageScore,
      latencyMs: durationMs,
      promptTokens,
      completionTokens,
      parseOk,
    };
  }

  // =========================================================================
  // Prompt builder
  // =========================================================================

  private buildAuditPrompt(params: AuditPromptParams): string {
    const {
      prTitle,
      diffContent,
      changedFiles,
      taskDescription,
      guidelines,
    } = params;

    const guidelinesText =
      guidelines.length > 0
        ? guidelines
            .map(
              (g) =>
                `- **${g.name}** [${g.severity}]: ${g.description || g.pattern}`,
            )
            .join('\n')
        : '(No guidelines configured for this organization)';

    const filesText = formatChangedFilesForPrompt(changedFiles);

    const taskSection = taskDescription
      ? `## Task Description (requirements to check coverage against)\n${taskDescription}\n`
      : '';

    return [
      'You are an AI code reviewer for an automated governance platform.',
      '',
      '## PR Title',
      prTitle,
      '',
      taskSection,
      '## Coding Standards (check these)',
      guidelinesText,
      '',
      '## Diff',
      '```diff',
      diffContent,
      '```',
      '',
      '## Changed Files (full content for context)',
      filesText,
      '',
      '## Instructions',
      'Analyze this PR against the coding standards and the full file context. Return your findings as valid JSON with exactly this shape:',
      '',
      '```json',
      '{',
      '  "verdict": "pass" | "warning" | "fail",',
      '  "totalViolations": <number>,',
      '  "errorCount": <number>,',
      '  "warningCount": <number>,',
      '  "scopeCreepDetected": <boolean>,',
      '  "actualLoc": <number>,',
      '  "estimatedLoc": <number>,',
      '  "scopeFile": "<string or null>",',
      '  "scopeDescription": "<string or null>",',
      '  "complianceScore": <number 0-100>,',
      '  "efficiencyScore": <number 0-100>,',
      '  "coverageScore": <number 0-100>,',
      '  "summary": "<one-paragraph summary of findings>"',
      '}',
      '```',
      '',
      '## Scoring Guide',
      '- complianceScore: % of coding standards the code followed. Count each guideline. If code violates it, mark failed. Score = (passed / total) * 100.',
      '- efficiencyScore: Is code appropriately sized? If actualLoc ≤ estimatedLoc → 100. Otherwise: (estimated / actual) * 100, minimum 0. This penalizes over-engineering.',
      '- coverageScore: Does code cover all requirements from the task description? 100 = every requirement addressed. Deduct for each missing/incomplete requirement. If no task description provided, use 100.',
      '',
      'Do not output anything except the JSON object. Do not wrap it in markdown fences.',
    ].join('\n');
  }

  /**
   * Build the audit prompt for a given prompt strategy variant.
   * `baseline`/`json` use the current production prompt; `cot` and `few-shot`
   * layer on top of it.
   */
  private buildPromptForStrategy(
    params: AuditPromptParams,
    variant: PromptVariant,
  ): string {
    const base = this.buildAuditPrompt(params);

    switch (variant) {
      case 'cot':
        return base.replace(
          '## Instructions',
          '## Instructions\nThink step-by-step about each coding standard and requirement before assigning any score.\n',
        );
      case 'few-shot':
        return (
          base +
          '\n\n## Worked Example\n' +
          '{"verdict":"pass","totalViolations":0,"errorCount":0,"warningCount":0,' +
          '"scopeCreepDetected":false,"actualLoc":40,"estimatedLoc":150,' +
          '"scopeFile":null,"scopeDescription":null,"complianceScore":100,' +
          '"efficiencyScore":100,"coverageScore":100,"summary":"Clean change, all standards followed."}\n'
        );
      case 'json':
      case 'baseline':
      default:
        return base;
    }
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  /** Clamp a score to 0–100, return null if invalid. */
  private clampScore(value: number | null | undefined): number | null {
    if (value === null || value === undefined || isNaN(value)) return null;
    return Math.max(0, Math.min(100, Math.round(value)));
  }

  /**
   * Extract a JSON object from agent output. The SDK may wrap JSON in
   * markdown fences or include explanatory text before/after.
   */
  private parseAgentJson(raw: string): unknown {
    // Try to find a JSON block in markdown fences first
    const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    const candidate = fenceMatch ? fenceMatch[1] : raw;

    // Find the outermost JSON object
    const jsonMatch = candidate.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      return null;
    }
  }
}

/** Shape of the JSON output expected from CodeWhale sandbox. */
interface SandboxOutput {
  verdict: AuditVerdict;
  totalViolations: number;
  errorCount: number;
  warningCount: number;
  scopeCreepDetected: boolean;
  actualLoc: number;
  estimatedLoc: number;
  scopeFile: string | null;
  scopeDescription: string | null;
  complianceScore: number;
  efficiencyScore: number;
  coverageScore: number;
  summary: string;
}

/** Parameters for building the audit analysis prompt. */
interface AuditPromptParams {
  prTitle: string;
  diffContent: string;
  changedFiles: Record<string, string>;
  taskDescription?: string;
  guidelines: Array<{
    name: string;
    description: string | null;
    pattern: string;
    severity: string;
  }>;
}
