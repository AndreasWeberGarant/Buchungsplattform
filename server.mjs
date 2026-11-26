import { createServer } from 'node:http'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

const { ADMIN_PASSWORD, RESEND_API_KEY, MAIL_FROM, MAIL_TO, PUBLIC_ORIGIN, CUSTOMER_MAIL_MODE = 'auto' } = process.env
if (!['auto', 'manual'].includes(CUSTOMER_MAIL_MODE)) throw new Error('CUSTOMER_MAIL_MODE muss auto oder manual sein.')
const mailMissing = Object.entries({ RESEND_API_KEY, MAIL_FROM, MAIL_TO, PUBLIC_ORIGIN })
  .filter(([, value]) => !value?.trim()).map(([name]) => name)
const mailConfigured = mailMissing.length === 0
const manualCustomerMail = CUSTOMER_MAIL_MODE === 'manual' || !mailConfigured
if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 16) throw new Error('ADMIN_PASSWORD braucht mindestens 16 Zeichen.')
const dbPath = process.env.DB_PATH || './data/bookings.sqlite'
mkdirSync(dirname(dbPath), { recursive: true })
const db = new DatabaseSync(dbPath)
db.exec(`
  PRAGMA busy_timeout = 5000;
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS objects (id TEXT PRIMARY KEY, title TEXT NOT NULL, meeting TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS windows (
    id TEXT PRIMARY KEY, object_id TEXT NOT NULL REFERENCES objects(id), day TEXT NOT NULL,
    start INTEGER NOT NULL, end INTEGER NOT NULL, duration INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, window_id TEXT NOT NULL REFERENCES windows(id),
    start INTEGER NOT NULL, first TEXT NOT NULL, last TEXT NOT NULL, phone TEXT NOT NULL, canceled INTEGER NOT NULL DEFAULT 0
  );
  CREATE UNIQUE INDEX IF NOT EXISTS unique_active_slot ON bookings(window_id, start) WHERE canceled = 0;
  CREATE INDEX IF NOT EXISTS windows_by_day ON windows(day);
  CREATE TABLE IF NOT EXISTS outbox (
    id TEXT PRIMARY KEY, subject TEXT NOT NULL, body TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    next INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS waitlist (
    id TEXT PRIMARY KEY, object_id TEXT NOT NULL REFERENCES objects(id),
    first TEXT NOT NULL, last TEXT NOT NULL, phone TEXT NOT NULL, preference TEXT NOT NULL,
    created INTEGER NOT NULL, closed INTEGER NOT NULL DEFAULT 0
  );
`)
for (const [table, column] of [['bookings', 'email'], ['bookings', 'manual_mail'],
  ['bookings', 'note'], ['outbox', 'recipient']]) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(entry => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`)
  }
}

const all = (sql, ...args) => db.prepare(sql).all(...args)
const get = (sql, ...args) => db.prepare(sql).get(...args)
const run = (sql, ...args) => db.prepare(sql).run(...args)
const digest = value => createHash('sha256').update(value).digest()
const tokenHash = value => digest(value).toString('hex')
const localClock = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Berlin' })
const utcOffset = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', timeZoneName: 'longOffset' })
const time = minutes => [Math.floor(minutes / 60), minutes % 60].map(n => String(n).padStart(2, '0')).join(':')
const inFuture = (day, start) => `${day} ${time(start)}` > localClock.format(new Date())
const twoHours = 2 * 60 * 60 * 1000
const windowById = id => get('SELECT * FROM windows WHERE id = ?', id)
const objectById = id => get('SELECT * FROM objects WHERE id = ?', id)
const bookingByToken = token => get('SELECT * FROM bookings WHERE token = ?', tokenHash(token))
const publicObject = ({ id, title }) => ({ id, title })

function changeAllowed(day, start) {
  const local = `${day}T${time(start)}:00`
  const offsetAt = instant => utcOffset.formatToParts(instant).find(part => part.type === 'timeZoneName').value.slice(3)
  const estimated = Date.parse(local + offsetAt(new Date(local + 'Z')))
  const actual = Date.parse(local + offsetAt(new Date(estimated)))
  return actual - Date.now() >= twoHours
}

function fail(code, message) {
  throw Object.assign(new Error(message), { status: code })
}

function transaction(work) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = work()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function slots(window, excluded, moving = false, showWholeWindow = false) {
  const { id, day, start, end, duration } = window
  const dayBookings = all(`
    SELECT bookings.id, bookings.window_id, bookings.start, windows.duration
    FROM bookings JOIN windows ON windows.id = bookings.window_id
    WHERE windows.day = ? AND bookings.canceled = 0
    ORDER BY bookings.start
  `, day).filter(booking => booking.id !== excluded)
  const occupied = dayBookings.filter(booking => booking.window_id === id).map(booking => booking.start)
  const otherBookings = dayBookings.filter(booking => booking.window_id !== id)
  const canBook = at => inFuture(day, at) && (!moving || changeAllowed(day, at)) &&
    !otherBookings.some(booking => at < booking.start + booking.duration && booking.start < at + duration)
  const gaps = new Set()
  for (let i = 1; i < occupied.length; i++) {
    for (let at = occupied[i - 1] + duration; at + duration <= occupied[i]; at += duration) {
      if (canBook(at)) gaps.add(at)
    }
  }
  const edges = new Set([occupied[0] - duration, occupied.at(-1) + duration])
  const allowed = gaps.size ? gaps : edges
  const result = []
  for (let at = start; at + duration <= end; at += 15) {
    if (!showWholeWindow && !inFuture(day, at)) continue
    const booked = occupied.includes(at)
    const free = (!occupied.length || allowed.has(at)) && canBook(at)
    result.push({ at, time: time(at), state: booked ? 'booked' : free ? 'free' : 'blocked' })
  }
  return result
}

function availability(objectId, excluded) {
  const object = objectById(objectId)
  if (!object) fail(404, 'Dieser Buchungslink ist ungültig.')
  const windows = all('SELECT * FROM windows WHERE object_id = ? ORDER BY day, start', objectId)
    .filter(window => inFuture(window.day, window.end))
    .map(window => ({
      id: window.id, day: window.day, duration: window.duration, from: time(window.start), to: time(window.end),
      before: window.start > 0 ? { from: time(Math.max(0, window.start - 60)), to: time(window.start) } : null,
      after: window.end < 1440 ? { from: time(window.end), to: time(Math.min(1440, window.end + 30)) } : null,
      slots: slots(window, excluded, Boolean(excluded), true),
    }))
  return { object: publicObject(object), windows, manualCustomerMail }
}

function destination(body, objectId, excluded) {
  const window = windowById(String(body.windowId || ''))
  if (!window || window.object_id !== objectId ||
      !slots(window, excluded, Boolean(excluded)).some(slot => slot.at === body.at && slot.state === 'free')) {
    fail(409, 'Dieser Termin ist inzwischen nicht mehr verfügbar. Bitte wählen Sie einen anderen.')
  }
  return window
}

function value(body, key, max) {
  const result = typeof body[key] === 'string' ? body[key].trim() : ''
  if (!result || result.length > max || /[\r\n\x00]/u.test(result)) fail(400, 'Bitte prüfen Sie die eingegebenen Pflichtfelder.')
  return result
}

function timestamp(window, at) {
  return `${window.day.split('-').reverse().join('.')} · ${time(at)}–${time(at + window.duration)} Uhr`
}

function details(booking) {
  const window = windowById(booking.window_id)
  const active = !booking.canceled && inFuture(window.day, booking.start)
  return { object: publicObject(objectById(window.object_id)), when: timestamp(window, booking.start),
    active, editable: active && changeAllowed(window.day, booking.start), canceled: Boolean(booking.canceled), manualCustomerMail }
}

function notify(subject, booking, previous) {
  const { object, when } = details(booking)
  const lines = [object.title, when, previous && `Bisher: ${previous}`, objectById(object.id).meeting || null,
    '', [booking.first, booking.last].filter(Boolean).join(' '), `Telefon: ${booking.phone}`, booking.email && `E-Mail: ${booking.email}`]
  if (booking.note) lines.push('', 'Anmerkungen zur Buchung:', booking.note)
  queueMail(subject, lines.filter(line => line != null))
}

function queueMail(subject, lines, recipient = null) {
  run('INSERT INTO outbox (id, subject, body, recipient) VALUES (?, ?, ?, ?)',
    randomUUID(), subject, lines.join('\n'), recipient)
}

function customerMail(booking, token, moved = false) {
  if (!booking.email) return
  const { object, when } = details(booking)
  const meeting = objectById(object.id).meeting
  const managePath = `/termin#${token}`
  const subject = moved ? 'Ihr neuer Besichtigungstermin' : 'Ihr Besichtigungstermin ist bestätigt'
  const lines = [
    'Guten Tag ' + [booking.first, booking.last].filter(Boolean).join(' ') + ',', '',
    object.title, when, meeting ? 'Adresse und Treffpunkt: ' + meeting : 'Den Treffpunkt teile ich Ihnen separat mit.', '',
    'Sie können bis zwei Stunden vor Beginn umbuchen oder absagen:',
    PUBLIC_ORIGIN ? new URL(managePath, PUBLIC_ORIGIN).href : managePath,
    '', 'Andreas Weber · GARANT Immobilien',
  ]
  if (manualCustomerMail) {
    run('UPDATE bookings SET manual_mail = ? WHERE id = ?',
      JSON.stringify({ subject, body: lines.join('\n'), relativeLink: PUBLIC_ORIGIN ? null : managePath }), booking.id)
  } else {
    queueMail(subject, lines, booking.email)
  }
}

