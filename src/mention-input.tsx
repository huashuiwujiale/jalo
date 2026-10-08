import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Api, FileReference, Project } from '../shared/types';
import { FileIcon } from './file-tree';
import { insertMention, mentionAt, type Mention } from './mentions';
import { editorText, editorSelection, selectEditor, renderEditor, insertEditorText } from './mention-editor';

export function MentionInput({api,project,value,references,onChange,onChoose,onPending,disabled,canAdd,placeholder,submit}: {
  api:Api; project?:Project; value:string; references:FileReference[]; onChange:(value:string)=>void; onChoose:(ref:FileReference)=>void;
  onPending:(pending:boolean)=>void; disabled:boolean; canAdd:boolean; placeholder:string; submit:()=>void;
}) {
  const input=useRef<HTMLDivElement>(null), generation=useRef(0), liveValue=useRef(value), suppressed=useRef(false), composing=useRef(false);
  liveValue.current=value;
  const listId=useId();
  const [mention,setMention]=useState<Mention>(), [active,setActive]=useState(0), [pending,setPending]=useState(false), [error,setError]=useState('');
  const [search,setSearch]=useState<{key:string;paths:string[];truncated:boolean;error?:string}>();
  const [position,setPosition]=useState({left:0,bottom:0,width:0,maxHeight:300});
  const key=JSON.stringify([project?.id,mention?.start,mention?.query]);
  const open=!!mention && !!project && !disabled;
  const paths=search?.key===key ? search.paths : [];
  useLayoutEffect(()=>{if(input.current && !composing.current)renderEditor(input.current,value,references,project);});
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
  function locate(element:HTMLDivElement) {
    if(suppressed.current || composing.current)return;
    const selection=editorSelection(element);
    setMention(selection ? mentionAt(editorText(element),selection.start,selection.end) : undefined);
  }
  function changed(element:HTMLDivElement) {
    if(disabled || pending)return;
    const text=editorText(element).slice(0,100000);
    if(!composing.current)suppressed.current=false;
    onChange(text); locate(element);
  }
  function pasteText(text:string) {
    const element=input.current;
    if(!element || disabled || pending)return;
    const selection=editorSelection(element), available=100000-editorText(element).length+(selection ? selection.end-selection.start : 0);
    insertEditorText(element,text.replace(/\r\n?/g,'\n').slice(0,Math.max(0,available)));
  }
  function copySelection(e:React.ClipboardEvent<HTMLDivElement>,cut=false) {
    const selection=window.getSelection();
    if(!selection?.rangeCount || selection.isCollapsed || !editorSelection(e.currentTarget))return;
    e.preventDefault();e.clipboardData.setData('text/plain',editorText(selection.getRangeAt(0).cloneContents()));
    if(cut && !disabled && !pending)document.execCommand('delete');
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
      requestAnimationFrame(()=>{if(input.current){input.current.focus();selectEditor(input.current,{start:next.caret,end:next.caret});}});
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
    <div ref={input} className="mention-editor" role="textbox" aria-label="任务要求" aria-placeholder={placeholder} aria-multiline="true" aria-disabled={disabled} aria-readonly={pending || disabled}
      contentEditable={!disabled && !pending} suppressContentEditableWarning tabIndex={disabled ? -1 : 0} data-placeholder={placeholder} data-empty={!value}
      aria-autocomplete="list" aria-controls={open?listId:undefined} aria-expanded={open} aria-activedescendant={open&&paths[active]?`${listId}-${active}`:undefined}
      onInput={e=>changed(e.currentTarget)} onKeyUp={e=>locate(e.currentTarget)} onMouseUp={e=>locate(e.currentTarget)}
      onBlur={()=>{if(!pending){setMention(undefined);suppressed.current=true;}}}
      onPaste={e=>{e.preventDefault();pasteText(e.clipboardData.getData('text/plain'));}} onCopy={e=>copySelection(e)} onCut={e=>copySelection(e,true)} onDrop={e=>e.preventDefault()}
      onCompositionStart={()=>{composing.current=true;setMention(undefined);}} onCompositionEnd={e=>{composing.current=false;suppressed.current=false;changed(e.currentTarget);renderEditor(e.currentTarget,editorText(e.currentTarget),references,project);}}
      onKeyDown={e=>{
        if(e.nativeEvent.isComposing || e.keyCode===229)return;
        if(pending){e.preventDefault();return;}
        if(open && !e.ctrlKey && !e.metaKey){
          if(e.key==='Escape'){e.preventDefault();suppressed.current=true;setMention(undefined);return;}
          if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();if(paths.length)setActive(n=>(n+(e.key==='ArrowDown'?1:-1)+paths.length)%paths.length);return;}
          if(e.key==='Enter' || e.key==='Tab'){e.preventDefault();if(paths[active])void choose(paths[active]);return;}
        }
        if(e.key==='Enter' && (e.metaKey||e.ctrlKey)){e.preventDefault();if(!pending)submit();}
        else if(e.key==='Enter'){e.preventDefault();pasteText('\n');}
      }}/>
  </div>;
}
