const app = document.querySelector('#app')
const dayFormat = new Intl.DateTimeFormat('de-DE', {
  weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
})
const dayLabel = day => dayFormat.format(new Date(day + 'T12:00:00Z'))
const path = location.pathname

function node(tag, properties = {}, ...children) {
  const element = document.createElement(tag)
  Object.assign(element, properties)
  element.append(...children.flat())
  return element
}

const para = (text, className = '') => node('p', { className }, text)
const title = text => node('h1', {}, text)
const section = (...children) => node('section', { className: 'panel' }, ...children)
const button = (text, fn, className = 'primary') =>
  node('button', { type: 'button', className, onclick: fn }, text)
const status = () => {
  const element = para('', 'status')
  element.setAttribute('aria-live', 'polite')
  return element
}

async function api(url, payload) {
  const response = await fetch(url, payload === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  })
  const result = await response.json()
  if (!response.ok) throw Object.assign(new Error(result.error), { status: response.status })
  return result
}

function heading(label, object) {
  return node('header', { className: 'page-heading' }, title(label),
    object ? para(object.title, 'object-name') : '')
}

function field(label, properties) {
  const input = node('input', { required: true, ...properties })
  return node('label', {}, node('span', {}, label), input)
}

function select(label, name, options) {
  return node('label', {}, node('span', {}, label), node('select', { name, required: true },
    options.map(([value, label]) => node('option', { value }, label))))
}

function form(fields, label, action, onSuccess, onConflict) {
  const message = status()
  const submit = node('button', { type: 'submit', className: 'primary' }, label)
  return node('form', { onsubmit: async event => {
    event.preventDefault()
    if (submit.disabled) return
    submit.disabled = true
    message.textContent = ''
    try {
      const values = Object.fromEntries(new FormData(event.currentTarget))
      await onSuccess(await action(values))
    } catch (error) {
      if (error.status === 409 && onConflict) await onConflict()
      message.textContent = error.message
    } finally {
      submit.disabled = false
    }
  } }, fields, submit, message)
}

function picker(windows, current, onPick, selected) {
  if (!windows.length) return para('Derzeit sind keine kommenden Termine eingetragen.', 'muted')
  const labels = { free: 'Frei', booked: 'Belegt', blocked: 'Nicht verfügbar' }
  const bookable = windows.some(window => window.slots.some(slot =>
    slot.state === 'free' && (window.id !== current?.windowId || slot.at !== current.at)))
  return node('div', { className: 'days' }, bookable ? '' : para('Derzeit ist kein weiterer Termin buchbar.', 'muted'), windows.map(window =>
    node('div', {}, node('h3', {}, dayLabel(window.day)), para(window.duration + ' Minuten', 'muted duration'),
      node('div', { className: 'slot-grid' }, window.slots.map(slot => {
        const isCurrent = window.id === current?.windowId && slot.at === current.at
        const picked = window.id === selected?.windowId && slot.at === selected.at
        const control = button('', () => onPick({ windowId: window.id, at: slot.at, label: dayLabel(window.day) + ', ' + slot.time + ' Uhr' }),
          'slot ' + slot.state)
        control.disabled = isCurrent || slot.state !== 'free'
        control.setAttribute('aria-pressed', String(picked))
        control.append(node('strong', {}, slot.time), node('span', {}, isCurrent ? 'Ihr Termin' : labels[slot.state]))
        return control
      })))))
}

function shareLink(url, label) {
  const message = status()
  const input = node('input', { readOnly: true, value: url.href, onclick: event => event.currentTarget.select() })
  return node('div', { className: 'share' }, node('label', {}, label, input),
    button('Link kopieren', async () => {
      try {
        await navigator.clipboard.writeText(url.href)
        message.textContent = 'Link kopiert.'
      } catch {
        input.select()
        message.textContent = 'Der Link ist markiert und kann kopiert werden.'
      }
    }, 'secondary'), message)
}

function confirmed(result) {
  const link = new URL(result.manage, location.origin)
  app.replaceChildren(heading('Termin gebucht', result.object), section(
    node('h2', {}, result.when),
    para(result.manualCustomerMail
      ? 'Andreas Weber sendet Ihnen Adresse und Treffpunkt separat per E-Mail.'
      : 'Die Bestätigung mit Adresse und Treffpunkt wird Ihnen per E-Mail zugesandt.'),
    para('Mit dem persönlichen Link können Sie bis zwei Stunden vor Beginn umbuchen oder absagen.'),
    shareLink(link, 'Persönlicher Terminlink'),
    node('a', { href: link.href, className: 'text-link' }, 'Termin verwalten'),
  ))
}

