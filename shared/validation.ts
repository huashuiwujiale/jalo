import { z } from 'zod';
export const settingsSchema = z.object({
  baseUrl: z.string().url().refine(value => {
    const u = new URL(value);
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash && (u.pathname === '/' || u.pathname === '');
  }, '服务地址应为 http(s)://主机:端口，不包含 /v1 或账号密码'),
  token: z.string().max(4096), model: z.string().max(300),
  temperature: z.number().min(0).max(2), contextLength: z.number().int().min(4096).max(262144),
  maxTokens: z.number().int().min(128).max(16384), maxSteps: z.number().int().min(1).max(100),
  commandTimeout: z.number().int().min(1).max(600),
}).strict().refine(s => s.maxTokens < s.contextLength / 2, '最大输出须小于上下文长度的一半');
export const referenceSchema = z.object({ projectId: z.string().uuid(), path: z.string().min(1).max(1024), startLine: z.number().int().min(1), endLine: z.number().int().min(1), version: z.string().regex(/^[a-f0-9]{64}$/) }).strict().refine(r => r.endLine >= r.startLine && r.endLine - r.startLine < 400, '引用范围无效或超过 400 行');
export const submitSchema = z.object({ projectId: z.string().uuid(), prompt: z.string().trim().min(1).max(16000), taskId: z.string().uuid().optional(), mode: z.enum(['execute', 'plan', 'review']).default('execute'), references: z.array(referenceSchema).max(8).default([]), planRunId: z.string().uuid().optional(), reviewRunId: z.string().uuid().optional() }).strict();
