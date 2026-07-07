import { useState, useEffect } from 'react';
import {
  BarChart3,
  CheckCircle,
  AlertTriangle,
  XCircle,
  ShieldCheck,
  Gauge,
  Target,
  TrendingUp,
} from 'lucide-react';
import type { ApiResponse } from '@aigov/shared-types';
import api from '../lib/api';

interface OrgStats {
  totalAudits: number;
  passed: number;
  failed: number;
  warnings: number;
  scopeCreepDetected: number;
  avgDurationMs: number;
  avgCompliance: number | null;
  avgEfficiency: number | null;
  avgCoverage: number | null;
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
        setStats({
          totalAudits: 0, passed: 0, failed: 0, warnings: 0,
          scopeCreepDetected: 0, avgDurationMs: 0,
          avgCompliance: null, avgEfficiency: null, avgCoverage: null,
        });
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-20 text-center">
        <div className="inline-block w-6 h-6 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
        <p className="mt-4 text-sm text-slate-500">Loading dashboard...</p>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Dashboard</h1>
          <p className="text-sm text-slate-500 mt-1">
            Overview of your AI code governance metrics
          </p>
        </div>
      </div>

      {/* Verdict stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard
          icon={<BarChart3 className="w-5 h-5" />}
          label="Total Audits"
          value={stats?.totalAudits ?? 0}
          color="text-slate-300"
          iconBg="bg-slate-500/10"
          iconBorder="border-slate-500/20"
        />
        <StatCard
          icon={<CheckCircle className="w-5 h-5" />}
          label="Passed"
          value={stats?.passed ?? 0}
          color="text-emerald-400"
          iconBg="bg-emerald-500/10"
          iconBorder="border-emerald-500/20"
        />
        <StatCard
          icon={<XCircle className="w-5 h-5" />}
          label="Failed"
          value={stats?.failed ?? 0}
          color="text-red-400"
          iconBg="bg-red-500/10"
          iconBorder="border-red-500/20"
        />
        <StatCard
          icon={<AlertTriangle className="w-5 h-5" />}
          label="Warnings"
          value={stats?.warnings ?? 0}
          color="text-amber-400"
          iconBg="bg-amber-500/10"
          iconBorder="border-amber-500/20"
        />
      </div>

      {/* Score cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <ScoreCard
          icon={<ShieldCheck className="w-5 h-5" />}
          label="Avg Compliance"
          value={stats?.avgCompliance ?? null}
          color="emerald"
          description="Standards followed"
        />
        <ScoreCard
          icon={<Gauge className="w-5 h-5" />}
          label="Avg Efficiency"
          value={stats?.avgEfficiency ?? null}
          color="blue"
          description="Code vs estimate"
        />
        <ScoreCard
          icon={<Target className="w-5 h-5" />}
          label="Avg Coverage"
          value={stats?.avgCoverage ?? null}
          color="violet"
          description="Requirements met"
        />
      </div>

      {/* Scope creep */}
      <div className="card p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-lg bg-orange-500/10 border border-orange-500/20">
            <TrendingUp className="w-5 h-5 text-orange-400" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-white">AI Scope Creep</h2>
            <p className="text-xs text-slate-500">PRs flagged for over-engineering</p>
          </div>
        </div>
        <p className="text-4xl font-bold text-orange-400">
          {stats?.scopeCreepDetected ?? 0}
        </p>
      </div>
    </div>
  );
}

function StatCard({
  icon, label, value, color, iconBg, iconBorder,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  color: string;
  iconBg: string;
  iconBorder: string;
}) {
  return (
    <div className="stat-card">
      <div className="flex items-center gap-3 mb-3">
        <div className={`p-2 rounded-lg ${iconBg} ${iconBorder} border ${color}`}>
          {icon}
        </div>
        <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
          {label}
        </span>
      </div>
      <p className={`text-3xl font-bold ${color}`}>{value}</p>
    </div>
  );
}

function ScoreCard({
  icon, label, value, color, description,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | null;
  color: 'emerald' | 'blue' | 'violet';
  description: string;
}) {
  const colorMap = {
    emerald: { text: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', bar: 'bg-emerald-500' },
    blue: { text: 'text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/20', bar: 'bg-blue-500' },
    violet: { text: 'text-violet-400', bg: 'bg-violet-500/10', border: 'border-violet-500/20', bar: 'bg-violet-500' },
  };
  const c = colorMap[color];
  const score = value ?? 0;
  const hasData = value !== null;

  return (
    <div className="card p-5">
      <div className="flex items-center gap-2.5 mb-3">
        <div className={`p-1.5 rounded-md ${c.bg} ${c.border} border ${c.text}`}>
          {icon}
        </div>
        <span className="text-sm font-medium text-slate-300">{label}</span>
      </div>

      <p className={`text-3xl font-bold mb-3 ${c.text}`}>
        {hasData ? `${score}%` : '—'}
      </p>

      <div className="score-bar">
        <div
          className={`score-bar-fill ${c.bar}`}
          style={{ width: `${hasData ? score : 0}%` }}
        />
      </div>

      <p className="text-xs text-slate-500 mt-2">{description}</p>
    </div>
  );
}
