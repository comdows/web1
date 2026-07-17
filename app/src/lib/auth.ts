/* Supabase Auth(GoTrue) 최소 클라이언트 — 이메일+비밀번호.
 * supabase-js 없이 REST 직접 호출(번들 최소화, api.ts와 동일 원칙).
 * 세션은 localStorage 유지, 만료 60초 전 refresh_token으로 자동 갱신. */
import { useEffect, useState } from "react";

const SB_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SB_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
export const authEnabled = Boolean(SB_URL && SB_KEY);

/* 확인 메일 링크가 돌아올 주소 — GitHub Pages 서브패스(/web1/)를 포함해야 앱으로 복귀한다.
 * 이 URL을 Supabase Auth의 Site URL·Redirect 허용목록에도 등록해야 링크가 유효하다. */
const REDIRECT_URL = typeof location !== "undefined" ? location.origin + import.meta.env.BASE_URL : "";

export interface Session {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch seconds
  user: { id: string; email?: string };
}
export interface Profile {
  id: string;
  role: "user" | "operator" | "admin";
  display_name: string | null;
  founder_optin_at?: string | null; // 유료화 공지 알림 신청 시각(0011) — 버튼 상태 복원용
}

const KEY = "sm.session.v1";
let session: Session | null = null;
let profile: Profile | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/* 손상·조작된 세션 방어: 유효 JSON이어도 형태가 어긋나면(user.id 없음 등) 무효로 간주해 폐기한다.
 * (store.ts readSet/Interests.get의 shape 검증과 동일 원칙 — 조작된 sm.session.v1 주입 시
 *  이후 session.user.id/email 참조가 TypeError로 터지는 것을 부팅 시점에 차단.) */
function isValidSession(s: unknown): s is Session {
  if (!s || typeof s !== "object") return false;
  const o = s as Record<string, unknown>;
  const u = o.user as Record<string, unknown> | undefined;
  return typeof o.access_token === "string" && !!u && typeof u.id === "string" && u.id.length > 0;
}
function load(): Session | null {
  try {
    const v = localStorage.getItem(KEY);
    if (!v) return null;
    const parsed = JSON.parse(v);
    if (!isValidSession(parsed)) { localStorage.removeItem(KEY); return null; }
    return parsed;
  } catch { return null; }
}
function save(s: Session | null) {
  session = s;
  try { if (s) localStorage.setItem(KEY, JSON.stringify(s)); else localStorage.removeItem(KEY); } catch { /* noop */ }
  if (!s) profile = null;
  emit();
  if (s) void loadProfile();
}

