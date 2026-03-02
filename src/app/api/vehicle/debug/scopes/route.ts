import { supabaseAdmin } from "@/lib/db/client";
import { decryptJson } from "@/lib/crypto";

const DEV_USER_ID = process.env.DEV_USER_ID!;

export async function GET() {
  if (!DEV_USER_ID) return new Response("Missing DEV_USER_ID", { status: 500 });

  const { data: conn, error } = await supabaseAdmin
    .from("vehicle_connections")
    .select("*")
    .eq("user_id", DEV_USER_ID)
    .eq("provider_key", "tesla_fleet")
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return new Response(`DB error: ${error.message}`, { status: 500 });
  if (!conn) return new Response("No active tesla_fleet connection", { status: 404 });

  const token = decryptJson<any>(conn.token_iv_b64, conn.token_data_b64);

  return Response.json({
    ok: true,
    tokenFields: Object.keys(token ?? {}),
    scope: token?.scope ?? null,
    expires_in_present: token?.expires_in ?? null
  });
}