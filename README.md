# nayah

Static site (`index.html`, `admin.html`) backed by Supabase.

## Paystack payments

Customers can pay for cart items with M-Pesa or card through the Paystack popup.
The Paystack **secret key never touches the browser**: the `paystack` Supabase Edge
Function prices the cart from `nayah_products`, starts the transaction, verifies it,
and receives Paystack webhooks. Paid orders show up under **Online orders** in admin.

### One-time setup

1. **Create the orders table** – run `supabase/migrations/20261020000000_paystack_orders.sql`
   in the Supabase SQL editor (or `supabase db push`).
2. **Install the Supabase CLI and link the project**
   ```sh
   npx supabase login
   npx supabase link --project-ref znzfxfsmrcxkeuathtos
   ```
3. **Add your Paystack secret key** (Paystack dashboard → Settings → API Keys & Webhooks).
   Use `sk_test_...` while testing, then switch to `sk_live_...`.
   ```sh
   npx supabase secrets set PAYSTACK_SECRET_KEY=sk_test_xxxxxxxx
   ```
4. **Deploy the function** (`--no-verify-jwt` lets Paystack call the webhook):
   ```sh
   npx supabase functions deploy paystack --no-verify-jwt
   ```
5. **Set the webhook URL** in Paystack → Settings → API Keys & Webhooks:
   `https://znzfxfsmrcxkeuathtos.supabase.co/functions/v1/paystack`
   (This confirms payments even if the customer closes the page before it finishes.)
6. Make sure your Paystack account is set to **KES** and **M-Pesa** is enabled as a channel.

### Testing

With a test key, use Paystack's test card `4084 0840 8408 4081`, any future expiry, CVV `408`.
