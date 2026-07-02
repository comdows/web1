/* 이름 해시 → HSL hue (오프라인 안전 아바타 배경) */
export function avatarHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

export function hostOf(url: string): string {
  try { return new URL(url).host.replace(/^www\./, ""); } catch { return ""; }
}

export function faviconUrl(url: string): string | null {
  const host = hostOf(url);
  return host ? `https://www.google.com/s2/favicons?domain=${host}&sz=64` : null;
}

export function debounce<T extends (...a: never[]) => void>(fn: T, ms: number) {
  let t: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
