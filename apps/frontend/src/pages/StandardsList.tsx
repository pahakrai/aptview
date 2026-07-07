import { useState, useEffect } from 'react';
import { FileCheck, AlertCircle, CheckCircle2, EyeOff } from 'lucide-react';
import type { CodeGuideline } from '@aigov/shared-types';
import api from '../lib/api';

export default function StandardsList() {
  const [guidelines, setGuidelines] = useState<CodeGuideline[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const demoOrgId = import.meta.env.VITE_DEMO_ORG_ID || 'demo-org-id';
    api
      .get<CodeGuideline[]>(`/standards/org/${demoOrgId}`)
      .then((res) => setGuidelines(res.data))
      .catch(() => setGuidelines([]))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-20 text-center">
        <div className="inline-block w-6 h-6 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
        <p className="mt-4 text-sm text-slate-500">Loading standards...</p>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Coding Standards</h1>
          <p className="text-sm text-slate-500 mt-1">
            {guidelines.length} active guideline{guidelines.length !== 1 ? 's' : ''}
          </p>
        </div>
      </div>

      {guidelines.length === 0 ? (
        <div className="card p-12 text-center">
          <FileCheck className="w-10 h-10 text-slate-700 mx-auto mb-3" />
          <p className="text-slate-400 font-medium">No standards configured</p>
          <p className="text-sm text-slate-600 mt-1">
            Add coding guidelines to begin governing AI-generated code.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {guidelines.map((g) => (
            <div key={g.id} className="card p-5 hover:border-slate-700 transition-colors duration-150">
              {/* Header */}
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-white text-[15px]">{g.name}</h3>
                <SeverityBadge severity={g.severity} />
              </div>

              {/* Description */}
              {g.description && (
                <p className="text-sm text-slate-400 mb-3 leading-relaxed">
                  {g.description}
                </p>
              )}

              {/* Pattern */}
              <div className="bg-surface-950 border border-slate-800 rounded-lg px-3 py-2 mb-3">
                <code className="text-xs font-mono text-slate-300 break-all">
                  {g.pattern}
                </code>
              </div>

              {/* Footer */}
              <div className="flex items-center gap-3 text-xs">
                <span className="text-slate-600 font-mono">{g.category}</span>
                <span className="text-slate-700">·</span>
                {g.isEnabled ? (
                  <span className="flex items-center gap-1 text-emerald-500">
                    <CheckCircle2 className="w-3 h-3" />
                    Active
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-slate-600">
                    <EyeOff className="w-3 h-3" />
                    Disabled
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  switch (severity) {
    case 'error':
      return <span className="badge-danger"><AlertCircle className="w-3 h-3" /> Error</span>;
    case 'warning':
      return <span className="badge-warning"><AlertCircle className="w-3 h-3" /> Warning</span>;
    case 'info':
      return <span className="badge-neutral">Info</span>;
    default:
      return <span className="badge-neutral">{severity}</span>;
  }
}
