import { useState, useEffect, useCallback } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  addEdge,
  useReactFlow,
  type Node,
  type Edge,
  type NodeProps,
  type Connection,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Layers, Save, FlaskConical, Trash2, Plus, Wand2 } from 'lucide-react';
import api from '../lib/api';
import type { AuditStrategy, ToolCatalogEntry } from '@aigov/shared-types';
import { ConfigField, fieldCls } from '../components/ConfigField';

interface AgentNodeData {
  label: string;
  engine: string;
  vendor: string;
  modelId: string;
  temperature: number;
  maxTokens: number;
  promptVariant: string;
}

interface ToolNodeData {
  name: string;
  kind: 'skill' | 'mcp';
  description: string;
  config: Record<string, unknown>;
}

interface StructureLite {
  id: string;
  name: string;
  description: string | null;
  strategy: AuditStrategy;
  isActive: boolean;
}

const VENDORS = ['deepseek', 'claude', 'gemini'];
const ENGINES = ['deepseek', 'inline', 'sdk', 'sandbox'];
const PROMPTS = ['baseline', 'json', 'cot', 'few-shot'];

function defaultsFor(entry: ToolCatalogEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of entry.configSchema.fields) {
    if (f.default !== undefined) out[f.key] = f.default;
  }
  return out;
}

function AgentNodeView(props: NodeProps) {
  const d = props.data as unknown as AgentNodeData;
  return (
    <div className="w-64 rounded-xl border-2 border-emerald-500/40 bg-slate-900 shadow-lg shadow-black/40">
      <div className="px-4 py-3 border-b border-slate-800 flex items-center gap-2">
        <Layers className="w-4 h-4 text-emerald-400" />
        <span className="font-semibold text-white text-sm truncate">{d.label || 'Agent'}</span>
      </div>
      <div className="px-4 py-2 space-y-1 text-xs text-slate-400">
        <div className="flex justify-between"><span className="text-slate-600">Model</span><span className="text-slate-200 truncate">{d.vendor}/{d.modelId}</span></div>
        <div className="flex justify-between"><span className="text-slate-600">Temp</span><span>{d.temperature}</span></div>
        <div className="flex justify-between"><span className="text-slate-600">Prompt</span><span>{d.promptVariant}</span></div>
      </div>
      <Handle type="target" position={Position.Left} id="mcp-in" style={{ top: '36%', background: '#3b82f6', width: 12, height: 12, border: '2px solid #0f172a' }} />
      <Handle type="target" position={Position.Left} id="skill-in" style={{ top: '66%', background: '#f43f5e', width: 12, height: 12, border: '2px solid #0f172a' }} />
    </div>
  );
}

function McpNodeView(props: NodeProps) {
  const d = props.data as unknown as ToolNodeData;
  return (
    <div className="w-44 rounded-lg border border-blue-500/50 bg-slate-900 px-3 py-2 shadow-md shadow-black/40">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-blue-300"><span className="w-1.5 h-1.5 rounded-full bg-blue-400" />{d.name}</div>
      <div className="text-[11px] text-slate-500 truncate mt-0.5">{d.description}</div>
      <Handle type="source" position={Position.Right} id="mcp-out" style={{ background: '#3b82f6', width: 12, height: 12, border: '2px solid #0f172a' }} />
    </div>
  );
}

function SkillNodeView(props: NodeProps) {
  const d = props.data as unknown as ToolNodeData;
  return (
    <div className="w-44 rounded-lg border border-rose-500/50 bg-slate-900 px-3 py-2 shadow-md shadow-black/40">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-rose-300"><span className="w-1.5 h-1.5 rounded-full bg-rose-400" />{d.name}</div>
      <div className="text-[11px] text-slate-500 truncate mt-0.5">{d.description}</div>
      <Handle type="source" position={Position.Right} id="skill-out" style={{ background: '#f43f5e', width: 12, height: 12, border: '2px solid #0f172a' }} />
    </div>
  );
}

const nodeTypes = { agent: AgentNodeView, mcp: McpNodeView, skill: SkillNodeView };

