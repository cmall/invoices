# Invoices

A small, self-hosted invoicing app for freelancers and small studios who send a handful of invoices a year and don't want a monthly subscription.

- **Clients, projects and rates**: each client has its own currency, payment terms and default taxes. Projects carry an hourly rate that fills in automatically.
- **Invoices and estimates**: line items with optional dates, quantities, discounts and notes. A draft stays open so you can keep adding lines as you work, then send it when you're ready. Estimates can be accepted online and turned into invoices in one click.
- **Taxes**: any number of named tax rates (GST, HST, PST, VAT, sales tax…) with registration numbers printed on the invoice. Each line can be marked taxable or not, and old invoices never change when you edit a rate.
- **Modern interface** with light and dark modes, built around your brand colours, plus one-click updates from GitHub.
- **Your branding**: upload a logo and pick from colour themes or your own accent and heading colours, with a modern or classic typeface. Branding applies to PDFs, the client payment page, emails and the app itself, with a live preview in Settings.
- **PDF invoices by email** through [Postmark](https://postmarkapp.com), with an editable message, an attached PDF and a link to the online invoice.
- **Online payments** through [Stripe Checkout](https://stripe.com/payments/checkout). Payments are recorded automatically, and the client gets a receipt. You can also record e-transfers, cheques and bank transfers by hand.
- **Overdue reminders** sent automatically on a schedule you choose (for example 3, 14 and 30 days after the due date).
- **Reports**: yearly totals invoiced and collected, tax charged and collected per tax (for filing returns), plus per-client and monthly breakdowns, with CSV export.
- **Harvest import**: brings over your clients, contacts, projects, invoices, payments and estimates.
- **Simple to run**: Node.js and a single SQLite file. No external database and no headless browser.

There is one admin login (you). Clients never need an account; each invoice has a private link.

## Requirements

- Node.js 20.12 or newer (22 LTS recommended)
- A Linux server you can SSH into, with a domain or subdomain pointed at it (the app runs behind a reverse proxy such as nginx, Caddy or CloudPanel)
- Optional: a [Postmark](https://postmarkapp.com) account for email, and a [Stripe](https://stripe.com) account for card payments

## Quick start (local)

```bash
git clone https://github.com/cmall/invoices.git
cd invoices
npm install
npm run setup     # answers a few questions and writes .env
npm start         # http://localhost:3000
```

Log in with the email and password you chose during setup. Then:

1. **Settings → Business details**: your name, address and contact details.
2. **Settings → Branding**: upload your logo and pick your colours.
3. **Settings → Tax rates**: add the taxes you charge.
4. **Settings → Email**: the From address (verified in Postmark). Click **Send test email**.
5. **Clients → New client**, add a project with an hourly rate, then **New invoice**.

## Deploying to a server

Any host that can run a Node.js process behind HTTPS works. Step-by-step guides:

- **[CloudPanel](docs/cloudpanel.md)**
- **Docker**: see [below](#docker)
- **Any Linux VPS with nginx**: see [below](#plain-linux-server-nginx--pm2)

Whichever you choose, finish with [Postmark](#postmark-email) and [Stripe](#stripe-online-payments) set-up.

### Plain Linux server (nginx + PM2)

```bash
git clone https://github.com/cmall/invoices.git /srv/invoices
cd /srv/invoices
npm ci --omit=dev
npm run setup                   # set APP_URL to your https:// address
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save && pm2 startup         # restart on reboot
```

Proxy your domain to the app with nginx and add HTTPS (for example with `certbot --nginx`):

```nginx
server {
  server_name invoices.example.com;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

### Docker

```bash
git clone https://github.com/cmall/invoices.git && cd invoices
cp .env.example .env
docker compose run --rm app npm run setup
docker compose up -d
```

The app listens on `127.0.0.1:3000`; put your reverse proxy with HTTPS in front of it. Data is stored in `./data`.

## Postmark (email)

1. Create a Postmark account and a **Server** for transactional mail.
2. Under **Sender Signatures**, verify either your From address or your whole domain. Add the DKIM and Return-Path DNS records so mail lands in inboxes.
3. Copy the **Server API token** (Server → API Tokens) into `POSTMARK_SERVER_TOKEN` in `.env`, then restart the app.
4. In the app, set **Settings → Email → From email** to the verified address and click **Send test email**.

New Postmark accounts start in test mode, which only sends to addresses on your own domain. Request approval in Postmark before sending to clients.

## Stripe (online payments)

1. In the Stripe Dashboard, copy your **secret key** (Developers → API keys) into `STRIPE_SECRET_KEY`.
2. Add a webhook endpoint (Developers → Webhooks → Add endpoint):
   - URL: `https://your-domain/webhooks/stripe`
   - Events: `checkout.session.completed` and `checkout.session.async_payment_succeeded`
3. Copy the endpoint's **signing secret** (`whsec_…`) into `STRIPE_WEBHOOK_SECRET` and restart the app.

Invoices now show a **Pay online** button. Clients pay the outstanding balance in the invoice's currency on a Stripe-hosted page. The payment appears on the invoice, the client gets a receipt, and you get a notification. The payment methods offered (cards, Apple Pay, and so on) are controlled in Stripe's payment method settings. Use `sk_test_…` keys and Stripe's test cards to try it first.

## Importing from Harvest

Go to **Settings → Data → Import from Harvest**. Create a Personal Access Token at [id.getharvest.com/developers](https://id.getharvest.com/developers) and paste the token and account ID. The token is used once and never stored. Import is safe to repeat: records that were already imported are skipped. Imported invoices keep Harvest's exact tax amounts, so totals match. Optionally, new invoices continue Harvest's numbering.

## Backups

Everything lives in the `data/` folder: the SQLite database `invoices.db` and your logo.

- **Settings → Data → Download a backup** downloads a copy of the database.
- `npm run backup` writes a timestamped copy to `data/backups/` and keeps the newest 30. Schedule it with cron:
  ```
  15 3 * * * cd /path/to/invoices && npm run backup --silent
  ```
- Copy `data/backups` off the server regularly (for example with rclone or your host's backup feature).

To restore, stop the app and replace `data/invoices.db` with a backup.

## Updating

**From the app:** open **Updates** in the sidebar and click **Check for updates**, then **Update now**. The app pulls the latest version of the `main` branch from GitHub, reinstalls dependencies if they changed, and restarts itself when it runs under PM2. A badge appears in the sidebar when an update is available (checked twice a day). Your `data/` folder and `.env` are never touched.

**From the command line:**

```bash
cd /path/to/invoices
npm run update
```

This runs the same steps (`git` fast-forward to `main`, `npm ci` when needed, `pm2 restart invoices`). With Docker, use `git pull && docker compose up -d --build` instead.

Database changes are applied automatically on start. To follow a different branch, set `UPDATE_BRANCH` in `.env`.

## Configuration reference (`.env`)

| Variable | Description |
| --- | --- |
| `APP_URL` | Public URL, for example `https://invoices.example.com`. Used in emails, PDFs and Stripe redirects. |
| `PORT` / `HOST` | Where the app listens (default `127.0.0.1:3000`). Use `HOST=0.0.0.0` in containers. |
| `TZ` | Your time zone (for example `America/Toronto`). Decides when invoices become overdue. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD_HASH` | Your login. `npm run setup` or `npm run hash-password` creates the hash. |
| `SESSION_SECRET` | Random string used to sign sessions. `npm run setup` generates it. |
| `POSTMARK_SERVER_TOKEN` | Postmark server API token. |
| `POSTMARK_MESSAGE_STREAM` | Postmark message stream (default `outbound`). |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Stripe API key and webhook signing secret. |
| `DATA_DIR` | Where the database, logo and backups live (default `./data`). |
| `UPDATE_BRANCH` | GitHub branch used by in-app updates and `npm run update` (default `main`). `UPDATES_ENABLED=0` hides in-app updates. |

Everything else, including business details, logo, colours, numbering, default terms, reminder schedule and email templates, is edited in the app under **Settings**.

## Security notes

- Run the app behind HTTPS only. Session cookies are marked `Secure` when `APP_URL` starts with `https://`.
- Client links contain a long random token. Drafts are never visible through them.
- Logins are rate-limited, and all admin forms are CSRF-protected.
- Keep `.env` private (`npm run setup` creates it with `600` permissions).

## Development

```bash
npm run dev     # restarts on file changes
npm test        # end-to-end tests with mocked Postmark, Stripe and Harvest
```

The code is plain CommonJS with no build step: Express 5, EJS templates, better-sqlite3 and PDFKit.

```
src/
  server.js        app setup
  routes/admin.js  everything behind the login
  routes/public.js client-facing invoice/estimate pages and payments
  documents.js     invoices and estimates (shared model)
  calc.js          totals, discounts and taxes
  pdf.js           PDF rendering
  email.js         Postmark
  stripe.js        Stripe Checkout and webhook
  reminders.js     overdue reminder scheduler
  reports.js       yearly reports and CSV
  harvest.js       Harvest import
views/             EJS templates
public/            CSS and the line-item editor
```

## License

MIT
