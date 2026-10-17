// Tiny hand-rolled router (history-API based) — enough for the admin SPA's five
// pages without pulling in a routing library.
import { useEffect, useState, type ReactNode } from 'react';

const listeners = new Set<() => void>();

function currentPath(): string {
  return window.location.pathname || '/';
}

export function navigate(to: string): void {
  if (to === window.location.pathname) return;
  window.history.pushState({}, '', to);
  listeners.forEach((l) => l());
}

/** navigate() that replaces the history entry — for legacy-path redirects. */
export function replace(to: string): void {
  window.history.replaceState({}, '', to);
  listeners.forEach((l) => l());
}

export function useRoute(): string {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const onChange = () => setPath(currentPath());
    listeners.add(onChange);
    window.addEventListener('popstate', onChange);
    return () => {
      listeners.delete(onChange);
      window.removeEventListener('popstate', onChange);
    };
  }, []);
  return path;
}

export function Link(props: { to: string; className?: string; title?: string; children: ReactNode }) {
  return (
    <a
      href={props.to}
      className={props.className}
      title={props.title}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        navigate(props.to);
      }}
    >
      {props.children}
    </a>
  );
}
