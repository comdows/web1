/* 인앱 알림 센터 — 매칭 알림(브리프↔매물) 등 회원 알림을 모아 보여주고 읽음 처리한다.
 * 생성은 서버 잡(notify.mjs)이 하고, 여기선 열람·읽음·이동만. */
import { useCallback, useEffect, useState } from "react";
import type { Notification } from "./lib/api";
import { listNotifications, markAllNotifsRead, markNotifRead, remoteEnabled } from "./lib/api";
import { useSession } from "./lib/auth";
import { useNav } from "./nav";
import type { ViewName } from "./nav";

function timeAgo(iso: string): string {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (d < 1) return "방금";
  if (d < 60) return `${d}분 전`;
  if (d < 1440) return `${Math.floor(d / 60)}시간 전`;
  return `${Math.floor(d / 1440)}일 전`;
}

export function Notifications() {
  const { session } = useSession();
  const go = useNav();
  const [list, setList] = useState<Notification[] | null>(null);
  const load = useCallback(() => { listNotifications().then(setList).catch(() => setList([])); }, []);
  useEffect(() => { if (session) load(); else setList([]); }, [session, load]);

  if (!remoteEnabled) return <main className="page container"><h1>알림</h1><div className="empty">백엔드 미연결 빌드입니다.</div></main>;
  if (!session) return <main className="page container"><h1>알림</h1><div className="empty">로그인이 필요해요. <button className="linklike" onClick={() => go("account")}>로그인 →</button></div></main>;

  const open = async (n: Notification) => {
    if (!n.read_at) { await markNotifRead(n.id).catch(() => { /* noop */ }); }
    // url은 "?view=exchange" 형태의 상대 경로 → 뷰 이름만 파싱해 이동
    const v = n.url?.match(/view=([a-z-]+)/)?.[1] as ViewName | undefined;
    if (v) go(v); else load();
  };
  const readAll = async () => { await markAllNotifsRead().catch(() => { /* noop */ }); load(); };

  return (
    <main className="page container">
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <h1 style={{ marginBottom: 0 }}>알림</h1>
        {list && list.some((n) => !n.read_at) && (
          <button className="btn ghost sm" style={{ marginLeft: "auto" }} onClick={readAll}>모두 읽음</button>
        )}
      </div>
      {list === null ? <div className="empty">불러오는 중…</div>
        : list.length === 0 ? <div className="empty" style={{ marginTop: 16 }}>아직 알림이 없어요. 인수 브리프를 등록해 두면 조건에 맞는 새 매물이 올 때 알려드려요.</div>
        : (
          <div style={{ display: "grid", gap: 8, marginTop: 16 }}>
            {list.map((n) => (
              <button key={n.id} className={`notif-item${n.read_at ? "" : " unread"}`} onClick={() => open(n)}
                style={{ textAlign: "left", padding: "12px 14px", border: "1px solid var(--line)", borderRadius: 10,
                  background: n.read_at ? "transparent" : "var(--surface-2, var(--surface))", cursor: "pointer", display: "block", width: "100%" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                  {!n.read_at && <span aria-hidden style={{ color: "var(--brand)", fontSize: 10 }}>●</span>}
                  <b style={{ flex: 1 }}>{n.title}</b>
                  <span className="mono faint" style={{ fontSize: 11 }}>{timeAgo(n.created_at)}</span>
                </div>
                {n.body && <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--muted)" }}>{n.body}</p>}
              </button>
            ))}
          </div>
        )}
    </main>
  );
}
