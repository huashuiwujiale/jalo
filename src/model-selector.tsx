import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, LoaderCircle, RefreshCw, Settings2 } from 'lucide-react';
import type { Api, LocalModel } from '../shared/types';
import { findLocalModel, modelSelectionError } from '../shared/models';
import './model-selector.css';

export interface ModelValidation { service: string; model: string; error: string }
export function ModelSelector({ api, value, defaultModel, service, disabled, onChange, onValidation, settings }: {
  api: Pick<Api, 'models'>; value: string; defaultModel: string; service: string; disabled: boolean;
  onChange: (model: string) => void; onValidation: (validation: ModelValidation) => void; settings: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLElement>(null), list = useRef<HTMLDivElement>(null);
  const generation = useRef(0), listId = useId();
  const [open, setOpen] = useState(false), [active, setActive] = useState(0);
  const [catalog, setCatalog] = useState<{ service: string; models: LocalModel[] }>();
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  const [position, setPosition] = useState({ left: 0, bottom: 0, width: 320, maxHeight: 300 });
  const models = catalog?.service === service ? catalog.models : undefined;
  const effective = value || defaultModel, current = models && findLocalModel(models, effective);
  const problem = models ? modelSelectionError(models, effective) : '';
  const name = current?.name || effective || '选择模型';
  const options = [{ value: '', name: '使用默认模型', hint: defaultModel ? findLocalModel(models || [], defaultModel)?.name || defaultModel : '尚未设置默认模型', disabled: !!(models && modelSelectionError(models, defaultModel)) },
    ...(models || []).map(model => ({ value: model.key, name: model.name, hint: [model.instances.length ? '已加载' : '未加载', model.toolUse === false ? '不支持工具调用' : !model.instances.length ? '发送时加载' : ''].filter(Boolean).join(' · '), disabled: model.toolUse === false }))];
  const isSelected = (id: string) => id === value || (!!value && id !== '' && current?.key === id);
  const close = (restoreFocus = false) => {
    generation.current++; setOpen(false); setPending(false);
    if (restoreFocus) trigger.current?.focus();
  };
  async function refresh() {
    const request = ++generation.current;
    setPending(true); setError('');
    try {
      const result = await api.models();
      if (request === generation.current) setCatalog({ service, models: result });
    } catch (e) {
      if (request === generation.current) setError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': Error: /, ''));
    } finally { if (request === generation.current) setPending(false); }
  }
  function choose(index: number) {
    const option = options[index];
    if (disabled || !option || option.disabled) return;
    onChange(option.value); close(true);
  }
  useEffect(() => { onValidation({ service, model: effective, error: problem }); }, [service, effective, problem, onValidation]);
  useEffect(() => {
    if (!open || disabled) return;
    void refresh();
    return () => { generation.current++; };
  }, [open, service, disabled, api]);
  useEffect(() => { if (disabled) close(); }, [disabled]);
  useLayoutEffect(() => {
    if (!open) return;
    const selected = options.findIndex(option => isSelected(option.value) && !option.disabled);
    setActive(selected >= 0 ? selected : options.findIndex(option => !option.disabled));
  }, [open, catalog, value, defaultModel, service]);
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const locate = () => {
      const rect = trigger.current!.getBoundingClientRect(), width = Math.min(360, window.innerWidth - 32);
      setPosition({ left: Math.max(16, Math.min(rect.right - width, window.innerWidth - width - 16)), bottom: window.innerHeight - rect.top + 8, width, maxHeight: Math.max(80, rect.top - 24) });
    };
    locate(); list.current?.focus();
    const observer = new ResizeObserver(locate); observer.observe(trigger.current);
    window.addEventListener('resize', locate); window.addEventListener('scroll', locate, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', locate); window.removeEventListener('scroll', locate, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: Event) => { if (e.target instanceof Node && !menu.current?.contains(e.target) && !trigger.current?.contains(e.target)) close(); };
    document.addEventListener('pointerdown', outside); document.addEventListener('focusin', outside);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); };
  }, [open]);
  useEffect(() => { if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' }); }, [active, open, listId]);
  return <>
    <button ref={trigger} type="button" className={`composer-model${problem ? ' unavailable' : ''}`} disabled={disabled}
      aria-label={`切换聊天模型：${name}`} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
      title={`${value ? '' : '默认模型：'}${name}${problem ? ` · ${problem}` : ''}`} onClick={() => open ? close() : setOpen(true)}
      onKeyDown={e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); } else if (e.key === 'Escape') close(true); }}>
      <span>{name}</span><ChevronDown size={12}/>
    </button>
    {open && !disabled && createPortal(<section ref={menu} className="composer-model-menu" role="dialog" aria-label="选择聊天模型" style={position}
      onKeyDown={e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); return; }
        if (!list.current?.contains(e.target as Node)) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault(); const direction = e.key === 'ArrowDown' ? 1 : -1;
          for (let step = 1; step <= options.length; step++) { const index = (Math.max(0, active) + direction * step + options.length) % options.length; if (!options[index].disabled) { setActive(index); break; } }
        } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(active); }
      }}>
      <header><strong>选择模型</strong><button type="button" aria-label="刷新模型列表" disabled={pending} onClick={() => void refresh()}>
        {pending ? <LoaderCircle size={14} className="spin"/> : <RefreshCw size={14}/>}</button></header>
      <div ref={list} id={listId} role="listbox" aria-label="本地模型" tabIndex={0} aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined} aria-busy={pending} className="composer-model-options">
        {options.map((option, index) => <button type="button" role="option" aria-selected={isSelected(option.value)} aria-disabled={option.disabled}
          disabled={option.disabled} tabIndex={-1} id={`${listId}-${index}`} key={option.value} title={`${option.name} · ${option.hint}`}
          className={index === active ? 'active' : ''} onMouseEnter={() => !option.disabled && setActive(index)} onClick={() => choose(index)}>
          <span><strong>{option.name}</strong><small>{option.hint}</small></span>{isSelected(option.value) && <Check size={16}/>}
        </button>)}
      </div>
      <div className="composer-model-feedback" aria-live="polite">
        {pending && <p>正在获取模型列表…</p>}
        {problem && <p role="alert">{problem}</p>}
        {error && <p role="alert">{error}<button type="button" disabled={pending} onClick={() => void refresh()}>重试</button></p>}
        {!pending && !error && models?.length === 0 && <p>暂无语言模型，请在当前模型服务中下载模型并启动服务器。</p>}
      </div>
      <footer><button type="button" onClick={() => { close(); settings(); }}><Settings2 size={14}/>模型与设置</button><span>↑ ↓ 选择 · Enter 确认</span></footer>
    </section>, document.body)}
  </>;
}
