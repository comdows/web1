/* 관심 프로필 서버 동기화(0031) — favsync와 동형. 로그인하면 서버·로컬을 합쳐
 * 서버 우선(다른 기기의 최신 선택)으로 로컬을 맞추고, 서버가 비었으면 로컬을 올린다.
 * 이후 관심 변경(Interests.set)은 서버에도 반영. 비로그인·오프라인이면 로컬만. */
import { Interests, setInterestSync } from "./store";
import type { InterestsState } from "./store";
import { getSession, onAuth } from "./auth";
import { fetchMyInterests, saveMyInterests, remoteEnabled } from "./api";

let started = false;
let lastUid: string | null = null;

async function pullOrPush(): Promise<void> {
  try {
    const server = await fetchMyInterests();
    if (server && (server.groups.length || server.cats.length || server.new_pref)) {
      Interests.setLocal({ groups: server.groups, cats: server.cats, newPref: server.new_pref }); // 서버 → 로컬(재푸시 없이)
    } else {
      const local = Interests.get();
      if (local && (local.groups.length || local.cats.length || local.newPref)) await saveMyInterests(local); // 로컬 → 서버
    }
  } catch { /* 동기화 실패해도 로컬 관심은 그대로 동작 */ }
}

export function startInterestSync(): void {
  if (started || !remoteEnabled) return;
  started = true;
  // 관심 변경 시 서버 반영(로그인 상태에서만)
  setInterestSync((s: InterestsState) => { if (getSession()) void saveMyInterests(s); });
  const onChange = () => {
    const uid = getSession()?.user.id ?? null;
    if (uid === lastUid) return;
    lastUid = uid;
    if (uid) void pullOrPush();
  };
  onAuth(onChange);
  onChange(); // 저장된 세션으로 시작한 경우
}
