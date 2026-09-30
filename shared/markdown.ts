// Markdown links are display data. Only explicit web URLs can leave the app;
// application protocols, local files and credentials are never handed to the OS.
export function webLink(value: string): string | undefined {
  if (!/^https?:\/\//i.test(value) || /[\u0000-\u0020\u007f]/.test(value)) return;
  try {
    const url = new URL(value);
    if (!url.hostname || url.username || url.password) return;
    return url.href;
  } catch { return; }
}
