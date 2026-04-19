'use strict'

const express             = require('express')
const Database            = require('better-sqlite3')
const imaps               = require('imap-simple')
const { simpleParser }    = require('mailparser')
const { v4: uuidv4 }      = require('uuid')
const chalk               = require('chalk')

const app = express()
app.use(express.urlencoded({ extended: true }))
app.use(express.json())

// ── Config ────────────────────────────────────────────────────────────────────

const IMAP_HOST      = process.env.IMAP_HOST      || 'm41l.example.com'
const IMAP_PORT      = parseInt(process.env.IMAP_PORT      || '993')
const IMAP_USER      = process.env.IMAP_USER      || 'catch@example.com'
const IMAP_PASS      = process.env.IMAP_PASS      || ''
const DOMAIN         = process.env.DOMAIN         || 'example.com'
const API_KEY        = process.env.API_KEY        || 'changeme'
const DB_PATH        = process.env.DB_PATH        || 'emailapi.db'
const EMAIL_TTL      = parseInt(process.env.EMAIL_TTL      || '600')
const POLL_INTERVAL  = parseInt(process.env.POLL_INTERVAL  || '4')  * 1000
const VERIFY_TIMEOUT = parseInt(process.env.VERIFY_TIMEOUT || '90') * 1000
const PORT           = parseInt(process.env.PORT || '6060')

// ── Logger ────────────────────────────────────────────────────────────────────

const ts = () => new Date().toTimeString().slice(0, 8)
const log = {
    success: msg => console.log(`[${chalk.green(ts())}]  ${msg}`),
    info:    msg => console.log(`[${chalk.cyan(ts())}]  ${msg}`),
    warn:    msg => console.log(`[${chalk.yellow(ts())}]  ${msg}`),
    error:   msg => console.log(`[${chalk.red(ts())}]  ${msg}`),
}

// ── DB ────────────────────────────────────────────────────────────────────────

const db = new Database(DB_PATH)
db.exec(`
    CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, email TEXT NOT NULL, site TEXT,
        status TEXT DEFAULT 'waiting', code TEXT, subject TEXT,
        body TEXT, created_at REAL, expires_at REAL
    );
    CREATE TABLE IF NOT EXISTS mailboxes (
        email TEXT PRIMARY KEY, created_at REAL
    );
`)

// ── Code extraction ───────────────────────────────────────────────────────────

const CODE_PATTERNS = [
    /(?:^|\n)\s*([0-9]{6})\s*(?:\n|$)/m,
    /(?:code|Code|CODE)[^\w]*([0-9]{6})/,
    /(?:verify|Verify|verification)[^\w]*([0-9]{6})/,
    /(?:sign up|Sign up|signup)[^\w]*([0-9]{6})/,
    /(?:OTP|otp)[^\w]*([0-9]{6})/,
    /(?:is|:)\s*([0-9]{6})\b/,
    /<[^>]*>\s*([0-9]{6})\s*</,
    /(?:code|Code|CODE)[^\w]*([A-Z0-9]{4,10})/,
    /(?:verify|Verify)[^\w]*([A-Z0-9]{4,10})/,
    /(?:token|Token)[^\w]*([a-zA-Z0-9]{8,32})/,
    /\b([0-9]{6})\b/,
    /\b([0-9]{4})\b/,
    /\b([0-9]{8})\b/,
]

function extractCode(text) {
    for (const p of CODE_PATTERNS) {
        const m = text.match(p)
        if (m) return m[1]
    }
    return null
}

// ── IMAP ──────────────────────────────────────────────────────────────────────

const IMAP_CONFIG = {
    imap: {
        user: IMAP_USER,
        password: IMAP_PASS,
        host: IMAP_HOST,
        port: IMAP_PORT,
        tls: true,
        tlsOptions: { rejectUnauthorized: false },
        authTimeout: 10000,
    }
}

async function searchInbox(targetEmail, sinceTs, sender = 'ALL', location = 'body') {
    let conn
    try {
        conn = await imaps.connect(IMAP_CONFIG)
        await conn.openBox('INBOX')

        const since    = new Date((sinceTs - 86400) * 1000)
        const criteria = [['SINCE', since]]
        if (sender && sender.toUpperCase() !== 'ALL') criteria.push(['FROM', sender])

        const messages = await conn.search(criteria, { bodies: [''], markSeen: false })

        for (const msg of messages.reverse()) {
            const raw = msg.parts.find(p => p.which === '')
            if (!raw) continue

            const parsed    = await simpleParser(raw.body)
            const toHeader  = [
                parsed.to?.text || '',
                parsed.headers?.get('delivered-to') || '',
                parsed.headers?.get('x-original-to') || '',
            ].join(' ')

            if (!toHeader.toLowerCase().includes(targetEmail.toLowerCase())) continue

            const subject = parsed.subject || ''
            const body    = parsed.text || parsed.html || ''
            const source  = location === 'subject' ? subject : body
            const code    = extractCode(source)

            await conn.end()
            return { code, subject, body: body.slice(0, 4000) }
        }

        await conn.end()
    } catch (e) {
        log.error(`[IMAP] ${e.message}`)
        try { if (conn) await conn.end() } catch {}
    }

    return { code: null, subject: '', body: '' }
}

