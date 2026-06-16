# DSP — GCP VM Deployment Runbook

Deploy the Anutech Support panel to a GCP Compute Engine VM, bound to a
subdomain, behind Cloudflare. Stack: **e2-small (asia-south1) · Ubuntu 22.04 ·
Node 20 + PM2 · Nginx · self-hosted MySQL · Cloudflare front**.

> Replace these placeholders throughout:
> - `support.yourdomain.com` → your subdomain
> - `yourdomain.com` → your root domain (DNS on Cloudflare)
> - `<office-ip>` → your office public IP (for admin/agent allowlist)
> - `<repo-url>` → your git remote

---

## 0. Prerequisites
- Root domain's DNS is managed by **Cloudflare** (free plan is fine).
- A GCP project with billing enabled + `gcloud` (Cloud Shell works).
- Your code pushed to a **git remote** (`.gitignore` already excludes `.env`, `node_modules`, `dist`, `uploads`).
- Decide **data**: start fresh (seed one admin) **or** migrate your dev database.

## 1. Create the VM + static IP + firewall
```bash
gcloud compute addresses create dsp-ip --region=asia-south1

gcloud compute instances create dsp-prod \
  --zone=asia-south1-c \
  --machine-type=e2-small \
  --image-family=ubuntu-2204-lts --image-project=ubuntu-os-cloud \
  --boot-disk-size=30GB --boot-disk-type=pd-balanced \
  --address=$(gcloud compute addresses describe dsp-ip --region=asia-south1 --format='value(address)') \
  --tags=http-server,https-server
```
Firewall: GCP's default `allow-http`/`allow-https` (via the tags) open 80/443. Lock SSH to your IP:
```bash
gcloud compute firewall-rules create dsp-ssh --allow=tcp:22 \
  --source-ranges=<office-ip>/32 --target-tags=dsp-prod
```
Note the static IP (`gcloud compute addresses describe dsp-ip --region=asia-south1 --format='value(address)'`).

## 2. Install the runtime (SSH into the VM)
```bash
gcloud compute ssh dsp-prod --zone=asia-south1-c
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs nginx mysql-server git
sudo npm i -g pm2
sudo mysql_secure_installation     # set a root password, remove test db/anon users
```

## 3. Database
```bash
sudo mysql
```
```sql
CREATE DATABASE dsp CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'dsp'@'localhost' IDENTIFIED BY '<strong-db-password>';
GRANT ALL PRIVILEGES ON dsp.* TO 'dsp'@'localhost';
FLUSH PRIVILEGES; EXIT;
```
**Data — pick one:**
- **Migrate dev data** (keeps your customers/tickets/admin):
  ```bash
  # on your PC:  mysqldump -u <devuser> -p <devdb> > dsp.sql
  gcloud compute scp dsp.sql dsp-prod:~ --zone=asia-south1-c
  # on the VM:
  mysql -u dsp -p dsp < ~/dsp.sql
  ```
- **Fresh start:** skip the import — the app creates all tables on first boot. You'll seed an admin after step 4 (ask me for the one-liner).

## 4. Deploy the code
```bash
sudo mkdir -p /opt && sudo chown -R $USER /opt
cd /opt && git clone <repo-url> dsp && cd dsp
( cd backend  && npm ci --omit=dev )
( cd frontend && npm ci && npm run build )
```
Create `/opt/dsp/backend/.env` (production values):
```
NODE_ENV=production
PORT=5000
DB_HOST=localhost
DB_USER=dsp
DB_PASSWORD=<strong-db-password>
DB_NAME=dsp
JWT_SECRET=<long-random-string-NOT-the-dev-one>
JWT_EXPIRES_IN=7d
FRONTEND_URL=https://support.yourdomain.com
SMTP_ENABLED=true
SMTP_HOST=...  SMTP_PORT=587  SMTP_USER=...  SMTP_PASS=...  EMAIL_FROM=...
ANTHROPIC_API_KEY=...
VAPID_PUBLIC_KEY=...  VAPID_PRIVATE_KEY=...  VAPID_SUBJECT=mailto:you@yourdomain.com   # NEW keypair
CLOUDFLARE_TURN_KEY_ID=...  CLOUDFLARE_TURN_API_TOKEN=...
```
> Generate a JWT secret: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
> Generate VAPID keys: `npx web-push generate-vapid-keys`

