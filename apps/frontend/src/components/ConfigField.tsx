import type { ToolConfigField } from '@aigov/shared-types';

export const fieldCls =
  'mt-1 w-full rounded-lg bg-surface-950 border border-slate-800 px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500';

export function ConfigField({
  field,
  value,
  onChange,
}: {
  field: ToolConfigField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const label = (
    <label className="text-xs text-slate-500" title={field.description}>{field.label}</label>
  );

  if (field.type === 'boolean') {
    return (
      <label className="flex items-center gap-2 mt-2 cursor-pointer">
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} className="rounded border-slate-700 bg-surface-950" />
        <span className="text-xs text-slate-400">{field.label}</span>
      </label>
    );
  }

  if (field.type === 'enum') {
    return (
      <div className="mt-2">
        {label}
        <select value={String(value ?? field.default ?? '')} onChange={(e) => onChange(e.target.value)} className={fieldCls}>
          {(field.enumValues ?? []).map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      </div>
    );
  }

  const textValue = value === undefined || value === null ? '' : String(value);

  if (field.type === 'number') {
    return (
      <div className="mt-2">
        {label}
        <input type="number" value={textValue} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} className={fieldCls} placeholder={field.placeholder} />
      </div>
    );
  }

  if (field.type === 'secretRef') {
    return (
      <div className="mt-2">
        {label}
        <input value={textValue} onChange={(e) => onChange(e.target.value)} className={fieldCls} placeholder={field.placeholder ?? 'env:VAR_NAME'} />
        <p className="text-[11px] text-slate-600 mt-1">Store a reference (env:VAR), not the raw secret.</p>
      </div>
    );
  }

  if (field.type === 'text') {
    return (
      <div className="mt-2">
        {label}
        <textarea rows={2} value={textValue} onChange={(e) => onChange(e.target.value)} className={fieldCls} placeholder={field.placeholder} />
      </div>
    );
  }

  return (
    <div className="mt-2">
      {label}
      <input value={textValue} onChange={(e) => onChange(e.target.value)} className={fieldCls} placeholder={field.placeholder} />
    </div>
  );
}
