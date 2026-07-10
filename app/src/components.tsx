import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, KeyboardEvent as RKeyboardEvent } from "react";
import type { Platform } from "./data";
import { categoryById } from "./data";
import { useFavs, useCompare, Recent } from "./lib/store";
import { usePlatforms, usePlatformStats } from "./lib/platforms";
import { avatarHue, faviconUrl } from "./lib/util";
import { trackEvent, trackImpression } from "./lib/api";
import { suggest } from "./lib/suggest";
import type { Suggestion } from "./lib/suggest";
import { FLAGS } from "./config";
import { useNav } from "./nav";

/* 1a 로고 마크 — 라운드 사각(#2563eb) + "세" */
export function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <span className="logo-sq" aria-hidden style={size !== 26 ? { width: size, height: size, fontSize: Math.round(size * 0.54), borderRadius: Math.round(size * 0.27) } : undefined}>세</span>
  );
}

export function Logo() {
  return (
    <span className="logo"><LogoMark /><span className="word">세모플</span></span>
  );
}

export function Badge({ kind, children }: { kind: "new" | "good" | "soon" | "muted" | "verify" | "ad"; children: ReactNode }) {
  return <span className={`badge ${kind}`}>{children}</span>;
}

/* 1a 아바타 — 연한 브랜드색 배경 + 진한 이니셜(파비콘 로드되면 실제 로고) */
export function Avatar({ name, url, size }: { name: string; url: string; size?: "lg" }) {
  const [imgOk, setImgOk] = useState(true);
  const fav = faviconUrl(url);
  const hue = avatarHue(name);
  return (
    <span className={`avatar${size === "lg" ? " lg" : ""}`}
      style={{ background: `hsl(${hue} 75% 94%)`, color: `hsl(${hue} 65% 38%)` }}>
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

export function PlatformCard({ p, showCat = true, fit }: { p: Platform; showCat?: boolean; fit?: string | null }) {
  const favs = useFavs();
  const cmp = useCompare();
  const go = useNav();
  const on = favs.has(p.id);
  const inCmp = cmp.has(p.id);
  const cat = categoryById(p.category);
  useEffect(() => { trackImpression(p.id); }, [p.id]); // 노출 계측(세션당 1회 dedup·벌크)
  const openDetail = () => { trackEvent("click", p.id); go("detail", { id: p.id }); };
  const toggleFav = () => { if (!on) trackEvent("favorite", p.id); favs.toggle(p.id); };
  // 1a: 카드 전체 클릭 → 상세. 내부 컨트롤(★·비교·공식링크)은 전파 차단.
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return (
    <div className={`pcard${fit ? " fit" : ""}`} role="link" tabIndex={0} aria-label={`${p.name} 상세`}
      onClick={openDetail}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(); } }}>
      <div className="top">
        <Avatar name={p.name} url={p.url} />
        <div style={{ minWidth: 0 }}>
          <h4><span className="pname">{p.name}</span>
            {p.new && <Badge kind="new">NEW</Badge>}{p.verified && <Badge kind="verify">✓ 검증</Badge>}{fit && <Badge kind="good">{fit}</Badge>}
            {p.link_status === "dead" && <span title="최근 점검에서 접속 불가 — 확인 필요"><Badge kind="muted">⚠ 링크 확인</Badge></span>}</h4>
          {showCat && cat && <div className="cat">{cat.name}</div>}
        </div>
        <button className={`star ${on ? "on" : ""}`} aria-label="즐겨찾기"
          onClick={(e) => { stop(e); toggleFav(); }}>{on ? "★" : "☆"}</button>
      </div>
      <p>{p.blurb}</p>
      <div className="pcard-actions">
        <span className="cta">자세히 보기 →</span>
        <a className="ext" href={p.url} target="_blank" rel="noopener noreferrer"
          onClick={(e) => { stop(e); Recent.push(p.id); trackEvent("outbound", p.id); }}>공식 ↗</a>
        <button className={`cmp-btn ${inCmp ? "on" : ""}`} disabled={!inCmp && cmp.full}
          onClick={(e) => { stop(e); cmp.toggle(p.id); }} title={cmp.full && !inCmp ? "최대 4개" : "비교 담기"}>
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
      <div className="foot-cap">© 2026 세모플 SEMOPL — 세상의 모든 플랫폼 · {total.toLocaleString()}개 등재</div>
    </div></footer>
  );
}

/* 검색 자동완성 입력(1a 핸드오프 권장) — 플랫폼명·분야명 제안 + 최근 검색어.
 * 키보드 ↑↓/Enter/Esc, 선택: 플랫폼→상세, 분야→onPickCategory, 텍스트→onSubmitQuery. */
export function SuggestInput({ value, onChange, placeholder, ariaLabel, autoFocus, onSubmitQuery, onPickCategory }: {
  value: string; onChange: (v: string) => void; placeholder: string; ariaLabel: string; autoFocus?: boolean;
  onSubmitQuery: (q: string) => void; onPickCategory: (catId: string) => void;
}) {
  const go = useNav();
  const platforms = usePlatforms();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const boxRef = useRef<HTMLSpanElement>(null);
  const items = useMemo<Suggestion[]>(() => (open ? suggest(value, platforms) : []), [open, value, platforms]);

  // 바깥 클릭으로 닫기
  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  useEffect(() => { setActive(-1); }, [value]);

  const pick = (s: Suggestion) => {
    setOpen(false);
    if (s.kind === "platform") { trackEvent("click", s.id); go("detail", { id: s.id }); }
    else if (s.kind === "category") onPickCategory(s.id);
    else onSubmitQuery(s.id);
  };
  const key = (e: RKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, items.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, -1)); }
    else if (e.key === "Escape") { setOpen(false); setActive(-1); }
    else if (e.key === "Enter") {
      if (open && active >= 0 && items[active]) pick(items[active]);
      else { setOpen(false); onSubmitQuery(value); }
    }
  };

  return (
    <span ref={boxRef} style={{ position: "relative", flex: 1, minWidth: 0, display: "flex" }}
      role="combobox" aria-expanded={open && items.length > 0} aria-haspopup="listbox">
      <input value={value} aria-label={ariaLabel} placeholder={placeholder} autoFocus={autoFocus}
        aria-autocomplete="list" aria-activedescendant={active >= 0 ? `sug-${active}` : undefined}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)} onKeyDown={key}
        style={{ flex: 1, minWidth: 0, background: "none", border: "none", outline: "none", font: "inherit", color: "inherit" }} />
      {open && items.length > 0 && (
        <ul className="suggest" role="listbox" aria-label="검색 제안">
          {items.map((s, i) => (
            <li key={`${s.kind}:${s.id}`} id={`sug-${i}`} role="option" aria-selected={i === active}
              className={`sug-item${i === active ? " on" : ""}`}
              onMouseDown={(e) => { e.preventDefault(); pick(s); }}
              onMouseEnter={() => setActive(i)}>
              <span className="sug-label">{s.label}</span>
              {s.sub && <span className="sug-sub">{s.sub}</span>}
            </li>
          ))}
        </ul>
      )}
    </span>
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
