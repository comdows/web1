#!/usr/bin/env node
/*
 * build.js — 프리렌더 빌드 (프레임워크 없음, 순수 Node)
 * ─────────────────────────────────────────────────────────────
 * platforms.js 단일 소스로부터:
 *   1) 딥 레코드 스키마 검증 (실패 시 빌드 중단 = CI 게이트, 기획서 §7.2)
 *   2) /crowdfunding/{id}.html  — 색인 가능한 고유 URL, 본문 텍스트 + meta + OG + JSON-LD
 *   3) /compare/{a}-vs-{c}.html — 15개 pair, canonical 정규화
 *   4) sitemap.xml, robots.txt  — 딥 페이지만 색인, 스텁은 noindex
 * 실행:  node build.js   (mvp/ 디렉터리에서)
 */
const fs = require("fs");
const path = require("path");
const CFG = require("./data/platforms.js");

const ROOT = __dirname;
const SITE = "https://platformall.example"; // 실제 도메인으로 교체
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ── 1) 스키마 검증 (딥 레코드) ──────────────────────────────
function validate(platforms) {
  const errors = [];
  for (const p of platforms) {
    if (p.stub) {
      if (!p.source_url) errors.push(`[stub ${p.platform_id}] source_url 누락`);
      continue;
    }
    const req = [
      ["fee_model", p.fee_model],
      ["settlement", p.settlement],
      ["evidence", p.evidence],
      ["evidence.source_url", p.evidence && p.evidence.source_url],
      ["evidence.verified_at", p.evidence && p.evidence.verified_at],
      ["outbound_url", p.outbound_url],
    ];
    for (const [name, v] of req) if (v == null || v === "") errors.push(`[deep ${p.platform_id}] ${name} 누락`);
    // 요율 공개(disclosed) 레코드만 숫자 강제. 비공개는 rate null 허용하되 note 필수(지어내기 방지).
    if (p.fee_model) {
      if (p.fee_model.disclosed === false) {
        if (!p.fee_model.note) errors.push(`[deep ${p.platform_id}] fee_model.disclosed=false인데 note(비공개 사유) 누락`);
      } else if (typeof p.fee_model.rate_min !== "number" || typeof p.fee_model.rate_max !== "number") {
        errors.push(`[deep ${p.platform_id}] 요율 공개 레코드인데 rate_min/max 숫자 아님(NaN 전파 위험)`);
      }
    }
  }
  if (errors.length) {
    console.error("❌ 데이터 스키마 검증 실패:\n" + errors.map((e) => "  - " + e).join("\n"));
    process.exit(1);
  }
  console.log(`✅ 스키마 검증 통과 (${platforms.length}개 레코드)`);
}

// ── 공통 HTML 셸 ────────────────────────────────────────────
function page({ title, desc, canonical, jsonld, body, noindex, depth }) {
  const asset = depth ? "../assets" : "assets";
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
${noindex ? '<meta name="robots" content="noindex,follow">' : '<meta name="robots" content="index,follow">'}
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(canonical)}">
<link rel="stylesheet" href="${asset}/style.css">
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>` : ""}
</head>
<body>
<header class="site"><div class="container">
  <div class="logo">플랫폼<b>올</b></div>
  <nav class="top">
    <a href="${depth ? "../" : ""}index.html">발견·비교</a>
    <a href="${depth ? "../" : ""}compare.html">비교함</a>
    <a href="${depth ? "../" : ""}calculator.html">실수령 계산기</a>
  </nav>
</div></header>
<main class="container">${body}</main>
<footer class="site"><div class="container">
  플랫폼올 (가칭) · 1단계 MVP 데모 · 수수료·정산은 예시이며 계약 전 원문 약관 확인이 필요합니다.
</div></footer>
</body>
</html>`;
}

