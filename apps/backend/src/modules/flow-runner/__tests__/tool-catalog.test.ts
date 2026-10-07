import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSkillSchema, executeSkill, listGuardSkills, REVIEW_SKILLS } from '../tool-catalog.ts';

test('buildSkillSchema: empty enabled list returns all skills', () => {
  assert.equal(buildSkillSchema([]).length, REVIEW_SKILLS.length);
});

test('buildSkillSchema: filters to the enabled set', () => {
  assert.equal(buildSkillSchema(['search_guidelines']).length, 1);
});

test('executeSkill: search_guidelines filters by keyword', () => {
  const ctx = {
    guidelines: [
      { name: 'No Logging', severity: 'error', pattern: 'console.log' },
      { name: 'Use Fetch', severity: 'warning', pattern: 'axios' },
    ],
  };
  const out = executeSkill('search_guidelines', { query: 'logging' }, ctx);
  assert.ok(out !== null && out.includes('No Logging'));
  assert.ok(out !== null && !out.includes('Use Fetch'));
});

test('executeSkill: assess_diff_size counts added lines', () => {
  const out = executeSkill('assess_diff_size', {}, { diffContent: '+a\n+b\n-c\n' });
  assert.ok(out !== null && out.includes('Added lines: 2'));
});

test('executeSkill: unknown tool returns null', () => {
  assert.equal(executeSkill('nope', {}, {}), null);
});

test('listGuardSkills: returns tenant_scope_guard when all skills enabled', () => {
  const guards = listGuardSkills([]);
  assert.ok(guards.some((g) => g.name === 'tenant_scope_guard'));
});

test('listGuardSkills: excludes non-guard skills', () => {
  assert.equal(listGuardSkills(['search_guidelines']).length, 0);
});

test('tenant_scope_guard: blocks without tenant, rewrites args with tenant', () => {
  const guard = REVIEW_SKILLS.find((s) => s.name === 'tenant_scope_guard');
  assert.ok(guard && guard.guard);
  const blocked = guard!.guard!({ sql: 'select * from orders' }, {});
  assert.equal(blocked.action, 'block');
  const rewritten = guard!.guard!({ sql: 'select * from orders' }, { tenantId: 'org_123' });
  assert.equal(rewritten.action, 'rewrite');
  const args = rewritten.args as Record<string, unknown>;
  assert.equal(args.tenant_id, 'org_123');
  assert.ok(String(args.sql).includes('tenant_id'));
});