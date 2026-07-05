// ============================================================================
// @aigov/utils — Shared utility functions
// ============================================================================

/**
 * Compute pagination metadata from total count, page, and page size.
 */
export function paginate(total: number, page: number, pageSize: number) {
  return {
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

/**
 * Extract a human-readable error message from an unknown error.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Compute scope creep ratio: actual LOC / estimated LOC.
 * Returns null if estimated LOC is zero or undefined.
 */
export function computeScopeCreepRatio(
  actualLoc: number,
  estimatedLoc: number,
): number | null {
  if (!estimatedLoc || estimatedLoc <= 0) return null;
  return actualLoc / estimatedLoc;
}

/**
 * Truncate a string to maxLength, appending "..." if truncated.
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}

/**
 * Generate a random alphanumeric string of given length.
 */
export function randomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Sleep for a given number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
