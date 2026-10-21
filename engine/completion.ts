import type { RunEvidence } from '../shared/types';

// This only rejects unsupported claims. Text is never parsed into executable calls.
export function unsupportedCompletion(text: string, evidence: RunEvidence): string | undefined {
  const normalized = text.replace(/\\_/g, '_');
  const toolNames = 'find_vue_elements|edit_vue_element|read_file|list_directory|search_files|edit_file|replace_lines|write_file|run_command|show_changes';
  const transcript = new RegExp(`(?:工具\\s*[:：]\\s*(${toolNames})|(${toolNames})\\s+tool\\s*[:：]|<tool_call>\\s*\\{[^}]*"name"\\s*:\\s*"(${toolNames})")`, 'gi');
  const claimed = [...normalized.matchAll(transcript)].map(m => m[1] || m[2] || m[3]);
  const missing = claimed.filter(name => !evidence.successfulTools.includes(name));
  if (missing.length) return `回复描述了 ${[...new Set(missing)].join('、')} 的执行结果，但本轮没有这些工具的成功记录。`;
  const mutation = /(?:已(?:经)?(?:成功)?(?:完成)?\s*(?:修改|更新|删除|移除|创建|替换|写入|保存)|(?:文件|代码|按钮|内容)[^\n。]{0,40}(?:已(?:被)?(?:修改|更新|删除|移除|写入)|被移除)|\b(?:updated|modified|deleted|removed|created|saved)\s+(?:the\s+)?(?:files?|code|buttons?|content|[\w./-]+\.[\w]+)\b|\b(?:files?|code|buttons?|content)\s+(?:(?:has|have)\s+been|was|were|is|are)\s+(?:updated|modified|deleted|removed|created|saved)\b)/i;
  // Quoted code/data and a bare status word are not assertions of an action.
  const narrative = normalized.replace(/```[\s\S]*?```/g, '').replace(/`([^`\n]*)`/g, (_match, code: string) => /^[\w./-]+\.[\w]+$/.test(code) ? code : '');
  if (!evidence.changedFiles.length && (mutation.test(narrative) || claimed.some(name => ['write_file', 'edit_file', 'replace_lines', 'edit_vue_element'].includes(name)))) {
    return '回复声称完成了文件修改，但本轮没有产生实际文件差异。';
  }
  return undefined;
}
