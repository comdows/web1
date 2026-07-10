import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { categories, groups, categoriesByGroup, categoryById } from "./data";
import type { Platform } from "./data";
import hubIntros from "./data/hub-intros.ko.json"; // 분야 허브 편집 인트로(검색 랜딩 안내)
const HUB: Record<string, { intro: string; pickBy: string[] }> = hubIntros as never;
import { Avatar, Badge, PlatformCard, ShareButton } from "./components";
import { usePlatforms, usePlatformIndex, usePlatformsLoaded, usePlatformStats } from "./lib/platforms";
import { amOperatorOf, createCorrection, createOperatorClaim, getMyClaim, getPlatform, remoteEnabled, trackEvent } from "./lib/api";
import type { OperatorClaim } from "./lib/api";
import { pickRecommended, sortByRelevance, sortByPopularity } from "./lib/search";
import { usePopularity } from "./lib/popularity";
import { rankSimilar } from "./lib/match";
import { Compare as CompareStore, Favs, Interests, Recent, useCompare, useFavs } from "./lib/store";
import { useNav } from "./nav";
import { useSession } from "./lib/auth";
import { FLAGS } from "./config";
import { ProposalComposer } from "./proposal";

const Compare_hasSafe = (id: string) => CompareStore.has(id);

const FEE_LABEL: Record<string, { l: string; k: "good" | "soon" | "muted" }> = {
  low: { l: "낮음", k: "good" }, mid: { l: "중간", k: "soon" }, high: { l: "높음", k: "muted" },
};

/* ── 운영자 인증 신청(클레임) — 승인 시 운영자 지정 + 검증 배지, 제휴·거래소의 B2B 접점 ── */
function OperatorClaimBox({ platformId, platformUrl }: { platformId: string; platformUrl: string }) {
  const go = useNav();
  const { session } = useSession();
  const [claim, setClaim] = useState<OperatorClaim | null>(null);
  const [isOp, setIsOp] = useState(false);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);
  useEffect(() => {
    setClaim(null); setIsOp(false); setOpen(false); setDone(false);
    if (!session || !remoteEnabled) return;
    let alive = true;
    getMyClaim(platformId).then((c) => { if (alive) setClaim(c); }).catch(() => { /* noop */ });
    amOperatorOf(platformId).then((v) => { if (alive) setIsOp(v); }).catch(() => { /* noop */ });
    return () => { alive = false; };
  }, [platformId, session]);
  if (!remoteEnabled) return null;

  let host = "";
  try { host = new URL(platformUrl).hostname.replace(/^www\./, ""); } catch { /* noop */ }
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(""); setBusy(true);
    try { await createOperatorClaim(platformId, email.trim()); setDone(true); setOpen(false); }
    catch (ex) { setErr(ex instanceof Error ? ex.message : String(ex)); }
    finally { setBusy(false); }
  };

  return (
    <div className="banner" style={{ margin: "14px 0" }}>
      {isOp ? (
        <>✓ <b>운영자 인증 완료</b> — 이 플랫폼에 검증 배지가 표시됩니다. 정보 수정은 정정 제보 또는 문의로 반영돼요.</>
      ) : done || claim?.status === "pending" || claim?.status === "code_sent" ? (
        <>🏷 <b>운영자 인증 검수 중</b> — 도메인 이메일 확인 후 승인되면 검증 배지가 붙어요. 진행 상태는 이 페이지에서 확인할 수 있어요.</>
      ) : claim?.status === "verified" ? (
        <>✓ <b>운영자 인증 완료</b> — 검증 배지가 표시됩니다.</>
      ) : claim?.status === "rejected" ? (
        <>🏷 운영자 인증이 반려됐어요 — 도메인 이메일로 다시 신청하거나 문의해 주세요.
          <button className="btn ghost sm" style={{ marginLeft: 8 }} onClick={() => { setClaim(null); setOpen(true); }}>다시 신청</button></>
      ) : !session ? (
        <>🏷 <b>이 플랫폼의 운영자이신가요?</b> 인증하면 검증 배지가 붙고, 제휴 제안을 공식으로 받을 수 있어요.{" "}
          <button className="linklike" onClick={() => go("account")}>로그인 후 신청 →</button></>
      ) : !open ? (
        <>🏷 <b>이 플랫폼의 운영자이신가요?</b> 인증하면 검증 배지가 붙고, 제휴 제안을 공식으로 받을 수 있어요.{" "}
          <button className="btn ghost sm" onClick={() => setOpen(true)}>운영자 인증 신청</button></>
      ) : (
        <form className="frm" style={{ marginTop: 6 }} onSubmit={submit}>
          <label>업무용 이메일 *
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder={host ? `예: name@${host}` : "도메인 이메일"} />
          </label>
          <div className="frm-note">플랫폼 도메인({host || "공식 도메인"})과 일치하는 이메일이면 검수가 빨라요. 서류 인증이 필요하면 검수 중에 안내드립니다.</div>
          {err && <div className="err">{err}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn primary sm" disabled={busy} type="submit">{busy ? "신청 중…" : "인증 신청"}</button>
            <button className="btn ghost sm" type="button" onClick={() => setOpen(false)}>취소</button>
          </div>
        </form>
      )}
    </div>
  );
}

