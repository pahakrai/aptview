import { useState, useEffect } from 'react';
import { CheckCircle, XCircle, AlertTriangle, ArrowUpRight } from 'lucide-react';
import type { AiAudit, PaginatedResponse } from '@aigov/shared-types';
import api from '../lib/api';

export default function AuditHistory() {
  const [audits, setAudits] = useState<AiAudit[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const demoRepoId = import.meta.env.VITE_DEMO_REPO_ID || 'demo-repo-id';
    api
      .get<PaginatedResponse<AiAudit>>(`/audits/repo/${demoRepoId}`)
      .then((res) => setAudits(res.data.data))
      .catch(() => setAudits([]))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-12 text-center text-gray-500">
        Loading audit history...
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-8">Audit History</h1>

      {audits.length === 0 ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center text-gray-500">
          No audits yet. Connect a repository and open a PR to get started.
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  PR
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Verdict
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Violations
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Scope Creep
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Duration
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {audits.map((audit) => (
                <tr key={audit.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4">
                    <span className="font-medium text-gray-900">
                      #{audit.prNumber}
                    </span>
                    <span className="ml-2 text-sm text-gray-500">
                      {audit.prTitle}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <VerdictBadge verdict={audit.verdict} />
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500">
                    {audit.totalViolations} ({audit.errorCount} errors, {audit.warningCount} warnings)
                  </td>
                  <td className="px-6 py-4">
                    {audit.scopeCreepDetected ? (
                      <span className="inline-flex items-center text-sm text-orange-600">
                        <AlertTriangle className="w-4 h-4 mr-1" />
                        Detected
                      </span>
                    ) : (
                      <span className="text-sm text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500">
                    {audit.auditDurationMs != null
                      ? `${(audit.auditDurationMs / 1000).toFixed(1)}s`
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function VerdictBadge({ verdict }: { verdict: string }) {
  switch (verdict) {
    case 'pass':
      return (
        <span className="inline-flex items-center gap-1 text-sm font-medium text-green-700">
          <CheckCircle className="w-4 h-4" /> Pass
        </span>
      );
    case 'fail':
      return (
        <span className="inline-flex items-center gap-1 text-sm font-medium text-red-700">
          <XCircle className="w-4 h-4" /> Fail
        </span>
      );
    case 'warning':
      return (
        <span className="inline-flex items-center gap-1 text-sm font-medium text-yellow-700">
          <AlertTriangle className="w-4 h-4" /> Warning
        </span>
      );
    default:
      return <span className="text-sm text-gray-500">{verdict}</span>;
  }
}
