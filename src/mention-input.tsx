import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Api, FileReference, Project } from '../shared/types';
import { FileIcon } from './file-tree';
import { insertMention, mentionAt, type Mention } from './mentions';

export function MentionInput({api,project,value,onChange,onChoose,onPending,disabled,canAdd,placeholder,submit}: {
  api:Api; project?:Project; value:string; onChange:(value:string)=>void; onChoose:(ref:FileReference)=>void;
  onPending:(pending:boolean)=>void; disabled:boolean; canAdd:boolean; placeholder:string; submit:()=>void;
}) {
  const input=useRef<HTMLTextAreaElement>(null), generation=useRef(0), liveValue=useRef(value), suppressed=useRef(false), composing=useRef(false);
  liveValue.current=value;
  const listId=useId();
  const [mention,setMention]=useState<Mention>(), [active,setActive]=useState(0), [pending,setPending]=useState(false), [error,setError]=useState('');
  const [search,setSearch]=useState<{key:string;paths:string[];truncated:boolean;error?:string}>();
  const [position,setPosition]=useState({left:0,bottom:0,width:0,maxHeight:300});
  const key=JSON.stringify([project?.id,mention?.start,mention?.query]);
  const open=!!mention && !!project && !disabled;
  const paths=search?.key===key ? search.paths : [];
  useLayoutEffect(()=>{
    if(!open || !input.current)return;
    const positionMenu=()=>{const rect=input.current?.getBoundingClientRect();if(rect)setPosition({left:rect.left,bottom:window.innerHeight-rect.top+8,width:rect.width,maxHeight:Math.max(80,rect.top-16)});};
    positionMenu();const observer=new ResizeObserver(positionMenu);observer.observe(input.current);
    window.addEventListener('resize',positionMenu);window.addEventListener('scroll',positionMenu,true);
    return ()=>{observer.disconnect();window.removeEventListener('resize',positionMenu);window.removeEventListener('scroll',positionMenu,true);};
  },[open]);
  useEffect(()=>{setPending(false);return ()=>{generation.current++;onPending(false);};},[project?.id,disabled,onPending]);
  useEffect(()=>{
    setActive(0);setError('');
    if(!open || !canAdd || mention!.query.length>200)return;
    let valid=true;
    const timer=setTimeout(()=>api.searchFiles({projectId:project!.id,query:mention!.query}).then(result=>{
      if(valid)setSearch({key,...result});
    }).catch(e=>{if(valid)setSearch({key,paths:[],truncated:false,error:e.message});}),140);
    return ()=>{valid=false;clearTimeout(timer);};
  },[key,open,canAdd]);
  useEffect(()=>{if(open)document.getElementById(`${listId}-${active}`)?.scrollIntoView({block:'nearest'});},[active,key,open]);
  function locate(element:HTMLTextAreaElement) {
    if(!suppressed.current && !composing.current)setMention(mentionAt(element.value,element.selectionStart,element.selectionEnd));
  }
  async function choose(path:string) {
    if(!mention || !project || pending || !canAdd)return;
    const before=value, selected=mention, id=generation.current;
    setPending(true);onPending(true);setError('');
    try {
      const ref=await api.referenceFile({projectId:project.id,path});
      if(id!==generation.current || liveValue.current!==before)return;
      onChoose(ref);
      const next=insertMention(before,selected,path);onChange(next.text);setMention(undefined);suppressed.current=true;
      requestAnimationFrame(()=>{input.current?.focus();input.current?.setSelectionRange(next.caret,next.caret);});
    }catch(e){if(id===generation.current)setError(e instanceof Error?e.message:String(e));}
    finally{if(id===generation.current){setPending(false);onPending(false);}}
  }
  return <div className="mention-input">
    {open && createPortal(<div className="mention-menu" style={position} onMouseDown={e=>e.preventDefault()}>
      <div className="mention-heading" title={project.path}>引用文件 · {project.name}<span>选择后引用整份文件</span></div>
      {!canAdd ? <p>最多引用 8 个文件，请先移除已有引用。</p> : mention.query.length>200 ? <p>搜索内容最多 200 个字符。</p> : <>
        <div id={listId} role="listbox" aria-label="文件候选">{paths.map((path,i)=>{const parts=path.split('/'),name=parts.pop();return <button type="button" role="option" aria-selected={i===active} id={`${listId}-${i}`} key={path} className={i===active?'active':''} disabled={pending} title={`${project.path}/${path}`} onMouseEnter={()=>setActive(i)} onClick={()=>void choose(path)}><FileIcon name={name || path}/><strong>{name}</strong><span>{parts.join('/') || '项目根目录'}</span></button>;})}</div>
        {search?.key!==key ? <p>搜索中…</p> : search.error ? <p role="alert">{search.error}</p> : !paths.length ? <p>没有找到文件，试试文件名或相对路径。</p> : null}
        {search?.key===key && search.truncated && <p>结果未全部显示，请继续输入路径缩小范围。</p>}
      </>}
      {error && <p role="alert">{error}</p>}
      <footer>{pending?'正在校验文件…':'↑ ↓ 选择 · Enter 引用 · Esc 关闭'}</footer>
    </div>,document.body)}
    <textarea ref={input} aria-label="任务要求" aria-autocomplete="list" aria-controls={open?listId:undefined} aria-expanded={open} aria-activedescendant={open&&paths[active]?`${listId}-${active}`:undefined} maxLength={100000} placeholder={placeholder} value={value} disabled={disabled} readOnly={pending}
      onChange={e=>{suppressed.current=false;onChange(e.target.value);locate(e.target);}}
      onSelect={e=>locate(e.currentTarget)} onBlur={()=>{if(!pending){setMention(undefined);suppressed.current=true;}}}
      onCompositionStart={()=>{composing.current=true;setMention(undefined);}} onCompositionEnd={e=>{composing.current=false;suppressed.current=false;locate(e.currentTarget);}}
      onKeyDown={e=>{
        if(e.nativeEvent.isComposing || e.keyCode===229)return;
        if(pending){e.preventDefault();return;}
        if(open && !e.ctrlKey && !e.metaKey){
          if(e.key==='Escape'){e.preventDefault();suppressed.current=true;setMention(undefined);return;}
          if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();if(paths.length)setActive(n=>(n+(e.key==='ArrowDown'?1:-1)+paths.length)%paths.length);return;}
          if(e.key==='Enter' || e.key==='Tab'){e.preventDefault();if(paths[active])void choose(paths[active]);return;}
        }
        if(e.key==='Enter' && (e.metaKey||e.ctrlKey)){e.preventDefault();if(!pending)submit();}
      }}/>
  </div>;
}