// ── Background poll ───────────────────────────────────────────────────────────

async function pollLoop() {
    while (true) {
        try {
            const rows = db.prepare(
                "SELECT id, email, created_at FROM requests WHERE status='waiting' AND expires_at > ?"
            ).all(Date.now() / 1000)

            for (const { id, email, created_at } of rows) {
                const { code, subject, body } = await searchInbox(email, created_at)
                if (code) {
                    db.prepare("UPDATE requests SET status='ready', code=?, subject=?, body=? WHERE id=?")
                        .run(code, subject, body, id)
                    log.success(`[poll] ${email} → ${code}`)
                }
            }
        } catch (e) {
            log.error(`[poll] ${e.message}`)
        }

        await new Promise(r => setTimeout(r, POLL_INTERVAL))
    }
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function requireKey(req, res, next) {
    const key = req.query.apiKey || req.headers['x-api-key'] || ''
    if (key !== API_KEY) return res.status(401).json({ status: 'error', message: 'invalid key' })
    next()
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.post('/create_email', (req, res) => {
    const prefix = (req.body.email || '').trim().toLowerCase()
    if (!prefix) return res.status(400).json({ error: 'email required' })

    const addr = prefix.includes('@') ? prefix : `${prefix}@${DOMAIN}`
    db.prepare('INSERT OR REPLACE INTO mailboxes VALUES (?, ?)').run(addr, Date.now() / 1000)

    log.success(`[create_email] ${addr}`)
    res.type('application/json').send(JSON.stringify(addr))
})

app.post('/get_verification', async (req, res) => {
    const addr     = (req.body.email || '').trim().toLowerCase()
    const sender   = req.body.sender || 'ALL'
    const location = req.body.verification_location || 'body'

    if (!addr) return res.status(400).json({ error: 'email required' })

    const row     = db.prepare('SELECT created_at FROM mailboxes WHERE email=?').get(addr)
    const sinceTs = row ? row.created_at : Date.now() / 1000 - 300

    log.info(`[get_verification] waiting for ${addr}...`)
    const deadline = Date.now() + VERIFY_TIMEOUT
    while (Date.now() < deadline) {
        const { code } = await searchInbox(addr, sinceTs, sender, location)
        if (code) {
            log.success(`[get_verification] ${addr} → ${code}`)
            return res.type('application/json').send(JSON.stringify(code))
        }
        await new Promise(r => setTimeout(r, POLL_INTERVAL))
    }

    log.warn(`[get_verification] ${addr} → timeout`)
    res.json({ error: 'timeout', message: `no email in ${VERIFY_TIMEOUT / 1000}s` })
})

function randomAddr() {
    const chars  = 'abcdefghijklmnopqrstuvwxyz0123456789'
    const prefix = Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
    return `${prefix}@${DOMAIN}`
}

app.get('/api/getEmail', requireKey, (req, res) => {
    const site = req.query.site || ''
    const id   = uuidv4()
    const addr = randomAddr()
    const now  = Date.now() / 1000

    db.prepare('INSERT INTO requests VALUES (?,?,?,?,?,?,?,?,?)').run(id, addr, site, 'waiting', null, null, null, now, now + EMAIL_TTL)
    db.prepare('INSERT OR REPLACE INTO mailboxes VALUES (?,?)').run(addr, now)

    log.info(`[getEmail] ${addr}`)
    res.json({ status: 'OK', id, email: addr })
})

app.get('/api/getEmailResult', requireKey, (req, res) => {
    const row = db.prepare('SELECT status, code, email, subject FROM requests WHERE id=?').get(req.query.id || '')
    if (!row) return res.status(404).json({ status: 'error', message: 'not found' })

    const { status, code, email, subject } = row
    if (status === 'ready')   return res.json({ status: 'OK', email, code, subject })
    if (status === 'waiting') return res.json({ status: 'wait' })
    return res.json({ status: 'error', message: status })
})

app.get('/api/cancelEmail', requireKey, (req, res) => {
    db.prepare("UPDATE requests SET status='cancelled' WHERE id=?").run(req.query.id || '')
    res.json({ status: 'OK' })
})

app.get('/api/status', (req, res) => {
    const counts = {}
    for (const s of ['waiting', 'ready', 'cancelled']) {
        counts[s] = db.prepare('SELECT COUNT(*) as n FROM requests WHERE status=?').get(s).n
    }
    res.json({ status: 'OK', domain: DOMAIN, imap: IMAP_HOST, requests: counts })
})

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(chalk.cyan(`\n  imap email api  (node)\n  ${'─'.repeat(32)}`))
log.info(`domain: ${chalk.white(DOMAIN)}  imap: ${chalk.white(IMAP_HOST + ':' + IMAP_PORT)}`)
log.info(`poll: ${POLL_INTERVAL / 1000}s  timeout: ${VERIFY_TIMEOUT / 1000}s  ttl: ${EMAIL_TTL}s`)

pollLoop()
app.listen(PORT, '0.0.0.0', () => log.success(`listening on :${PORT}\n`))
