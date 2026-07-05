/**
 * diff-parser.ts — Extract changed file paths from unified diff output.
 *
 * Parses `git diff` / `diff --git` headers to build the list of paths
 * that were added or modified in a PR. Renames and deletes are excluded.
 */

/**
 * Extract the list of changed file paths from a unified diff string.
 *
 * Matches lines of the form:
 *   +++ b/path/to/file.ts
 *   --- a/path/to/file.ts
 *
 * Returns only the `b/` (new) paths. Filters out `/dev/null` (deletions).
 * Paths are returned relative (stripped of the `b/` prefix).
 */
export function extractChangedFilePaths(diffContent: string): string[] {
  const paths = new Set<string>();

  // Matches: +++ b/path/to/file.ext
  const re = /^\+\+\+ b\/(.+)$/gm;
  let match: RegExpExecArray | null;

  while ((match = re.exec(diffContent)) !== null) {
    const path = match[1].trim();
    // /dev/null means the file was deleted — skip those
    if (path !== '/dev/null') {
      paths.add(path);
    }
  }

  // Fallback: also parse --- a/ lines for renamed/copied diffs
  const reOld = /^--- a\/(.+)$/gm;
  while ((match = reOld.exec(diffContent)) !== null) {
    const path = match[1].trim();
    if (path !== '/dev/null') {
      paths.add(path);
    }
  }

  return Array.from(paths);
}

/**
 * Build a prompt-friendly file listing from a changed-files map.
 */
export function formatChangedFilesForPrompt(
  changedFiles: Record<string, string>,
): string {
  if (Object.keys(changedFiles).length === 0) {
    return '(No file contents provided)';
  }

  return Object.entries(changedFiles)
    .map(([path, content]) => `### File: ${path}\n\`\`\`\n${content}\n\`\`\``)
    .join('\n\n');
}
