import { z } from 'zod';
import { referenceSchema } from './validation';
import type { Snapshot } from './types';
const id = z.union([z.string().uuid(), z.literal('')]);
export const selectionSchema = z.object({ projectId: id, taskId: id }).strict();
export const scrollSchema = z.object({ top: z.number().finite().min(0).max(1e9), follow: z.boolean(), anchor: z.string().max(200).optional(), offset: z.number().finite().min(-1e7).max(1e7).optional(), expanded: z.array(z.string().max(200)).max(600) }).strict();
export const viewSchema = selectionSchema.extend({ prompt: z.string().max(100000), mode: z.enum(['execute','plan','review']), references: z.array(referenceSchema).max(8), runId: id, tab: z.enum(['changes','terminal']), scroll: scrollSchema }).strict();
export type SessionView = z.infer<typeof viewSchema>;
export interface SessionState { version: 1; selected: z.infer<typeof selectionSchema>; projectTasks: Record<string,string>; views: Record<string,SessionView> }
export const emptySession = (): SessionState => ({ version:1, selected:{projectId:'',taskId:''}, projectTasks:{}, views:{} });
export const viewKey = (projectId: string, taskId: string) => `${projectId}:${taskId || 'new'}`;
export function emptyView(projectId: string, taskId = ''): SessionView { return { projectId, taskId, prompt:'', mode:'execute', references:[], runId:'', tab:'changes', scroll:{top:0,follow:true,expanded:[]} }; }
export function rememberView(state: SessionState, view: SessionView) {
  state.views[viewKey(view.projectId,view.taskId)] = structuredClone(view);
  state.selected = { projectId:view.projectId, taskId:view.taskId };
  if(view.projectId) state.projectTasks[view.projectId] = view.taskId;
}
export function restoreView(state: SessionState, snapshot: Pick<Snapshot,'projects'|'tasks'>, selection = state.selected): SessionView {
  const projectId = snapshot.projects.some(p=>p.id===selection.projectId) ? selection.projectId : snapshot.projects[0]?.id || '';
  const preferred = projectId === selection.projectId ? selection.taskId : state.projectTasks[projectId] || '';
  const task = snapshot.tasks.find(t=>t.id===preferred && t.projectId===projectId);
  const view = structuredClone(state.views[viewKey(projectId,task?.id || '')] || emptyView(projectId,task?.id));
  if(view.runId && !task?.runs?.some(r=>r.id===view.runId)) view.runId = '';
  return view;
}
