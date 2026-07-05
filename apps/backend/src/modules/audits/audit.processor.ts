import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { db } from '../../database/client';
import { aiAudits, scopeViolations, codeGuidelines } from '../../database/schema';
import { eq } from 'drizzle-orm';
import { AuditRequest, AuditVerdict } from '@aigov/shared-types';
import { SandboxService } from './sandbox.service';
import { formatChangedFilesForPrompt } from './diff-parser';

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

@Processor('audits')
export class AuditProcessor extends WorkerHost {
  private readonly auditMode: 'inline' | 'sandbox' | 'sdk';

  constructor(
    private readonly sandboxService: SandboxService,
    private readonly configService: ConfigService,
  ) {
    super();
    const mode = this.configService.get<string>('AUDIT_MODE');
    if (mode === 'sandbox') this.auditMode = 'sandbox';
    else if (mode === 'sdk') this.auditMode = 'sdk';
    else this.auditMode = 'inline';
  }

  async process(job: Job<AuditRequest>): Promise<{ auditId: string }> {
    if (this.auditMode === 'sandbox') return this.processViaSandbox(job);
    if (this.auditMode === 'sdk') return this.processViaSDK(job);
    return this.processInline(job);
  }

  // =========================================================================
  // SANDBOX MODE — K8s Job via CodeWhale
  // =========================================================================

  private async processViaSandbox(
    job: Job<AuditRequest>,
  ): Promise<{ auditId: string }> {
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

    const verdict: AuditVerdict = sv?.verdict ?? 'warning';
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

    return { auditId: audit.id };
  }

  // =========================================================================
  // INLINE MODE — Regex pattern matching
  // =========================================================================

  private async processInline(
    job: Job<AuditRequest>,
  ): Promise<{ auditId: string }> {
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
      verdict = 'fail';
    } else if (warningCount > 0) {
      verdict = 'warning';
    } else {
      verdict = 'pass';
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

    return { auditId: audit.id };
  }

  // =========================================================================
  // SDK MODE — Claude Agent SDK harness in-process
  // =========================================================================

  private async processViaSDK(
    job: Job<AuditRequest>,
  ): Promise<{ auditId: string }> {
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
    const verdict: AuditVerdict = sd?.verdict ?? 'warning';
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

    return { auditId: audit.id };
  }

  // =========================================================================
  // Prompt builder
  // =========================================================================

  private buildAuditPrompt(params: {
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
  }): string {
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
