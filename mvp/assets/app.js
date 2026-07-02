/* 공용 모듈 — 데이터 헬퍼 · localStorage 상태(즐겨찾기/최근본) · 카드 템플릿 · 하이드레이션
 * 홈(index.html)과 프리렌더 분야 페이지(c/*.html) 양쪽에서 로드된다.
 * c/ 페이지는 data/platforms.js 없이 이 파일만 로드해도 동작해야 한다(하이드레이션은 id 기반). */
(function () {
  const P = window.PLATFORMS || [];
  const C = window.CATEGORIES || [];
  const G = window.GROUPS || [];

  // ── 계측 스텁 ──
  window.__track = function (event, payload) {
    try { (window.__events = window.__events || []).push({ event, payload }); } catch (e) {}
  };

  // ── localStorage 안전 래퍼 (시크릿모드·file:// 예외 시 메모리 폴백) ──
  const mem = {};
  const Store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v == null ? (key in mem ? mem[key] : fallback) : JSON.parse(v); }
      catch (e) { return key in mem ? mem[key] : fallback; }
    },
    set(key, value) {
      mem[key] = value;
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
    }
  };

  const K = { favs: "pa.favs.v1", recent: "pa.recent.v1", sort: "pa.sort.v1", open: "pa.collapse.v1" };

  const Favs = {
    all() { return Store.get(K.favs, []); },
    has(id) { return this.all().includes(id); },
    toggle(id) {
      const a = this.all(); const i = a.indexOf(id);
      if (i >= 0) a.splice(i, 1); else a.push(id);
      Store.set(K.favs, a);
      window.__track("fav_toggle", { id, on: i < 0 });
      return i < 0;
    }
  };

  const Recent = {
    push(id) {
      let a = Store.get(K.recent, []).filter((r) => r.id !== id);
      a.unshift({ id, t: Date.now() });
      if (a.length > 20) a = a.slice(0, 20);
      Store.set(K.recent, a);
    },
    list(limit) { return Store.get(K.recent, []).slice(0, limit || 12); }
  };

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // 이름 해시 → 색상각 (오프라인 안전 이니셜 아바타)
  function avatarHue(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return h % 360;
  }

  function hostOf(url) { try { return new URL(url).hostname; } catch (e) { return null; } }

  // 카드 템플릿 단일화 — opts: { catLabel: 분야 라벨 표시(검색·평면 리스트용) }
  function cardHTML(p, opts) {
    opts = opts || {};
    const hue = avatarHue(p.name);
    const host = hostOf(p.url);
    const fav = Favs.has(p.id);
    const cat = opts.catLabel ? (C.find((c) => c.id === p.category) || null) : null;
    return `<div class="pcard" data-pid="${esc(p.id)}">
      <div class="row">
        <span class="avatar" style="background:hsl(${hue} 45% 38%)">${esc(p.name.charAt(0))}${host ? `<img class="favicon" loading="lazy" src="https://www.google.com/s2/favicons?domain=${esc(host)}&sz=64" alt="" onerror="this.remove()">` : ""}</span>
        <h3>${esc(p.name)}${p.new ? '<span class="new-tag">NEW</span>' : ""}</h3>
        <button class="star${fav ? " on" : ""}" data-star="${esc(p.id)}" aria-label="즐겨찾기" title="즐겨찾기">${fav ? "★" : "☆"}</button>
      </div>
      <p class="blurb">${esc(p.blurb)}</p>
      <div class="cardfoot">
        <span class="chip">${esc(p.region)}</span>
        ${cat ? `<span class="chip">${esc(cat.icon)} ${esc(cat.name)}</span>` : ""}
        <a class="btn ghost gosite" href="${esc(p.url)}" target="_blank" rel="nofollow noopener" data-go="${esc(p.id)}">공식 ↗</a>
      </div>
    </div>`;
  }

  // 정적 페이지(c/*.html)용: data-star 버튼 상태 채우기 + 위임 리스너 (PLATFORMS 없이 동작)
  function hydrateStars(root) {
    root = root || document;
    root.querySelectorAll("[data-star]").forEach((b) => {
      const on = Favs.has(b.getAttribute("data-star"));
      b.classList.toggle("on", on);
      b.textContent = on ? "★" : "☆";
    });
    root.addEventListener("click", (e) => {
      const b = e.target.closest("[data-star]");
      if (b) {
        const on = Favs.toggle(b.getAttribute("data-star"));
        b.classList.toggle("on", on);
        b.textContent = on ? "★" : "☆";
        e.preventDefault();
        return;
      }
      const go = e.target.closest("[data-go]");
      if (go) { Recent.push(go.getAttribute("data-go")); window.__track("outbound", { id: go.getAttribute("data-go") }); }
    });
  }

  function debounce(fn, ms) {
    let t;
    return function () { const a = arguments, self = this; clearTimeout(t); t = setTimeout(() => fn.apply(self, a), ms); };
  }

  window.App = {
    platforms: P, categories: C, groups: G,
    Store, K, Favs, Recent, esc, avatarHue, cardHTML, hydrateStars, debounce,
    byId: (id) => P.find((p) => p.id === id || p.platform_id === id),
    byCategory: (cid) => P.filter((p) => p.category === cid),
    categoryById: (cid) => C.find((c) => c.id === cid),
    categoriesByGroup: (gid) => C.filter((c) => c.group === gid)
  };

  document.addEventListener("DOMContentLoaded", () => {
    const path = location.pathname.split("/").pop() || "index.html";
    document.querySelectorAll("nav.top a").forEach((a) => {
      if ((a.getAttribute("href") || "").split("?")[0] === path) a.classList.add("active");
    });
  });
})();
