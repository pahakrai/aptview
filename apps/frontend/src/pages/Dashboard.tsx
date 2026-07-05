import { useState, useEffect } from 'react';
import { BarChart3, CheckCircle, AlertTriangle, XCircle, TrendingUp } from 'lucide-react';
import type { ApiResponse } from '@aigov/shared-types';
import api from '../lib/api';

interface OrgStats {
  totalAudits: number;
  passed: number;
  failed: number;
  warnings: number;
  scopeCreepDetected: number;
  avgDurationMs: number;
}

export default function Dashboard() {
  const [stats, setStats] = useState<OrgStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const demoOrgId = import.meta.env.VITE_DEMO_ORG_ID || 'demo-org-id';
    api
      .get<ApiResponse<OrgStats>>(`/audits/org/${demoOrgId}/stats`)
      .then((res) => setStats(res.data.data))
      .catch(() => {
        // Use placeholder data if API isn't available
        setStats({
          totalAudits: 0,
          passed: 0,
          failed: 0,
          warnings: 0,
          scopeCreepDetected: 0,
          avgDurationMs: 0,
        });
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-12 text-center text-gray-500">
        Loading dashboard...
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-8">Dashboard</h1>

      {/* Stats grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        <StatCard
          icon={<BarChart3 className="w-6 h-6" />}
          label="Total Audits"
          value={stats?.totalAudits ?? 0}
          color="text-indigo-600"
          bgColor="bg-indigo-50"
        />
        <StatCard
          icon={<CheckCircle className="w-6 h-6" />}
          label="Passed"
          value={stats?.passed ?? 0}
          color="text-green-600"
          bgColor="bg-green-50"
        />
        <StatCard
          icon={<XCircle className="w-6 h-6" />}
          label="Failed"
          value={stats?.failed ?? 0}
          color="text-red-600"
          bgColor="bg-red-50"
        />
        <StatCard
          icon={<AlertTriangle className="w-6 h-6" />}
          label="Warnings"
          value={stats?.warnings ?? 0}
          color="text-yellow-600"
          bgColor="bg-yellow-50"
        />
      </div>

      {/* Scope Creep card */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-8">
        <div className="flex items-center gap-3 mb-4">
          <TrendingUp className="w-5 h-5 text-orange-600" />
          <h2 className="text-lg font-semibold text-gray-900">
            AI Scope Creep
          </h2>
        </div>
        <p className="text-3xl font-bold text-orange-600 mb-2">
          {stats?.scopeCreepDetected ?? 0}
        </p>
        <p className="text-sm text-gray-500">
          Total PRs flagged for scope creep
        </p>
      </div>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  color,
  bgColor,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  color: string;
  bgColor: string;
}) {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
      <div className="flex items-center gap-3 mb-3">
        <div className={`p-2 rounded-lg ${bgColor} ${color}`}>{icon}</div>
        <span className="text-sm font-medium text-gray-500">{label}</span>
      </div>
      <p className={`text-3xl font-bold ${color}`}>{value}</p>
    </div>
  );
}