interface TokenResponse {
  access_token?: string; refresh_token?: string; expires_at?: number; expires_in?: number;
  user?: { id: string; email?: string };
}
async function gotrue(path: string, body: unknown): Promise<TokenResponse> {
  const res = await fetch(`${SB_URL}/auth/v1/${path}`, {
    method: "POST",
    headers: { apikey: SB_KEY!, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as TokenResponse & { msg?: string; error_description?: string; message?: string };
  if (!res.ok) {
    // status를 부착해 갱신 실패의 원인(확정 무효 4xx vs 순단 5xx/네트워크)을 구분할 수 있게 한다
    const err = new Error(data.msg || data.error_description || data.message || `AUTH ${res.status}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return data;
}
function toSession(d: TokenResponse): Session | null {
  if (!d.access_token || !d.user?.id) return null;
  return {
    access_token: d.access_token,
    refresh_token: d.refresh_token ?? "",
    expires_at: d.expires_at ?? Math.floor(Date.now() / 1000) + (d.expires_in ?? 3600),
    user: { id: d.user.id, email: d.user.email },
  };
}

const redirectQ = REDIRECT_URL ? `?redirect_to=${encodeURIComponent(REDIRECT_URL)}` : "";

/* 가입 — Supabase의 "Confirm email" 설정이 켜져 있으면 세션 없이 확인 메일만 발송된다.
 * redirect_to로 확인 링크가 우리 앱(/web1/)으로 돌아오게 한다.
 * termsVersion: 가입 시 동의한 약관 버전을 user_metadata에 기록(분쟁 시 동의 근거). */
export async function signUp(email: string, password: string, termsVersion?: string): Promise<{ needsConfirm: boolean }> {
  const s = toSession(await gotrue(`signup${redirectQ}`, {
    email, password,
    ...(termsVersion ? { data: { terms_version: termsVersion, terms_agreed_at: new Date().toISOString() } } : {}),
  }));
  if (s) { save(s); return { needsConfirm: false }; }
  return { needsConfirm: true };
}
export async function signIn(email: string, password: string): Promise<void> {
  const s = toSession(await gotrue("token?grant_type=password", { email, password }));
  if (!s) throw new Error("로그인 응답에 세션이 없습니다");
  save(s);
}
/* 확인 메일 재발송(미확인 계정용) */
export async function resendConfirmation(email: string): Promise<void> {
  await gotrue(`resend${redirectQ}`, { type: "signup", email });
}
/* 비밀번호 재설정 메일 — 링크는 #type=recovery 해시로 앱에 돌아온다 */
export async function requestPasswordReset(email: string): Promise<void> {
  await gotrue(`recover${redirectQ}`, { email });
}
/* 비밀번호 변경(로그인/recovery 세션 필요) */
export async function updatePassword(password: string): Promise<void> {
  const token = await getAccessToken();
  if (!token) throw new Error("로그인이 필요합니다");
  const res = await fetch(`${SB_URL}/auth/v1/user`, {
    method: "PUT",
    headers: { apikey: SB_KEY!, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const data = (await res.json().catch(() => ({}))) as { msg?: string; error_description?: string };
  if (!res.ok) throw new Error(data.msg || data.error_description || `AUTH ${res.status}`);
}
/* 이메일 변경 — GoTrue가 신·구 주소로 확인 메일을 보내고, 새 주소의 링크 클릭 시 완료된다.
 * 소개는 계정 이메일로만 이뤄지므로(v_admin_intro_queue) 이 경로가 없으면 이직·메일 폐기 시 연락 두절. */
export async function updateEmail(newEmail: string): Promise<void> {
  const token = await getAccessToken();
  if (!token) throw new Error("로그인이 필요합니다");
  const res = await fetch(`${SB_URL}/auth/v1/user${redirectQ}`, {
    method: "PUT",
    headers: { apikey: SB_KEY!, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email: newEmail }),
  });
  const data = (await res.json().catch(() => ({}))) as { msg?: string; error_description?: string };
  if (!res.ok) throw new Error(data.msg || data.error_description || `AUTH ${res.status}`);
}
export function signOut(): void { save(null); }

/* 유효한 액세스 토큰 — 만료 임박 시 갱신.
 * 갱신 실패는 원인을 구분한다: 4xx(invalid_grant 등)는 확정 무효라 세션 폐기,
 * 네트워크 예외·5xx는 순단일 수 있으므로 refresh_token을 보존하고 다음 호출에서 재시도
 * (긴 폼 작성 중 모바일 순단 한 번에 강제 로그아웃되는 사고 방지). */
export async function getAccessToken(): Promise<string | null> {
  if (!session) return null;
  if (session.expires_at - 60 > Date.now() / 1000) return session.access_token;
  try {
    const s = toSession(await gotrue("token?grant_type=refresh_token", { refresh_token: session.refresh_token }));
    if (s) { save(s); return s.access_token; }
    save(null); // 응답은 정상인데 세션 형태가 아님 — 확정 무효로 간주
  } catch (e) {
    const status = (e as Error & { status?: number }).status;
    if (status !== undefined && status >= 400 && status < 500) save(null);
    // 그 외(네트워크 reject·5xx): 세션 유지 — 이번 호출만 실패 처리
  }
  return null;
}
export const getSession = (): Session | null => session;
export const getProfile = (): Profile | null => profile;

async function loadProfile(): Promise<void> {
  const token = await getAccessToken();
  if (!token || !session) return;
  try {
    const res = await fetch(`${SB_URL}/rest/v1/profiles?id=eq.${session.user.id}&select=id,role,display_name,founder_optin_at`, {
      headers: { apikey: SB_KEY!, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const rows = (await res.json()) as Profile[];
    profile = rows[0] ?? null;
    emit();
  } catch { /* 프로필은 편의 정보 — 실패해도 세션은 유효 */ }
}
export function refreshProfile(): void { void loadProfile(); }

/* 인증 상태 변경 구독(즐겨찾기 동기화 등) */
export function onAuth(fn: () => void): void { listeners.add(fn); }

/* access_token(JWT)에서 sub·email·exp 추출 — 확인 콜백 해시엔 user 객체가 없다 */
function decodeJwt(token: string): { sub?: string; email?: string; exp?: number } | null {
  try {
    const payload = token.split(".")[1];
    return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
  } catch { return null; }
}

/* 확인 메일 링크 복귀 처리 — GoTrue는 #access_token=… 또는 #error_description=… 해시로 돌아온다.
 * 토큰이면 세션 주입, 오류면 안내 메시지 저장. 처리 후 해시 제거(새로고침 시 재실행 방지). */
let hashNotice: string | null = null;
let recoveryPending = false; // 비밀번호 재설정 링크로 복귀 — 새 비밀번호 입력 필요
export function consumeRecoveryPending(): boolean { const v = recoveryPending; recoveryPending = false; return v; }
function consumeAuthHash(): void {
  if (typeof location === "undefined" || !location.hash) return;
  const h = new URLSearchParams(location.hash.slice(1));
  const at = h.get("access_token");
  const err = h.get("error_description") || h.get("error");
  if (at) {
    const c = decodeJwt(at);
    if (c?.sub) {
      save({
        access_token: at,
        refresh_token: h.get("refresh_token") ?? "",
        expires_at: c.exp ?? Math.floor(Date.now() / 1000) + Number(h.get("expires_in") ?? 3600),
        user: { id: c.sub, email: c.email },
      });
      if (h.get("type") === "recovery") {
        recoveryPending = true;
        hashNotice = "본인 확인 완료 — 아래에서 새 비밀번호를 설정해 주세요.";
        // 복구 링크는 홈으로 돌아오는데 비밀번호 폼은 계정 화면에만 있다 — 막다른 길 방지 라우팅
        history.replaceState(null, "", location.pathname + "?view=account");
        return;
      } else if (h.get("provider_token")) {
        hashNotice = "소셜 계정으로 로그인됐어요.";
        // OAuth 첫 로그인엔 가입 폼이 없으므로 약관 동의 버전을 메타데이터로 기록(멱등)
        void recordTermsMeta(at);
      } else {
        hashNotice = "이메일 확인이 완료됐어요. 로그인된 상태입니다.";
      }
    }
    history.replaceState(null, "", location.pathname + location.search);
  } else if (err) {
    hashNotice = /expired|invalid/i.test(err)
      ? "확인 링크가 만료됐거나 이미 사용됐어요. 다시 로그인하거나 확인 메일을 재발송해 주세요."
      : decodeURIComponent(err);
    history.replaceState(null, "", location.pathname + location.search);
  }
}
async function recordTermsMeta(token: string): Promise<void> {
  try {
    await fetch(`${SB_URL}/auth/v1/user`, {
      method: "PUT",
      headers: { apikey: SB_KEY!, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ data: { terms_version: "oauth", terms_agreed_at: new Date().toISOString() } }),
    });
  } catch { /* noop */ }
}

/* Google OAuth — Supabase 대시보드에서 provider 활성화 필요(FLAGS.googleAuth로 노출 제어) */
export function signInWithGoogle(): void {
  location.href = `${SB_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(REDIRECT_URL)}`;
}

/* AuthPanel이 1회 소비(표시 후 비움) */
export function consumeHashNotice(): string | null { const n = hashNotice; hashNotice = null; return n; }

/* init: 저장된 세션 복원 → 확인 콜백 해시 처리 */
session = load();
consumeAuthHash();
if (session) void loadProfile();

export function useSession() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return { session, profile, isAdmin: profile?.role === "admin" };
}
