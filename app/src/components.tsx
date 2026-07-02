import { useState } from "react";
import type { ReactNode } from "react";
import type { Platform } from "./data";
import { categoryById } from "./data";
import { useFavs, useCompare, Recent } from "./lib/store";
import { avatarHue, faviconUrl } from "./lib/util";
import { trackEvent } from "./lib/api";
import { useNav } from "./nav";

export function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden>
      <path d="M24 7 L41 37 H7 Z" stroke="var(--brand-soft)" strokeWidth="3" fill="none" strokeLinejoin="round" />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="logo"><LogoMark /><span className="word">세모<b>플</b></span></span>
  );
}

export function Badge({ kind, children }: { kind: "new" | "good" | "soon" | "muted" | "verify"; children: ReactNode }) {
  return <span className={`badge ${kind}`}>{children}</span>;
}

function Avatar({ name, url }: { name: string; url: string }) {
  const [imgOk, setImgOk] = useState(true);
  const fav = faviconUrl(url);
  return (
    <span className="avatar" style={{ background: `hsl(${avatarHue(name)} 45% 40%)` }}>
      {fav && imgOk
        ? <img src={fav} alt="" loading="lazy" onError={() => setImgOk(false)} />
        : name.charAt(0)}
    </span>
  );
}

export function StatTile({ n, l, tone }: { n: string; l: string; tone?: "b" | "t" }) {
  return (
    <div className="stat"><div className={`n ${tone ?? ""}`}>{n}</div><div className="l">{l}</div></div>
  );
}

export function PlatformCard({ p, showCat = true }: { p: Platform; showCat?: boolean }) {
  const favs = useFavs();
  const cmp = useCompare();
  const go = useNav();
  const on = favs.has(p.id);
  const inCmp = cmp.has(p.id);
  const cat = categoryById(p.category);
  return (
    <div className="pcard">
      <div className="top">
        <Avatar name={p.name} url={p.url} />
        <div style={{ minWidth: 0 }}>
          <h4><span className="pname" onClick={() => go("detail", { id: p.id })}>{p.name}</span>{p.new && <Badge kind="new">NEW</Badge>}</h4>
          {showCat && cat && <div className="cat">{cat.icon} {cat.name}</div>}
        </div>
        <button className={`star ${on ? "on" : ""}`} aria-label="즐겨찾기"
          onClick={() => favs.toggle(p.id)}>{on ? "★" : "☆"}</button>
      </div>
      <p>{p.blurb}</p>
      <div className="pcard-actions">
        <a className="ext" href={p.url} target="_blank" rel="noopener noreferrer"
          onClick={() => { Recent.push(p.id); trackEvent("outbound", p.id); }}>공식 사이트 ↗</a>
        <button className="linklike" onClick={() => go("detail", { id: p.id })}>상세</button>
        <button className={`cmp-btn ${inCmp ? "on" : ""}`} disabled={!inCmp && cmp.full}
          onClick={() => cmp.toggle(p.id)} title={cmp.full && !inCmp ? "최대 4개" : "비교 담기"}>
          {inCmp ? "✓ 비교" : "+ 비교"}
        </button>
      </div>
    </div>
  );
}

export function Footer() {
  return (
    <footer className="site-footer"><div className="container">
      세모플 (SEMOPL) · 세상의 모든 플랫폼 · 분야별 플랫폼 디렉토리 — 각 설명은 개략 소개이며 상세는 공식 사이트에서 확인하세요.
    </div></footer>
  );
}
