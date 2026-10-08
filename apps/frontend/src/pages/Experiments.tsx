import { useState, useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  FlaskConical,
  Trophy,
  ShieldCheck,
  Gauge,
  ThumbsUp,
  Clock,
  Coins,
  Layers,
  Plus,
  Play,
  Pause,
  CheckCircle2,
} from 'lucide-react';
import type { Experiment, AuditStrategy, MetricsWeights } from '@aigov/shared-types';
import api from '../lib/api';

interface StructureOption {
  id: string;
  name: string;
  strategy: AuditStrategy;
}

// ---------------------------------------------------------------------------
// Report shape returned by GET /experiments/:id/report
// ---------------------------------------------------------------------------

interface SubScores {
  accuracy: number | null;
  quality: number | null;
  acceptance: number | null;
  speed: number | null;
  cost: number | null;
}

interface ExperimentArm {
  variantId: string;
  vendor: string;
  modelId: string;
  samples: number;
  decided: number;
  undecided: number;
  acceptanceRate: number | null;
  agreedWithInlineRate: number | null;
  parseOkRate: number | null;
  avgCompliance: number | null;
  avgEfficiency: number | null;
  avgCoverage: number | null;
  avgLatencyMs: number | null;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCostUsd: number;
  avgCostUsd: number;
  subScores: SubScores;
  composite: number | null;
  compositeCI: [number, number] | null;
  complianceCI: [number, number] | null;
  efficiencyCI: [number, number] | null;
  coverageCI: [number, number] | null;
  latencyCI: [number, number] | null;
  minSampleReached: boolean;
  acceptanceCI: [number, number] | null;
  vsControl: {
    compositeDelta: number | null;
    compositeVerdict: 'better' | 'worse' | 'inconclusive';
    acceptanceDelta: number | null;
    acceptanceVerdict: 'better' | 'worse' | 'inconclusive';
  } | null;
}

interface ExperimentReport {
  experiment: Experiment;
  metricsWeights: MetricsWeights;
  arms: ExperimentArm[];
  recommendation: {
    variantId: string;
    vendor: string;
    modelId: string;
    composite: number;
    samples: number;
    compositeVerdict: 'better';
  } | null;
  /** Methodology caveats that qualify how the numbers should be read. */
  caveat: string | null;
}

const STATUS_STYLES: Record<string, string> = {
  draft: 'badge-neutral',
  running: 'badge-success',
  paused: 'badge-warning',
  completed: 'badge-neutral',
};

const pct = (v: number | null | undefined, digits = 1): string =>
  v === null || v === undefined ? '—' : `${v.toFixed(digits)}%`;

const num = (v: number | null | undefined, digits = 0): string =>
  v === null || v === undefined ? '—' : v.toFixed(digits);

const ci = (v: [number, number] | null | undefined, digits = 1): string =>
  v ? `${v[0].toFixed(digits)}–${v[1].toFixed(digits)}` : '—';

const money = (v: number | null | undefined): string =>
  v === null || v === undefined ? '—' : `$${v.toFixed(3)}`;

const verdictStyle = (v: 'better' | 'worse' | 'inconclusive' | null): string =>
  v === 'better' ? 'badge-success' : v === 'worse' ? 'badge-danger' : 'badge-neutral';

const DEFAULT_CONTROL: AuditStrategy = {
  engine: 'deepseek',
  vendor: 'deepseek',
  modelId: 'deepseek-v4-pro',
  temperature: 0.2,
  maxTokens: 4000,
  promptVariant: 'baseline',
};

const DEFAULT_TREATMENT: AuditStrategy = {
  engine: 'deepseek',
  vendor: 'deepseek',
  modelId: 'deepseek-v4-flash',
  temperature: 0.2,
  maxTokens: 4000,
  promptVariant: 'baseline',
};

