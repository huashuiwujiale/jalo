import type { FileReference, Project } from '../shared/types';
import { mentionSegments, referenceName } from './mentions';

/** File-name tokens serialize as their full project-relative path. Pasted HTML is never rendered. */
export function editorText(root: Node): string {
  if (root.nodeType === 3) return root.textContent || '';
  const element=root.nodeType === 1 ? root as HTMLElement : undefined;
  if (element) {
    if (element.dataset?.referencePath !== undefined) return element.dataset.referencePath;
    if (element.dataset?.editorTail !== undefined) return '';
    if (element.tagName === 'BR') return '\n';
  }
  let text = '';
  let index=0;
  for (const child of root.childNodes) {
    const childElement=child.nodeType === 1 ? child as HTMLElement : undefined;
    const block=childElement && ['DIV','P'].includes(childElement.tagName);
    if (block && index > 0) text += '\n';
    // Chromium adds a final BR to make an empty line editable; it is not an extra newline.
    if (childElement?.tagName === 'BR' && child === root.lastChild && element) continue;
    text += editorText(child);
    index++;
  }
  return text;
}

export interface EditorSelection { start: number; end: number }
export function editorSelection(root: HTMLElement): EditorSelection | undefined {
  const selected = window.getSelection();
  if (!selected?.rangeCount) return;
  const range = selected.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
  const before = range.cloneRange(); before.selectNodeContents(root); before.setEnd(range.startContainer,range.startOffset);
  const through = range.cloneRange(); through.selectNodeContents(root); through.setEnd(range.endContainer,range.endOffset);
  return {start:editorText(before.cloneContents()).length,end:editorText(through.cloneContents()).length};
}

export function selectEditor(root: HTMLElement, selection: EditorSelection) {
  const point = (offset: number): [Node,number] => {
    for (let index=0;index<root.childNodes.length;index++) {
      const node=root.childNodes[index], length=editorText(node).length;
      if (offset <= length) {
        if (node.nodeType === Node.TEXT_NODE) return [node,offset];
        return [root,index+(offset > 0 ? 1 : 0)];
      }
      offset-=length;
    }
    return [root,root.childNodes.length];
  };
  const range=document.createRange(); range.setStart(...point(selection.start)); range.setEnd(...point(selection.end));
  const selected=window.getSelection(); selected?.removeAllRanges(); selected?.addRange(range);
}

export function renderEditor(root: HTMLElement, value: string, references: FileReference[], project?: Project) {
  const parts=mentionSegments(value,references);
  const expected=parts.filter(part=>part.reference).map(part=>`${part.reference!.projectId}:${part.text}`);
  const present=Array.from(root.querySelectorAll<HTMLElement>('[data-reference-path]')).map(node=>`${node.dataset.referenceProject}:${node.dataset.referencePath}`);
  // Ordinary typing keeps the browser's DOM and undo history. Rebuild only for external updates or changed tokens.
  if (editorText(root) === value && JSON.stringify(expected) === JSON.stringify(present) && !root.querySelector('div,p')) return;
  const selected=editorSelection(root), focused=document.activeElement===root;
  const children: Node[]=[];
  for (const part of parts) {
    if (!part.reference) { children.push(document.createTextNode(part.text)); continue; }
    const token=document.createElement('span'); token.contentEditable='false'; token.spellcheck=false;
    token.className=`inline-file-reference${part.reference.projectId !== project?.id ? ' invalid' : ''}`;
    token.dataset.referencePath=part.text; token.dataset.referenceProject=part.reference.projectId;
    token.title=part.reference.projectId === project?.id ? `${project.path}/${part.text}` : `${part.text}（项目已切换，引用失效）`;
    const icon=document.createElementNS('http://www.w3.org/2000/svg','svg');
    for (const [key,val] of Object.entries({width:'14',height:'14',viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.7','aria-hidden':'true'})) icon.setAttribute(key,val);
    const outline=document.createElementNS('http://www.w3.org/2000/svg','path'); outline.setAttribute('d','M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z M14 2v6h6'); icon.append(outline);
    const label=document.createElement('span'); label.className='reference-name'; label.textContent=referenceName(part.text);
    token.append(icon,label); children.push(token);
  }
  if (value.endsWith('\n')) { const tail=document.createElement('br'); tail.dataset.editorTail=''; children.push(tail); }
  root.replaceChildren(...children);
  if (focused && selected) selectEditor(root,{start:Math.min(selected.start,value.length),end:Math.min(selected.end,value.length)});
}

/** Native text insertion preserves normal undo/redo and strips rich clipboard markup. */
export function insertEditorText(root: HTMLElement, text: string) {
  root.focus();
  document.execCommand('insertText',false,text);
}
