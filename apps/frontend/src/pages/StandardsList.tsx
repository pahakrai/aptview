import { useState, useEffect } from 'react';
import type { CodeGuideline } from '@aigov/shared-types';
import api from '../lib/api';

const severityColors: Record<string, string> = {
  error: 'text-red-700 bg-red-50 border-red-200',
  warning: 'text-yellow-700 bg-yellow-50 border-yellow-200',
  info: 'text-blue-700 bg-blue-50 border-blue-200',
};

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
      <div className="max-w-7xl mx-auto px-4 py-12 text-center text-gray-500">
        Loading standards...
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Coding Standards</h1>
        <span className="text-sm text-gray-500">
          {guidelines.length} guideline{guidelines.length !== 1 ? 's' : ''}
        </span>
      </div>

      {guidelines.length === 0 ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center text-gray-500">
          No standards configured. Add coding guidelines to begin governing AI-generated code.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {guidelines.map((g) => (
            <div
              key={g.id}
              className="bg-white rounded-lg shadow-sm border border-gray-200 p-5"
            >
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-semibold text-gray-900">{g.name}</h3>
                <span
                  className={`text-xs font-medium px-2 py-1 rounded-full border ${severityColors[g.severity] || 'text-gray-700 bg-gray-50 border-gray-200'}`}
                >
                  {g.severity}
                </span>
              </div>
              {g.description && (
                <p className="text-sm text-gray-600 mb-3">{g.description}</p>
              )}
              <code className="text-xs bg-gray-100 px-2 py-1 rounded text-gray-700">
                {g.pattern}
              </code>
              <div className="flex gap-2 mt-3">
                <span className="text-xs text-gray-400">{g.category}</span>
                {g.isEnabled ? (
                  <span className="text-xs text-green-600">Active</span>
                ) : (
                  <span className="text-xs text-gray-400">Disabled</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