if (PUBLIC_ORIGIN && !/^https?:$/.test(new URL(PUBLIC_ORIGIN).protocol)) throw new Error('PUBLIC_ORIGIN muss eine HTTP(S)-Adresse sein.')
let sending = false
async function sendPending() {
  if (sending || !mailConfigured) return
  sending = true
  try {
    for (const item of all('SELECT * FROM outbox WHERE sent = 0 AND (? = 0 OR recipient IS NULL) AND next <= ? ORDER BY next LIMIT 10',
      Number(manualCustomerMail), Date.now())) {
      try {
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST', signal: AbortSignal.timeout(8000),
          headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': item.id },
          body: JSON.stringify({ from: MAIL_FROM, to: [item.recipient || MAIL_TO], subject: item.subject, text: item.body }),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        run("UPDATE outbox SET sent = 1, body = '', recipient = NULL WHERE id = ?", item.id)
      } catch (error) {
        console.error('E-Mail-Versand fehlgeschlagen:', error.message)
        run('UPDATE outbox SET attempts = attempts + 1, next = ? WHERE id = ?',
          Date.now() + Math.min(3600, 10 * 2 ** item.attempts) * 1000, item.id)
      }
    }
  } finally {
    sending = false
  }
}

function admin(req) {
  const auth = req.headers.authorization || ''
  const actual = auth.startsWith('Basic ') ? Buffer.from(auth.slice(6), 'base64').toString('utf8') : ''
  return timingSafeEqual(digest(actual), digest(`admin:${ADMIN_PASSWORD}`))
}

