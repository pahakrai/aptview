import { useState, useEffect } from 'react';
import { CheckCircle, XCircle, AlertTriangle, Clock, ShieldCheck, Gauge, Target } from 'lucide-react';
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
      <div className="max-w-7xl mx-auto px-4 py-20 text-center">
        <div className="inline-block w-6 h-6 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
        <p className="mt-4 text-sm text-slate-500">Loading audit history...</p>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Audit History</h1>
          <p className="text-sm text-slate-500 mt-1">
            {audits.length} audit{audits.length !== 1 ? 's' : ''}
          </p>
        </div>
      </div>

      {audits.length === 0 ? (
        <div className="card p-12 text-center">
          <ShieldCheck className="w-10 h-10 text-slate-700 mx-auto mb-3" />
          <p className="text-slate-400 font-medium">No audits yet</p>
          <p className="text-sm text-slate-600 mt-1">
            Connect a repository and open a PR to get started.
          </p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full">
              <thead>
                <tr className="border-b border-slate-800">
                  <th className="px-5 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    PR
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Verdict
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider hidden md:table-cell">
                    Compliance
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider hidden md:table-cell">
                    Efficiency
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider hidden lg:table-cell">
                    Coverage
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider hidden sm:table-cell">
                    Scope
                  </th>
                  <th className="px-5 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Time
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {audits.map((audit) => (
                  <tr
                    key={audit.id}
                    className="hover:bg-surface-800/30 transition-colors duration-150"
                  >
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm text-slate-400">
                          #{audit.prNumber}
                        </span>
                        <span className="text-sm text-slate-300 truncate max-w-[200px]">
                          {audit.prTitle}
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-3.5">
                      <VerdictBadge verdict={audit.verdict} />
                    </td>
                    <td className="px-5 py-3.5 hidden md:table-cell">
                      <ScoreCell value={audit.complianceScore} color="emerald" />
                    </td>
                    <td className="px-5 py-3.5 hidden md:table-cell">
                      <ScoreCell value={audit.efficiencyScore} color="blue" />
                    </td>
                    <td className="px-5 py-3.5 hidden lg:table-cell">
                      <ScoreCell value={audit.coverageScore} color="violet" />
                    </td>
                    <td className="px-5 py-3.5 hidden sm:table-cell">
                      {audit.scopeCreepDetected ? (
                        <span className="badge-warning">
                          <AlertTriangle className="w-3 h-3" />
                          Creep
                        </span>
                      ) : (
                        <span className="text-xs text-slate-600">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <span className="text-xs text-slate-500 font-mono">
                        {audit.auditDurationMs != null
                          ? `${(audit.auditDurationMs / 1000).toFixed(1)}s`
                          : '—'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function VerdictBadge({ verdict }: { verdict: string }) {
  switch (verdict) {
    case 'pass':
      return (
        <span className="badge-success">
          <CheckCircle className="w-3 h-3" /> Pass
        </span>
      );
    case 'fail':
      return (
        <span className="badge-danger">
          <XCircle className="w-3 h-3" /> Fail
        </span>
      );
    case 'warning':
      return (
        <span className="badge-warning">
          <AlertTriangle className="w-3 h-3" /> Warning
        </span>
      );
    default:
      return <span className="badge-neutral">{verdict}</span>;
  }
}

function ScoreCell({
  value,
  color,
}: {
  value: number | null;
  color: 'emerald' | 'blue' | 'violet';
}) {
  const colorMap = {
    emerald: { text: 'text-emerald-400', bar: 'bg-emerald-500' },
    blue: { text: 'text-blue-400', bar: 'bg-blue-500' },
    violet: { text: 'text-violet-400', bar: 'bg-violet-500' },
  };
  const c = colorMap[color];
  const hasData = value !== null && value !== undefined;
  const score = hasData ? value! : 0;

  return (
    <div className="flex items-center gap-2 min-w-[80px]">
      {hasData ? (
        <>
          <div className="score-bar w-12">
            <div
              className={`score-bar-fill ${c.bar}`}
              style={{ width: `${score}%` }}
            />
          </div>
          <span className={`text-xs font-mono font-medium ${c.text}`}>
            {score}%
          </span>
        </>
      ) : (
        <span className="text-xs text-slate-600">—</span>
      )}
    </div>
  );
}
