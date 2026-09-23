import React, { useEffect, useState } from 'react';
import { Download, FolderOpen, RefreshCw } from 'lucide-react';
import type { Api, AppInfo } from '../shared/types';

export function AppMaintenance({ api }: { api: Api }) {
  const [info, setInfo] = useState<AppInfo>();
  const [working, setWorking] = useState(false), [error, setError] = useState(''), [feedback, setFeedback] = useState('');
  const fail = (error: unknown) => setError((error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, ''));
  const refresh = () => api.appInfo().then(setInfo).catch(fail);
  useEffect(() => { let mounted = true; api.appInfo().then(value => { if (mounted) setInfo(value); }).catch(error => { if (mounted) fail(error); }); return () => { mounted = false; }; }, [api]);
  async function perform(action: () => Promise<void>) {
    setWorking(true); setError(''); setFeedback('');
    try { await action(); await refresh(); } catch (error) { fail(error); } finally { setWorking(false); }
  }
  return <section className="app-maintenance" aria-label="应用与诊断">
    <div className="settings-section-heading"><span>应用与诊断</span><small>{info ? `Jalo ${info.version} · ${info.packaged ? '安装版' : '开发版'}` : '读取版本信息…'}</small></div>
    {info && <><dl className="app-info"><dt>运行环境</dt><dd>{info.platform} · {info.arch} · Darwin {info.osRelease}</dd><dt>应用组件</dt><dd>Electron {info.electron} · Chromium {info.chrome} · Node {info.node}</dd><dt>数据目录</dt><dd>{info.dataDirectory}</dd><dt>日志目录</dt><dd>{info.logDirectory}</dd></dl>
      {!info.logsAvailable && <p role="alert" className="maintenance-error">诊断日志暂时无法写入，请检查数据目录权限和剩余空间。仍可导出当前运行信息。</p>}</>}
    <div className="maintenance-actions"><button className="outline" disabled={working || !info} onClick={() => perform(async () => { await api.openDataDirectory(); setFeedback('已在 Finder 中打开数据目录'); })}><FolderOpen size={14}/>打开数据目录</button><button className="outline" disabled={working || !info} onClick={() => perform(async () => { const file = await api.exportDiagnostics(); if (file) setFeedback(`诊断日志已保存：${file}`); })}><Download size={14}/>{working ? '处理中…' : '导出诊断日志'}</button>{!info && <button className="outline" disabled={working} onClick={() => perform(async () => { await refresh(); })}><RefreshCw size={14}/>重新读取</button>}</div>
    <p className="settings-hint">日志仅含运行环境、执行阶段与错误类别，不含聊天、源码、命令或令牌。导出到本机，不会自动上传。安装版更新需退出后替换应用，历史数据保留。</p>
    {error && <p role="alert" className="maintenance-error">{error}</p>}{feedback && <p role="status" className="maintenance-feedback">{feedback}</p>}
  </section>;
}
