import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { db } from '../../database/client';
import { codeGuidelines, aiAudits } from '../../database/schema';
import { eq, sql, desc } from 'drizzle-orm';

interface ParsedStandard {
  name: string;
  pattern: string;
  description: string;
  severity: 'error' | 'warning' | 'info';
}

@Injectable()
export class StandardsService {
  async create(input: {
    organizationId: string;
    name: string;
    pattern: string;
    description?: string;
    severity?: string;
    category?: string;
  }) {
    const [guideline] = await db
      .insert(codeGuidelines)
      .values({
        organizationId: input.organizationId,
        name: input.name,
        description: input.description ?? null,
        pattern: input.pattern,
        severity: (input.severity as 'error' | 'warning' | 'info') || 'warning',
        category: input.category || 'general',
      })
      .returning();

    return guideline;
  }

  async getById(id: string) {
    const [guideline] = await db
      .select()
      .from(codeGuidelines)
      .where(eq(codeGuidelines.id, id))
      .limit(1);

    if (!guideline) throw new NotFoundException(`Guideline ${id} not found`);
    return guideline;
  }

  async listByOrg(organizationId: string) {
    return db
      .select()
      .from(codeGuidelines)
      .where(eq(codeGuidelines.organizationId, organizationId));
  }

  async update(id: string, data: Record<string, unknown>) {
    await this.getById(id);

    const [updated] = await db
      .update(codeGuidelines)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(codeGuidelines.id, id))
      .returning();

