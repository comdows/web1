/* 공용 헬퍼 — 데이터 조회·포맷·신뢰가드·비교상태(URL)·계측 */
(function () {
  const P = window.PLATFORMS || [];
  const V = window.VERTICALS || [];
  const TODAY = "2026-07-01"; // 데모 기준일(정적사이트라 고정; 실서비스는 서버시각)

  // 아웃바운드/이벤트 계측 스텁 — 실서비스에서 GA/자체 수집으로 교체
  window.__track = function (event, payload) {
    try { (window.__events = window.__events || []).push({ event, payload, t: TODAY }); } catch (e) {}
    // console.debug("[track]", event, payload);
  };

  function daysBetween(a, b) {
    return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
  }

  window.App = {
    platforms: P,
    verticals: V,
    byId: (id) => P.find((p) => p.platform_id === id),
    byVertical: (vid) => P.filter((p) => p.vertical === vid),
    verticalById: (vid) => V.find((v) => v.id === vid),

    // 신뢰 가드 — high 신뢰 + 공식 출처일 때만 평가성(부정) 서술 렌더 허용 (§12 법적 노출 대응)
    isTrusted(p) {
      return !!(p && p.evidence && p.evidence.confidence === "high");
    },

    // 데이터 신선도 배지 상태
    staleness(p) {
      if (!p.evidence || !p.evidence.next_review_due) return { label: "검증 정보 없음", cls: "warn" };
      const left = daysBetween(TODAY, p.evidence.next_review_due);
      if (left < 0) return { label: "재검증 만료", cls: "bad" };
      if (left < 30) return { label: "재검증 임박", cls: "warn" };
      return { label: "검증 최신", cls: "good" };
    },

    feeText(p) {
      if (p.stub || !p.fee_model) return "정보 준비 중";
      const f = p.fee_model;
      if (f.type === "percent")
        return f.rate_min === f.rate_max ? `${f.rate_min}%` : `${f.rate_min}~${f.rate_max}%`;
      return f.type;
    },

    won: (n) => new Intl.NumberFormat("ko-KR").format(Math.round(n)) + "원",

    // ── 비교 상태: URL(?ids=a,c) 우선, 없으면 localStorage. 정렬해 중복 URL 방지 ──
    getCompareSet() {
      const q = new URLSearchParams(location.search).get("ids");
      if (q) {
        const ids = q.split(",").map((s) => s.trim()).filter(Boolean).filter((id) => this.byId(id));
        if (ids.length) { this.setCompareSet(new Set(ids)); return new Set(ids); }
      }
      try { return new Set(JSON.parse(localStorage.getItem("cmp") || "[]")); }
      catch (e) { return new Set(); }
    },
    setCompareSet(set) {
      try { localStorage.setItem("cmp", JSON.stringify([...set])); } catch (e) {}
    },
    compareUrl(set) {
      const ids = [...(set || this.getCompareSet())].sort();
      return location.origin === "null"
        ? "compare.html?ids=" + ids.join(",")            // file:// 로컬
        : location.pathname.replace(/[^/]*$/, "compare.html") + "?ids=" + ids.join(",");
    },
    toggleCompare(id) {
      const s = this.getCompareSet();
      if (s.has(id)) s.delete(id);
      else {
        if (s.size >= 4) { alert("한 번에 최대 4개까지 비교할 수 있습니다."); return false; }
        s.add(id);
      }
      this.setCompareSet(s);
      window.__track("compare_toggle", { id, size: s.size });
      return true;
    }
  };

  document.addEventListener("DOMContentLoaded", () => {
    const path = location.pathname.split("/").pop() || "index.html";
    document.querySelectorAll("nav.top a").forEach((a) => {
      if ((a.getAttribute("href") || "").split("?")[0] === path) a.classList.add("active");
    });
    const badge = document.getElementById("cmp-count");
    if (badge) badge.textContent = window.App.getCompareSet().size;
  });
})();
