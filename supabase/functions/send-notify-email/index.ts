// 세모플 — 알림 이메일 요약 발송(Edge Function) · Deno
// ⚠️ 배포·시크릿 설정 전까지 동작하지 않음. app_settings 'notify_email'.enabled=false면 즉시 skip(200).
//
// 스케줄 호출(cron 또는 notify.yml 뒤 curl 스텝)이 트리거 — 사용자 요청이 아니라 배치라
// 호출자 인증 대신 CRON_SECRET 헤더로 잠근다(스위치 off면 시크릿 없이 호출돼도 무해).
//
// 배포:
//   supabase functions deploy send-notify-email
// 필요한 시크릿:
//   supabase secrets set RESEND_API_KEY=... NOTIFY_EMAIL_FROM="세모플 알림 <notify@yourdomain>" CRON_SECRET=...
// 발신 도메인은 SPF/DKIM/DMARC 인증 필수 + 정보통신망법 §50(수신거부 링크 실동작) — README 체크리스트 참조.
//
// 발송 정책(스팸·피로 방지, 개인정보 최소화):
//   · 사용자당 하루 1통(notify_email_log unique가 DB에서 강제)
//   · 본문은 "미읽음 N건" 요약뿐 — 알림 원문(매칭 상세 등)은 싣지 않고 알림 센터 링크로 유도
//   · outreach_optout(수신거부) 대조 후 제외

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const SITE = "https://comdows.github.io/web1/";
const OPTOUT_URL = `${SITE}?view=optout`;

Deno.serve(async (req) => {
  try {
    const SB_URL = Deno.env.get("SUPABASE_URL")!;
    const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(SB_URL, SB_SERVICE);

    // 1) 게이트(법적 스위치) — off면 아무 일도 하지 않고 성공 반환(스케줄러가 미리 켜져 있어도 무해)
    const { data: setting } = await admin.from("app_settings").select("value").eq("key", "notify_email").single();
    const cfg = (setting?.value ?? {}) as { enabled?: boolean; from_name?: string };
    if (!cfg.enabled) return json({ ok: true, skipped: "notify_email disabled" });

    // 2) 배치 호출 인증 — 게이트가 켜진 뒤에는 시크릿 없는 호출 거부
    const secret = Deno.env.get("CRON_SECRET");
    if (!secret || req.headers.get("x-cron-secret") !== secret) return json({ error: "unauthorized" }, 401);

    // 3) 미읽음 알림 사용자 집계(최근 7일 생성분 — 오래된 미읽음으로 무한 재발송 방지)
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const { data: unread, error: qErr } = await admin.from("notifications")
      .select("user_id").is("read_at", null).gt("created_at", since).limit(5000);
    if (qErr) return json({ error: "query failed" }, 500);
    const counts = new Map<string, number>();
    for (const n of unread ?? []) counts.set(n.user_id, (counts.get(n.user_id) ?? 0) + 1);
    if (counts.size === 0) return json({ ok: true, sent: 0 });

    let sent = 0, capped = 0, opted = 0, failed = 0;
    for (const [userId, count] of counts) {
      // 4) 사용자당 하루 1통 — insert가 성공한 경우에만 발송(unique 충돌 = 오늘 이미 발송)
      const { error: logErr } = await admin.from("notify_email_log")
        .insert({ user_id: userId, sent_on: new Date().toISOString().slice(0, 10), notif_count: count });
      if (logErr) { capped++; continue; }

      // 5) 이메일 주소는 auth에서(프로필에 이메일 없음 — 최소 수집 원칙)
      const { data: u } = await admin.auth.admin.getUserById(userId);
      const email = u?.user?.email?.toLowerCase();
      if (!email) { failed++; continue; }

      // 6) 수신거부 대조(정보통신망법 §50)
      const { data: opt } = await admin.from("outreach_optout").select("email").eq("email", email).maybeSingle();
      if (opt) { opted++; continue; }

      // 7) 발송 — 요약만(개별 알림 내용 비포함), 링크는 알림 센터로
      const ok = await sendEmail(
        email,
        `[세모플] 읽지 않은 알림 ${count}건이 있어요`,
        `안녕하세요, 세모플입니다.\n\n` +
        `최근 7일 사이에 도착한 알림 중 ${count}건을 아직 읽지 않으셨어요.\n` +
        `매칭·관심 플랫폼 소식은 알림 센터에서 확인하세요:\n${SITE}?view=notifications\n\n` +
        `이 메일은 세모플 회원 서비스 알림입니다(하루 최대 1통).\n` +
        `알림 이메일을 더 받고 싶지 않으시면 수신거부: ${OPTOUT_URL}`,
        cfg.from_name ?? "세모플 알림",
      );
      if (ok) sent++; else failed++;
    }
    return json({ ok: true, sent, capped, opted, failed, users: counts.size });
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});

// Resend 발송 — send-proposal과 동일한 교체 지점(SES/Postmark 등으로 바꾸려면 이 함수만 수정)
async function sendEmail(to: string, subject: string, text: string, fromName: string): Promise<boolean> {
  const key = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("NOTIFY_EMAIL_FROM") ?? `${fromName} <onboarding@resend.dev>`;
  if (!key) return false;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, text }),
  });
  return res.ok;
}