async function json(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') fail(415, 'Ungültiges Anfrageformat.')
  let input = ''
  for await (const chunk of req) {
    input += chunk
    if (input.length > 8192) fail(413, 'Die Anfrage ist zu groß.')
  }
  try {
    const data = JSON.parse(input)
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error()
    return data
  } catch {
    fail(400, 'Ungültige Eingabe.')
  }
}

function adminWindow(body) {
  const { day, start, end, duration } = body
  const validDay = typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day
  if (!validDay || ![30, 45].includes(duration) || ![start, end].every(n => Number.isInteger(n) && n % 15 === 0) ||
      start < 0 || end > 1440 || end - start < duration || !inFuture(day, start)) {
    fail(400, 'Bitte wähle ein zukünftiges Zeitfenster im 15-Minuten-Raster mit Platz für mindestens einen Termin.')
  }
  return transaction(() => {
    const objectId = String(body.objectId || '')
    if (!objectById(objectId)) fail(404, 'Objekt nicht gefunden.')
    if (get('SELECT id FROM windows WHERE object_id = ? AND day = ? AND start < ? AND end > ?', objectId, day, end, start)) {
      fail(409, 'Dieses Objekt hat bereits ein Besichtigungsfenster, das sich mit der gewählten Zeit überschneidet.')
    }
    run('INSERT INTO windows VALUES (?, ?, ?, ?, ?, ?)', randomUUID(), objectId, day, start, end, duration)
    return { ok: true }
  })
}

