import { useEffect, useState } from 'react';
/** Include the resource version in the key; old task/file responses stay invisible. */
export function useRemoteResource<T>(key: string, load: () => Promise<T>) {
  const [attempt, retry] = useState(0), [state, setState] = useState<{ key: string; value?: T; error?: string }>({ key: '' });
  useEffect(() => {
    let current = true;
    if (!key) return;
    setState({ key });
    void load().then(value => { if (current) setState({ key, value }); }, error => { if (current) setState({ key, error: error instanceof Error ? error.message : String(error) }); });
    return () => { current = false; };
  }, [key, attempt]);
  return { value: state.key === key ? state.value : undefined, error: state.key === key ? state.error : undefined, retry: () => retry(n => n + 1) };
}