/* 정보 정정·보강 제안 — 기존 항목의 판단 필드(수수료·정산·입점·강점·URL)를 회원이 교정 제안한다.
 * 인증 운영자면 by_operator=true(관리 큐 우선). 앱 내 처리(외부 GitHub 이슈 대체). */
function CorrectionBox({ p }: { p: Platform }) {
  const go = useNav();
  const { session } = useSession();
  const [isOp, setIsOp] = useState(false);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ fee_band: p.fee_band ?? "", fee_text: p.fee_text ?? "", settle_text: p.settle_text ?? "", enter_text: p.enter_text ?? "", strength: p.strength ?? "", url: "" });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);
  useEffect(() => {
    setIsOp(false);
    if (!session || !remoteEnabled) return;
    let alive = true;
    amOperatorOf(p.id).then((v) => { if (alive) setIsOp(v); }).catch(() => { /* noop */ });
    return () => { alive = false; };
  }, [p.id, session]);
  if (!remoteEnabled) return null;

  const submit = async () => {
    setErr("");
    const base: Record<string, string> = { fee_band: p.fee_band ?? "", fee_text: p.fee_text ?? "", settle_text: p.settle_text ?? "", enter_text: p.enter_text ?? "", strength: p.strength ?? "", url: "" };
    const fields: Record<string, string> = {};
    for (const k of Object.keys(base)) { const v = (f as Record<string, string>)[k].trim(); if (v && v !== base[k]) fields[k] = v; }
    if (Object.keys(fields).length === 0 && !note.trim()) { setErr("바뀐 내용을 입력해 주세요."); return; }
    setBusy(true);
    try { await createCorrection({ id: p.id, name: p.name, url: p.url, category: p.category, region: p.region }, fields, note.trim(), isOp); setDone(true); setOpen(false); }
    catch (ex) { setErr(ex instanceof Error ? ex.message : String(ex)); }
    finally { setBusy(false); }
  };

  if (done) return <div className="banner" style={{ marginTop: 8 }}>✓ 정정 제안이 접수됐어요 — 검수 후 반영됩니다. 감사합니다{isOp ? " (운영자 확인 우선 처리)" : ""}.</div>;
  if (!session) return (
    <span> 정보가 다르면 <button className="linklike" onClick={() => go("account")}>로그인 후 정정 제안 →</button> 부탁드립니다.</span>
  );
  if (!open) return (
    <span> {isOp
      ? <><b>운영자님 — 정확한 정보를 채워주세요.</b> <button className="linklike" onClick={() => setOpen(true)}>정보 채우기·정정 →</button></>
      : <>정보가 다르면 <button className="linklike" onClick={() => setOpen(true)}>정정 제안 →</button> 부탁드립니다.</>}</span>
  );
  return (
    <form className="frm" style={{ marginTop: 10 }} onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <div className="frm-note">{isOp ? "운영자 확인으로 우선 반영됩니다." : "공개 정보 기준으로 정정·보강을 제안해 주세요 — 검수 후 반영됩니다."} 바뀐 항목만 입력하면 됩니다.</div>
      <label>수수료대
        <select value={f.fee_band} onChange={(e) => setF({ ...f, fee_band: e.target.value })}>
          <option value="">모름/변경 없음</option><option value="low">낮음</option><option value="mid">중간</option><option value="high">높음</option>
        </select>
      </label>
      <label>수수료 표기 <input value={f.fee_text} onChange={(e) => setF({ ...f, fee_text: e.target.value })} placeholder="예: ~4–10.8%" maxLength={80} /></label>
      <label>정산 주기 <input value={f.settle_text} onChange={(e) => setF({ ...f, settle_text: e.target.value })} placeholder="예: 월 2회, D+7" maxLength={80} /></label>
      <label>입점 조건 <input value={f.enter_text} onChange={(e) => setF({ ...f, enter_text: e.target.value })} placeholder="예: 사업자등록 필요" maxLength={120} /></label>
      <label>강점 한 줄 <input value={f.strength} onChange={(e) => setF({ ...f, strength: e.target.value })} placeholder="예: 신선식품 새벽배송망" maxLength={120} /></label>
      <label>URL 정정(폐업·이전 시) <input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://… (바뀐 공식 주소)" /></label>
      <label>메모(선택) <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="근거·출처 등" maxLength={200} /></label>
      {err && <div className="err">{err}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn primary sm" type="submit" disabled={busy}>{busy ? "제출 중…" : "정정 제안 보내기"}</button>
        <button className="btn ghost sm" type="button" onClick={() => setOpen(false)}>취소</button>
      </div>
    </form>
  );
}

