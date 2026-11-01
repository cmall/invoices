# Deploying on CloudPanel

This guide installs the app on a server managed by [CloudPanel](https://www.cloudpanel.io), using `invoices.example.com` as the domain. Replace it with your own (for example `accounts.yourdomain.com`).

## 1. Point the domain at your server

At your DNS provider, add an `A` record for `invoices.example.com` pointing to your CloudPanel server's IP address.

## 2. Create a Node.js site

In CloudPanel:

1. **Sites → Add Site → Create a Node.js Site**
2. **Domain Name**: `invoices.example.com`
3. **Node.js Version**: 22 LTS
4. **App Port**: `3000`, or any free port. Use a different port for each Node.js site on the server.
5. Set a **Site User** and password and note them down.

CloudPanel creates the nginx configuration that forwards the domain to the app port.

## 3. Enable HTTPS

Open the site, go to **SSL/TLS → Actions → New Let's Encrypt Certificate**, and click **Create and Install**.

## 4. Install the app

SSH into the server **as the site user** (not root):

```bash
ssh site-user@your-server
cd ~/htdocs
rm -rf invoices.example.com           # CloudPanel's placeholder folder
git clone https://github.com/cmall/invoices.git invoices.example.com
cd invoices.example.com
npm ci --omit=dev
npm run setup
```

During setup:

- **Public URL**: `https://invoices.example.com`
- **Port**: the App Port you chose in step 2
- **Time zone**: for example `America/Toronto`
- Enter your Postmark and Stripe keys now, or leave them blank and add them to `.env` later.

## 5. Keep it running with PM2

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
```

To start the app again after a server reboot, open the site in CloudPanel, go to **Cron Jobs**, and add a job:

- **Schedule**: `@reboot`. If CloudPanel requires five fields, use the custom field.
- **Command**: `bash -lc "cd ~/htdocs/invoices.example.com && pm2 resurrect"`

Visit `https://invoices.example.com` and log in.

## 6. Nightly backups

In **Cron Jobs**, add a daily job (for example at minute `15`, hour `3`):

```
bash -lc "cd ~/htdocs/invoices.example.com && npm run backup --silent"
```

Backups go to `data/backups/` inside the site folder. CloudPanel's own **Backups** feature (Admin Area → Backups) can copy the site folder, including those backups, to remote storage.

## 7. Stripe webhook

In Stripe, add a webhook endpoint at `https://invoices.example.com/webhooks/stripe` for `checkout.session.completed` and `checkout.session.async_payment_succeeded`. Put the signing secret in `.env` as `STRIPE_WEBHOOK_SECRET`, then run `pm2 restart invoices`.

## Updating

```bash
cd ~/htdocs/invoices.example.com
git pull
npm ci --omit=dev
pm2 restart invoices
```

## Troubleshooting

- **502 Bad Gateway**: the app isn't running, or the port in `.env` doesn't match the site's App Port. Check `pm2 logs invoices`.
- **`npm` or `pm2` not found**: log in as the site user, not root, so CloudPanel's Node.js version is on the PATH.
- **Logged out right after logging in**: `APP_URL` must start with `https://` exactly as you visit the site.
