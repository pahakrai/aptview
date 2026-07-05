import { Injectable, Logger } from '@nestjs/common';
import { GitHubPREvent, JiraIssueEvent, LinearIssueEvent } from '@aigov/shared-types';
import { GitHubService } from './github.service';
import { AuditsService } from '../audits/audits.service';

/**
 * WebhooksService — Routes incoming webhook events to the appropriate handlers.
 *
 * GitHub PR events:
 *   1. Validates event type and action
 *   2. Lists changed files via GitHubService.listPRFiles()
 *   3. Fetches full file contents via GitHubService.fetchFiles()
 *   4. Enqueues an audit job with diff + changed files
 *   5. Returns 202 Accepted immediately — audit runs async
 */

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly githubService: GitHubService,
    private readonly auditsService: AuditsService,
  ) {}

  /**
   * Process incoming GitHub webhook events.
   */
  async processGitHubWebhook(
    event: string,
    payload: Record<string, unknown>,
    signature: string,
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

    const fullName = pr.repository.full_name;
    const prNumber = pr.pull_request.number;
    const commitSha = pr.pull_request.head.sha;
    const prTitle = pr.pull_request.title;

    this.logger.log(
      `PR #${prNumber} (${pr.action}) in ${fullName}, commit ${commitSha.slice(0, 7)}`,
    );

    // TODO: Validate HMAC signature against stored webhook secret
    // TODO: Look up organizationId + repositoryId by full_name from the database

    // -----------------------------------------------------------------------
    // 1. List changed files in the PR
    // -----------------------------------------------------------------------
    const prFiles = await this.githubService.listPRFiles(fullName, prNumber);

    if (prFiles.length === 0) {
      return {
        status: 'skipped',
        reason: 'No files changed in PR (or GitHub API unavailable)',
      };
    }

    // -----------------------------------------------------------------------
    // 2. Build diff from per-file patches
    // -----------------------------------------------------------------------
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

    // -----------------------------------------------------------------------
    // 3. Fetch full file contents for non-removed files
    // -----------------------------------------------------------------------
    const changedPaths = prFiles
      .filter((f) => f.status !== 'removed')
      .map((f) => f.filename);

    let changedFiles: Record<string, string> = {};
    if (changedPaths.length > 0) {
      changedFiles = await this.githubService.fetchFiles(
        fullName,
        commitSha,
        changedPaths,
      );
      this.logger.log(
        `Fetched ${Object.keys(changedFiles).length}/${changedPaths.length} files`,
      );
    }

    // -----------------------------------------------------------------------
    // 4. Enqueue audit
    // -----------------------------------------------------------------------
    const result = await this.auditsService.enqueueAudit({
      // TODO: Map from DB lookup
      organizationId: '00000000-0000-0000-0000-000000000000',
      repositoryId: '00000000-0000-0000-0000-000000000000',
      prNumber,
      prTitle,
      commitSha,
      diffContent,
      changedFiles,
    });

    this.logger.log(
      `Audit enqueued for PR #${prNumber}: job ${result.jobId}`,
    );

    return {
      status: 'accepted',
      prNumber,
      repository: fullName,
      commitSha,
      jobId: result.jobId,
      changedFiles: Object.keys(changedFiles),
      changedFileCount: prFiles.length,
    };
  }

  /**
   * Process incoming Jira webhook events.
   */
  async processJiraWebhook(payload: Record<string, unknown>) {
    this.logger.log('Received Jira webhook');

    const issue = payload as unknown as JiraIssueEvent;

    // TODO: Look up organizationId, enqueue decomposition

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

    // TODO: Look up organizationId, enqueue decomposition

    return {
      status: 'accepted',
      issueId: issue?.data?.id,
      message: 'Linear webhook received.',
    };
  }
}