function changeBooking(token, action, body) {
  return transaction(() => {
    const booking = bookingByToken(token)
    if (!booking) fail(404, 'Der persönliche Terminlink ist ungültig.')
    const old = details(booking)
    if (!old.editable) fail(409, 'Online-Änderungen sind bis zwei Stunden vor Beginn möglich.')
    if (action === 'cancel') {
      run('UPDATE bookings SET canceled = 1, manual_mail = NULL WHERE id = ?', booking.id)
      booking.canceled = 1
      notify('Besichtigung abgesagt', booking)
    } else {
      const window = destination(body, old.object.id, booking.id)
      if (window.id !== booking.window_id || body.at !== booking.start) {
        run('UPDATE bookings SET window_id = ?, start = ? WHERE id = ?', window.id, body.at, booking.id)
        booking.window_id = window.id
        booking.start = body.at
        notify('Besichtigung umgebucht', booking, old.when)
        customerMail(booking, token, true)
      }
    }
    return details(booking)
  })
}

function contact(body, firstRequired = true) {
  const first = !firstRequired && (body.first == null || (typeof body.first === 'string' && !body.first.trim()))
    ? '' : value(body, 'first', 80)
  const last = value(body, 'last', 80)
  const phone = value(body, 'phone', 40)
  const digits = phone.replace(/\D/g, '').length
  if (!/^[+0-9 ()/.-]+$/.test(phone) || digits < 5 || digits > 20) fail(400, 'Bitte geben Sie eine gültige Telefonnummer ein.')
  return { first, last, phone }
}

function createBooking(body, objectId, waitlistId) {
  return transaction(() => {
    const window = destination(body, objectId)
    const token = randomBytes(32).toString('base64url')
    const email = value(body, 'email', 254)
    if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/u.test(email)) fail(400, 'Bitte geben Sie eine gültige E-Mail-Adresse ein.')
    if (body.note != null && (typeof body.note !== 'string' || body.note.length > 500 || body.note.includes('\x00'))) {
      fail(400, 'Anmerkungen dürfen höchstens 500 Zeichen enthalten.')
    }
    const note = body.note?.replace(/\r\n?/g, '\n').trim() || null
    const booking = { id: randomUUID(), window_id: window.id, start: body.at, ...contact(body, false), email, note }
    run('INSERT INTO bookings (id, token, window_id, start, first, last, phone, email, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      booking.id, tokenHash(token), window.id, body.at, booking.first, booking.last, booking.phone, booking.email, booking.note)
    notify('Neue Besichtigungsbuchung', booking)
    customerMail(booking, token)
    if (waitlistId) run('UPDATE waitlist SET closed = 1 WHERE id = ? AND object_id = ?', waitlistId, objectId)
    return { ...details(booking), manage: `/termin#${token}` }
  })
}

function addToWaitlist(body, objectId) {
  return transaction(() => {
    const data = availability(objectId)
    if (data.windows.some(window => window.slots.some(slot => slot.state === 'free'))) {
      fail(409, 'Inzwischen ist ein Termin frei. Bitte prüfen Sie die verfügbaren Termine.')
    }
    const { first, last, phone } = contact(body)
    const preference = value(body, 'preference', 250)
    run('INSERT INTO waitlist (id, object_id, first, last, phone, preference, created) VALUES (?, ?, ?, ?, ?, ?, ?)',
      randomUUID(), objectId, first, last, phone, preference, Date.now())
    queueMail('Neue Vormerkung für eine Besichtigung', [data.object.title, first + ' ' + last, 'Telefon: ' + phone,
      'Gewünschter Termin: ' + preference])
    return { ok: true }
  })
}

