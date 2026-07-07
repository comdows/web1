// 세모플 — 제휴 제안 서버 발송(Edge Function) · Deno
// ⚠️ 배포·시크릿 설정 전까지 동작하지 않음. app_settings 'outreach'.server_send=false면 즉시 거부.
//
// 배포:
//   supabase functions deploy send-proposal
// 필요한 시크릿:
//   supabase secrets set RESEND_API_KEY=... EMAIL_FROM="세모플 제휴 <partner@yourdomain>"
//   (Resend 대신 SES/Postmark 등으로 바꾸려면 sendEmail()만 교체)
// 발신 도메인은 SPF/DKIM/DMARC 인증이 되어 있어야 스팸함을 피한다(정보통신망법 준비와 함께).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const SB_URL = Deno.env.get("SUPABASE_URL")!;
    const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const authHeader = req.headers.get("Authorization") ?? "";

    // 호출자(회원) 인증 — anon 클라이언트 + 사용자 JWT
    const asUser = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: "로그인이 필요합니다" }, 401);

    // 권한을 넘는 조회·기록은 service 컨텍스트(RLS 우회)로 — 단 게이트·상한·수신거부를 서버가 강제
    const admin = createClient(SB_URL, SB_SERVICE);

    // 1) 서버 발송 스위치(법적 게이트)
    const { data: setting } = await admin.from("app_settings").select("value").eq("key", "outreach").single();
    const cfg = (setting?.value ?? {}) as { server_send?: boolean; from_name?: string; daily_cap?: number };
    if (!cfg.server_send) return json({ error: "서버 발송은 아직 오픈 전입니다(회원 본인 메일로 보내주세요)" }, 403);

    const { target_platform_id, target_name, target_email, type_id, subject, body, sender_name } = await req.json();
    if (!target_email || !subject || !body || !sender_name) return json({ error: "필수 항목 누락" }, 400);

    // 2) 수신거부 대조(정보통신망법)
    const email = String(target_email).trim().toLowerCase();
    const { data: opt } = await admin.from("outreach_optout").select("email").eq("email", email).maybeSingle();
    if (opt) return json({ error: "수신거부한 주소입니다" }, 403);

    // 3) 하루 발송 상한
    const { data: left } = await admin.rpc("outreach_quota_left", { p_user: user.id });
    if (typeof left === "number" && left <= 0) return json({ error: "오늘 보낼 수 있는 제안 수를 모두 사용했어요" }, 429);

    // 4) 기록(감사) — queued
    const { data: row, error: insErr } = await admin.from("outreach_proposals").insert({
      sender_id: user.id, sender_name, target_platform_id: target_platform_id ?? null,
      target_name, target_email: email, type_id, subject, body, channel: "server", status: "queued",
    }).select("id").single();
    if (insErr) return json({ error: "기록 실패" }, 500);

    // 5) 발송(Resend) — 실패 시 상태만 갱신하고 사용자에겐 재시도 안내
    const ok = await sendEmail(email, subject, body, cfg.from_name ?? "세모플 제휴");
    await admin.from("outreach_proposals").update({
      status: ok ? "sent" : "failed", sent_at: ok ? new Date().toISOString() : null,
      fail_reason: ok ? null : "email_provider_error",
    }).eq("id", row.id);

    return ok ? json({ ok: true, id: row.id }) : json({ error: "발송 실패 — 잠시 후 다시 시도해 주세요" }, 502);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});

// Resend 발송 — 교체 지점(SES/Postmark 등으로 바꾸려면 이 함수만 수정)
async function sendEmail(to: string, subject: string, text: string, fromName: string): Promise<boolean> {
  const key = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("EMAIL_FROM") ?? `${fromName} <onboarding@resend.dev>`;
  if (!key) return false;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, text, reply_to: Deno.env.get("EMAIL_REPLY_TO") ?? undefined }),
  });
  return res.ok;
}
