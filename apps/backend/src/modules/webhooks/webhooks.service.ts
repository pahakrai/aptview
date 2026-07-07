import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

/**
 * Score a file path by priority for context inclusion.
 * Lower score = higher priority. Config files and types are prioritized first.
 */
function priorityScore(filepath: string): number {
  const lower = filepath.toLowerCase();
  if (lower.includes('config') || lower.includes('.env')) return 0;
  if (lower.includes('.d.ts') || lower.includes('types/') || lower.includes('interface')) return 1;
  if (lower.endsWith('.ts') && !lower.endsWith('.test.ts') && !lower.endsWith('.spec.ts')) return 2;
  if (lower.endsWith('.json')) return 3;
  if (lower.endsWith('.test.ts') || lower.endsWith('.spec.ts')) return 4;
  if (lower.includes('node_modules')) return 100;
  return 5;
}
import { GitHubPREvent, JiraIssueEvent, LinearIssueEvent } from '@aigov/shared-types';
import { GitHubService } from './github.service';
import { AuditsService } from '../audits/audits.service';
import { ReviewsService } from '../reviews/reviews.service';

/**
 * WebhooksService — Routes incoming webhook events.
 *
 * GitHub PR events:
 *   1. Validates HMAC signature
 *   2. Extracts PR metadata + branch info
 *   3. Enqueues TWO parallel pipelines:
 *      - Audit (scoring) via AuditsService
 *      - Review (HITL) via ReviewsService
 */

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);
  private readonly webhookSecret: string;

  constructor(
    private readonly githubService: GitHubService,
    private readonly auditsService: AuditsService,
    private readonly reviewsService: ReviewsService,
    private readonly configService: ConfigService,
  ) {
    this.webhookSecret = this.configService.get<string>('WEBHOOK_SECRET') || '';
    if (!this.webhookSecret) {
      this.logger.warn('WEBHOOK_SECRET not set — HMAC validation will be skipped');
    }
  }

  /**
   * Validate GitHub HMAC signature against the stored webhook secret.
   * Uses constant-time comparison to prevent timing attacks.
   */
  private validateSignature(rawBody: string, signature: string): boolean {
    if (!this.webhookSecret) return true; // Skip if not configured

    const hmac = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(rawBody, 'utf-8')
      .digest('hex');

    const expected = `sha256=${hmac}`;

    try {
      return crypto.timingSafeEqual(
        Buffer.from(expected),
        Buffer.from(signature),
      );
    } catch {
      return false;
    }
  }

  /**
   * Process incoming GitHub webhook events.
   */
  async processGitHubWebhook(
    event: string,
    payload: Record<string, unknown>,
    signature: string,
    rawBody?: string,
  ) {
    this.logger.log(`Received GitHub webhook: ${event}`);

    if (!['pull_request'].includes(event)) {
      return { status: 'ignored', event };
    }

    const pr = payload as unknown as GitHubPREvent;

    if (!['opened', 'synchronize', 'reopened'].includes(pr.action)) {
      return {
        status: 'skipped',
        reason: `Action "${pr.action}" not audited`,
      };
    }

    // -----------------------------------------------------------------------
    // 1. Validate HMAC signature
    // -----------------------------------------------------------------------
    if (rawBody && !this.validateSignature(rawBody, signature)) {
      this.logger.warn('HMAC signature validation failed');
      return {
        status: 'unauthorized',
        reason: 'Invalid webhook signature',
      };
    }

    // -----------------------------------------------------------------------
    // 2. Extract metadata
    // -----------------------------------------------------------------------
    const fullName = pr.repository.full_name;
    const prNumber = pr.pull_request.number;
    const commitSha = pr.pull_request.head.sha;
    const prTitle = pr.pull_request.title;
    const sourceBranch = pr.pull_request.head.ref;
    const targetBranch = pr.pull_request.base.ref;
    const author = (pr.pull_request as Record<string, unknown>).user
      ? ((pr.pull_request as Record<string, unknown>).user as Record<string, string>).login
      : 'unknown';

    const { owner, repo } = GitHubService.parseFullName(fullName);

    this.logger.log(
      `PR #${prNumber}: ${sourceBranch} → ${targetBranch} by @${author}, commit ${commitSha.slice(0, 7)}`,
    );

    // -----------------------------------------------------------------------
    // 3. List changed files and build diff
    // -----------------------------------------------------------------------
    const prFiles = await this.githubService.listPRFiles(fullName, prNumber);
    const diffParts: string[] = [];
    for (const f of prFiles) {
      if (f.patch) {
        diffParts.push(`diff --git a/${f.filename} b/${f.filename}`);
        diffParts.push(`--- a/${f.filename}`);
        diffParts.push(`+++ b/${f.filename}`);
        diffParts.push(f.patch);
      }
    }
    const diffContent = diffParts.join('\n');

    // Fetch full file contents first — needed by both audit and review
    const changedPaths = prFiles
      .filter((f) => f.status !== 'removed')
      .map((f) => f.filename);

    let changedFiles: Record<string, string> = {};
    if (changedPaths.length > 0) {
      changedFiles = await this.githubService.fetchFiles(fullName, commitSha, changedPaths);
    }

    // Build repo context — file listing + smart file contents for the review pipeline.
    // For large PRs (20-50 files), only include full contents of priority files
    // (config, types, entry points, files with significant changes). Everything else
    // gets listed by name only. Total content is capped at ~30KB.
    const repoContextParts = [
      `Repository: ${fullName}`,
      `Source: ${sourceBranch} → Target: ${targetBranch}`,
      `Changed files (${prFiles.length}):`,
      ...prFiles.map((f) => `  ${f.status === 'added' ? 'A' : f.status === 'removed' ? 'D' : 'M'}  ${f.filename}`),
    ];

    if (Object.keys(changedFiles).length > 0) {
      repoContextParts.push('', '--- Key file contents ---');
      let totalContentSize = 0;
      const MAX_CONTENT_SIZE = 30_000; // ~30KB total

      // Priority: config files > type files > files with many changes > rest
      const entries = Object.entries(changedFiles)
        .sort(([a], [b]) => priorityScore(a) - priorityScore(b));

      for (const [path, content] of entries) {
        if (totalContentSize >= MAX_CONTENT_SIZE) break;

        const perFileLimit = Math.min(3000, MAX_CONTENT_SIZE - totalContentSize);
        const truncated = content.length > perFileLimit
          ? content.slice(0, perFileLimit) + '\n... (truncated)'
          : content;

        repoContextParts.push(`\n### ${path} (${content.length}B)\n\`\`\`\n${truncated}\n\`\`\``);
        totalContentSize += truncated.length + 50; // ~50B overhead per file
      }

      if (Object.keys(changedFiles).length > 10 && entries.length > 5) {
        repoContextParts.push(`\n_Showing ${Math.min(entries.length, Math.floor(MAX_CONTENT_SIZE / 3000))} of ${Object.keys(changedFiles).length} files. Priority files shown first._`);
      }
    }
    const repoContext = repoContextParts.join('\n');

    // -----------------------------------------------------------------------
    // 4. Enqueue scoring audit (fire-and-forget)
    // -----------------------------------------------------------------------
    const auditResult = await this.auditsService.enqueueAudit({
      organizationId: '00000000-0000-0000-0000-000000000000',
      repositoryId: '00000000-0000-0000-0000-000000000000',
      prNumber,
      prTitle,
      commitSha,
      diffContent,
      changedFiles,
    });

    // -----------------------------------------------------------------------
    // 5. Enqueue HITL review (human-in-the-loop with task + standards)
    // -----------------------------------------------------------------------

    // Extract PR body as task description
    const taskDescription = (pr.pull_request as Record<string, unknown>).body as string || '';

    // Load active guidelines as a formatted string for the LLM prompt
    const { db } = await import('../../database/client');
    const { codeGuidelines } = await import('../../database/schema');
    const { eq } = await import('drizzle-orm');
    const guidelines = await db
      .select()
      .from(codeGuidelines)
      .where(eq(codeGuidelines.organizationId, '00000000-0000-0000-0000-000000000000'));
    const activeGuidelines = guidelines.filter((g) => g.isEnabled);
    const guidelinesText = activeGuidelines.length > 0
      ? activeGuidelines.map((g) =>
          `- **${g.name}** [${g.severity}]: ${g.description || g.pattern}`
        ).join('\n')
      : '';

    const reviewResult = await this.reviewsService.startReview({
      prNumber,
      prTitle,
      commitSha,
      owner,
      repo,
      sourceBranch,
      targetBranch,
      author,
      diffContent,
      taskDescription,
      guidelines: guidelinesText,
      repoContext,
    });

    this.logger.log(
      `PR #${prNumber}: audit ${auditResult.jobId}, review ${reviewResult.threadId}`,
    );

    return {
      status: 'accepted',
      prNumber,
      repository: fullName,
      sourceBranch,
      targetBranch,
      author,
      commitSha,
      auditJobId: auditResult.jobId,
      reviewThreadId: reviewResult.threadId,
    };
  }

  /**
   * Process incoming Jira webhook events.
   */
  async processJiraWebhook(payload: Record<string, unknown>) {
    this.logger.log('Received Jira webhook');
    const issue = payload as unknown as JiraIssueEvent;
    return {
      status: 'accepted',
      issueKey: issue?.issue?.key,
      message: 'Jira webhook received.',
    };
  }

  /**
   * Process incoming Linear webhook events.
   */
  async processLinearWebhook(payload: Record<string, unknown>) {
    this.logger.log('Received Linear webhook');
    const issue = payload as unknown as LinearIssueEvent;
    return {
      status: 'accepted',
      issueId: issue?.data?.id,
      message: 'Linear webhook received.',
    };
  }
}