async function api(req, path) {
  let match
  if (req.method === 'GET' && path === '/api/admin') {
    return {
      today: localClock.format(new Date()).split(' ')[0],
      bookingOverview: all(`
        SELECT windows.day, bookings.start, bookings.first, bookings.last, bookings.phone, bookings.note,
               bookings.canceled, objects.title
        FROM bookings
        JOIN windows ON windows.id = bookings.window_id
        JOIN objects ON objects.id = windows.object_id
        ORDER BY windows.day, bookings.start, objects.title, bookings.id
      `).map(({ start, canceled, ...booking }) => ({
        ...booking, time: time(start),
        status: canceled ? 'canceled' : inFuture(booking.day, start) ? 'upcoming' : 'past',
      })),
      objects: all('SELECT * FROM objects ORDER BY rowid DESC').map(object => ({
        ...object,
        waitlist: all('SELECT id, first, last, phone, preference FROM waitlist WHERE object_id = ? AND closed = 0 ORDER BY created', object.id),
        windows: all('SELECT * FROM windows WHERE object_id = ? ORDER BY day, start', object.id).map(window => ({
          ...window, range: `${time(window.start)}–${time(window.end)} Uhr`,
          free: slots(window).filter(slot => slot.state === 'free'),
          bookings: all('SELECT id, first, last, phone, email, start, manual_mail, note FROM bookings WHERE window_id = ? AND canceled = 0 ORDER BY start', window.id)
            .map(({ manual_mail, ...booking }) => ({ ...booking, time: time(booking.start),
              manualMail: manual_mail ? JSON.parse(manual_mail) : null })),
        })),
      })),
      mailConfigured, manualCustomerMail, mailMissing,
      pending: get('SELECT count(*) AS count FROM outbox WHERE sent = 0 AND (? = 0 OR recipient IS NULL)', Number(manualCustomerMail)).count,
    }
  }
  if (req.method === 'GET' && (match = path.match(/^\/api\/objects\/([\w-]+)$/))) return availability(match[1])
  if (req.method === 'GET' && (match = path.match(/^\/api\/manage\/([\w-]+)$/))) {
    const booking = bookingByToken(match[1])
    if (!booking) fail(404, 'Der persönliche Terminlink ist ungültig.')
    const detail = details(booking)
    return { ...detail, windows: detail.editable ? availability(detail.object.id, booking.id).windows : [],
      current: { windowId: booking.window_id, at: booking.start } }
  }
  if (req.method !== 'POST') fail(404, 'Seite nicht gefunden.')
  const body = await json(req)
  if (path === '/api/admin/objects') {
    const meeting = body.meeting ? value(body, 'meeting', 250) : ''
    run('INSERT INTO objects VALUES (?, ?, ?)', randomUUID(), value(body, 'title', 120), meeting)
    return { ok: true }
  }
  if (path === '/api/admin/windows') return adminWindow(body)
  if (path === '/api/admin/bookings') return createBooking(body, String(body.objectId || ''), String(body.waitlistId || ''))
  if ((match = path.match(/^\/api\/admin\/waitlist\/([\w-]+)\/close$/))) {
    run('UPDATE waitlist SET closed = 1 WHERE id = ?', match[1])
    return { ok: true }
  }
  if ((match = path.match(/^\/api\/manage\/([\w-]+)\/(cancel|move)$/))) {
    return changeBooking(match[1], match[2], body)
  }
  if ((match = path.match(/^\/api\/objects\/([\w-]+)\/book$/))) {
    return createBooking(body, match[1])
  }
  if ((match = path.match(/^\/api\/objects\/([\w-]+)\/waitlist$/))) return addToWaitlist(body, match[1])
  fail(404, 'Seite nicht gefunden.')
}

const assets = new Map([
  ['/garant-logo.svg', ['image/svg+xml; charset=utf-8', readFileSync(new URL('./public/garant-logo.svg', import.meta.url))]],
  ['/andreas-weber.png', ['image/png', readFileSync(new URL('./public/andreas-weber.png', import.meta.url))]],
  ['/app.js', ['text/javascript; charset=utf-8', readFileSync(new URL('./public/app.js', import.meta.url))]],
  ['/style.css', ['text/css; charset=utf-8', readFileSync(new URL('./public/style.css', import.meta.url))]],
])
const html = readFileSync(new URL('./public/index.html', import.meta.url))

createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
  const path = new URL(req.url, 'http://localhost').pathname
  if ((path === '/admin' || path === '/api/admin' || path.startsWith('/api/admin/')) && !admin(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Besichtigungsverwaltung", charset="UTF-8"' })
    return res.end('Anmeldung erforderlich.')
  }
  if (!path.startsWith('/api/') && req.method === 'GET') {
    const asset = assets.get(path)
    if (asset) {
      res.writeHead(200, { 'Content-Type': asset[0] })
      return res.end(asset[1])
    }
    if (/^\/(?:admin|termin|buchen(?:\/[\w-]+)?)?$/.test(path)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(html)
    }
  }
  try {
    if (req.method === 'POST' && req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'Anfrage abgelehnt.')
    const result = await api(req, path)
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(result))
    if (req.method === 'POST') void sendPending()
  } catch (error) {
    if (!error.status) console.error(error.message)
    res.writeHead(error.status || 500, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: error.status ? error.message : 'Die Anfrage konnte nicht verarbeitet werden.' }))
  }
}).listen(Number(process.env.PORT || 3000), process.env.HOST || '0.0.0.0', () => {
  console.log('Besichtigungskalender bereit.')
  void sendPending()
})
setInterval(() => void sendPending(), 15000).unref()
