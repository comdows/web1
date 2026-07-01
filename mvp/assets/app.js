/* 공용 헬퍼 — 디렉토리(분야별 목록) */
(function () {
  const P = window.PLATFORMS || [];
  const C = window.CATEGORIES || [];

  window.__track = function (event, payload) {
    try { (window.__events = window.__events || []).push({ event, payload }); } catch (e) {}
  };

  window.App = {
    platforms: P,
    categories: C,
    byCategory: (cid) => P.filter((p) => p.category === cid),
    categoryById: (cid) => C.find((c) => c.id === cid)
  };

  document.addEventListener("DOMContentLoaded", () => {
    const path = location.pathname.split("/").pop() || "index.html";
    document.querySelectorAll("nav.top a").forEach((a) => {
      if ((a.getAttribute("href") || "").split("?")[0] === path) a.classList.add("active");
    });
  });
})();
