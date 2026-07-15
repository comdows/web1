import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, KeyboardEvent as RKeyboardEvent } from "react";
import type { Platform } from "./data";
import { categoryById } from "./data";
import { useFavs, useCompare, Recent } from "./lib/store";
import { usePlatforms, usePlatformStats } from "./lib/platforms";
import { useReviewStats } from "./lib/reviews";
import { avatarHue, faviconUrl } from "./lib/util";
import { createReport, trackEvent, trackImpression } from "./lib/api";
import type { ReportTargetType } from "./lib/api";
import { getSession } from "./lib/auth";
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

/* AI 요금형태(0032) — 형태만 표기(금액 게재 안 함, 편집 추정). 라벨·배지색 매핑을 한 곳에서. */
export const AI_PRICING: Record<"free" | "freemium" | "paid", { label: string; kind: "good" | "soon" | "muted"; hint: string }> = {
  free:     { label: "무료",   kind: "good",  hint: "무료로 핵심 기능 사용(오픈소스·완전무료 등)" },
  freemium: { label: "부분무료", kind: "soon",  hint: "무료 플랜/체험 있고 유료 업그레이드 존재" },
  paid:     { label: "유료",   kind: "muted", hint: "무료 사용 제한(무료체험만 또는 유료 전용)" },
};
export function AiPricingBadge({ v }: { v?: "free" | "freemium" | "paid" | null }) {
  if (!v || !AI_PRICING[v]) return null;
  const m = AI_PRICING[v];
  return <span title={`요금형태: ${m.hint} · 참고용(공식 사이트 확인)`}><Badge kind={m.kind}>{m.label}</Badge></span>;
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
  const rstat = useReviewStats().get(p.id); // 표시 전용 — 정렬에는 반영 안 함(0025)
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
            <AiPricingBadge v={p.ai_pricing} />
            {p.link_status === "dead" && <span title="최근 점검에서 접속 불가 — 확인 필요"><Badge kind="muted">⚠ 링크 확인</Badge></span>}</h4>
          {showCat && cat && <div className="cat">{cat.name}{rstat && <span title={`이용 후기 ${rstat.review_count}건 평균`}> · ★{rstat.avg_rating} ({rstat.review_count})</span>}</div>}
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
            <button className="foot-link" onClick={() => go("support")}>문의·도움말</button>
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

/* 신고 버튼(0028) — 게시물 문제 신고: 클릭 → 인라인 사유 입력 → 접수(운영자 검수 큐).
 * 신고 내용은 관리자만 보므로 연락처 차단(CONTACT_RE) 불필요. 비로그인은 안내만. */
export function ReportButton({ targetType, targetId }: { targetType: ReportTargetType; targetId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "done" | "need-login" | "error">("idle");
  const [err, setErr] = useState("");
  if (state === "done") return <span className="frm-note">✓ 신고 접수됨 — 운영자가 확인해요</span>;
  if (state === "need-login") return <span className="frm-note">신고에는 로그인이 필요해요</span>;
  if (!open) {
    return (
      <button className="linklike" style={{ fontSize: 12, opacity: 0.75 }}
        onClick={() => { if (!getSession()) { setState("need-login"); return; } setOpen(true); }}>
        🚩 신고
      </button>
    );
  }
  const submit = async () => {
    if (reason.trim().length < 10) { setErr("사유를 10자 이상 적어 주세요"); return; }
    setState("busy"); setErr("");
    try {
      await createReport(targetType, targetId, reason);
      setState("done");
    } catch (ex) {
      setState("error"); setErr(ex instanceof Error ? ex.message : "접수에 실패했어요");
      setTimeout(() => setState("idle"), 0);
    }
  };
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500}
        placeholder="신고 사유(10자 이상)" aria-label="신고 사유"
        style={{ fontSize: 12, padding: "4px 8px", border: "1px solid var(--line, #ddd)", borderRadius: 6, minWidth: 180 }} />
      <button className="btn ghost sm" disabled={state === "busy"} onClick={submit}>{state === "busy" ? "접수 중…" : "접수"}</button>
      <button className="linklike" style={{ fontSize: 12 }} onClick={() => { setOpen(false); setErr(""); }}>취소</button>
      {err && <span className="frm-note" style={{ color: "#c0392b" }}>{err}</span>}
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
