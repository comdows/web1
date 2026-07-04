import { useState } from "react";
import type { ReactNode } from "react";
import type { Platform } from "./data";
import { categoryById } from "./data";
import { useFavs, useCompare, Recent } from "./lib/store";
import { usePlatformStats } from "./lib/platforms";
import { avatarHue, faviconUrl } from "./lib/util";
import { trackEvent } from "./lib/api";
import { FLAGS } from "./config";
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

export function Avatar({ name, url, size }: { name: string; url: string; size?: "lg" }) {
  const [imgOk, setImgOk] = useState(true);
  const fav = faviconUrl(url);
  return (
    <span className={`avatar${size === "lg" ? " lg" : ""}`} style={{ background: `hsl(${avatarHue(name)} 45% 40%)` }}>
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
          <h4><button className="pname" onClick={() => go("detail", { id: p.id })}>{p.name}</button>{p.new && <Badge kind="new">NEW</Badge>}</h4>
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
  const go = useNav();
  const { total } = usePlatformStats();
  return (
    <footer className="site-footer"><div className="container">
      <div className="foot-grid">
        <div>
          <span className="logo" style={{ marginBottom: 8 }}><LogoMark size={20} /><span className="word" style={{ fontSize: 16 }}>세모<b>플</b></span></span>
          <p className="foot-desc">세상의 모든 플랫폼 — 사업자를 위한 플랫폼·AI 도구 안내소. 발견하고, 제휴하고, 거래하세요.
            각 설명은 개략 소개이며 상세는 공식 사이트에서 확인하세요.</p>
        </div>
        <div>
          <div className="foot-h">바로가기</div>
          <button className="foot-link" onClick={() => go("home")}>분야별 디렉토리</button>
          <button className="foot-link" onClick={() => go("ai-finder")}>AI 도구 찾기</button>
          <button className="foot-link" onClick={() => go("packs")}>업종별 시작 조합</button>
          <button className="foot-link" onClick={() => go("weekly")}>새로 나온 플랫폼·AI</button>
          <button className="foot-link" onClick={() => go("partners")}>제휴 매칭</button>
          <button className="foot-link" onClick={() => go("exchange")}>플랫폼 거래소</button>
          <button className="foot-link" onClick={() => go("value-check")}>가치 자가 진단</button>
          <button className="foot-link" onClick={() => go("deal-guide")}>양수도 가이드</button>
          <button className="foot-link" onClick={() => go("submit")}>플랫폼 제보</button>
        </div>
        <div>
          <div className="foot-h">안내</div>
          <p className="foot-desc">세모플은 제휴·거래의 <b>당사자가 아니며</b>, 정보 게시와 쌍방 동의에 따른 소개만 제공합니다.
            계약·정산·실사는 당사자와 전문 자문사가 직접 진행합니다.</p>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <button className="foot-link" onClick={() => go("terms")}>이용약관</button>
            <button className="foot-link" onClick={() => go("privacy")}>개인정보처리방침</button>
            {FLAGS.contactEmail && <a className="foot-link" href={`mailto:${FLAGS.contactEmail}`}>문의</a>}
          </div>
        </div>
      </div>
      {/* 운영 주체 표기 — 사업자등록 정보 확정 시 이 블록에 추가(상호·등록번호·소재지) */}
      <div className="foot-cap" style={{ fontSize: 11.5, opacity: 0.7 }}>
        운영: 세모플 운영자{FLAGS.contactEmail ? ` · 문의 ${FLAGS.contactEmail}` : ""} · 개인정보 보호책임자: 운영자 겸임
      </div>
      <div className="foot-cap mono">© 2026 SEMOPL · {total.toLocaleString()} PLATFORMS · GRID 8PX</div>
    </div></footer>
  );
}

/* 공유 버튼 — 모바일은 시스템 공유 시트, 데스크톱은 링크 복사(폴백) */
export function ShareButton({ title, url, small = true }: { title: string; url?: string; small?: boolean }) {
  const [copied, setCopied] = useState(false);
  const target = () => url ?? location.href;
  const share = async () => {
    const u = target();
    try {
      if (navigator.share) { await navigator.share({ title, url: u }); return; }
      throw new Error("no-share");
    } catch {
      try { await navigator.clipboard.writeText(u); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* noop */ }
    }
  };
  return (
    <button className={`btn ghost ${small ? "sm" : ""}`} onClick={share}>
      {copied ? "✓ 링크 복사됨" : "🔗 공유"}
    </button>
  );
}
