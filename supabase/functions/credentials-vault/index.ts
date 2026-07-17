// F-Accounts 다계정 대시보드 — 네이버 검색광고 Secret Key 암호화 저장/조회.
//
// Secret Key는 원문으로 저장하지 않는다. AES-GCM으로 봉인해 credentials.secret_key_enc에 넣는다.
// 인증은 로그인 JWT(Authorization) → 유저 확정 → profiles.status === 'approved' 확인 순.
// 저장/조회 모두 검증된 user_id 소유 row만 다룬다(service role 클라이언트 사용).
//
// 광고주 데이터가 아니라 계정 자격증명이라 로그에도 값 자체는 남기지 않는다.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const VAULT_KEY = Deno.env.get("VAULT_KEY") ?? ""; // base64 32바이트

async function key(): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(VAULT_KEY), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function seal(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(), new TextEncoder().encode(plain)),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return btoa(String.fromCharCode(...out));
}
async function open(sealed: string): Promise<string> {
  const buf = Uint8Array.from(atob(sealed), (c) => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: buf.slice(0, 12) },
    await key(),
    buf.slice(12),
  );
  return new TextDecoder().decode(plain);
}

// CORS — 옵션 페이지(확장 UI)에서 fetch. brief-compose와 동일 패턴으로 preflight 대응.
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: CORS_HEADERS });

  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader) return json({ error: "unauthorized" }, 401);

  // 유저 컨텍스트 클라이언트로 JWT 검증
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "unauthorized" }, 401);
  const userId = userData.user.id;

  // service role 클라이언트로 승인 상태 확인 + DB 접근 (RLS 우회는 여기서만, 검증 후)
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: profile, error: profileErr } = await admin
    .from("profiles")
    .select("status")
    .eq("id", userId)
    .maybeSingle();
  if (profileErr || profile?.status !== "approved") return json({ error: "unauthorized" }, 401);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }

  if (body.action === "save") {
    const customerId = typeof body.customerId === "string" ? body.customerId : "";
    const accessLicense = typeof body.accessLicense === "string" ? body.accessLicense : "";
    const secretKey = typeof body.secretKey === "string" ? body.secretKey : "";
    if (!customerId || !accessLicense || !secretKey) return json({ error: "bad_request" }, 400);

    const secretKeyEnc = await seal(secretKey);
    const { error: upsertErr } = await admin
      .from("credentials")
      .upsert(
        {
          user_id: userId,
          customer_id: customerId,
          access_license: accessLicense,
          secret_key_enc: secretKeyEnc,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      );
    if (upsertErr) return json({ error: "db_error" }, 500);
    return json({ ok: true });
  }

  if (body.action === "load") {
    const { data: row, error: selErr } = await admin
      .from("credentials")
      .select("customer_id, access_license, secret_key_enc")
      .eq("user_id", userId)
      .maybeSingle();
    if (selErr) return json({ error: "db_error" }, 500);
    if (!row) return json({ credentials: null });

    const secretKey = await open(row.secret_key_enc as string);
    return json({
      credentials: {
        customerId: row.customer_id,
        accessLicense: row.access_license,
        secretKey,
      },
    });
  }

  return json({ error: "bad_action" }, 400);
});