function contactFields(withEmail) {
  return [
    node('div', { className: 'columns' }, field('Vorname', { name: 'first', autocomplete: 'given-name', maxLength: 80 }),
      field('Nachname', { name: 'last', autocomplete: 'family-name', maxLength: 80 })),
    field('Telefonnummer', { name: 'phone', type: 'tel', autocomplete: 'tel', maxLength: 40 }),
    ...(withEmail ? [field('E-Mail-Adresse', { name: 'email', type: 'email', autocomplete: 'email', maxLength: 254 })] : []),
  ]
}

async function bookingPage(id) {
  const endpoint = '/api/objects/' + id
  let data = await api(endpoint)
  let selected
  const selection = node('div')
  const actions = node('div')
  const selectionText = para('Bitte wählen Sie zuerst einen freien Termin.', 'muted')
  const bookingForm = form(contactFields(true), 'Termin verbindlich buchen', values => {
    if (!selected) throw new Error('Bitte wählen Sie zuerst einen freien Termin.')
    return api(endpoint + '/book', { ...values, ...selected })
  }, confirmed, async () => {
    data = await api(endpoint)
    selected = undefined
    selectionText.textContent = 'Bitte wählen Sie einen neuen Termin.'
    renderPicker(false)
    renderActions()
  })
  const contactSection = section(node('h2', {}, 'Ihre Kontaktdaten'), selectionText, bookingForm)
  function renderActions() {
    const bookable = data.windows.some(window => window.slots.some(slot => slot.state === 'free'))
    if (bookable) {
      if (actions.firstChild !== contactSection) actions.replaceChildren(contactSection)
      return
    }
    const waitlist = form([
      ...contactFields(false),
      field('Wann würde Ihnen ein Termin passen?', { name: 'preference', maxLength: 250,
        placeholder: 'Zum Beispiel dienstags oder donnerstags ab 16 Uhr' }),
    ], 'Vormerken lassen', values => api(endpoint + '/waitlist', values), () => {
      actions.replaceChildren(section(node('h2', {}, 'Vormerkung gespeichert'),
        para('Sie sind vorgemerkt. Wenn ein Termin passt, melden wir uns telefonisch.')))
    }, async () => {
      data = await api(endpoint)
      renderPicker(false)
      renderActions()
    })
    actions.replaceChildren(section(node('h2', {}, 'Für einen Termin vormerken'),
      para('Hinterlassen Sie eine Wunschzeit. Wenn ein Termin passt, melden wir uns telefonisch.'), waitlist))
  }
  function renderPicker(focus) {
    selection.replaceChildren(picker(data.windows, null, slot => {
      selected = slot
      selectionText.textContent = slot.label
      renderPicker(true)
    }, selected))
    if (focus) selection.querySelector('[aria-pressed="true"]')?.focus()
  }
  renderPicker(false)
  renderActions()
  app.replaceChildren(heading('Besichtigung buchen', data.object),
    section(node('h2', {}, 'Termin auswählen'),
      para(data.manualCustomerMail
        ? 'Nach der Buchung sendet Ihnen Andreas Weber eine separate E-Mail mit genauer Adresse und Treffpunkt.'
        : 'Nach der Buchung erhalten Sie eine separate E-Mail mit Bestätigung, genauer Adresse und Treffpunkt.'), selection),
    actions)
}