// ── 2) 플랫폼 상세 정적 페이지 ──────────────────────────────
function feeText(p) {
  const f = p.fee_model;
  if (f.disclosed === false || f.rate_min == null) return "요율 비공개";
  return f.rate_min === f.rate_max ? `${f.rate_min}%` : `${f.rate_min}~${f.rate_max}%`;
}
function cycleText(s) {
  return s.cycle_days == null ? "확인 불가(공식 미확인)" : `${s.cycle_days}일`;
}
function platformPage(p) {
  const f = p.fee_model, s = p.settlement;
  const title = `${p.name} 수수료·정산주기 비교 | 플랫폼올`;
  const desc = `${p.name} 크라우드펀딩 수수료 ${feeText(p)}, 정산주기 ${cycleText(s)}. 숨은 비용·가입 조건을 같은 기준으로 비교하세요. (출처 표기 데이터)`;
  const canonical = `${SITE}/crowdfunding/${p.platform_id}.html`;
  // FAQPage + BreadcrumbList (rich result 대응)
  const jsonld = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "FAQPage",
        "mainEntity": [
          { "@type": "Question", "name": `${p.name} 수수료는 얼마인가요?`,
            "acceptedAnswer": { "@type": "Answer", "text": (f.disclosed === false ? `${p.name}의 플랫폼 수수료율은 공식 페이지에 공개되어 있지 않아 직접 문의가 필요합니다.` : `${p.name}의 플랫폼 수수료는 약 ${feeText(p)} 수준입니다.`) + ((f.hidden_fees||[]).length ? " 추가로 " + f.hidden_fees.join(", ") + "이(가) 있을 수 있습니다." : "") + " (출처 표기, 계약 전 원문 확인 필요)" } },
          { "@type": "Question", "name": `${p.name} 정산주기는 어떻게 되나요?`,
            "acceptedAnswer": { "@type": "Answer", "text": `${p.name}의 정산주기는 ${cycleText(s)}입니다${s.escrow ? ", 에스크로가 적용됩니다" : ""}${s.holdback_pct ? `, 정산유보 ${s.holdback_pct}%가 있습니다` : ""}.` } },
        ],
      },
      { "@type": "BreadcrumbList", "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "발견·비교", "item": `${SITE}/index.html` },
        { "@type": "ListItem", "position": 2, "name": "크라우드펀딩", "item": `${SITE}/index.html#beachhead` },
        { "@type": "ListItem", "position": 3, "name": p.name, "item": canonical },
      ] },
    ],
  };
  const body = `
    <nav class="sub" style="margin-top:20px"><a href="../index.html">발견·비교</a> › 크라우드펀딩 › ${esc(p.name)}</nav>
    <h1>${esc(p.name)} 수수료·정산 비교</h1>
    <p class="sub">${esc(p.funding_type || "")} · ${esc((p.region||[]).join(", "))} · 데모 예시 데이터</p>
    <div class="ad-slot"><b>[광고 자리]</b> 상위노출/입점 슬롯 (Sponsored)</div>
    <dl class="kv">
      <dt>플랫폼 수수료</dt><dd><b>${feeText(p)}</b> ${(f.hidden_fees||[]).length ? "· 추가: " + esc(f.hidden_fees.join(", ")) : ""} ${f.note ? "<br><span class='muted'>" + esc(f.note) + "</span>" : ""}</dd>
      <dt>정산주기</dt><dd>${cycleText(s)} ${s.escrow ? "· 에스크로" : ""} ${s.holdback_pct ? "· 정산유보 " + s.holdback_pct + "%" : ""}</dd>
      <dt>가입 대상</dt><dd>${esc(p.onboarding.biz_type_required)}</dd>
      <dt>강점</dt><dd>${esc((p.highlights||[]).join(", "))}</dd>
      ${(p.facts||[]).length ? "<dt>사실(출처)</dt><dd>" + esc(p.facts.join(" · ")) + "</dd>" : ""}
    </dl>
    <p>${esc(p.name)}의 정산주기는 <b>${cycleText(s)}</b>이며, 플랫폼 수수료는 ${f.disclosed === false ? "<b>공식 미공개</b>(직접 문의 필요)" : "약 <b>" + feeText(p) + "</b>"}입니다.
       실제 조건은 <a href="${esc(p.outbound_url)}" target="_blank" rel="nofollow sponsored noopener">공식 사이트</a> 및
       <a href="${esc(p.evidence.source_url)}" target="_blank" rel="nofollow noopener">원문 안내</a>에서 확인하세요. (데이터 신뢰도: ${esc(p.evidence.confidence)})</p>
    <div class="cta" style="display:flex;gap:12px;flex-wrap:wrap;margin-top:16px">
      <a class="btn primary" href="${esc(p.outbound_url)}" target="_blank" rel="nofollow sponsored noopener">${esc(p.name)} 공식 사이트 ↗</a>
      <a class="btn ghost" href="../platform.html?id=${esc(p.platform_id)}">인터랙티브 상세</a>
      <a class="btn ghost" href="../calculator.html">💰 실수령 계산</a>
    </div>`;
  return page({ title, desc, canonical, jsonld, body, depth: true });
}

