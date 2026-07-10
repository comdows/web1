/* 1a 라인 아이콘 — 이모지 대체(stroke 2px, round cap/join, Lucide 스타일 인라인 SVG).
 * 그룹·도구 섹션·히어로 검색이 공유. 필요 최소 세트만 유지. */
import type { ReactNode } from "react";

function I({ size = 18, color = "currentColor", children }: { size?: number; color?: string; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color}
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
  );
}

export const IcSearch = ({ size = 18, color }: { size?: number; color?: string }) => (
  <I size={size} color={color}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></I>
);
export const IcCart = ({ size = 18, color }: { size?: number; color?: string }) => (
  <I size={size} color={color}><path d="M6 6h15l-1.5 8.5H8L6 3H3" /><circle cx="9" cy="20" r="1.6" /><circle cx="18" cy="20" r="1.6" /></I>
);
export const IcShip = ({ size = 18, color }: { size?: number; color?: string }) => (
  <I size={size} color={color}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.8 5.7 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3z" /></I>
);
export const IcUsers = ({ size = 18, color }: { size?: number; color?: string }) => (
  <I size={size} color={color}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20v-1a6.5 6.5 0 0 1 13 0v1M16 4.6a3.5 3.5 0 0 1 0 6.8M21.5 20v-1a6.5 6.5 0 0 0-4-5.9" /></I>
);
export const IcHome = ({ size = 18, color }: { size?: number; color?: string }) => (
  <I size={size} color={color}><path d="M3 11l9-8 9 8" /><path d="M5 9.5V21h14V9.5" /><path d="M10 21v-6h4v6" /></I>
);
export const IcCoins = ({ size = 18, color }: { size?: number; color?: string }) => (
  <I size={size} color={color}><circle cx="8" cy="8" r="5.5" /><path d="M13.3 6.3a5.5 5.5 0 1 1-7 7" /><path d="M8 5.8v4.4M6 8h4" /></I>
);
export const IcLamp = ({ size = 18, color }: { size?: number; color?: string }) => (
  <I size={size} color={color}><path d="M12 2a7 7 0 0 1 7 7c0 2.5-1.5 4-3 5.5V17H8v-2.5C6.5 13 5 11.5 5 9a7 7 0 0 1 7-7z" /><path d="M9 21h6" /></I>
);
export const IcHandshake = ({ size = 18, color }: { size?: number; color?: string }) => (
  <I size={size} color={color}><path d="M17 8a4 4 0 1 0-8 0M3 21v-1a6 6 0 0 1 6-6h0M16 16l2 2 4-4" /><circle cx="13" cy="8" r="4" /></I>
);
export const IcExchange = ({ size = 18, color }: { size?: number; color?: string }) => (
  <I size={size} color={color}><path d="M7 16V8l-4 4 4 4zM17 8v8l4-4-4-4zM10 12h4" /></I>
);
export const IcSparkle = ({ size = 18, color }: { size?: number; color?: string }) => (
  <I size={size} color={color}><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /><circle cx="12" cy="12" r="3.5" /></I>
);
export const IcBell = ({ size = 18, color }: { size?: number; color?: string }) => (
  <I size={size} color={color}><path d="M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6" /><path d="M10 20a2 2 0 0 0 4 0" /></I>
);
export const IcStar = ({ size = 18, color }: { size?: number; color?: string }) => (
  <I size={size} color={color}><path d="M12 3l2.7 5.6 6.1.8-4.5 4.2 1.1 6-5.4-3-5.4 3 1.1-6L3.2 9.4l6.1-.8L12 3z" /></I>
);
export const IcUser = ({ size = 18, color }: { size?: number; color?: string }) => (
  <I size={size} color={color}><circle cx="12" cy="8" r="4" /><path d="M4 21v-1a8 8 0 0 1 16 0v1" /></I>
);

/* 그룹 id → 라인 아이콘 (홈 분야별 헤더) */
export function GroupIcon({ id, size = 18, color }: { id: string; size?: number; color?: string }) {
  switch (id) {
    case "commerce": return <IcCart size={size} color={color} />;
    case "trade": return <IcShip size={size} color={color} />;
    case "service": return <IcUsers size={size} color={color} />;
    case "life": return <IcHome size={size} color={color} />;
    case "money": return <IcCoins size={size} color={color} />;
    case "ai": return <IcLamp size={size} color={color} />;
    default: return <IcSparkle size={size} color={color} />;
  }
}
