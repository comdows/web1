/* 공용 헬퍼 — 데이터 조회·포맷·비교 선택 상태 */
(function () {
  const P = window.PLATFORMS || [];
  const V = window.VERTICALS || [];

  window.App = {
    platforms: P,
    verticals: V,
    byId: (id) => P.find((p) => p.platform_id === id),
    byVertical: (vid) => P.filter((p) => p.vertical === vid),
    verticalById: (vid) => V.find((v) => v.id === vid),

    // 수수료 범위 텍스트
    feeText(p) {
      if (p.stub || !p.fee_model) return "정보 준비 중";
      const f = p.fee_model;
      if (f.type === "percent")
        return f.rate_min === f.rate_max ? `${f.rate_min}%` : `${f.rate_min}~${f.rate_max}%`;
      return f.type;
    },

    won(n) {
      return new Intl.NumberFormat("ko-KR").format(Math.round(n)) + "원";
    },

    // 비교함(localStorage 대신 URL 파라미터 기반 단순 관리)
    getCompareSet() {
      try {
        return new Set(JSON.parse(localStorage.getItem("cmp") || "[]"));
      } catch (e) {
        return new Set();
      }
    },
    setCompareSet(set) {
      localStorage.setItem("cmp", JSON.stringify([...set]));
    },
    toggleCompare(id) {
      const s = this.getCompareSet();
      if (s.has(id)) s.delete(id);
      else {
        if (s.size >= 4) {
          alert("한 번에 최대 4개까지 비교할 수 있습니다.");
          return false;
        }
        s.add(id);
      }
      this.setCompareSet(s);
      return true;
    }
  };

  // 헤더 활성 표시
  document.addEventListener("DOMContentLoaded", () => {
    const path = location.pathname.split("/").pop() || "index.html";
    document.querySelectorAll("nav.top a").forEach((a) => {
      if (a.getAttribute("href") === path) a.classList.add("active");
    });
    // 비교 카운트 배지
    const badge = document.getElementById("cmp-count");
    if (badge) badge.textContent = window.App.getCompareSet().size;
  });
})();
