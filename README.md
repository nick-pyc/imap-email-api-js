# imap email api — node

node.js version of the imap email API. same endpoints, same logic, just node instead of python. drop-in compatible with [Bluyx/email-api](https://github.com/Bluyx/email-api).

---

## stack

- **express** — HTTP server
- **imap-simple** — IMAP client
- **mailparser** — parses raw emails
- **better-sqlite3** — local DB for tracking requests
- **chalk** — colored console output

---

## running without docker

```bash
npm install
cp .env.example .env
# edit .env with your IMAP creds
node index.js
```

---

## running with docker

recommended — starts automatically on boot, no screen/pm2 needed.

```bash
cp .env.example .env
# edit .env with your IMAP creds

docker compose up -d
```

that's it. `restart: always` means it'll come back up if the server reboots or the process crashes.

**check logs:**
```bash
docker compose logs -f
```

**stop it:**
```bash
docker compose down
```

---

## env vars

| var | default | description |
|-----|---------|-------------|
| `IMAP_HOST` | `m41l.example.com` | your mail server |
| `IMAP_PORT` | `993` | IMAP SSL port |
| `IMAP_USER` | `catch@example.com` | catch-all inbox login |
| `IMAP_PASS` | *(required)* | IMAP password |
| `DOMAIN` | `example.com` | your domain |
| `API_KEY` | `changeme` | key for `/api/*` routes |
| `PORT` | `6060` | port to listen on |
| `VERIFY_TIMEOUT` | `90` | seconds to wait for a code |
| `POLL_INTERVAL` | `4` | seconds between IMAP checks |
| `EMAIL_TTL` | `600` | seconds until a slot expires |

---

## endpoints

**Bluyx-compatible:**

`POST /create_email`
```json
// success
"someuser@yourdomain.com"

// error
{ "error": "email required" }
```

`POST /get_verification`
```json
// success
"123456"

// timeout
{ "error": "timeout", "message": "no email in 90s" }

// error
{ "error": "email required" }
```

---

**Kopeechka-style (require API key):**

`GET /api/getEmail?apiKey=xxx&site=example.com`
```json
// success
{ "status": "OK", "id": "uuid-here", "email": "abc123@yourdomain.com" }

// bad key
{ "status": "error", "message": "invalid key" }
```

`GET /api/getEmailResult?apiKey=xxx&id=xxx`
```json
// code arrived
{ "status": "OK", "email": "abc123@yourdomain.com", "code": "123456", "subject": "Your verification code" }

// still waiting
{ "status": "wait" }

// not found
{ "status": "error", "message": "not found" }
```

`GET /api/cancelEmail?apiKey=xxx&id=xxx`
```json
{ "status": "OK" }
```

`GET /api/status`
```json
{
  "status": "OK",
  "domain": "yourdomain.com",
  "imap": "m41l.yourdomain.com",
  "requests": { "waiting": 2, "ready": 5, "cancelled": 1 }
}
```

---

## account generator config.json

```json
"imap": {
  "apiURL": "http://m41l.yourdomain.com:6060",
  "imap":   "m41l.yourdomain.com",
  "domain": "yourdomain.com"
}
```

---

## db / persistence

the sqlite db is stored at `/app/data/emailapi.db` inside the container, mapped to `./data/` on the host via the volume mount. it persists between restarts.