function initialAgentNode(): Node {
  return {
    id: 'agent',
    type: 'agent',
    position: { x: 400, y: 200 },
    data: {
      label: 'Agent',
      engine: 'deepseek',
      vendor: 'deepseek',
      modelId: 'deepseek-v4-pro',
      temperature: 0.2,
      maxTokens: 4000,
      promptVariant: 'baseline',
    },
  };
}

function CanvasWorkspace() {
  const { screenToFlowPosition } = useReactFlow();
  const [structures, setStructures] = useState<StructureLite[]>([]);
  const [catalog, setCatalog] = useState<{ skills: ToolCatalogEntry[]; mcp: ToolCatalogEntry[] }>({ skills: [], mcp: [] });
  const [name, setName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>('agent');
  const [discovered, setDiscovered] = useState<Record<string, Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>>>({});
  const [discovering, setDiscovering] = useState<string | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([initialAgentNode()]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const load = () => api.get<StructureLite[]>('/agent-structures').then((r) => setStructures(r.data)).catch(() => {});
  const loadCatalog = () => api.get<{ skills: ToolCatalogEntry[]; mcp: ToolCatalogEntry[] }>('/tool-catalog').then((r) => setCatalog(r.data)).catch(() => {});

  useEffect(() => { load(); loadCatalog(); }, []);

  const onConnect = useCallback((conn: Connection) => {
    setEdges((eds) => addEdge(conn, eds));
  }, [setEdges]);

  const isValidConnection = useCallback((conn: Edge | Connection) => {
    return (conn.sourceHandle === 'mcp-out' && conn.targetHandle === 'mcp-in') ||
      (conn.sourceHandle === 'skill-out' && conn.targetHandle === 'skill-in');
  }, []);

  const onDragStart = (e: React.DragEvent<HTMLDivElement>, kind: 'skill' | 'mcp', tool: ToolCatalogEntry) => {
    e.dataTransfer.setData('application/aigov-tool', JSON.stringify({ kind, name: tool.name, description: tool.description }));
    e.dataTransfer.effectAllowed = 'move';
  };

  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData('application/aigov-tool');
    if (!raw) return;
    const parsed = JSON.parse(raw) as { kind: 'skill' | 'mcp'; name: string; description: string };
    const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const id = parsed.kind + '-' + parsed.name;
    setNodes((nds) => {
      if (nds.some((n) => n.id === id)) return nds;
      const list = parsed.kind === 'skill' ? catalog.skills : catalog.mcp;
      const entry = list.find((t) => t.name === parsed.name);
      const node: Node = {
        id,
        type: parsed.kind,
        position: pos,
        data: { name: parsed.name, kind: parsed.kind, description: parsed.description, config: entry ? defaultsFor(entry) : {} },
      };
      return nds.concat(node);
    });
  }, [screenToFlowPosition, catalog]);

  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const updateNodeData = (id: string, patch: Record<string, unknown>) => {
    setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...(n.data as Record<string, unknown>), ...patch } } : n)));
  };

  const updateToolConfig = (id: string, key: string, value: unknown) => {
    setNodes((nds) => nds.map((n) => {
      if (n.id !== id) return n;
      const d = n.data as unknown as ToolNodeData;
      return { ...n, data: { ...d, config: { ...(d.config ?? {}), [key]: value } } };
    }));
  };

  const removeNode = (id: string) => {
    setNodes((nds) => nds.filter((n) => n.id !== id));
    setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
    setSelectedId(null);
  };

  const discover = async (nodeId: string) => {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const d = node.data as unknown as ToolNodeData;
    const nm = d.name;
    const cfg = d.config ?? {};
    setDiscovering(nm);
    try {
      const res = await api.post('/mcp/discover', { name: nm, transport: cfg.transport ?? 'sse', url: cfg.url, command: cfg.command, args: cfg.args });
      setDiscovered((p) => ({ ...p, [nm]: res.data?.tools ?? [] }));
    } catch {
      setDiscovered((p) => ({ ...p, [nm]: [] }));
    } finally {
      setDiscovering(null);
    }
  };

  const compile = (): AuditStrategy | null => {
    const agent = nodes.find((n) => n.type === 'agent');
    if (!agent) return null;
    const a = agent.data as unknown as AgentNodeData;
    const connected = new Set(edges.map((e) => e.source));
    const mcpNames: string[] = [];
    const skillNames: string[] = [];
    const toolConfig: Record<string, Record<string, unknown>> = {};
    for (const n of nodes) {
      if (n.type !== 'mcp' && n.type !== 'skill') continue;
      if (!connected.has(n.id)) continue;
      const d = n.data as unknown as ToolNodeData;
      if (n.type === 'mcp') mcpNames.push(d.name);
      else skillNames.push(d.name);
      if (d.config && Object.keys(d.config).length > 0) toolConfig[d.name] = d.config;
    }
    return {
      engine: a.engine as AuditStrategy['engine'],
      vendor: a.vendor as AuditStrategy['vendor'],
      modelId: a.modelId,
      temperature: a.temperature,
      maxTokens: a.maxTokens,
      promptVariant: a.promptVariant as AuditStrategy['promptVariant'],
      flow: 'orchestrator',
      toolChain: {
        skills: skillNames,
        mcp: mcpNames,
        ...(Object.keys(toolConfig).length > 0 ? { toolConfig } : {}),
      },
    };
  };

  const save = async () => {
    if (!name.trim()) { alert('Give the structure a name first.'); return; }
    const strategy = compile();
    if (!strategy) return;
    if (editingId) {
      await api.patch('/agent-structures/' + editingId, { name: name.trim(), strategy });
    } else {
      await api.post('/agent-structures', { name: name.trim(), strategy });
    }
    load();
  };

  const openStructure = (s: StructureLite) => {
    setEditingId(s.id);
    setName(s.name);
    const a = s.strategy;
    const agentNode: Node = {
      id: 'agent',
      type: 'agent',
      position: { x: 400, y: 200 },
      data: { label: s.name, engine: a.engine, vendor: a.vendor, modelId: a.modelId, temperature: a.temperature, maxTokens: a.maxTokens, promptVariant: a.promptVariant },
    };
    const newNodes: Node[] = [agentNode];
    const newEdges: Edge[] = [];
    const tc = a.toolChain ?? { skills: [], mcp: [] };
    let i = 0;
    for (const nm of tc.mcp ?? []) {
      const entry = catalog.mcp.find((t) => t.name === nm);
      const id = 'mcp-' + nm;
      newNodes.push({ id, type: 'mcp', position: { x: 60, y: 40 + i * 110 }, data: { name: nm, kind: 'mcp', description: entry?.description ?? '', config: tc.toolConfig?.[nm] ?? {} } });
      newEdges.push({ id: 'e-' + id, source: id, target: 'agent', sourceHandle: 'mcp-out', targetHandle: 'mcp-in' });
      i += 1;
    }
    for (const nm of tc.skills ?? []) {
      const entry = catalog.skills.find((t) => t.name === nm);
      const id = 'skill-' + nm;
      newNodes.push({ id, type: 'skill', position: { x: 60, y: 260 + i * 110 }, data: { name: nm, kind: 'skill', description: entry?.description ?? '', config: tc.toolConfig?.[nm] ?? {} } });
      newEdges.push({ id: 'e-' + id, source: id, target: 'agent', sourceHandle: 'skill-out', targetHandle: 'skill-in' });
      i += 1;
    }
    setNodes(newNodes);
    setEdges(newEdges);
    setSelectedId('agent');
  };

  const newCanvas = () => {
    setEditingId(null);
    setName('');
    setNodes([initialAgentNode()]);
    setEdges([]);
    setSelectedId('agent');
    setDiscovered({});
  };

  const removeStructure = (id: string) => api.delete('/agent-structures/' + id).then(load);

  const selectedNode = nodes.find((n) => n.id === selectedId) ?? null;
  const selectedTool = selectedNode && (selectedNode.type === 'mcp' || selectedNode.type === 'skill')
    ? (selectedNode.data as unknown as ToolNodeData)
    : null;
  const selectedToolEntry = selectedTool
    ? (selectedTool.kind === 'skill' ? catalog.skills : catalog.mcp).find((t) => t.name === selectedTool.name)
    : null;

  return (
    <div>
      <div className="card p-4">
        <div className="flex flex-wrap items-end gap-3 mb-3">
          <div className="flex-1 min-w-[220px]">
            <label className="text-xs text-slate-500">Structure name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Secure vendor portal flow" className={fieldCls} />
          </div>
          <button onClick={newCanvas} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-medium">
            <Plus className="w-4 h-4" /> New
          </button>
          <button onClick={save} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium">
            <Save className="w-4 h-4" /> Save workflow
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[210px_1fr_300px] gap-4">
          {/* Palette */}
          <div className="border border-slate-800 rounded-lg p-3 space-y-4 h-fit">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="w-2 h-2 rounded-full bg-rose-500" />
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Native skills</span>
              </div>
              <div className="space-y-1.5">
                {catalog.skills.map((s) => (
                  <div key={s.name} draggable onDragStart={(e) => onDragStart(e, 'skill', s)} className="cursor-grab rounded-lg border border-rose-500/30 bg-slate-900 px-2.5 py-1.5 hover:border-rose-500/60" title={s.description}>
                    <div className="text-xs font-medium text-rose-200">{s.name}</div>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="w-2 h-2 rounded-full bg-blue-500" />
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">MCP connectors</span>
              </div>
              <div className="space-y-1.5">
                {catalog.mcp.map((m) => (
                  <div key={m.name} draggable onDragStart={(e) => onDragStart(e, 'mcp', m)} className="cursor-grab rounded-lg border border-blue-500/30 bg-slate-900 px-2.5 py-1.5 hover:border-blue-500/60" title={m.description}>
                    <div className="text-xs font-medium text-blue-200">{m.name}</div>
                  </div>
                ))}
              </div>
            </div>
            <p className="text-[11px] text-slate-600 leading-relaxed">Drag a skill (red) or MCP connector (blue) onto the canvas, then link its handle to the matching slot on the agent.</p>
          </div>

          {/* Canvas */}
          <div className="border border-slate-800 rounded-lg" style={{ height: 560 }} onDrop={onDrop} onDragOver={onDragOver}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              isValidConnection={isValidConnection}
              nodeTypes={nodeTypes}
              onNodeClick={(_e, node) => setSelectedId(node.id)}
              onPaneClick={() => setSelectedId(null)}
              fitView
            >
              <Background color="#1e293b" gap={18} />
              <Controls />
            </ReactFlow>
          </div>

          {/* Side panel */}
          <div className="border border-slate-800 rounded-lg p-3 h-fit">
            {!selectedNode && <p className="text-sm text-slate-500">Click a node to configure it.</p>}

            {selectedNode && selectedNode.type === 'agent' && (
              <div>
                <p className="text-sm font-semibold text-white mb-2">Agent node</p>
                <label className="text-xs text-slate-500">Label</label>
                <input value={(selectedNode.data as unknown as AgentNodeData).label} onChange={(e) => updateNodeData(selectedNode.id, { label: e.target.value })} className={fieldCls} />
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <div>
                    <label className="text-xs text-slate-500">Vendor</label>
                    <select value={(selectedNode.data as unknown as AgentNodeData).vendor} onChange={(e) => updateNodeData(selectedNode.id, { vendor: e.target.value })} className={fieldCls}>
                      {VENDORS.map((v) => <option key={v} value={v}>{v}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-slate-500">Engine</label>
                    <select value={(selectedNode.data as unknown as AgentNodeData).engine} onChange={(e) => updateNodeData(selectedNode.id, { engine: e.target.value })} className={fieldCls}>
                      {ENGINES.map((v) => <option key={v} value={v}>{v}</option>)}
                    </select>
                  </div>
                </div>
                <label className="text-xs text-slate-500 block mt-2">Model id</label>
                <input value={(selectedNode.data as unknown as AgentNodeData).modelId} onChange={(e) => updateNodeData(selectedNode.id, { modelId: e.target.value })} className={fieldCls} />
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <div>
                    <label className="text-xs text-slate-500">Temp</label>
                    <input type="number" step="0.1" value={(selectedNode.data as unknown as AgentNodeData).temperature} onChange={(e) => updateNodeData(selectedNode.id, { temperature: Number(e.target.value) })} className={fieldCls} />
                  </div>
                  <div>
                    <label className="text-xs text-slate-500">Max tokens</label>
                    <input type="number" value={(selectedNode.data as unknown as AgentNodeData).maxTokens} onChange={(e) => updateNodeData(selectedNode.id, { maxTokens: Number(e.target.value) })} className={fieldCls} />
                  </div>
                </div>
                <label className="text-xs text-slate-500 block mt-2">Prompt</label>
                <select value={(selectedNode.data as unknown as AgentNodeData).promptVariant} onChange={(e) => updateNodeData(selectedNode.id, { promptVariant: e.target.value })} className={fieldCls}>
                  {PROMPTS.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
            )}

            {selectedTool && selectedToolEntry && (
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <span className={selectedTool.kind === 'mcp' ? 'badge-neutral' : 'badge-danger'}>{selectedTool.kind}</span>
                  <p className="text-sm font-semibold text-white">{selectedTool.name}</p>
                </div>
                <p className="text-xs text-slate-500 mb-2">{selectedToolEntry.description}</p>
                {selectedToolEntry.configSchema.fields.map((field) => (
                  <ConfigField key={field.key} field={field} value={(selectedTool.config ?? {})[field.key]} onChange={(v) => updateToolConfig(selectedNode!.id, field.key, v)} />
                ))}
                {selectedTool.kind === 'mcp' && (
                  <div className="mt-3 border-t border-slate-800 pt-2">
                    <button onClick={() => discover(selectedNode!.id)} disabled={discovering === selectedTool.name} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-700 hover:bg-blue-600 text-white text-xs font-medium disabled:opacity-40">
                      <Wand2 className="w-3.5 h-3.5" /> {discovering === selectedTool.name ? 'Discovering…' : 'Discover tools'}
                    </button>
                    {discovered[selectedTool.name] && discovered[selectedTool.name].length > 0 && (
                      <div className="mt-2 space-y-1">
                        {discovered[selectedTool.name].map((t) => (
                          <div key={t.name} className="text-xs"><span className="text-slate-300 font-mono">{t.name}</span><span className="text-slate-600"> — {t.description}</span></div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <button onClick={() => removeNode(selectedNode!.id)} className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-800 hover:bg-rose-700 text-white text-xs font-medium">
                  <Trash2 className="w-3.5 h-3.5" /> Remove node
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Structure list */}
      <div className="mt-4 space-y-2">
        {structures.length === 0 && (
          <div className="card p-8 text-center"><p className="text-slate-500">No structures yet. Build one on the canvas and save.</p></div>
        )}
        {structures.map((s) => (
          <div key={s.id} className="card p-4 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <FlaskConical className="w-4 h-4 text-emerald-400" />
                <span className="font-medium text-slate-200 truncate">{s.name}</span>
                <span className="badge-neutral">orchestrator</span>
                {s.isActive && <span className="badge-success">active</span>}
              </div>
              <p className="text-xs text-slate-500 mt-1 truncate">
                {s.strategy.vendor}/{s.strategy.modelId} - {s.strategy.toolChain?.skills?.length ?? 0} skills - {s.strategy.toolChain?.mcp?.length ?? 0} mcp
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={() => openStructure(s)} className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-white text-xs">Edit</button>
              <button onClick={() => removeStructure(s.id)} className="px-2 py-1 rounded bg-rose-700 hover:bg-rose-600 text-white text-xs"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function AgentCanvas() {
  return (
    <ReactFlowProvider>
      <CanvasWorkspace />
    </ReactFlowProvider>
  );
}
