/* 즐겨찾기 서버 동기화 — 로그인하면 서버·로컬을 합집합으로 병합하고,
 * 이후 토글은 서버에도 반영(fire-and-forget). 비로그인·오프라인이면 로컬만 사용. */
import { Draft, Favs, setFavSync } from "./store";
import { getSession, onAuth } from "./auth";
import { fetchServerFavs, removeFavorite, remoteEnabled, upsertFavorite } from "./api";

let started = false;
let lastUid: string | null = null;

async function pullAndPush(): Promise<void> {
  try {
    const server = await fetchServerFavs();
    const local = Favs.all();
    Favs.merge(server); // 서버 → 로컬
    for (const id of local.filter((x) => !server.includes(x))) {
      await upsertFavorite(id).catch(() => { /* 개별 실패 무시 */ }); // 로컬 → 서버
    }
  } catch { /* 동기화 실패해도 로컬 즐겨찾기는 그대로 동작 */ }
}

export function startFavSync(): void {
  if (started || !remoteEnabled) return;
  started = true;
  setFavSync((id, on) => {
    if (!getSession()) return;
    void (on ? upsertFavorite(id) : removeFavorite(id)).catch(() => { /* 다음 로그인 병합 때 복구 */ });
  });
  const onChange = () => {
    const uid = getSession()?.user.id ?? null;
    if (uid === lastUid) return; // 프로필 로드 등 무관한 emit 무시
    const prev = lastUid;
    lastUid = uid;
    // 로그아웃·계정 전환 시 이전 사용자의 로컬 즐겨찾기·폼 초안 제거(공용 PC 오염 방지).
    // 최초 로그인(prev=null)은 비우지 않는다 — 비로그인 때 담은 즐겨찾기를 계정에 병합.
    if (prev && prev !== uid) { Favs.clear(); Draft.clear("partner"); Draft.clear("sell"); }
    if (uid) void pullAndPush();
  };
  onAuth(onChange);
  onChange(); // 저장된 세션으로 시작한 경우
}
