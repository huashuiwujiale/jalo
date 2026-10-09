import { mkdirSync, lstatSync, openSync, writeSync, closeSync, fsyncSync, constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

function directoryCheck(directory: string) {
  // Only the app-owned commands/task/run subtree; OS ancestors may use symlinks.
  for (const part of [path.dirname(path.dirname(directory)), path.dirname(directory), directory]) {
    if (!lstatSync(part).isDirectory()) throw new Error('命令日志目录无效');
  }
}
function commandId(id: string) {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('命令日志标识无效');
}

export class CommandOutputWriter {
  private fd: number;
  bytes = 0; totalBytes = 0; tail = ''; truncated = false;
  constructor(directory: string, id: string, private limit = 16 * 1024 * 1024) {
    commandId(id);
    for (const part of [path.dirname(path.dirname(directory)), path.dirname(directory), directory]) {
      try { mkdirSync(part, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      if (!lstatSync(part).isDirectory()) throw new Error('命令日志目录无效');
    }
    this.fd = openSync(path.join(directory, id + '.log'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  }
  append(text: string) {
    const buffer = Buffer.from(text); this.totalBytes += buffer.length; this.tail = (this.tail + text).slice(-16000);
    const remaining = Math.max(0, this.limit - this.bytes);
    const decoder = new StringDecoder('utf8'), content = buffer.length > remaining ? Buffer.from(decoder.write(buffer.subarray(0, remaining))) : buffer;
    let offset = 0;
    while (offset < content.length) offset += writeSync(this.fd, content, offset, content.length - offset);
    this.bytes += content.length; this.truncated ||= buffer.length > remaining;
  }
  close() { const fd = this.fd; this.fd = -1; if (fd >= 0) { try { fsyncSync(fd); } finally { closeSync(fd); } } }
}
export async function commandOutput(directory: string, id: string, offset = 0) {
  commandId(id); directoryCheck(directory);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('命令输出游标无效');
  const handle = await fs.open(path.join(directory, id + '.log'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat(); if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) throw new Error('命令日志不是有效的普通文件');
    if (offset > stat.size) throw new Error('命令输出游标已失效');
    const buffer = Buffer.alloc(Math.min(65536, stat.size - offset));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    const decoder = new StringDecoder('utf8'); let text = decoder.write(buffer.subarray(0, bytesRead));
    const end = offset + bytesRead === stat.size;
    if (end) text += decoder.end();
    const consumed = end ? bytesRead : Buffer.byteLength(text);
    return { text, next: offset + consumed, totalBytes: stat.size, hasMore: offset + consumed < stat.size };
  } finally { await handle.close(); }
}
