// Paystack checkout for Nayah Allure.
//
// POST { action: "init", customer: {name,email,phone}, items: [[productId, qty], ...] }
//   -> prices the cart from nayah_products (never trusts client prices), creates a
//      pending order and a Paystack transaction. Returns { reference, access_code }.
// POST { action: "verify", reference }
//   -> asks Paystack for the transaction status and marks the order paid/failed.
// POST from Paystack with x-paystack-signature header (webhook)
//   -> verifies the HMAC signature and marks the order paid on charge.success.
//
// Secrets: PAYSTACK_SECRET_KEY (set with `supabase secrets set`).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.
// Deploy with --no-verify-jwt so Paystack can reach the webhook.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const PAYSTACK_SECRET = Deno.env.get("PAYSTACK_SECRET_KEY") ?? "";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function paystack(path: string, init: RequestInit = {}) {
  const res = await fetch(`https://api.paystack.co${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, "Content-Type": "application/json" },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.status) throw new Error(body.message || `Paystack error ${res.status}`);
  return body.data;
}

async function hmacSha512Hex(key: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Mark an order paid only if Paystack's amount and currency match what we charged.
async function settle(tx: { reference: string; status: string; amount: number; currency: string; channel?: string; paid_at?: string }) {
  const { data: order } = await db.from("nayah_orders").select("*").eq("reference", tx.reference).maybeSingle();
  if (!order) return { status: "unknown" };
  if (order.status === "paid") return { status: "paid", order };

  const ok = tx.status === "success" && tx.amount === order.amount * 100 && tx.currency === order.currency;
  const status = ok ? "paid" : tx.status === "failed" || tx.status === "abandoned" || tx.status === "success" ? "failed" : "pending";
  if (status === "pending") return { status, order };

  const { data } = await db.from("nayah_orders")
    .update({ status, channel: tx.channel ?? null, paid_at: ok ? (tx.paid_at ?? new Date().toISOString()) : null })
    .eq("id", order.id).neq("status", "paid").select().maybeSingle();
  return { status, order: data ?? order };
}

async function init(body: any) {
  const c = body.customer ?? {};
  const name = String(c.name ?? "").trim().slice(0, 100);
  const email = String(c.email ?? "").trim().toLowerCase().slice(0, 200);
  const phone = String(c.phone ?? "").trim().slice(0, 30);
  if (!name || !phone || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Please enter your name, phone and a valid email." }, 400);

  const wanted = new Map<string, number>();
  for (const [id, qty] of Array.isArray(body.items) ? body.items : []) {
    const q = Math.floor(Number(qty));
    if (typeof id === "string" && q > 0 && q <= 50) wanted.set(id, (wanted.get(id) ?? 0) + q);
  }
  if (!wanted.size) return json({ error: "Your cart is empty." }, 400);

  const { data: products, error } = await db.from("nayah_products").select("id,name,price,active").in("id", [...wanted.keys()]);
  if (error) throw error;
  const items = (products ?? []).filter((p) => p.active !== false).map((p) => ({ id: p.id, name: p.name, price: Number(p.price), qty: wanted.get(p.id)! }));
  if (items.length !== wanted.size) return json({ error: "Some items are no longer available. Please refresh the page." }, 409);
  const amount = items.reduce((s, i) => s + i.price * i.qty, 0);
  if (amount < 1) return json({ error: "Order total must be above zero." }, 400);

  const reference = `NA-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`.toUpperCase();
  const { error: insErr } = await db.from("nayah_orders").insert({
    reference, customer_name: name, customer_email: email, customer_phone: phone, items, amount, currency: "KES",
  });
  if (insErr) throw insErr;

  const tx = await paystack("/transaction/initialize", {
    method: "POST",
    body: JSON.stringify({
      email, reference, currency: "KES", amount: amount * 100, // Paystack expects the lowest unit (cents)
      channels: ["mobile_money", "card"],
      metadata: {
        custom_fields: [
          { display_name: "Customer", variable_name: "customer_name", value: name },
          { display_name: "Phone", variable_name: "customer_phone", value: phone },
          { display_name: "Items", variable_name: "items", value: items.map((i) => `${i.qty} x ${i.name}`).join(", ") },
        ],
      },
    }),
  });
  return json({ reference, access_code: tx.access_code, amount });
}

async function verify(body: any) {
  const reference = String(body.reference ?? "");
  if (!/^NA-[A-Z0-9-]+$/.test(reference)) return json({ error: "Invalid reference." }, 400);
  const tx = await paystack(`/transaction/verify/${encodeURIComponent(reference)}`);
  const { status } = await settle(tx);
  return json({ status, reference });
}

async function webhook(req: Request, raw: string) {
  const expected = await hmacSha512Hex(PAYSTACK_SECRET, raw);
  if (expected !== req.headers.get("x-paystack-signature")) return new Response("bad signature", { status: 401 });
  const event = JSON.parse(raw);
  if (event.event === "charge.success" && event.data?.reference) await settle(event.data);
  return new Response("ok");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!PAYSTACK_SECRET) return json({ error: "Payments are not configured yet." }, 500);
  try {
    const raw = await req.text();
    if (req.headers.has("x-paystack-signature")) return await webhook(req, raw);
    const body = JSON.parse(raw || "{}");
    if (body.action === "init") return await init(body);
    if (body.action === "verify") return await verify(body);
    return json({ error: "Unknown action" }, 400);
  } catch (err) {
    console.error(err);
    return json({ error: "Payment service error. Please try again or order via WhatsApp." }, 500);
  }
});
