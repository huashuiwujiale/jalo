import fs from 'node:fs';
import path from 'node:path';
import { emptySession, rememberView, selectionSchema, viewKey, viewSchema, type SessionState, type SessionView } from '../shared/session';

/** UI-only data is separate from the task database so typing never rewrites task history. */
export class SessionStore {
  private state = emptySession();
  private timer?: ReturnType<typeof setTimeout>;
  private pending: { resolve: () => void; reject: (error: Error) => void }[] = [];
  warning?: string;
  constructor(private file: string) {
    if (!fs.existsSync(file)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file,'utf8'));
      if(raw.version !== 1) throw new Error('unknown version');
      this.state.selected = selectionSchema.parse(raw.selected);
      for(const value of Object.values(raw.views || {})) {
        const parsed = viewSchema.safeParse(value);
        if(parsed.success) this.state.views[viewKey(parsed.data.projectId,parsed.data.taskId)] = parsed.data;
        else this.warning = '部分草稿记录损坏，已跳过；原文件已备份。';
      }
      for(const [projectId,taskId] of Object.entries(raw.projectTasks || {})) {
        const parsed=selectionSchema.safeParse({projectId,taskId});
        if(parsed.success && projectId) this.state.projectTasks[projectId]=parsed.data.taskId;
      }
    } catch { this.state=emptySession();this.warning='会话记录无法读取，已保留原文件副本；任务历史不受影响。'; }
    if(this.warning) fs.copyFileSync(file,`${file}.unreadable-${Date.now()}.bak`,fs.constants.COPYFILE_EXCL);
  }
  read(): { state: SessionState; warning?: string } { return { state:structuredClone(this.state), warning:this.warning }; }
  update(view: SessionView) { rememberView(this.state,viewSchema.parse(view)); }
  save(view: SessionView): Promise<void> {
    this.update(view);
    const promise = new Promise<void>((resolve,reject)=>this.pending.push({resolve,reject}));
    if(!this.timer)this.timer=setTimeout(()=>{try{this.flush();}catch{/* IPC callers receive the write error. */}},200);
    return promise;
  }
  flush() {
    clearTimeout(this.timer);this.timer=undefined;
    const pending=this.pending.splice(0),temp=this.file+'.tmp';
    try {
      fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});
      const fd=fs.openSync(temp,'w',0o600);
      try{fs.fchmodSync(fd,0o600);fs.writeFileSync(fd,JSON.stringify(this.state));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      fs.renameSync(temp,this.file);pending.forEach(p=>p.resolve());
    }catch{const error=new Error('草稿保存失败，请检查数据目录权限和磁盘空间；当前输入仍保留在窗口中');pending.forEach(p=>p.reject(error));throw error;}
  }
}
