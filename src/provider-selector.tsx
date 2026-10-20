import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import type { Settings } from '../shared/types';
import lmstudioLogo from './assets/providers/lmstudio.svg';
import ollamaLogo from './assets/providers/ollama.svg';
import './provider-selector.css';

type Provider = NonNullable<Settings['provider']>;
const providers: { value: Provider; name: string; logo: string }[] = [
  { value: 'lmstudio', name: 'LM Studio', logo: lmstudioLogo },
  { value: 'ollama', name: 'Ollama', logo: ollamaLogo },
];

export function ProviderSelector({ value, disabled, onChange }: { value: Provider; disabled: boolean; onChange: (value: Provider) => void }) {
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const id = useId(), selected = Math.max(0, providers.findIndex(provider => provider.value === value));
  const [open, setOpen] = useState(false), [active, setActive] = useState(selected);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0 });
  function close(focus = false) { setOpen(false); if (focus) trigger.current?.focus(); }
  function show() { if (!disabled) { setActive(selected); setOpen(true); } }
  function choose(index: number) {
    if (disabled) return;
    onChange(providers[index].value); close(true);
  }
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useLayoutEffect(() => {
    if (!open || disabled) return;
    const locate = () => {
      const rect = trigger.current!.getBoundingClientRect();
      setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - rect.width - 12)),
        top: rect.bottom + 118 > window.innerHeight ? Math.max(12, rect.top - 112) : rect.bottom + 6,
        width: Math.min(rect.width, window.innerWidth - 24) });
    };
    locate(); menu.current?.focus();
    const observer = new ResizeObserver(locate); observer.observe(trigger.current!);
    window.addEventListener('resize', locate); window.addEventListener('scroll', locate, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', locate); window.removeEventListener('scroll', locate, true); };
  }, [open, disabled]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !menu.current?.contains(event.target)) close();
    };
    document.addEventListener('pointerdown', outside); document.addEventListener('focusin', outside);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); };
  }, [open]);
  return <div className="provider-field"><span id={`${id}-label`}>模型服务</span>
    <button ref={trigger} type="button" className="provider-select-trigger" disabled={disabled} aria-labelledby={`${id}-label ${id}-value`}
      aria-haspopup="listbox" aria-expanded={open && !disabled} aria-controls={open && !disabled ? id : undefined}
      onClick={() => open ? close() : show()} onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(); }
      }}>
      <img className="provider-logo" src={providers[selected].logo} alt="" aria-hidden="true"/>
      <span id={`${id}-value`}>{providers[selected].name}</span><ChevronDown size={15}/>
    </button>
    {open && !disabled && createPortal(<div ref={menu} id={id} role="listbox" aria-labelledby={`${id}-label`} tabIndex={-1}
      aria-activedescendant={`${id}-${active}`} className="provider-menu" style={position} onKeyDown={event => {
        if (event.key === 'Tab') { close(true); return; }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); setActive(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + providers.length) % providers.length);
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault(); setActive(event.key === 'Home' ? 0 : providers.length - 1);
        } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(active); }
      }}>
      {providers.map((provider, index) => <button type="button" role="option" tabIndex={-1} key={provider.value} id={`${id}-${index}`}
        aria-selected={value === provider.value} className={active === index ? 'active' : ''} onMouseEnter={() => setActive(index)} onClick={() => choose(index)}>
        <img className="provider-logo" src={provider.logo} alt="" aria-hidden="true"/><span>{provider.name}</span>
        {value === provider.value && <Check size={16} aria-hidden="true"/>}
      </button>)}
    </div>, document.body)}
  </div>;
}
