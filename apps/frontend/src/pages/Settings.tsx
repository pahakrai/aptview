export default function Settings() {
  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-8">Settings</h1>

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          Enforcement Mode
        </h2>
        <p className="text-sm text-gray-500 mb-4">
          Control how strictly AI-generated code is governed. Start with advisory
          mode to collect data before enforcing rules.
        </p>

        <div className="space-y-3">
          {[
            {
              mode: 'advisory',
              title: 'Advisory',
              description:
                'Reports violations but never blocks merges. Best for initial rollout (weeks 1-2).',
              active: true,
            },
            {
              mode: 'scope_only',
              title: 'Scope Only',
              description:
                'Blocks scope creep violations. Standards violations are warnings only (weeks 3-4).',
              active: false,
            },
            {
              mode: 'full',
              title: 'Full',
              description:
                'Blocks both scope and standards violations. Maximum governance (week 5+).',
              active: false,
            },
          ].map((level) => (
            <div
              key={level.mode}
              className={`p-4 rounded-lg border ${level.active ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200'}`}
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-gray-900">{level.title}</p>
                  <p className="text-sm text-gray-500 mt-1">{level.description}</p>
                </div>
                {level.active && (
                  <span className="text-xs font-medium text-indigo-700 bg-indigo-100 px-2 py-1 rounded-full">
                    Current
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          API Key
        </h2>
        <p className="text-sm text-gray-500 mb-4">
          Use this key to authenticate the GitHub Action and other integrations.
          Keep it secure.
        </p>
        <div className="flex items-center gap-3">
          <code className="flex-1 bg-gray-100 px-3 py-2 rounded text-sm text-gray-700">
            aigov_dev_••••••••••••••••
          </code>
          <button className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">
            Rotate
          </button>
        </div>
      </div>
    </div>
  );
}