/* ─────────────── Platform Detail ─────────────── */
export function PlatformDetail({ id }: { id?: string }) {
  const go = useNav();
  const favs = useFavs();
  const cmp = useCompare();
  const list = usePlatforms();
  const index = usePlatformIndex();
  const loaded = usePlatformsLoaded();
  const local = id ? index.get(id) : undefined;

  // 목록에 없으면(원격 전용 신규 등) 개별 원격 조회 폴백
  const [remote, setRemote] = useState<(Platform & { similar?: Platform[] }) | null>(null);
  const [fetching, setFetching] = useState(false);
  const [proposing, setProposing] = useState(false); // 제휴 제안 작성기 열림
  useEffect(() => {
    setRemote(null);
    if (!id || local || !remoteEnabled) return;
    let alive = true;
    setFetching(true);
    getPlatform(id).then((r) => { if (alive) setRemote(r); }).catch(() => { /* 폴백은 local */ }).finally(() => { if (alive) setFetching(false); });
    return () => { alive = false; };
  }, [id, local]);

  const p = local ?? remote ?? undefined;
  useEffect(() => {
    if (p) { document.title = `${p.name} — 세모플`; Recent.push(p.id); } // 열람 이력 기록(최근 본)
    return () => { document.title = "세모플 — 세상의 모든 플랫폼"; };
  }, [p]);
  // 검색엔진(/p/ 프리렌더 경로)으로 들어온 첫 방문에만 사이트 소개 배너 1회 노출
  const [seoCtx] = useState(() => {
    if (!/\/p\/[a-z0-9-]+\/?$/.test(location.pathname)) return false;
    try { if (sessionStorage.getItem("sm.seen.v1")) return false; sessionStorage.setItem("sm.seen.v1", "1"); } catch { /* noop */ }
    return true;
  });
  if (!p) {
    if (fetching || (!loaded && remoteEnabled)) return <div className="page container"><div className="empty">불러오는 중…</div></div>;
    return (
      <div className="page container">
        <div className="empty">
          플랫폼을 찾을 수 없습니다 — 주소가 바뀌었거나 삭제된 항목이에요.{" "}
          <button className="linklike" onClick={() => go("search")}>🔍 검색으로 찾기</button>{" "}
          <button className="linklike" onClick={() => go("home")}>← 홈으로</button>
        </div>
      </div>
    );
  }
  const cat = categoryById(p.category);
  const on = favs.has(p.id);
  const inCmp = cmp.has(p.id);
  // 같은 분야 후보를 설명 토큰 유사도로 재정렬(임의 6개 → 실제로 비슷한 6개)
  const related = rankSimilar(p, (local ? list : (remote?.similar ?? [])).filter((x) => x.category === p.category), 6);
  return (
    <div className="page container">
      {seoCtx && (
        <div className="banner" style={{ marginBottom: 12 }}>
          △ <b>세모플</b> — 1,600여 개 플랫폼·AI 도구를 같은 기준으로 정리한 무료 디렉토리예요. 비교하고 ★로 저장해 보세요.{" "}
          <button className="linklike" onClick={() => go("home")}>전체 디렉토리 →</button>{" "}
          <button className="linklike" onClick={() => go("ai-finder")}>AI 도구 찾기 →</button>
        </div>
      )}
      <button className="linklike" onClick={() => history.length > 1 ? history.back() : go("home")}>← 뒤로</button>
      <div className="detail-hero">
        <Avatar name={p.name} url={p.url} size="lg" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1>{p.name} {p.verified && <Badge kind="verify">검증</Badge>}{p.new && <Badge kind="new">NEW</Badge>}</h1>
          <div className="cat">{cat?.icon} <span className="linklike" onClick={() => go("search", { q: cat?.name ?? "" })}>{cat?.name}</span> · {p.region}</div>
          <div className="detail-cta">
            <a className="btn primary" href={p.url} target="_blank" rel="noopener noreferrer" onClick={() => { Recent.push(p.id); trackEvent("outbound", p.id); }}>공식 사이트 방문 ↗</a>
            <button className={`btn ghost ${on ? "on" : ""}`} onClick={() => favs.toggle(p.id)}>{on ? "★ 저장됨" : "☆ 즐겨찾기"}</button>
            <button className={`btn ghost ${inCmp ? "on" : ""}`} disabled={!inCmp && cmp.full} onClick={() => cmp.toggle(p.id)}>{inCmp ? "✓ 비교 담김" : "+ 비교 담기"}</button>
            {FLAGS.stage2 && p.category.startsWith("ai_") === false && (
              <button className={`btn ghost ${proposing ? "on" : ""}`} onClick={() => setProposing((v) => !v)}>🤝 제휴 제안</button>
            )}
            <ShareButton small={false} title={`${p.name} — 세모플`} url={`${location.origin}${import.meta.env.BASE_URL}p/${p.id}/`} />
          </div>
        </div>
      </div>

      {proposing && <ProposalComposer target={p} onClose={() => setProposing(false)} />}

      {p.blurb && <p className="lead" style={{ maxWidth: 640, marginTop: 4 }}>{p.blurb}</p>}

      <div className="facts">
        <div className="fact"><div className="k">분야</div><div className="v">{cat?.icon} {cat?.name}</div></div>
        <div className="fact"><div className="k">지역</div><div className="v">{p.region}</div></div>
        <div className="fact"><div className="k">신규 여부</div><div className="v">{p.new ? "🆕 최근 등록" : "기존 등록"}</div></div>
        <div className="fact"><div className="k">공식 주소</div><div className="v mono" style={{ fontSize: 12, wordBreak: "break-all" }}>
          {p.url.replace(/^https?:\/\//, "").replace(/\/$/, "")}
          {p.link_status === "dead" && <span className="est" style={{ color: "var(--warn)" }}> ⚠ 최근 점검 접속 불가</span>}
          {p.link_checked_at && <span className="faint" style={{ fontSize: 11 }}> · 링크 확인 {p.link_checked_at.slice(0, 7).replace("-", ".")}</span>}
        </div></div>
        {p.fee_band && (
          <div className="fact"><div className="k">수수료대 <span className="est">추정</span></div><div className="v">
            <Badge kind={FEE_LABEL[p.fee_band].k}>{FEE_LABEL[p.fee_band].l}</Badge>{p.fee_text ? ` ${p.fee_text}` : ""}
            {" "}<a className="src" href={p.url} target="_blank" rel="noopener noreferrer">공식 확인 ↗</a>
          </div></div>
        )}
        {p.settle_text && <div className="fact"><div className="k">정산 주기 <span className="est">추정</span></div><div className="v">{p.settle_text} <a className="src" href={p.url} target="_blank" rel="noopener noreferrer">공식 확인 ↗</a></div></div>}
        {p.enter_text && <div className="fact"><div className="k">입점 조건</div><div className="v">{p.enter_text}</div></div>}
        {p.strength && <div className="fact"><div className="k">강점</div><div className="v">{p.strength}</div></div>}
      </div>

      <OperatorClaimBox platformId={p.id} platformUrl={p.url} />

      <div className="panel-note banner">
        ⓘ <b>수수료대·정산 주기·입점 조건은 공개 정보를 바탕으로 한 세모플의 개략 추정치</b>이며 해당 플랫폼의 공식 수치가 아닙니다.
        요율·조건은 카테고리·시기·계약에 따라 다르고 수시로 바뀌므로, 실제 값은 반드시 <b>공식 사이트</b>에서 확인하세요.
        <CorrectionBox p={p} />
      </div>

      {related.length > 0 && (() => {
        const alts = related.slice(0, 3);
        const cols = [p, ...alts];
        const val = (pl: Platform, k: string): string => {
          if (k === "fee") return pl.fee_band ? `${FEE_LABEL[pl.fee_band].l}${pl.fee_text ? ` ${pl.fee_text}` : ""}` : "—";
          if (k === "settle") return pl.settle_text || "—";
          if (k === "enter") return pl.enter_text || "—";
          return pl.strength || "—";
        };
        const rows: [string, string][] = [["수수료대", "fee"], ["정산 주기", "settle"], ["입점 조건", "enter"], ["강점", "strength"]];
        const pickBy = HUB[p.category]?.pickBy ?? [];
        const addAll = () => { for (const c of cols) if (!cmp.has(c.id) && !cmp.full) cmp.toggle(c.id); go("compare"); };
        return (
          <>
            <div className="sec-title">대안 비교 — 같은 기준으로</div>
            {pickBy.length > 0 && <div className="frm-note" style={{ marginBottom: 6 }}>이 분야는 <b>{pickBy.slice(0, 3).join(" · ")}</b>{pickBy.length > 3 ? " 등" : ""}을 따져보세요.</div>}
            <div style={{ overflowX: "auto" }}>
              <table className="cmp-mini" style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
                <thead><tr>
                  <th style={{ textAlign: "left", padding: "6px 8px", color: "var(--faint)" }}>항목</th>
                  {cols.map((c, i) => <th key={c.id} style={{ textAlign: "left", padding: "6px 8px", whiteSpace: "nowrap" }}>
                    <button className="linklike" onClick={() => go("detail", { id: c.id })}>{c.name}</button>{i === 0 && <span className="est"> 현재</span>}
                  </th>)}
                </tr></thead>
                <tbody>{rows.map(([label, k]) => (
                  <tr key={k} style={{ borderTop: "1px solid var(--line)" }}>
                    <td style={{ padding: "6px 8px", color: "var(--muted)", whiteSpace: "nowrap" }}>{label}{(k === "fee" || k === "settle") && <span className="est"> 추정</span>}</td>
                    {cols.map((c) => <td key={c.id} style={{ padding: "6px 8px" }}>{val(c, k)}</td>)}
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <div style={{ marginTop: 8 }}><button className="btn ghost sm" onClick={addAll}>이 대안들 비교함에 담기 →</button></div>
            <p className="sub faint" style={{ fontSize: 12, marginTop: 6 }}>수수료·정산은 공개 정보 기반 개략 추정치예요. 빈 칸은 <button className="linklike" onClick={() => document.querySelector(".panel-note")?.scrollIntoView({ behavior: "smooth" })}>정정 제안</button>으로 채워주시면 반영됩니다.</p>

            <div className="sec-title">같은 분야의 다른 플랫폼</div>
            <div className="card-grid">{related.map((r) => <PlatformCard key={r.id} p={r} showCat={false} />)}</div>
          </>
        );
      })()}
      {(() => {
        const rec = Recent.list().filter((x) => x !== p.id).map((x) => index.get(x)).filter(Boolean).slice(0, 4) as Platform[];
        if (rec.length < 2) return null;
        return (
          <>
            <div className="sec-title">🕘 최근 본 플랫폼</div>
            <div className="card-grid">{rec.map((r) => <PlatformCard key={r.id} p={r} />)}</div>
            <p className="sub faint" style={{ fontSize: 12.5 }}>★로 저장하면 로그인 시 계정에 동기화돼요.</p>
          </>
        );
      })()}
    </div>
  );
}

/* ─────────────── Search Results ─────────────── */
type Sort = "relevance" | "popular" | "new" | "name";
export function SearchResults({ initialQ = "" }: { initialQ?: string }) {
  const go = useNav();
  // URL에서 필터 복원(새로고침·공유·뒤로가기에 필터 유지)
  const sp0 = new URLSearchParams(location.search);
  const pathCat = location.pathname.match(/\/c\/([a-z0-9_-]+)\/?$/)?.[1]; // 분야 허브(/c/) 진입
  const [q, setQ] = useState(initialQ || sp0.get("q") || "");
  const [cats, setCats] = useState<Set<string>>(() => new Set([...(sp0.get("cats") ?? "").split(",").filter(Boolean), ...(pathCat ? [pathCat] : [])]));
  const [showFilters, setShowFilters] = useState(false); // 모바일: 필터 접이식(결과 먼저)
  const [region, setRegion] = useState<string>(sp0.get("region") ?? "all");
  const [onlyNew, setOnlyNew] = useState(sp0.get("new") === "1");
  const [fees, setFees] = useState<Set<string>>(() => new Set((sp0.get("fee") ?? "").split(",").filter(Boolean))); // 수수료대 필터
  const [sort, setSort] = useState<Sort>((sp0.get("sort") as Sort) || "relevance");

  // 필터 상태 → URL(replaceState — 홈과 동일 패턴)
  useEffect(() => {
    const p = new URLSearchParams();
    p.set("view", "search");
    if (q.trim()) p.set("q", q.trim());
    if (cats.size) p.set("cats", [...cats].join(","));
    if (region !== "all") p.set("region", region);
    if (onlyNew) p.set("new", "1");
    if (fees.size) p.set("fee", [...fees].join(","));
    if (sort !== "relevance") p.set("sort", sort);
    history.replaceState(null, "", `?${p}`);
  }, [q, cats, region, onlyNew, fees, sort]);
  const platforms = usePlatforms();
  const pop = usePopularity();
  const stats = usePlatformStats();

  const toggleCat = (id: string) => setCats((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleFee = (id: string) => setFees((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  // 검색어가 멈추면 이벤트 기록(관리자 '인기 검색어' 근거) — 원격 모드에서만, 실패 무시
  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) return;
    const id = setTimeout(() => trackEvent("search", undefined, query), 600);
    return () => clearTimeout(id);
  }, [q]);

  const results = useMemo(() => {
    const query = q.trim().toLowerCase();
    let list = platforms.filter((p) => {
      if (cats.size && !cats.has(p.category)) return false;
      if (region !== "all" && p.region !== region) return false;
      if (onlyNew && !p.new) return false;
      if (fees.size && (!p.fee_band || !fees.has(p.fee_band))) return false;
      if (query) {
        const hay = (p.name + " " + p.blurb + " " + (categoryById(p.category)?.name ?? "")).toLowerCase();
        if (!query.split(/\s+/).every((t) => hay.includes(t))) return false;
      }
      return true;
    });
    if (sort === "new") list = [...list].sort((a, b) => (b.new ? 1 : 0) - (a.new ? 1 : 0));
    else if (sort === "name") list = [...list].sort((a, b) => a.name.localeCompare(b.name, "ko"));
    else if (sort === "popular") list = sortByPopularity(list, pop); // 인기순(외부방문·클릭·노출 집계)
    else if (query) list = sortByRelevance(list, query, pop); // 관련도(1차) + 인기(2차 보정)
    return list;
  }, [q, cats, region, onlyNew, fees, sort, platforms, pop]);

  const activeChips: { label: string; clear: () => void }[] = [];
  cats.forEach((c) => activeChips.push({ label: categoryById(c)?.name ?? c, clear: () => toggleCat(c) }));
  if (region !== "all") activeChips.push({ label: region, clear: () => setRegion("all") });
  if (onlyNew) activeChips.push({ label: "신규만", clear: () => setOnlyNew(false) });
  fees.forEach((f) => activeChips.push({ label: `수수료 ${FEE_LABEL[f]?.l ?? f}`, clear: () => toggleFee(f) }));

  return (
    <div className="page container search-page">
      <div className="search" style={{ maxWidth: "none", marginBottom: 18 }}>
        <span className="ico">⌕</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} aria-label="플랫폼·분야 검색" placeholder="플랫폼·분야 검색" autoFocus />
      </div>
      <button className="btn ghost sm filters-toggle" onClick={() => setShowFilters((v) => !v)}>
        {showFilters ? "필터 접기 ▴" : `필터 열기${activeChips.length ? ` (${activeChips.length}개 적용 중)` : ""} ▾`}
      </button>
      <div className={`search-layout ${showFilters ? "filters-open" : ""}`}>
        <aside className="facets">
          <div className="facet-group">
            <div className="facet-title">지역</div>
            {["all", "국내", "해외"].map((r) => (
              <label key={r} className="facet-opt"><input type="radio" name="region" checked={region === r} onChange={() => setRegion(r)} /> {r === "all" ? "전체" : r}</label>
            ))}
          </div>
          <div className="facet-group">
            <div className="facet-title">신규</div>
            <label className="facet-opt"><input type="checkbox" checked={onlyNew} onChange={() => setOnlyNew((v) => !v)} /> 🆕 최근 등록만</label>
          </div>
          <div className="facet-group">
            <div className="facet-title">수수료대 <span className="faint" style={{ fontWeight: 400 }}>(추정)</span></div>
            {["low", "mid", "high"].map((f) => (
              <label key={f} className="facet-opt"><input type="checkbox" checked={fees.has(f)} onChange={() => toggleFee(f)} /> {FEE_LABEL[f].l}</label>
            ))}
            <div className="facet-ct" style={{ fontSize: 11, marginTop: 2 }}>수수료대가 표기된 플랫폼만 대상</div>
          </div>
          <div className="facet-group">
            <div className="facet-title">분야</div>
            {groups.map((g) => (
              <div key={g.id} className="facet-sub">
                <div className="facet-sub-title">{g.icon} {g.name}</div>
                {categoriesByGroup(g.id).map((c) => (
                  <label key={c.id} className="facet-opt sm" style={(stats.counts.get(c.id) ?? 0) === 0 ? { opacity: .45 } : undefined}>
                    <input type="checkbox" disabled={(stats.counts.get(c.id) ?? 0) === 0 && !cats.has(c.id)}
                      checked={cats.has(c.id)} onChange={() => toggleCat(c.id)} /> {c.name}
                    <span className="facet-ct">{stats.counts.get(c.id) ?? 0}</span>
                  </label>
                ))}
              </div>
            ))}
          </div>
        </aside>
        <div className="search-main">
          {(() => {
            // 분야 허브(/c/) 진입 = 한 분야만 필터·검색어 없음 → 편집 인트로로 안내(검색 유입 이탈 감소)
            const only = cats.size === 1 && !q.trim() ? [...cats][0] : "";
            const hub = only ? HUB[only] : null;
            if (!only || !hub) return null;
            const c = categoryById(only);
            return (
              <section className="hub-intro">
                <h1 style={{ fontSize: 20, margin: "0 0 8px" }}>{c?.icon} {c?.name} 플랫폼</h1>
                {hub.intro.split(/\n\n+/).map((para, i) => <p key={i}>{para}</p>)}
                {hub.pickBy?.length > 0 && (
                  <div className="pickby">
                    <b>고를 때 따져볼 기준</b>
                    <ul>{hub.pickBy.map((b) => <li key={b}>{b}</li>)}</ul>
                  </div>
                )}
              </section>
            );
          })()}
          <div className="search-toolbar">
            <div className="result-meta" style={{ margin: 0 }}>{results.length.toLocaleString()}개 결과</div>
            <select className="select" aria-label="정렬" value={sort} onChange={(e) => setSort(e.target.value as Sort)} style={{ marginLeft: "auto" }}>
              <option value="relevance">관련도</option>
              <option value="popular">인기순</option>
              <option value="new">신규 우선</option>
              <option value="name">가나다</option>
            </select>
          </div>
          {activeChips.length > 0 && (
            <div className="chips-row">
              {activeChips.map((c, i) => <button key={i} className="fchip on" onClick={c.clear}>{c.label} ✕</button>)}
              <button className="linklike" onClick={() => { setCats(new Set()); setRegion("all"); setOnlyNew(false); setFees(new Set()); }}>전체 해제</button>
            </div>
          )}
          {results.length === 0
            ? <div className="empty">조건에 맞는 플랫폼이 없습니다. 필터를 줄여보세요. 찾는 플랫폼이 없다면 <button className="linklike" onClick={() => go("submit")}>+ 제보</button>해 주시면 검수 후 등재해 드려요.</div>
            : <div className="card-grid">{results.slice(0, 300).map((p) => <PlatformCard key={p.id} p={p} />)}</div>}
          {results.length > 300 && <div className="result-meta">상위 300개 표시 · 검색어·필터로 좁혀보세요.</div>}
        </div>
      </div>
    </div>
  );
}

/* ─────────────── Compare ─────────────── */
export function Compare() {
  const go = useNav();
  const cmp = useCompare();
  const index = usePlatformIndex();
  // 공유 링크(?ids=a,b,c)로 진입하면 비교함을 채운다 — 비교표가 "보낼 수 있는 산출물"이 됨
  useEffect(() => {
    // 삭제·개명된 id는 담지 않는다 — 유령 항목이 4개 상한 슬롯을 소모하고 개별 제거도 불가했음
    const ids = (new URLSearchParams(location.search).get("ids") ?? "").split(",").filter(Boolean)
      .filter((id) => index.get(id)).slice(0, 4);
    for (const id of ids) if (!Compare_hasSafe(id)) cmp.toggle(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 비교함 상태를 URL에 반영(새로고침·공유 유지)
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    if (cmp.count > 0) p.set("ids", cmp.all().join(",")); else p.delete("ids");
    history.replaceState(null, "", `?${p}`);
  }, [cmp.count]);
  const items = cmp.all().map((id) => index.get(id)).filter(Boolean) as Platform[];
  if (items.length === 0) return (
    <div className="page container"><h1>비교</h1>
      <div className="empty">비교할 플랫폼이 없습니다. 카드의 <b>+ 비교</b>로 최대 4개까지 담아보세요. <button className="linklike" onClick={() => go("search")}>검색하러 가기</button></div>
    </div>
  );
  const rows: { k: string; render: (p: Platform) => ReactNode }[] = [
    { k: "분야", render: (p) => `${categoryById(p.category)?.icon ?? ""} ${categoryById(p.category)?.name ?? p.category}` },
    { k: "지역", render: (p) => p.region },
    { k: "신규", render: (p) => (p.new ? "🆕" : "—") },
    { k: "설명", render: (p) => <span style={{ fontSize: 13 }}>{p.blurb}</span> },
  ];
  // 리치 필드: 비교 대상 중 하나라도 값이 있으면 행 생성(전원 null 행은 숨김)
  if (items.some((p) => p.fee_band)) rows.push({ k: "수수료대 (추정)", render: (p) => p.fee_band ? `${FEE_LABEL[p.fee_band].l}${p.fee_text ? ` (${p.fee_text})` : ""}` : "—" });
  if (items.some((p) => p.settle_text)) rows.push({ k: "정산 주기 (추정)", render: (p) => p.settle_text ?? "—" });
  if (items.some((p) => p.enter_text)) rows.push({ k: "입점 조건", render: (p) => p.enter_text ?? "—" });
  if (items.some((p) => p.strength)) rows.push({ k: "강점", render: (p) => p.strength ?? "—" });
  rows.push({ k: "공식", render: (p) => <a className="ext" href={p.url} target="_blank" rel="noopener noreferrer">방문 ↗</a> });
  return (
    <div className="page container">
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <h1 style={{ margin: 0 }}>비교 <span className="mono faint" style={{ fontSize: 16 }}>{items.length}/4</span></h1>
        <ShareButton title={`세모플 비교 — ${items.map((p) => p.name).join(" vs ")}`} />
        <button className="linklike" style={{ marginLeft: "auto" }} onClick={() => cmp.clear()}>비우기</button>
      </div>
      <div className="cmp-scroll">
        <table className="cmp-table">
          <thead><tr><th></th>{items.map((p) => (
            <th key={p.id}>
              <div className="cmp-h"><button className="pname" onClick={() => go("detail", { id: p.id })}>{p.name}</button>
                <button className="linklike" onClick={() => cmp.toggle(p.id)} aria-label="비교에서 제거">✕</button></div>
            </th>
          ))}</tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.k}><td className="cmp-k">{r.k}</td>{items.map((p) => <td key={p.id}>{r.render(p)}</td>)}</tr>
          ))}</tbody>
        </table>
      </div>
      {items.some((p) => p.fee_band || p.settle_text) && (
        <p className="sub faint" style={{ fontSize: 12.5, marginTop: 10 }}>
          ⓘ 수수료대·정산은 공개 정보 기반 세모플 추정치이며 공식 수치가 아닙니다 — 실제 조건은 각 <b>공식 사이트</b>에서 확인하세요.
        </p>
      )}
    </div>
  );
}

/* ─────────────── Onboarding ─────────────── */
export function Onboarding() {
  const go = useNav();
  const platforms = usePlatforms();
  const saved = Interests.get(); // 이전 온보딩 선택 복원(관심 프로필)
  const [step, setStep] = useState(0);
  const [gsel, setGsel] = useState<Set<string>>(new Set(saved?.groups ?? []));
  const [csel, setCsel] = useState<Set<string>>(new Set(saved?.cats ?? []));
  const [newPref, setNewPref] = useState(saved?.newPref ?? false);
  const [savedAll, setSavedAll] = useState(false);

  const availCats = useMemo(() => categories.filter((c) => gsel.size === 0 || gsel.has(c.group)), [gsel]);
  const toggle = (set: Set<string>, id: string, fn: (s: Set<string>) => void) => { const n = new Set(set); if (n.has(id)) n.delete(id); else n.add(id); fn(n); };

  const pop = usePopularity();
  const recs = useMemo(() => pickRecommended(platforms, [...gsel], [...csel], newPref, 12, pop), [gsel, csel, newPref, platforms, pop]);

  const steps = ["관심 영역", "세부 분야", "선호", "추천"];
  return (
    <div className="page container onboarding">
      <div className="ob-bar">{steps.map((s, i) => <div key={i} className={`ob-step ${i === step ? "on" : ""} ${i < step ? "done" : ""}`}><span className="mono">{i + 1}</span> {s}</div>)}</div>

      {step === 0 && (
        <div className="ob-panel">
          <h2>어떤 영역에서 팔거나 사업을 확장하시나요?</h2>
          <p className="muted">관심 있는 대분류를 고르세요 (복수 선택).</p>
          <div className="groups">{groups.map((g) => (
            <button key={g.id} className={`gcard ${gsel.has(g.id) ? "sel" : ""}`} onClick={() => toggle(gsel, g.id, setGsel)}>
              <div className="g-ic">{g.icon}</div><h4>{g.name}</h4><div className="g-meta">{categoriesByGroup(g.id).length} 분야</div>
            </button>
          ))}</div>
          <div className="ob-nav"><button className="btn primary" disabled={gsel.size === 0} onClick={() => setStep(1)}>다음 →</button></div>
        </div>
      )}

      {step === 1 && (
        <div className="ob-panel">
          <h2>구체적으로 어떤 분야인가요?</h2>
          <p className="muted">해당하는 분야를 고르세요 (건너뛰면 대분류 전체 추천).</p>
          <div className="chips-row" style={{ maxHeight: 300, overflow: "auto" }}>
            {availCats.map((c) => <button key={c.id} className={`fchip ${csel.has(c.id) ? "on" : ""}`} onClick={() => toggle(csel, c.id, setCsel)}>{c.icon} {c.name}</button>)}
          </div>
          <div className="ob-nav"><button className="btn ghost" onClick={() => setStep(0)}>← 이전</button><button className="btn primary" onClick={() => setStep(2)}>다음 →</button></div>
        </div>
      )}

      {step === 2 && (
        <div className="ob-panel">
          <h2>선호를 알려주세요</h2>
          <label className="facet-opt" style={{ fontSize: 15 }}><input type="checkbox" checked={newPref} onChange={() => setNewPref((v) => !v)} /> 🆕 새로 나온 플랫폼을 우선 추천</label>
          <div className="ob-nav"><button className="btn ghost" onClick={() => setStep(1)}>← 이전</button><button className="btn primary" onClick={() => { Interests.set({ groups: [...gsel], cats: [...csel], newPref }); setStep(3); }}>추천 보기 →</button></div>
        </div>
      )}

      {step === 3 && (
        <div className="ob-panel">
          <h2>맞춤 추천 {recs.length}개</h2>
          <p className="muted">고르신 조건에 맞는 플랫폼입니다. ★로 저장하거나 상세를 확인하세요.</p>
          {recs.length === 0 ? <div className="empty">조건에 맞는 플랫폼이 없습니다. <button className="linklike" onClick={() => setStep(0)}>다시 고르기</button></div>
            : <div className="card-grid">{recs.map((p) => <PlatformCard key={p.id} p={p} />)}</div>}
          <div className="frm-note" style={{ marginTop: 8 }}>선택하신 관심 분야는 저장돼요 — 홈과 "새로 나온 것"에서 내 분야 위주로 볼 수 있습니다.</div>
          <div className="ob-nav">
            <button className="btn ghost" onClick={() => setStep(0)}>처음부터</button>
            {recs.length > 0 && (
              <button className="btn ghost" disabled={savedAll} onClick={() => { recs.forEach((p) => { if (!Favs.has(p.id)) Favs.toggle(p.id); }); setSavedAll(true); }}>
                {savedAll ? "★ 저장됨" : "★ 추천 전체 저장"}
              </button>
            )}
            <button className="btn primary" onClick={() => go("home")}>전체 디렉토리 보기</button>
          </div>
        </div>
      )}
    </div>
  );
}