export default function Experiments() {
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [report, setReport] = useState<ExperimentReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [reportLoading, setReportLoading] = useState(false);
  const [newName, setNewName] = useState('');
  const [newRollout, setNewRollout] = useState(100);
  const [newMinSample, setNewMinSample] = useState(50);
  const [creating, setCreating] = useState(false);
  const [newFlow, setNewFlow] = useState<'sequential' | 'orchestrator'>('orchestrator');
  const [newSkills, setNewSkills] = useState('');
  const [newMcp, setNewMcp] = useState('');
  const [structures, setStructures] = useState<StructureOption[]>([]);
  const [structName, setStructName] = useState('');
  const [structRollout, setStructRollout] = useState(100);
  const [structMinSample, setStructMinSample] = useState(50);
  const [structControl, setStructControl] = useState('');
  const [structTreatments, setStructTreatments] = useState<string[]>([]);
  const [experimentsEnabled, setExperimentsEnabled] = useState(false);
  const [searchParams] = useSearchParams();
  const controlFromUrl = searchParams.get('control');
  const treatmentFromUrl = searchParams.get('treatment');

  const refresh = () => {
    api
      .get<Experiment[]>('/experiments')
      .then((res) => setExperiments(res.data))
      .catch(() => {});
  };

  const createExperiment = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    const treatment: AuditStrategy = {
      ...DEFAULT_TREATMENT,
      flow: newFlow,
      ...(newFlow === 'orchestrator'
        ? {
            toolChain: {
              skills: newSkills.split(',').map((s) => s.trim()).filter(Boolean),
              mcp: newMcp.split(',').map((s) => s.trim()).filter(Boolean),
            },
          }
        : {}),
    };
    try {
      await api.post('/experiments', {
        name: newName.trim(),
        rolloutPercent: newRollout,
        minSampleSize: newMinSample,
        controlStrategy: DEFAULT_CONTROL,
        treatmentStrategies: [treatment],
        metricsWeights: {
          accuracy: 0.35,
          quality: 0.35,
          acceptance: 0.15,
          speed: 0.075,
          cost: 0.075,
        },
      });
      setNewName('');
      refresh();
    } finally {
      setCreating(false);
    }
  };

  const createFromStructures = async () => {
    if (!structName.trim() || !structControl) return;
    setCreating(true);
    try {
      await api.post('/experiments/from-structures', {
        name: structName.trim(),
        rolloutPercent: structRollout,
        minSampleSize: structMinSample,
        controlStructureId: structControl,
        treatmentStructureIds: structTreatments.filter((id) => !!id),
        metricsWeights: {
          accuracy: 0.35,
          quality: 0.35,
          acceptance: 0.15,
          speed: 0.075,
          cost: 0.075,
        },
      });
      setStructName('');
      setStructTreatments([]);
      refresh();
    } finally {
      setCreating(false);
    }
  };

  const toggleExperimentsEnabled = async () => {
    const next = !experimentsEnabled;
    setExperimentsEnabled(next);
    await api.put('/settings/experiments_enabled', { value: String(next) });
  };

  const setStatus = async (id: string, status: string) => {
    await api.patch(`/experiments/${id}`, { status });
    refresh();
    if (selectedId === id) {
      setReportLoading(true);
      api
        .get<ExperimentReport>(`/experiments/${id}/report`)
        .then((res) => setReport(res.data))
        .catch(() => setReport(null))
        .finally(() => setReportLoading(false));
    }
  };

  useEffect(() => {
    api
      .get<Experiment[]>('/experiments')
      .then((res) => {
        setExperiments(res.data);
        if (res.data[0]) setSelectedId(res.data[0].id);
      })
      .catch(() => setExperiments([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    api
      .get<StructureOption[]>('/agent-structures')
      .then((res) => {
        setStructures(res.data);
        const ctrl = controlFromUrl && res.data.some((s) => s.id === controlFromUrl) ? controlFromUrl : null;
        if (ctrl) {
          setStructControl(ctrl);
          const src = res.data.find((s) => s.id === ctrl);
          if (src && !structName) setStructName(src.name + ' A/B');
        } else if (res.data[0] && !structControl) {
          setStructControl(res.data[0].id);
        }
        if (treatmentFromUrl && res.data.some((s) => s.id === treatmentFromUrl)) {
          setStructTreatments((prev) => (prev.includes(treatmentFromUrl) ? prev : [...prev, treatmentFromUrl]));
        }
      })
      .catch(() => {});
    api
      .get<{ key: string; value: string | null }>('/settings/experiments_enabled')
      .then((res) => setExperimentsEnabled(res.data.value === 'true'))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    setReportLoading(true);
    api
      .get<ExperimentReport>(`/experiments/${selectedId}/report`)
      .then((res) => setReport(res.data))
      .catch(() => setReport(null))
      .finally(() => setReportLoading(false));
  }, [selectedId]);

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-20 text-center">
        <div className="inline-block w-6 h-6 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
        <p className="mt-4 text-sm text-slate-500">Loading experiments...</p>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Experiments</h1>
          <p className="text-sm text-slate-500 mt-1">
            A/B tests comparing model &amp; strategy arms, scored on automated
            review and reviewer acceptance.
          </p>
        </div>
      </div>

      {/* A/B toggle */}
      <div className="card p-4 mb-6 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <FlaskConical className="w-5 h-5 text-emerald-400" />
          <div>
            <p className="text-sm font-medium text-slate-200">Live A/B testing</p>
            <p className="text-xs text-slate-500">
              Bucket live PR review traffic across the running experiment arms.
            </p>
          </div>
        </div>
        <button
          onClick={toggleExperimentsEnabled}
          className={
            'px-4 py-2 rounded-lg text-sm font-medium ' +
            (experimentsEnabled
              ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
              : 'bg-slate-800 hover:bg-slate-700 text-slate-400')
          }
        >
          {experimentsEnabled ? 'Enabled' : 'Disabled'}
        </button>
      </div>

      {/* New experiment from agent structures */}
      <div className="card p-4 mb-6">
        <div className="flex items-center gap-2 mb-3">
          <Layers className="w-4 h-4 text-emerald-400" />
          <h2 className="text-sm font-semibold text-white">
            Create from agent structures
          </h2>
        </div>
        {structures.length === 0 ? (
          <p className="text-xs text-slate-600">
            No agent structures yet. Design some on the{' '}
            <Link to="/agent-structures" className="text-emerald-400 hover:underline">
              Agent Structures
            </Link>{' '}
            page, then pick a control and any number of treatment arms here.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex-1 min-w-[200px]">
                <label className="text-xs text-slate-500">Experiment name</label>
                <input
                  value={structName}
                  onChange={(e) => setStructName(e.target.value)}
                  placeholder="e.g. Orchestrator vs Sequential"
                  className="mt-1 w-full rounded-lg bg-surface-950 border border-slate-800 px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500"
                />
              </div>
              <div>
                <label className="text-xs text-slate-500">Rollout %</label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={structRollout}
                  onChange={(e) => setStructRollout(Number(e.target.value))}
                  className="mt-1 w-24 rounded-lg bg-surface-950 border border-slate-800 px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-emerald-500"
                />
              </div>
              <div>
                <label className="text-xs text-slate-500">Min sample</label>
                <input
                  type="number"
                  min={1}
                  value={structMinSample}
                  onChange={(e) => setStructMinSample(Number(e.target.value))}
                  className="mt-1 w-24 rounded-lg bg-surface-950 border border-slate-800 px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-emerald-500"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-end gap-3 mt-3">
              <div className="w-56">
                <label className="text-xs text-slate-500">Control structure</label>
                <select
                  value={structControl}
                  onChange={(e) => setStructControl(e.target.value)}
                  className="mt-1 w-full rounded-lg bg-surface-950 border border-slate-800 px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-emerald-500"
                >
                  {structures.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
              <button
                onClick={createFromStructures}
                disabled={creating || !structName.trim() || !structControl}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Plus className="w-4 h-4" /> Create draft
              </button>
            </div>

            <div className="mt-3">
              <p className="text-xs text-slate-500 mb-1">
                Treatment structures ({structTreatments.length})
              </p>
              {structTreatments.map((tId, i) => (
                <div key={i} className="flex items-end gap-2 mb-2">
                  <select
                    value={tId}
                    onChange={(e) =>
                      setStructTreatments((prev) =>
                        prev.map((x, j) => (j === i ? e.target.value : x))
                      )
                    }
                    className="w-56 rounded-lg bg-surface-950 border border-slate-800 px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-emerald-500"
                  >
                    <option value="">— choose —</option>
                    {structures.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() =>
                      setStructTreatments((prev) => prev.filter((_, j) => j !== i))
                    }
                    className="px-2 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 text-xs"
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button
                onClick={() => setStructTreatments((prev) => [...prev, ''])}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs"
              >
                <Plus className="w-3.5 h-3.5" /> Add treatment
              </button>
            </div>
          </>
        )}
      </div>

      {/* New experiment */}
      <div className="card p-4 mb-6">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[200px]">
            <label className="text-xs text-slate-500">Experiment name</label>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. DeepSeek V4 Pro vs Flash"
              className="mt-1 w-full rounded-lg bg-surface-950 border border-slate-800 px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500"
            />
          </div>
          <div>
            <label className="text-xs text-slate-500">Rollout %</label>
            <input
              type="number"
              min={0}
              max={100}
              value={newRollout}
              onChange={(e) => setNewRollout(Number(e.target.value))}
              className="mt-1 w-24 rounded-lg bg-surface-950 border border-slate-800 px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-emerald-500"
            />
          </div>
          <div>
            <label className="text-xs text-slate-500">Min sample</label>
            <input
              type="number"
              min={1}
              value={newMinSample}
              onChange={(e) => setNewMinSample(Number(e.target.value))}
              className="mt-1 w-24 rounded-lg bg-surface-950 border border-slate-800 px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-emerald-500"
            />
          </div>
          <button
            onClick={createExperiment}
            disabled={creating || !newName.trim()}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Plus className="w-4 h-4" /> Create draft
          </button>
        </div>
        <div className="flex flex-wrap items-end gap-3 mt-3">
          <div>
            <label className="text-xs text-slate-500">Treatment flow</label>
            <select
              value={newFlow}
              onChange={(e) => setNewFlow(e.target.value as 'sequential' | 'orchestrator')}
              className={'mt-1 w-40 ' + 'rounded-lg bg-surface-950 border border-slate-800 px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-emerald-500'}
            >
              <option value="sequential">sequential</option>
              <option value="orchestrator">orchestrator</option>
            </select>
          </div>
          <div className="flex-1 min-w-[180px]">
            <label className="text-xs text-slate-500">Skills (empty = all built-in)</label>
            <input
              value={newSkills}
              onChange={(e) => setNewSkills(e.target.value)}
              placeholder="search_guidelines, assess_diff_size"
              className={'mt-1 w-full ' + 'rounded-lg bg-surface-950 border border-slate-800 px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500'}
            />
          </div>
          <div className="flex-1 min-w-[180px]">
            <label className="text-xs text-slate-500">MCP servers (optional add-on)</label>
            <input
              value={newMcp}
              onChange={(e) => setNewMcp(e.target.value)}
              placeholder="k8s, aws"
              className={'mt-1 w-full ' + 'rounded-lg bg-surface-950 border border-slate-800 px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500'}
            />
          </div>
        </div>
        <p className="text-xs text-slate-600 mt-2">
          Creates a global draft: control <code>deepseek-v4-pro</code> vs treatment{' '}
          <code>deepseek-v4-flash</code>. Orchestrator arms get the skills above plus any
          MCP servers you add (MCP is optional — skills are the baseline).
        </p>
      </div>

      {experiments.length === 0 ? (
        <div className="card p-12 text-center">
          <FlaskConical className="w-10 h-10 text-slate-700 mx-auto mb-3" />
          <p className="text-slate-400 font-medium">No experiments yet</p>
          <p className="text-sm text-slate-600 mt-1">
            Create an experiment via the API, then set it to <code>running</code>.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-6">
          {/* Test list */}
          <aside className="space-y-2">
            {experiments.map((exp) => (
              <button
                key={exp.id}
                onClick={() => setSelectedId(exp.id)}
                className={`w-full text-left card p-4 transition-colors duration-150 ${
                  selectedId === exp.id
                    ? 'border-emerald-500/50 bg-surface-800/50'
                    : 'hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-slate-200 truncate">
                    {exp.name}
                  </span>
                  <span className={`${STATUS_STYLES[exp.status] ?? 'badge-neutral'} shrink-0`}>
                    {exp.status}
                  </span>
                </div>
                <p className="text-xs text-slate-500 mt-2">
                  {exp.treatmentStrategies.length} treatment
                  {exp.treatmentStrategies.length === 1 ? '' : 's'} · rollout{' '}
                  {exp.rolloutPercent}%
                </p>
              </button>
            ))}
          </aside>

          {/* Detail */}
          <section className="space-y-6">
            {reportLoading && (
              <div className="card p-12 text-center">
                <div className="inline-block w-6 h-6 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
                <p className="mt-4 text-sm text-slate-500">Loading report...</p>
              </div>
            )}

            {!reportLoading && !report && (
              <div className="card p-12 text-center">
                <p className="text-slate-400">Could not load report for this experiment.</p>
              </div>
            )}

            {!reportLoading && report && (
              <ReportDetail report={report} onStatusChange={setStatus} />
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function ReportDetail({
  report,
  onStatusChange,
}: {
  report: ExperimentReport;
  onStatusChange: (id: string, status: string) => void;
}) {
  const { experiment: exp, metricsWeights, arms, recommendation, caveat } = report;
  const control = arms.find((a) => a.variantId === 'control');
  const treatments = arms.filter((a) => a.variantId !== 'control');

  return (
    <>
      {/* Status controls */}
      <div className="card p-4 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <span className={`${STATUS_STYLES[exp.status] ?? 'badge-neutral'}`}>
            {exp.status}
          </span>
          <span className="text-sm text-slate-400 font-medium">{exp.name}</span>
        </div>
        <div className="flex items-center gap-2">
          {exp.status !== 'running' && (
            <button
              onClick={() => onStatusChange(exp.id, 'running')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium"
            >
              <Play className="w-3.5 h-3.5" /> Start
            </button>
          )}
          {exp.status === 'running' && (
            <button
              onClick={() => onStatusChange(exp.id, 'paused')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-medium"
            >
              <Pause className="w-3.5 h-3.5" /> Pause
            </button>
          )}
          {exp.status !== 'completed' && (
            <button
              onClick={() => onStatusChange(exp.id, 'completed')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-xs font-medium"
            >
              <CheckCircle2 className="w-3.5 h-3.5" /> Complete
            </button>
          )}
        </div>
      </div>

      {/* Parameters */}
      <div className="card p-5">
        <div className="flex items-center gap-2 mb-4">
          <Layers className="w-4 h-4 text-emerald-400" />
          <h2 className="font-semibold text-white">Parameters</h2>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
          <Meta label="Rollout" value={`${exp.rolloutPercent}%`} />
          <Meta label="Min sample / arm" value={`${exp.minSampleSize}`} />
          <Meta label="Started" value={exp.startedAt ? new Date(exp.startedAt).toLocaleDateString() : '—'} />
          <Meta label="Org" value={exp.organizationId ?? 'global'} />
        </div>

        <div className="mb-5">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
            Composite weights
          </h3>
          <div className="flex flex-wrap gap-2">
            {(['accuracy', 'quality', 'acceptance', 'speed', 'cost'] as const).map((k) => (
              <span key={k} className="badge-neutral">
                {k} · {(metricsWeights[k] ?? 0).toFixed(3)}
              </span>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <StrategyBlock label="Control" strategy={exp.controlStrategy} />
          {exp.treatmentStrategies.map((s, i) => (
            <StrategyBlock key={i} label={`Treatment ${i + 1}`} strategy={s} />
          ))}
        </div>
      </div>

      {/* Recommendation */}
      {recommendation && (
        <div className="card p-5 border-emerald-500/30 bg-emerald-500/5">
          <div className="flex items-center gap-3">
            <Trophy className="w-6 h-6 text-emerald-400" />
            <div>
              <p className="font-semibold text-white">
                Winner: {recommendation.variantId}
                <span className="text-slate-400 font-normal"> · {recommendation.vendor}/{recommendation.modelId}</span>
              </p>
              <p className="text-sm text-slate-500">
                Composite {recommendation.composite.toFixed(1)} · {recommendation.samples} samples ·{' '}
                <span className="text-emerald-400">significantly better vs control</span>
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Arm comparison */}
      <div className="space-y-4">
        {arms.map((arm) => (
          <ArmCard key={arm.variantId} arm={arm} control={control} isControl={arm.variantId === 'control'} />
        ))}
      </div>

      {control && treatments.length > 0 && (
        <p className="text-xs text-slate-600">
          Δ shown against the control arm. Positive = treatment outperforms control.
        </p>
      )}

      {caveat && (
        <div className="card p-4 border-slate-800">
          <p className="text-xs text-slate-500 leading-relaxed">
            <span className="font-semibold text-slate-400">Methodology note: </span>
            {caveat}
          </p>
        </div>
      )}

      <BenchmarkPanel experimentId={exp.id} organizationId={exp.organizationId} arms={arms} />
    </>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-slate-500">{label}</p>
      <p className="text-sm font-medium text-slate-200 truncate">{value}</p>
    </div>
  );
}

function StrategyBlock({ label, strategy }: { label: string; strategy: AuditStrategy }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-surface-950/40 p-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
        {label}
      </p>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
        <Dt>Engine</Dt>
        <Dd>{strategy.engine}</Dd>
        <Dt>Model</Dt>
        <Dd className="truncate">{strategy.modelId}</Dd>
        <Dt>Vendor</Dt>
        <Dd>{strategy.vendor}</Dd>
        <Dt>Prompt</Dt>
        <Dd>{strategy.promptVariant}</Dd>
        <Dt>Temp</Dt>
        <Dd>{strategy.temperature}</Dd>
        <Dt>Max tokens</Dt>
        <Dd>{strategy.maxTokens}</Dd>
      </dl>
    </div>
  );
}

function Dt({ children }: { children: React.ReactNode }) {
  return <dt className="text-slate-500">{children}</dt>;
}

function Dd({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <dd className={`text-slate-300 ${className}`}>{children}</dd>;
}

function ArmCard({
  arm,
  control,
  isControl,
}: {
  arm: ExperimentArm;
  control?: ExperimentArm;
  isControl: boolean;
}) {
  const delta =
    !isControl && control && arm.composite !== null && control.composite !== null
      ? arm.composite - control.composite
      : null;

  return (
    <div className={`card p-5 ${isControl ? 'border-slate-700' : ''}`}>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-white">{arm.variantId}</h3>
            {isControl && <span className="badge-neutral">control</span>}
            {!arm.minSampleReached && <span className="badge-warning">under min sample</span>}
            {delta !== null && (
              <span className={delta >= 0 ? 'badge-success' : 'badge-danger'}>
                {delta >= 0 ? '+' : ''}
                {delta.toFixed(1)} pts
              </span>
            )}
            {arm.vsControl && arm.vsControl.compositeVerdict !== 'inconclusive' && (
              <span className={verdictStyle(arm.vsControl.compositeVerdict)}>
                {arm.vsControl.compositeVerdict}
              </span>
            )}
          </div>
          <p className="text-sm text-slate-500 mt-0.5">
            {arm.vendor}/{arm.modelId} · {arm.samples} sample{arm.samples === 1 ? '' : 's'}
          </p>
        </div>

        <div className="text-right">
          <p className="text-xs text-slate-500 uppercase tracking-wider">Composite</p>
          <p className="text-3xl font-bold text-emerald-400">
            {arm.composite === null ? '—' : arm.composite.toFixed(1)}
          </p>
          {arm.compositeCI && (
            <p className="text-xs text-slate-600 font-mono mt-0.5">
              CI {ci(arm.compositeCI, 1)}
            </p>
          )}
        </div>
      </div>

      {/* Sub-scores */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mt-5">
        <SubScore label="Accuracy" value={arm.subScores.accuracy} icon={<ShieldCheck className="w-4 h-4" />} />
        <SubScore label="Quality" value={arm.subScores.quality} icon={<Gauge className="w-4 h-4" />} />
        <SubScore label="Acceptance" value={arm.subScores.acceptance} icon={<ThumbsUp className="w-4 h-4" />} />
        <SubScore label="Speed" value={arm.subScores.speed} icon={<Clock className="w-4 h-4" />} />
        <SubScore label="Cost" value={arm.subScores.cost} icon={<Coins className="w-4 h-4" />} />
      </div>

      {/* Raw metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-5 pt-5 border-t border-slate-800">
        <MiniStat label="Accept rate" value={pct(arm.acceptanceRate === null ? null : arm.acceptanceRate * 100)} />
        <MiniStat label="Accept 95% CI" value={arm.acceptanceCI ? `${pct(arm.acceptanceCI[0] * 100, 0)}–${pct(arm.acceptanceCI[1] * 100, 0)}` : '—'} />
        <MiniStat label="Agree w/ inline" value={pct(arm.agreedWithInlineRate === null ? null : arm.agreedWithInlineRate * 100)} />
        <MiniStat label="Parse OK" value={pct(arm.parseOkRate === null ? null : arm.parseOkRate * 100)} />
        <MiniStat label="Avg compliance" value={pct(arm.avgCompliance, 0)} />
        <MiniStat label="Avg efficiency" value={pct(arm.avgEfficiency, 0)} />
        <MiniStat label="Avg coverage" value={pct(arm.avgCoverage, 0)} />
        <MiniStat label="Avg latency" value={arm.avgLatencyMs === null ? '—' : `${num(arm.avgLatencyMs, 0)}ms`} />
        <MiniStat label="Tokens (p/c)" value={`${num(arm.totalPromptTokens)}/${num(arm.totalCompletionTokens)}`} />
        <MiniStat label="Cost / audit" value={money(arm.avgCostUsd)} />
        <MiniStat label="Cost total" value={money(arm.totalCostUsd)} />
        <MiniStat label="Decided / undecided" value={`${arm.decided} / ${arm.undecided}`} />
      </div>
    </div>
  );
}

function SubScore({
  label,
  value,
  icon,
}: {
  label: string;
  value: number | null;
  icon: React.ReactNode;
}) {
  const score = value === null ? null : Math.round(value);
  return (
    <div className="rounded-lg border border-slate-800 bg-surface-950/40 p-3">
      <div className="flex items-center gap-1.5 text-slate-500 text-xs mb-1.5">
        {icon}
        {label}
      </div>
      {score === null ? (
        <span className="text-slate-600 text-sm">—</span>
      ) : (
        <div className="flex items-center gap-2">
          <div className="score-bar flex-1">
            <div className="score-bar-fill bg-emerald-500" style={{ width: `${score}%` }} />
          </div>
          <span className="text-sm font-mono font-medium text-slate-300">{score}</span>
        </div>
      )}
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-slate-500">{label}</p>
      <p className="text-sm font-medium text-slate-300">{value}</p>
    </div>
  );
}

interface BenchmarkArm {
  variantId: string;
  vendor: string | null;
  modelId: string | null;
  flow: string;
  samples: number;
  avgLatencyMs: number | null;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalToolCalls: number;
  avgCostUsd: number;
  parseOkRate: number | null;
  avgCompliance: number | null;
  avgEfficiency: number | null;
  avgCoverage: number | null;
  composite: number | null;
  rankingScore: number | null;
  finalScore: number | null;
}

interface BenchmarkReport {
  experiment: Experiment;
  arms: BenchmarkArm[];
  winner: { variantId: string; vendor: string; modelId: string; finalScore: number } | null;
  caveat: string;
}

const inputCls =
  'mt-1 w-full rounded-lg bg-surface-950 border border-slate-800 px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500';

function BenchmarkPanel({
  experimentId,
  organizationId,
  arms,
}: {
  experimentId: string;
  organizationId: string | null;
  arms: { variantId: string; vendor: string; modelId: string }[];
}) {
  const [bench, setBench] = useState<BenchmarkReport | null>(null);
  const [orgId, setOrgId] = useState(organizationId ?? '');
  const [prTitle, setPrTitle] = useState('');
  const [task, setTask] = useState('');
  const [diff, setDiff] = useState('');
  const [loading, setLoading] = useState(false);
  const [ranks, setRanks] = useState<Record<string, number>>({});
  const [repo, setRepo] = useState('');
  const [pr, setPr] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const loadBench = () => {
    api
      .get<BenchmarkReport>('/experiments/' + experimentId + '/benchmark')
      .then((res) => setBench(res.data))
      .catch(() => {});
  };

  const pollJob = (id: string) => {
    api
      .get<{ id: string; status: string }>('/experiments/benchmark-jobs/' + id)
      .then((res) => {
        const s = res.data.status;
        setJobStatus(s);
        if (s === 'completed' || s === 'failed' || s === 'cancelled') {
          setLoading(false);
          setJobId(null);
          if (s === 'completed') loadBench();
          return;
        }
        timerRef.current = window.setTimeout(() => pollJob(id), 2000);
      })
      .catch(() => {
        setLoading(false);
        setJobStatus(null);
      });
  };

  const runBench = async () => {
    setLoading(true);
    setJobStatus('queued');
    try {
      const res = await api.post<{ id: string }>('/experiments/' + experimentId + '/benchmark-runs', {
        organizationId: orgId,
        prTitle,
        taskDescription: task || undefined,
        diffContent: diff,
      });
      setJobId(res.data.id);
      pollJob(res.data.id);
    } catch {
      setLoading(false);
      setJobStatus(null);
      alert('Failed to start benchmark (maybe one is already running).');
    }
  };

  const cancelJob = async () => {
    if (!jobId) return;
    await api.post('/experiments/benchmark-jobs/' + jobId + '/cancel');
    setJobStatus('cancelled');
    setLoading(false);
    setJobId(null);
  };

  const saveRanks = async () => {
    if (!repo.trim() || !pr.trim()) {
      alert('Enter owner/repo and PR number to save rankings.');
      return;
    }
    await api.post('/experiments/' + experimentId + '/rankings', {
      repositoryFullName: repo.trim(),
      prNumber: Number(pr) || 0,
      rankings: arms.map((a) => ({ variantId: a.variantId, rank: ranks[a.variantId] ?? 1 })),
    });
    loadBench();
  };

  const promote = async (variantId: string) => {
    await api.post('/experiments/' + experimentId + '/promote', {
      variantId,
      scope: 'org',
      organizationId: orgId || organizationId,
    });
    alert('Promoted ' + variantId + ' as the active org flow.');
  };

  return (
    <div className="card p-5">
      <div className="flex items-center gap-2 mb-4">
        <FlaskConical className="w-4 h-4 text-emerald-400" />
        <h2 className="font-semibold text-white">Deliberate flow benchmark</h2>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
        <input value={orgId} onChange={(e) => setOrgId(e.target.value)} placeholder="Organization ID" className={inputCls} />
        <input value={prTitle} onChange={(e) => setPrTitle(e.target.value)} placeholder="PR title" className={inputCls} />
        <input value={task} onChange={(e) => setTask(e.target.value)} placeholder="Task description (optional)" className={inputCls} />
      </div>
      <textarea
        value={diff}
        onChange={(e) => setDiff(e.target.value)}
        placeholder="Paste a unified diff to review"
        rows={6}
        className={inputCls}
      />
      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={runBench}
          disabled={loading || !diff.trim()}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Play className="w-4 h-4" />
          {loading ? 'Running…' : 'Run benchmark (all arms)'}
        </button>
        {jobStatus && <span className="badge-neutral">status: {jobStatus}</span>}
        {loading && jobId && (
          <button
            onClick={cancelJob}
            className="px-3 py-1.5 rounded-lg bg-rose-700 hover:bg-rose-600 text-white text-xs font-medium"
          >
            Cancel
          </button>
        )}
      </div>

      {bench && (
        <div className="mt-5">
          {bench.winner && (
            <div className="card p-3 border-emerald-500/30 bg-emerald-500/5 mb-4">
              <p className="text-sm text-white font-semibold">
                Winner: {bench.winner.variantId} · {bench.winner.vendor}/{bench.winner.modelId} · final score {bench.winner.finalScore.toFixed(1)}
              </p>
            </div>
          )}

          <table className="w-full text-sm text-slate-300">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th className="py-1">Arm</th>
                <th>Flow</th>
                <th>Tokens</th>
                <th>Cost</th>
                <th>Latency</th>
                <th>Composite</th>
                <th>Rank</th>
                <th>Final</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {bench.arms.map((a) => (
                <tr key={a.variantId} className="border-t border-slate-800">
                  <td className="py-2 font-medium text-slate-200">{a.variantId}</td>
                  <td>{a.flow}</td>
                  <td>{a.totalPromptTokens + a.totalCompletionTokens}</td>
                  <td>{'$' + a.avgCostUsd.toFixed(3)}</td>
                  <td>{a.avgLatencyMs === null ? '—' : a.avgLatencyMs + 'ms'}</td>
                  <td>{a.composite === null ? '—' : a.composite.toFixed(1)}</td>
                  <td>{a.rankingScore === null ? '—' : a.rankingScore.toFixed(1)}</td>
                  <td className="font-semibold text-emerald-400">
                    {a.finalScore === null ? '—' : a.finalScore.toFixed(1)}
                  </td>
                  <td>
                    <button
                      onClick={() => promote(a.variantId)}
                      className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-white text-xs"
                    >
                      Promote
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
            <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo" className={inputCls} />
            <input value={pr} onChange={(e) => setPr(e.target.value)} placeholder="PR number" className={inputCls} />
            <button
              onClick={saveRanks}
              className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-sm font-medium"
            >
              Save rankings
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-4">
            {arms.map((a) => (
              <label key={a.variantId} className="inline-flex items-center gap-2 text-xs text-slate-400">
                {a.variantId}
                <select
                  value={ranks[a.variantId] ?? 1}
                  onChange={(e) => setRanks({ ...ranks, [a.variantId]: Number(e.target.value) })}
                  className="rounded bg-surface-950 border border-slate-800 px-2 py-1 text-xs text-slate-200"
                >
                  {arms.map((_, i) => (
                    <option key={i} value={i + 1}>
                      {i + 1}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
