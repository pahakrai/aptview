import { useState } from 'react';
import { Sun, Moon, Key, Shield, Copy, Check } from 'lucide-react';
import { useTheme } from '../lib/theme';

export default function SettingsPage() {
  const { theme, toggle } = useTheme();
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText('aigov_dev_••••••••••••••••');
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">Settings</h1>
        <p className="text-sm text-slate-500 mt-1">
          Configure your organization preferences
        </p>
      </div>

      {/* Theme */}
      <div className="card p-5 mb-4">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
            {theme === 'dark' ? (
              <Moon className="w-5 h-5 text-amber-400" />
            ) : (
              <Sun className="w-5 h-5 text-amber-400" />
            )}
          </div>
          <div>
            <h2 className="text-sm font-semibold text-white">Theme</h2>
            <p className="text-xs text-slate-500">
              {theme === 'dark' ? 'Dark mode' : 'Light mode'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={toggle}
            className={`
              relative inline-flex h-7 w-12 items-center rounded-full
              transition-colors duration-200 focus:outline-none
              ${theme === 'dark' ? 'bg-emerald-600' : 'bg-slate-600'}
            `}
          >
            <span
              className={`
                inline-block h-5 w-5 transform rounded-full bg-white shadow-sm
                transition-transform duration-200
                ${theme === 'dark' ? 'translate-x-6' : 'translate-x-1'}
              `}
            />
          </button>
          <span className="text-xs text-slate-500">
            Toggle dark / light mode
          </span>
        </div>
      </div>

      {/* Enforcement Mode */}
      <div className="card p-5 mb-4">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-lg bg-blue-500/10 border border-blue-500/20">
            <Shield className="w-5 h-5 text-blue-400" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-white">Enforcement Mode</h2>
            <p className="text-xs text-slate-500">
              Control how strictly AI-generated code is governed
            </p>
          </div>
        </div>

        <div className="space-y-2">
          {[
            { mode: 'advisory', label: 'Advisory', desc: 'Reports violations but never blocks merges. Best for initial rollout.', active: true },
            { mode: 'scope_only', label: 'Scope Only', desc: 'Blocks scope creep. Standards violations are warnings only.', active: false },
            { mode: 'full', label: 'Full', desc: 'Blocks both scope and standards violations. Maximum governance.', active: false },
          ].map((level) => (
            <div
              key={level.mode}
              className={`p-3.5 rounded-lg border transition-colors duration-150 ${
                level.active
                  ? 'border-emerald-500/30 bg-emerald-500/5'
                  : 'border-slate-800 bg-transparent'
              }`}
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-white">{level.label}</p>
                  <p className="text-xs text-slate-500 mt-0.5">{level.desc}</p>
                </div>
                {level.active && (
                  <span className="badge-success text-[11px]">
                    <Check className="w-3 h-3" /> Current
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* API Key */}
      <div className="card p-5">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-lg bg-slate-500/10 border border-slate-500/20">
            <Key className="w-5 h-5 text-slate-400" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-white">API Key</h2>
            <p className="text-xs text-slate-500">
              Authenticate the GitHub Action and other integrations
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <code className="flex-1 bg-surface-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-400 select-all">
            aigov_dev_••••••••••••••••
          </code>
          <button
            onClick={handleCopy}
            className="p-2 rounded-lg border border-slate-700 text-slate-400 hover:text-white hover:border-slate-600 transition-colors duration-150"
          >
            {copied ? (
              <Check className="w-4 h-4 text-emerald-400" />
            ) : (
              <Copy className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
