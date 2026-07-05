import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * GitHubService — Lightweight GitHub API client for fetching file contents.
 *
 * Uses GitHub's Contents API to retrieve the full content of individual files
 * at a specific commit SHA. Files are returned as UTF-8 strings.
 *
 * Requires `GITHUB_TOKEN` environment variable (classic PAT or fine-grained token
 * with `contents: read` scope on the target repositories).
 */

interface GitHubContentsResponse {
  name: string;
  path: string;
  sha: string;
  content: string; // Base64-encoded
  encoding: string;
}

@Injectable()
export class GitHubService {
  private readonly logger = new Logger(GitHubService.name);
  private readonly baseUrl = 'https://api.github.com';
  private readonly token: string | undefined;

  constructor(private readonly configService: ConfigService) {
    this.token = this.configService.get<string>('GITHUB_TOKEN');
    if (!this.token) {
      this.logger.warn(
        'GITHUB_TOKEN not set — file content fetching will fail. ' +
        'Set it to a GitHub PAT with `contents: read` scope.',
      );
    }
  }

  /**
   * Fetch the full content of one or more files from a repository at a given ref.
   *
   * @param fullName — Repository full name, e.g. "org/repo"
   * @param ref — Git ref (branch, tag, or commit SHA)
   * @param paths — List of file paths relative to repo root
   * @returns Map of path → file content (UTF-8)
   */
  async fetchFiles(
    fullName: string,
    ref: string,
    paths: string[],
  ): Promise<Record<string, string>> {
    if (!this.token) {
      this.logger.error('Cannot fetch files: GITHUB_TOKEN not configured');
      return {};
    }

    const results: Record<string, string> = {};

    // Fetch files concurrently (up to 10 at a time to avoid rate limits)
    const batchSize = 10;
    for (let i = 0; i < paths.length; i += batchSize) {
      const batch = paths.slice(i, i + batchSize);
      const batchResults = await Promise.allSettled(
        batch.map((path) => this.fetchSingleFile(fullName, ref, path)),
      );

      for (let j = 0; j < batch.length; j++) {
        const result = batchResults[j];
        if (result.status === 'fulfilled' && result.value !== null) {
          results[batch[j]] = result.value;
        } else if (result.status === 'rejected') {
          this.logger.warn(
            `Failed to fetch ${batch[j]} from ${fullName}@${ref}: ${(result.reason as Error)?.message}`,
          );
        }
      }
    }

    return results;
  }

  /**
   * Fetch a single file's content from GitHub Contents API.
   */
  private async fetchSingleFile(
    fullName: string,
    ref: string,
    path: string,
  ): Promise<string | null> {
    const url = `${this.baseUrl}/repos/${fullName}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'aigov-codereviewer/0.1',
      },
    });

    if (!response.ok) {
      // 404: file doesn't exist at this ref (e.g., it was added in this PR)
      if (response.status === 404) {
        this.logger.debug(`File not found at ref ${ref}: ${path}`);
        return null;
      }
      // 403: rate limited
      if (response.status === 403) {
        const resetTime = response.headers.get('x-ratelimit-reset');
        this.logger.warn(
          `GitHub API rate limit hit. Resets at ${resetTime ? new Date(Number(resetTime) * 1000).toISOString() : 'unknown'}`,
        );
      }
      throw new Error(
        `GitHub API error ${response.status} for ${fullName}/${path}: ${response.statusText}`,
      );
    }

    const body = (await response.json()) as GitHubContentsResponse;

    // Decode base64 content
    if (body.encoding === 'base64' && body.content) {
      return Buffer.from(body.content, 'base64').toString('utf-8');
    }

    return null;
  }

  /**
   * List changed files in a pull request.
   *
   * Calls GET /repos/:owner/:repo/pulls/:number/files and returns
   * filename, status (added/modified/removed), and the patch diff.
   */
  async listPRFiles(
    fullName: string,
    prNumber: number,
  ): Promise<Array<{ filename: string; status: string; patch?: string }>> {
    if (!this.token) {
      this.logger.error('Cannot list PR files: GITHUB_TOKEN not configured');
      return [];
    }

    const url = `${this.baseUrl}/repos/${fullName}/pulls/${prNumber}/files`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'aigov-codereviewer/0.1',
      },
    });

    if (!response.ok) {
      this.logger.error(
        `GitHub API error ${response.status} listing files for ${fullName}#${prNumber}`,
      );
      return [];
    }

    const files = (await response.json()) as Array<{
      filename: string;
      status: string;
      patch?: string;
    }>;

    this.logger.log(
      `PR #${prNumber}: ${files.length} files (${files.filter((f) => f.status !== 'removed').length} changed)`,
    );

    return files;
  }

  /**
   * Extract the owner and repo name from a full repository name.
   * "org/repo" → { owner: "org", repo: "repo" }
   */
  static parseFullName(fullName: string): { owner: string; repo: string } {
    const [owner, ...rest] = fullName.split('/');
    return { owner, repo: rest.join('/') };
  }
}