async function managePage(token) {
  if (!/^[\w-]{43}$/.test(token)) throw new Error('Bitte öffnen Sie Ihren persönlichen Terminlink, um die Buchung zu verwalten.')
  const endpoint = '/api/manage/' + token
  let data = await api(endpoint)
  let selected
  let notice = ''
  function render() {
    const message = status()
    message.textContent = notice
    const current = section(node('h2', {}, data.canceled ? 'Termin abgesagt' : 'Ihr Termin'),
      para(data.when), message)
    app.replaceChildren(heading('Termin verwalten', data.object), current)
    if (!data.editable) {
      if (data.active) current.append(para('Online-Änderungen sind bis zwei Stunden vor Beginn möglich.', 'muted'))
      return
    }
    const move = button('Ausgewählten Termin buchen', async () => {
      if (!selected) return
      move.disabled = cancel.disabled = true
      try {
        await api(endpoint + '/move', selected)
        data = await api(endpoint)
        selected = undefined
        notice = 'Ihr Termin wurde umgebucht. Sie erhalten eine aktualisierte Bestätigung per E-Mail.'
        render()
      } catch (error) {
        message.textContent = error.message
        move.disabled = cancel.disabled = false
        if (error.status === 409) {
          data = await api(endpoint)
          selected = undefined
          notice = error.message
          render()
        }
      }
    })
    move.disabled = !selected
    const cancel = button('Termin absagen', async event => {
      if (!confirm('Möchten Sie Ihren Termin wirklich absagen?')) return
      const control = event.currentTarget
      control.disabled = move.disabled = true
      try {
        data = await api(endpoint + '/cancel', {})
        notice = 'Ihre Absage wurde gespeichert.'
        render()
      } catch (error) {
        message.textContent = error.message
        control.disabled = false
        move.disabled = !selected
      }
    }, 'secondary')
    current.append(cancel)
    app.append(section(node('h2', {}, 'Anderen Termin wählen'),
      picker(data.windows, data.current, slot => {
        selected = slot
        render()
        app.querySelector('[aria-pressed="true"]')?.focus()
      }, selected), move))
  }
  render()
}

function minutes(value) {
  const [hour, minute] = value.split(':').map(Number)
  return hour * 60 + minute
}

function bookingRow(booking) {
  const row = node('li', {}, node('strong', {}, booking.time + ' Uhr'),
    ' · ' + booking.first + ' ' + booking.last + ' · ' + booking.phone)
  if (!booking.manualMail) return row
  const { subject, relativeLink } = booking.manualMail
  const body = relativeLink
    ? booking.manualMail.body.replace(relativeLink, new URL(relativeLink, location.origin).href)
    : booking.manualMail.body
  const recipient = encodeURIComponent(booking.email)
  const href = 'mailto:' + recipient + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body)
  const draft = node('textarea', { readOnly: true, value: body, rows: 7 })
  row.append(node('details', {},
    node('summary', {}, 'Kundenmail vorbereiten'),
    para('An: ' + booking.email),
    para('Betreff: ' + subject),
    node('label', {}, 'Mailtext', draft),
    node('a', { href, className: 'text-link' }, 'Im Mailprogramm öffnen')))
  return row
}

function bookingOverview(bookings) {
  const statuses = { upcoming: 'Anstehend', past: 'Vergangen', canceled: 'Abgesagt' }
  const upcoming = bookings.filter(booking => booking.status === 'upcoming')
  const history = bookings.filter(booking => booking.status !== 'upcoming').reverse()
  const headline = node('h2', {}, 'Buchungen im Überblick')
  function table(rows, label) {
    const container = node('div', { className: 'table-scroll', tabIndex: 0 },
      node('table', { className: 'booking-table' },
        node('thead', {}, node('tr', {}, ['Termin', 'Objekt', 'Interessent', 'Telefon', 'Status']
          .map(text => node('th', { scope: 'col' }, text)))),
        node('tbody', {}, rows.map(booking => node('tr', {},
          node('td', {}, node('strong', {}, booking.time + ' Uhr'), node('small', {}, dayLabel(booking.day))),
          node('td', {}, booking.title),
          node('td', {}, booking.first + ' ' + booking.last),
          node('td', {}, node('a', { href: 'tel:' + booking.phone.replace(/[^+\d]/g, '') }, booking.phone)),
          node('td', {}, node('span', { className: 'booking-status ' + booking.status }, statuses[booking.status])))))))
    container.setAttribute('aria-label', label)
    container.setAttribute('role', 'region')
    return container
  }
  return section(headline,
    upcoming.length ? table(upcoming, 'Anstehende Buchungen') : para('Keine anstehenden Buchungen.', 'muted'),
    ...(history.length ? [node('details', { className: 'booking-history' },
      node('summary', {}, 'Vergangene und abgesagte Buchungen (' + history.length + ')'),
      table(history, 'Vergangene und abgesagte Buchungen'))] : []))
}