    return updated;
  }

  async remove(id: string) {
    await this.getById(id);
    await db.delete(codeGuidelines).where(eq(codeGuidelines.id, id));
    return { deleted: true };
  }

  /**
   * Parse an uploaded file (PDF, TXT, MD) and extract coding standards.
   *
   * Supported formats in the file:
   *   - "Rule: name | pattern | severity"
   *   - "**name**: pattern (severity)"
   *   - Markdown tables with Name, Pattern, Severity columns
   *
   * Lines that don't match a rule pattern are treated as descriptions
   * for the previous rule.
   */
  async parseUploadedStandards(
    file: Express.Multer.File,
    organizationId: string,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    if (!organizationId) throw new BadRequestException('organizationId is required');

    // Extract text from buffer
    const text = this.extractTextFromFile(file);
    if (!text || text.trim().length === 0) {
      throw new BadRequestException('Could not extract text from file');
    }

    // Parse standards from text
    const parsed = this.parseStandardsText(text);

    if (parsed.length === 0) {
      throw new BadRequestException(
        'No coding standards found in file. ' +
        'Use format: "Rule: name | pattern | severity" or markdown tables.',
      );
    }

    // Create guidelines in database
    const created: Array<{ id: string; name: string }> = [];
    for (const p of parsed) {
      try {
        const [guideline] = await db
          .insert(codeGuidelines)
          .values({
            organizationId,
            name: p.name,
            description: p.description,
            pattern: p.pattern,
            severity: p.severity,
            category: 'uploaded',
          })
          .returning({ id: codeGuidelines.id, name: codeGuidelines.name });
        created.push(guideline);
      } catch (err) {
        console.error(`Failed to create guideline "${p.name}":`, err);
      }
    }

    return {
      created: created.length,
      skipped: parsed.length - created.length,
      guidelines: created,
      message: `Parsed ${parsed.length} standards from file, created ${created.length}.`,
    };
  }

  /**
   * Extract text from an uploaded file buffer.
   * Supports TXT, MD (plain text) and basic PDF extraction.
   */
  private extractTextFromFile(file: Express.Multer.File): string {
    const mimetype = file.mimetype;

    // Plain text files
    if (mimetype === 'text/plain' || mimetype === 'text/markdown' ||
        file.originalname.endsWith('.md') || file.originalname.endsWith('.txt')) {
      return file.buffer.toString('utf-8');
    }

    // PDF files — basic text extraction
    if (mimetype === 'application/pdf' || file.originalname.endsWith('.pdf')) {
      return this.extractPdfText(file.buffer);
    }

    // Try UTF-8 anyway
    return file.buffer.toString('utf-8');
  }

  /**
   * Basic PDF text extraction by searching for readable text streams.
   * For production, use pdf-parse or a dedicated PDF library.
   */
  private extractPdfText(buffer: Buffer): string {
    const content = buffer.toString('utf-8');
    // Extract text between stream/endstream markers
    const streams: string[] = [];
    const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    let match;
    while ((match = streamRegex.exec(content)) !== null) {
      const streamData = match[1];
      // Filter printable ASCII
      const text = streamData.replace(/[^\x20-\x7E\n\r]/g, '');
      if (text.trim().length > 10) {
        streams.push(text);
      }
    }
    return streams.join('\n');
  }

  /**
   * Parse standards from text content.
   *
   * Looks for patterns like:
   *   "Rule: No console.log | console\.log | error | Never use console.log in production"
   *   "**No any types**: \bany\b (warning)"
   *   Markdown tables with columns: Name, Pattern, Severity, Description
   */
  private parseStandardsText(text: string): ParsedStandard[] {
    const results: ParsedStandard[] = [];
    const lines = text.split('\n');

    // Pattern 1: "Rule: name | pattern | severity | description"
    const ruleRe = /^(?:Rule|Standard|Guideline)\s*:\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(\w+)(?:\s*\|\s*(.*))?$/i;

    // Pattern 2: "**name**: pattern (severity)"
    const mdRe = /^\*\*(.+?)\*\*\s*:\s*(.+?)\s*\((\w+)\)\s*$/;

    // Pattern 3: Markdown table rows: | name | pattern | severity |
    const tableRe = /^\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(\w+)\s*\|/;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let parsed: ParsedStandard | null = null;

      // Try rule format
      const ruleMatch = trimmed.match(ruleRe);
      if (ruleMatch) {
        parsed = {
          name: ruleMatch[1].trim(),
          pattern: ruleMatch[2].trim(),
          severity: this.normalizeSeverity(ruleMatch[3]),
          description: (ruleMatch[4] || ruleMatch[1]).trim(),
        };
      }

      // Try markdown bold format
      if (!parsed) {
        const mdMatch = trimmed.match(mdRe);
        if (mdMatch) {
          parsed = {
            name: mdMatch[1].trim(),
            pattern: mdMatch[2].trim(),
            severity: this.normalizeSeverity(mdMatch[3]),
            description: mdMatch[1].trim(),
          };
        }
      }

      // Try table row format
      if (!parsed) {
        const tableMatch = trimmed.match(tableRe);
        if (tableMatch && !trimmed.startsWith('| Name') && !trimmed.startsWith('| ---')) {
          parsed = {
            name: tableMatch[1].trim(),
            pattern: tableMatch[2].trim(),
            severity: this.normalizeSeverity(tableMatch[3]),
            description: tableMatch[1].trim(),
          };
        }
      }

      if (parsed) {
        results.push(parsed);
      }
    }

    return results;
  }

  private normalizeSeverity(input: string): 'error' | 'warning' | 'info' {
    const s = input.toLowerCase().trim();
    if (s.startsWith('err') || s === 'critical' || s === 'high') return 'error';
    if (s.startsWith('warn') || s === 'medium') return 'warning';
    return 'info';
  }

  /**
   * Generate a paste-able Markdown context string for AI coding tools.
   * Matches the specification's `/api/v1/standards/context/{org_id}` endpoint.
   */
  async getContextMarkdown(organizationId: string) {
    const guidelines = await this.listByOrg(organizationId);
    const topViolations = await this.getTopViolations(organizationId, 30);

    const guidelineList = guidelines
      .filter((g) => g.isEnabled)
      .map((g) => `- **${g.name}** [${g.severity}]: ${g.description || 'No description'}\n  Pattern: \`${g.pattern}\``)
      .join('\n');

    const violationList = topViolations
      .map((v) => `- ${v.guidelineName}: ${v.count} violations`)
      .join('\n');

    const contextMarkdown = `# Organizational Coding Standards (Auto-generated by AI Code Governance)

## Active Rules (${guidelines.filter((g) => g.isEnabled).length} total)
${guidelineList}

## Common AI Mistakes in This Codebase (Last 30 Days)
${violationList || 'No violations recorded yet.'}

## Task Scope Boundaries
Always check the decomposed task boundaries before coding.
Maximum 3 files, 150 lines per task. Do not touch explicitly forbidden files.
`;

    return {
      contextMarkdown,
      organizationId,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Get top violation patterns from audit history.
   */
  async getTopViolations(organizationId: string, days: number) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    // Aggregate violation counts from recent audits
    // (In production this would join with violation_detail table)
    const audits = await db
      .select({
        verdict: aiAudits.verdict,
        count: sql<number>`count(*)::int`,
      })
      .from(aiAudits)
      .where(eq(aiAudits.organizationId, organizationId))
      .groupBy(aiAudits.verdict)
      .orderBy(desc(sql`count(*)`));

    const total = audits.reduce((sum, a) => sum + a.count, 0);
    const failCount = audits.find((a) => a.verdict === 'fail')?.count ?? 0;
    const passRate = total > 0 ? ((total - failCount) / total * 100).toFixed(1) : '100.0';

    return {
      totalAudits: total,
      failCount,
      passRate: `${passRate}%`,
      breakdown: audits,
      period: `last ${days} days`,
    };
  }
}