Start under PM2:
```bash
cd /opt/dsp/backend
pm2 start src/server.js --name dsp
pm2 save && pm2 startup     # run the command it prints (survives reboots)
pm2 logs dsp --lines 50     # confirm "Server running" + migrations ran clean
curl -s localhost:5000/api/health   # → {"status":"ok"...}
```

## 5. Nginx
```bash
sudo cp /opt/dsp/nginx/dsp.conf /etc/nginx/sites-available/dsp
sudo sed -i 's/support.yourdomain.com/<your real subdomain>/g' /etc/nginx/sites-available/dsp
sudo ln -s /etc/nginx/sites-available/dsp /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
```
(Cert files are installed in step 6 before reloading.)

## 6. Cloudflare — subdomain + TLS
1. **DNS:** in Cloudflare → your domain → DNS → add an **A record**:
   `support` → `<static-ip>`, **Proxy status: Proxied (orange cloud)**.
2. **Origin certificate:** Cloudflare → SSL/TLS → Origin Server → **Create Certificate** (15-yr). Save the cert + key on the VM:
   ```bash
   sudo mkdir -p /etc/ssl/cloudflare
   sudo nano /etc/ssl/cloudflare/dsp.pem   # paste the Origin Certificate
   sudo nano /etc/ssl/cloudflare/dsp.key   # paste the Private Key
   sudo chmod 600 /etc/ssl/cloudflare/dsp.key
   ```
3. **SSL mode:** Cloudflare → SSL/TLS → Overview → **Full (strict)**. Enable **Always Use HTTPS**. (Websockets are on by default.)
4. Reload Nginx:
   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```
5. Visit `https://support.yourdomain.com` → the app loads over HTTPS.

## 7. Lock down admin/agent by IP
Real client IP already flows through (Nginx `real_ip` + the app's `trust proxy 1`).
- Log in as admin → **Settings → Security** → set **Admin IP allowlist** and **Agent IP allowlist** to `<office-ip>` (or a CIDR like `<office-ip>/24`). Empty = allow all.
- Customer logins are never restricted.
- **Lockout recovery (break-glass):** if you ever block yourself, SSH in →
  `nano /opt/dsp/backend/.env` → add `DISABLE_IP_ALLOWLIST=true` → `pm2 reload dsp`
  → log in, fix the lists → remove the line → `pm2 reload dsp`.

## 8. Backups & monitoring
```bash
# DB dump nightly (put creds in ~/.my.cnf so it's non-interactive)
( crontab -l 2>/dev/null; echo "0 2 * * * mysqldump dsp | gzip > /opt/dsp-backups/dsp-\$(date +\%F).sql.gz" ) | crontab -
mkdir -p /opt/dsp-backups
```
- GCP → schedule **disk snapshots** (daily, keep ~7).
- Cloudflare or an uptime monitor → ping `https://support.yourdomain.com/api/health`.
- `pm2 install pm2-logrotate` to cap log growth.

## 9. Go-live checks
HTTPS loads ✓ · login (all roles) ✓ · ticket reply + attachment → CC email ✓ ·
live chat connects ✓ · a call connects over mobile data (TURN) ✓ · push on a
real device ✓ · PWA installs as "Anutech Support" with the new icon ✓ ·
admin/agent blocked from a non-office network ✓.

## 10. Future updates
```bash
cd /opt/dsp && ./deploy.sh          # backup DB → git pull → build → graceful reload → health check
```
Tag releases (`git tag v1.0.0 && git push --tags`); rollback = `git checkout v<prev> && ./deploy.sh`.