async function adminPage() {
  const data = await api('/api/admin')
  const objectForm = form([
    field('Öffentlicher Objektname ohne Adresse', { name: 'title', maxLength: 120 }),
    field('Genaue Adresse und Treffpunkt für die Bestätigungsmail', { name: 'meeting', maxLength: 250 }),
  ], 'Objekt anlegen', values => api('/api/admin/objects', values), adminPage)
  const windowForm = form([
    select('Objekt', 'objectId', data.objects.map(object => [object.id, object.title])),
    field('Datum', { name: 'day', type: 'date' }),
    node('div', { className: 'columns' },
      field('Von', { name: 'from', type: 'time', step: 900, value: '14:00' }),
      field('Bis', { name: 'to', type: 'time', step: 900, value: '18:00' })),
    select('Dauer pro Termin', 'duration', [['30', '30 Minuten'], ['45', '45 Minuten']]),
  ], 'Zeitfenster anlegen', values => api('/api/admin/windows', {
    objectId: values.objectId, day: values.day, start: minutes(values.from), end: minutes(values.to), duration: Number(values.duration),
  }), adminPage)
  const objects = data.objects.map(object => {
    const options = object.windows.flatMap(window => window.free.map(slot =>
      [window.id + ':' + slot.at, dayLabel(window.day) + ' · ' + slot.time + ' Uhr']))
    const submitBooking = values => {
      const [windowId, at] = values.slot.split(':')
      return api('/api/admin/bookings', { ...values, objectId: object.id, windowId, at: Number(at) })
    }
    const manual = options.length ? node('details', { className: 'admin-window' },
      node('summary', {}, 'Interessenten einbuchen'),
      form([select('Freier Termin', 'slot', options), ...contactFields(true),
        node('input', { type: 'hidden', name: 'waitlistId' })], 'Buchung speichern',
        submitBooking, adminPage)) : null
    const requests = object.waitlist.map(row => {
      const feedback = status()
      const close = button('Erledigt', async () => {
        close.disabled = true
        try {
          await api('/api/admin/waitlist/' + row.id + '/close', {})
          await adminPage()
        } catch (error) {
          feedback.textContent = error.message
          close.disabled = false
        }
      }, 'secondary')
      const use = manual ? button('Buchung vorbereiten', () => {
        manual.open = true
        const formElement = manual.querySelector('form')
        for (const name of ['first', 'last', 'phone']) formElement.elements.namedItem(name).value = row[name]
        formElement.elements.namedItem('waitlistId').value = row.id
        formElement.elements.namedItem('email').value = ''
        formElement.elements.namedItem('slot').focus()
      }, 'secondary') : ''
      return node('li', {}, node('strong', {}, row.first + ' ' + row.last), ' · ' + row.phone,
        para(row.preference, 'muted'), node('div', { className: 'row-actions' }, use, close), feedback)
    })
    return section(node('h2', {}, object.title), para(object.meeting, 'muted'),
      shareLink(new URL('/buchen/' + object.id, location.origin), 'Buchungslink für Interessenten'),
      ...(manual ? [manual] : []),
      ...(requests.length ? [node('div', { className: 'admin-window' }, node('h3', {}, 'Vormerkungen'),
        node('ul', { className: 'appointments' }, requests))] : []),
      object.windows.map(window => node('div', { className: 'admin-window' },
        node('h3', {}, dayLabel(window.day)), para(window.range + ' · ' + window.duration + ' Minuten pro Termin', 'muted'),
        window.bookings.length ? node('ul', { className: 'appointments' }, window.bookings.map(bookingRow))
          : para('Noch keine Buchungen.', 'muted'))))
  })
  app.replaceChildren(heading('Besichtigungen verwalten'),
    ...(data.manualCustomerMail ? [para('Kundenbestätigungen verschickst du selbst aus der jeweiligen Buchung.', 'banner')] : []),
    ...(data.mailConfigured ? (data.pending ? [para(data.pending + ' E-Mail(s) warten auf den Versand.', 'banner')] : [])
      : [para('Benachrichtigungen warten auf die Einrichtung des Mailversands. Fehlende Einstellungen: ' +
        (data.mailMissing ?? []).join(', '), 'banner')]),
    bookingOverview(data.bookingOverview ?? []),
    node('div', { className: 'columns admin-forms' }, section(node('h2', {}, 'Objekt anlegen'), objectForm),
      ...(data.objects.length ? [section(node('h2', {}, 'Zeitfenster anlegen'), windowForm)] : [])), ...objects)
}

async function start() {
  if (path === '/admin') return adminPage()
  if (path.startsWith('/buchen/')) return bookingPage(path.split('/').at(-1))
  if (path === '/termin') return managePage(location.hash.slice(1))
  app.replaceChildren(heading('Besichtigungskalender'), section(
    para('Bitte öffnen Sie den Buchungslink, den Sie für das Objekt erhalten haben.'),
    node('a', { href: '/admin', className: 'text-link' }, 'Zur Verwaltung')))
}

start().catch(error => app.replaceChildren(heading('Link prüfen'), section(para(error.message))))
