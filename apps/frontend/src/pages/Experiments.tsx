import { useState, useEffect } from 'react';
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

  const refresh = () => {
    api
      .get<Experiment[]>('/experiments')
      .then((res) => setExperiments(res.data))
      .catch(() => {});
  };

  const createExperiment = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      await api.post('/experiments', {
        name: newName.trim(),
        rolloutPercent: newRollout,
        minSampleSize: newMinSample,
        controlStrategy: DEFAULT_CONTROL,
        treatmentStrategies: [DEFAULT_TREATMENT],
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
        <p className="text-xs text-slate-600 mt-2">
          Creates a global draft: control <code>deepseek-v4-pro</code> vs treatment{' '}
          <code>deepseek-v4-flash</code>. Customize arms via API.
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
