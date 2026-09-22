import React from 'react';
import { ChevronDown, Terminal } from 'lucide-react';
import type { ToolGroup } from './tool-events';
const labels: Record<string, string> = { read_file: '读取文件', list_directory: '浏览目录', search_files: '搜索文件', write_file: '写入文件', edit_file: '修改文件', replace_lines: '替换代码行', find_vue_elements: '定位 Vue 元素', edit_vue_element: '修改 Vue 元素', run_command: '执行命令', show_changes: '查看差异' };
export function ToolCard({ group, active, waiting }: { group: ToolGroup; active: boolean; waiting: boolean }) {
  const argsText = group.call.text.slice(group.name.length).trim();
  let target = '', parameters = argsText;
  try { const args = JSON.parse(argsText); target = args.path || args.command || args.query || ''; parameters = JSON.stringify(args, null, 2); } catch {}
  const result = group.result?.text.replace(/^\w+ 结果\n?/, '');
  const failed = group.errors.length > 0 || result?.startsWith('工具未成功：');
  const denied = result?.includes('用户拒绝了该命令');
  const deferred = result?.includes('尚未执行操作。');
  const status = failed ? '未成功' : denied ? '已拒绝' : deferred ? '未执行' : group.result ? '已返回' : active ? waiting && group.name === 'run_command' ? '等待确认' : '执行中' : '未收到结果';
  const errorText = group.errors.map(e => e.text).filter(text => !result?.includes(text));
  return <details className={`tool-event tool-card ${failed ? 'error' : ''}`}>
    <summary><Terminal size={14}/><strong>{labels[group.name] || group.name}</strong><span className="tool-target" title={target}>{target}</span><small>{status}</small><ChevronDown size={12}/></summary>
    {failed && <p className="tool-card-error">{(group.errors[0]?.text || result || '').split('\n')[0].slice(0, 200)}</p>}
    <div className="tool-card-body"><h4>调用参数 · {group.name}</h4><pre>{parameters || '无参数'}</pre>
      {errorText.length > 0 && <><h4>错误详情</h4><pre>{errorText.join('\n\n')}</pre></>}
      {result !== undefined && <><h4>执行结果</h4><pre>{result || '（空结果）'}</pre></>}
      {!group.result && <p>{active ? '等待工具返回结果…' : '此次调用没有完整结果记录，不能据此确认执行成功。'}</p>}
    </div>
  </details>;
}
