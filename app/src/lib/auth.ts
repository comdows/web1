/* Supabase Auth(GoTrue) 최소 클라이언트 — 이메일+비밀번호.
 * supabase-js 없이 REST 직접 호출(번들 최소화, api.ts와 동일 원칙).
 * 세션은 localStorage 유지, 만료 60초 전 refresh_token으로 자동 갱신. */
import { useEffect, useState } from "react";

const SB_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SB_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
export const authEnabled = Boolean(SB_URL && SB_KEY);

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
}

const KEY = "sm.session.v1";
let session: Session | null = null;
let profile: Profile | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function load(): Session | null {
  try { const v = localStorage.getItem(KEY); return v ? JSON.parse(v) : null; } catch { return null; }
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
  if (!res.ok) throw new Error(data.msg || data.error_description || data.message || `AUTH ${res.status}`);
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

/* 가입 — Supabase의 "Confirm email" 설정이 켜져 있으면 세션 없이 확인 메일만 발송된다 */
export async function signUp(email: string, password: string): Promise<{ needsConfirm: boolean }> {
  const s = toSession(await gotrue("signup", { email, password }));
  if (s) { save(s); return { needsConfirm: false }; }
  return { needsConfirm: true };
}
export async function signIn(email: string, password: string): Promise<void> {
  const s = toSession(await gotrue("token?grant_type=password", { email, password }));
  if (!s) throw new Error("로그인 응답에 세션이 없습니다");
  save(s);
}
export function signOut(): void { save(null); }

/* 유효한 액세스 토큰 — 만료 임박 시 갱신, 갱신 실패 시 로그아웃 처리 */
export async function getAccessToken(): Promise<string | null> {
  if (!session) return null;
  if (session.expires_at - 60 > Date.now() / 1000) return session.access_token;
  try {
    const s = toSession(await gotrue("token?grant_type=refresh_token", { refresh_token: session.refresh_token }));
    if (s) { save(s); return s.access_token; }
  } catch { /* 갱신 실패 → 아래에서 세션 폐기 */ }
  save(null);
  return null;
}
export const getSession = (): Session | null => session;
export const getProfile = (): Profile | null => profile;

async function loadProfile(): Promise<void> {
  const token = await getAccessToken();
  if (!token || !session) return;
  try {
    const res = await fetch(`${SB_URL}/rest/v1/profiles?id=eq.${session.user.id}&select=id,role,display_name`, {
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

/* init: 저장된 세션 복원 */
session = load();
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