// ── 3) 비교 pair 정적 페이지 ────────────────────────────────
function comparePage(a, b) {
  const [x, y] = [a, b].sort((m, n) => m.platform_id.localeCompare(n.platform_id));
  const slug = `${x.platform_id}-vs-${y.platform_id}`;
  const title = `${x.name} vs ${y.name} 수수료·정산 비교 | 플랫폼올`;
  const desc = `${x.name}(수수료 ${feeText(x)}, 정산 ${cycleText(x.settlement)}) vs ${y.name}(수수료 ${feeText(y)}, 정산 ${cycleText(y.settlement)}) 크라우드펀딩 비교. (출처 표기)`;
  const canonical = `${SITE}/compare/${slug}.html`;
  const row = (label, fx, fy) => `<tr><th>${esc(label)}</th><td>${fx}</td><td>${fy}</td></tr>`;
  const body = `
    <nav class="sub" style="margin-top:20px"><a href="../index.html">발견·비교</a> › 비교 › ${esc(x.name)} vs ${esc(y.name)}</nav>
    <h1>${esc(x.name)} vs ${esc(y.name)}</h1>
    <p class="sub">크라우드펀딩 수수료·정산 비교 · 데모 예시 데이터</p>
    <div class="cmp-wrap"><table class="cmp">
      <thead><tr><th>항목</th><th>${esc(x.name)}</th><th>${esc(y.name)}</th></tr></thead>
      <tbody>
        ${row("수수료", feeText(x), feeText(y))}
        ${row("정산주기", cycleText(x.settlement), cycleText(y.settlement))}
        ${row("펀딩 유형", esc(x.funding_type), esc(y.funding_type))}
        ${row("지역", esc((x.region||[]).join(", ")), esc((y.region||[]).join(", ")))}
        ${row("가입 대상", esc(x.onboarding.biz_type_required), esc(y.onboarding.biz_type_required))}
      </tbody>
    </table></div>
    <p style="margin-top:14px">${esc(x.name)}와(과) ${esc(y.name)} 중 선택은 수수료(${feeText(x)} vs ${feeText(y)})와
       정산주기(${cycleText(x.settlement)} vs ${cycleText(y.settlement)})를 기준으로 판단하세요. 출처 표기 데이터이니 계약 전 원문 확인 필수.</p>
    <div class="cta" style="display:flex;gap:12px;margin-top:16px">
      <a class="btn primary" href="../compare.html?ids=${esc(x.platform_id)},${esc(y.platform_id)}">인터랙티브 비교 ↗</a>
      <a class="btn ghost" href="../calculator.html">💰 실수령 계산</a>
    </div>`;
  return { slug, html: page({ title, desc, canonical, body, depth: true }) };
}

// ── 실행 ────────────────────────────────────────────────────
const platforms = CFG.platforms;
validate(platforms);

const deep = platforms.filter((p) => !p.stub && p.vertical === "crowdfunding");
const cfDir = path.join(ROOT, "crowdfunding");
const cmpDir = path.join(ROOT, "compare");
fs.mkdirSync(cfDir, { recursive: true });
fs.mkdirSync(cmpDir, { recursive: true });

const urls = [`${SITE}/index.html`, `${SITE}/calculator.html`];

for (const p of deep) {
  fs.writeFileSync(path.join(cfDir, `${p.platform_id}.html`), platformPage(p));
  urls.push(`${SITE}/crowdfunding/${p.platform_id}.html`);
}

let pairs = 0;
for (let i = 0; i < deep.length; i++)
  for (let j = i + 1; j < deep.length; j++) {
    const { slug, html } = comparePage(deep[i], deep[j]);
    fs.writeFileSync(path.join(cmpDir, `${slug}.html`), html);
    urls.push(`${SITE}/compare/${slug}.html`);
    pairs++;
  }

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${esc(u)}</loc><lastmod>2026-07-01</lastmod></url>`).join("\n")}
</urlset>`;
fs.writeFileSync(path.join(ROOT, "sitemap.xml"), sitemap);

fs.writeFileSync(path.join(ROOT, "robots.txt"),
  `User-agent: *\nAllow: /\n# 카탈로그 스텁은 개별 페이지 meta noindex로 제어\nSitemap: ${SITE}/sitemap.xml\n`);

console.log(`✅ 프리렌더 완료: 플랫폼 ${deep.length}개, 비교 pair ${pairs}개, sitemap ${urls.length}개 URL`);
console.log(`   → crowdfunding/, compare/, sitemap.xml, robots.txt`);
