import { useState, useEffect } from 'react';
import { Plus, Trash2, Layers, FlaskConical, CheckCircle2 } from 'lucide-react';
import api from '../lib/api';
import type { AuditStrategy, FlowType, ModelVendor, AuditEngine, PromptVariant } from '@aigov/shared-types';

interface Structure {
  id: string;
  name: string;
  description: string | null;
  strategy: AuditStrategy;
  isActive: boolean;
}

interface ToolCatalog {
  skills: { name: string; description: string }[];
  mcp: string[];
}

const inputCls =
  'mt-1 w-full rounded-lg bg-surface-950 border border-slate-800 px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500';

const empty = { name: '', description: '', flow: 'sequential' as FlowType, engine: 'deepseek' as AuditEngine, vendor: 'deepseek' as ModelVendor, modelId: 'deepseek-v4-pro', temperature: 0.2, maxTokens: 4000, promptVariant: 'baseline' as PromptVariant, skills: [] as string[], mcp: [] as string[] };

export default function AgentStructures() {
  const [structures, setStructures] = useState<Structure[]>([]);
  const [catalog, setCatalog] = useState<ToolCatalog>({ skills: [], mcp: [] });
  const [f, setF] = useState(empty);
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = () => api.get<Structure[]>('/agent-structures').then((r) => setStructures(r.data)).catch(() => {});
  const loadCatalog = () => api.get<ToolCatalog>('/tool-catalog').then((r) => setCatalog(r.data)).catch(() => {});

  useEffect(() => { load(); loadCatalog(); }, []);

  const build = (): AuditStrategy => ({
    engine: f.engine,
    vendor: f.vendor,
    modelId: f.modelId,
    temperature: f.temperature,
    maxTokens: f.maxTokens,
    promptVariant: f.promptVariant,
    flow: f.flow,
    ...(f.flow === 'orchestrator' ? { toolChain: { skills: f.skills, mcp: f.mcp } } : {}),
  });

  const submit = async () => {
    if (!f.name.trim()) return;
    const strategy = build();
    if (editingId) {
      await api.patch('/agent-structures/' + editingId, { name: f.name.trim(), description: f.description || null, strategy });
    } else {
      await api.post('/agent-structures', { name: f.name.trim(), description: f.description || null, strategy });
    }
    setF(empty); setEditingId(null); load();
  };

  const edit = (s: Structure) => {
    setEditingId(s.id);
    setF({
      name: s.name,
      description: s.description ?? '',
      flow: s.strategy.flow ?? 'sequential',
      engine: s.strategy.engine,
      vendor: s.strategy.vendor,
      modelId: s.strategy.modelId,
      temperature: s.strategy.temperature,
      maxTokens: s.strategy.maxTokens,
      promptVariant: s.strategy.promptVariant,
      skills: s.strategy.toolChain?.skills ?? [],
      mcp: s.strategy.toolChain?.mcp ?? [],
    });
  };

  const toggle = (s: Structure) => api.patch('/agent-structures/' + s.id, { isActive: !s.isActive }).then(load);
  const remove = (id: string) => api.delete('/agent-structures/' + id).then(load);

  const toggleSkill = (name: string) =>
    setF((p) => ({ ...p, skills: p.skills.includes(name) ? p.skills.filter((x) => x !== name) : [...p.skills, name] }));
  const toggleMcp = (name: string) =>
    setF((p) => ({ ...p, mcp: p.mcp.includes(name) ? p.mcp.filter((x) => x !== name) : [...p.mcp, name] }));

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Agent Structures</h1>
          <p className="text-sm text-slate-500 mt-1">Design reusable review-agent architectures (flow + model + tools).</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-6">
        <div className="card p-5 h-fit">
          <div className="flex items-center gap-2 mb-4">
            <Layers className="w-4 h-4 text-emerald-400" />
            <h2 className="font-semibold text-white">{editingId ? 'Edit structure' : 'New structure'}</h2>
          </div>

          <label className="text-xs text-slate-500">Name</label>
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Orchestrator + Claude" className={inputCls} />

          <label className="text-xs text-slate-500 block mt-3">Description</label>
          <input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} className={inputCls} />

          <div className="grid grid-cols-2 gap-3 mt-3">
            <div>
              <label className="text-xs text-slate-500">Flow</label>
              <select value={f.flow} onChange={(e) => setF({ ...f, flow: e.target.value as FlowType })} className={inputCls}>
                <option value="sequential">sequential</option>
                <option value="orchestrator">orchestrator</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-500">Engine</label>
              <select value={f.engine} onChange={(e) => setF({ ...f, engine: e.target.value as AuditEngine })} className={inputCls}>
                <option value="deepseek">deepseek</option>
                <option value="inline">inline</option>
                <option value="sdk">sdk</option>
                <option value="sandbox">sandbox</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 mt-3">
            <div>
              <label className="text-xs text-slate-500">Vendor</label>
              <select value={f.vendor} onChange={(e) => setF({ ...f, vendor: e.target.value as ModelVendor })} className={inputCls}>
                <option value="deepseek">deepseek</option>
                <option value="claude">claude</option>
                <option value="gemini">gemini</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-500">Model id</label>
              <input value={f.modelId} onChange={(e) => setF({ ...f, modelId: e.target.value })} className={inputCls} />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3 mt-3">
            <div>
              <label className="text-xs text-slate-500">Temp</label>
              <input type="number" step="0.1" value={f.temperature} onChange={(e) => setF({ ...f, temperature: Number(e.target.value) })} className={inputCls} />
            </div>
            <div>
              <label className="text-xs text-slate-500">Max tokens</label>
              <input type="number" value={f.maxTokens} onChange={(e) => setF({ ...f, maxTokens: Number(e.target.value) })} className={inputCls} />
            </div>
            <div>
              <label className="text-xs text-slate-500">Prompt</label>
              <select value={f.promptVariant} onChange={(e) => setF({ ...f, promptVariant: e.target.value as PromptVariant })} className={inputCls}>
                <option value="baseline">baseline</option>
                <option value="json">json</option>
                <option value="cot">cot</option>
                <option value="few-shot">few-shot</option>
              </select>
            </div>
          </div>

          {f.flow === 'orchestrator' && (
            <>
              <label className="text-xs text-slate-500 block mt-4">Skills</label>
              <div className="flex flex-wrap gap-2 mt-1">
                {catalog.skills.map((s) => (
                  <button key={s.name} onClick={() => toggleSkill(s.name)}
                    className={(f.skills.includes(s.name) ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-400') + ' px-2 py-1 rounded text-xs'} title={s.description}>
                    {s.name}
                  </button>
                ))}
              </div>
              <label className="text-xs text-slate-500 block mt-3">MCP servers</label>
              <div className="flex flex-wrap gap-2 mt-1">
                {catalog.mcp.map((m) => (
                  <button key={m} onClick={() => toggleMcp(m)}
                    className={(f.mcp.includes(m) ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-400') + ' px-2 py-1 rounded text-xs'}>
                    {m}
                  </button>
                ))}
              </div>
            </>
          )}

          <button onClick={submit} className="mt-4 w-full inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium">
            <Plus className="w-4 h-4" /> {editingId ? 'Save changes' : 'Save structure'}
          </button>
        </div>

        <div className="space-y-3">
          {structures.length === 0 && (
            <div className="card p-12 text-center"><p className="text-slate-500">No structures yet. Create one on the left.</p></div>
          )}
          {structures.map((s) => (
            <div key={s.id} className="card p-4 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <FlaskConical className="w-4 h-4 text-emerald-400" />
                  <span className="font-medium text-slate-200 truncate">{s.name}</span>
                  <span className="badge-neutral">{s.strategy.flow ?? 'sequential'}</span>
                  {s.isActive && <span className="badge-success">active</span>}
                </div>
                <p className="text-xs text-slate-500 mt-1 truncate">
                  {s.strategy.vendor}/{s.strategy.modelId} - temp {s.strategy.temperature} - {s.strategy.promptVariant}
                  {s.strategy.toolChain && s.strategy.toolChain.mcp && s.strategy.toolChain.mcp.length > 0 ? ' - mcp: ' + s.strategy.toolChain.mcp.join(', ') : ''}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button onClick={() => toggle(s)} className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-white text-xs"><CheckCircle2 className="w-3.5 h-3.5" /></button>
                <button onClick={() => edit(s)} className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-white text-xs">Edit</button>
                <button onClick={() => remove(s.id)} className="px-2 py-1 rounded bg-rose-700 hover:bg-rose-600 text-white text-xs"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
