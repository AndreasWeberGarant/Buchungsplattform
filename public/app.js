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
  return node('label', {}, fieldLabel(label, input.required), input)
}

function fieldLabel(label, required) {
  const marker = node('span', { className: 'required-marker' }, ' *')
  marker.setAttribute('aria-hidden', 'true')
  return node('span', {}, label, required ? marker : '')
}

function select(label, name, options) {
  return node('label', {}, fieldLabel(label, true), node('select', { name, required: true },
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
  const labels = { free: 'Frei', booked: 'Belegt' }
  const edge = start => node('div', { className: 'slot booked slot-edge' },
    node('strong', {}, start),
    node('span', {}, 'Belegt'))
  const bookable = windows.some(window => window.slots.some(slot =>
    slot.state === 'free' && (window.id !== current?.windowId || slot.at !== current.at)))
  const days = windows.map((window, index) => {
    const range = window.from && window.to ? window.from + '–' + window.to + ' Uhr' : ''
    const isCurrentSlot = slot => window.id === current?.windowId && slot.at === current.at
    const controls = window.slots.map(slot => {
      const isCurrent = isCurrentSlot(slot)
      const visibleState = slot.state === 'free' ? 'free' : 'booked'
      const picked = window.id === selected?.windowId && slot.at === selected.at
      const control = button('', () => onPick({ windowId: window.id, at: slot.at, label: dayLabel(window.day) + ', ' + slot.time + ' Uhr' }),
        'slot ' + visibleState)
      control.disabled = isCurrent || visibleState !== 'free'
      control.setAttribute('aria-pressed', String(picked))
      control.append(node('strong', {}, slot.time), node('span', {}, isCurrent ? 'Ihr Termin' : labels[visibleState]))
      return control
    })
    const start = window.from ? minutes(window.from) : window.slots[0]?.at
    const leadingSlots = index === 0
      ? Array.isArray(window.before) ? window.before.map(slot => edge(slot.from))
        : [start - 2 * window.duration, start - window.duration].filter(at => at >= 0).map(at =>
          edge([Math.floor(at / 60), at % 60].map(part => String(part).padStart(2, '0')).join(':')))
      : []
    return node('div', {}, node('h3', {}, dayLabel(window.day)),
      range ? para(range, 'muted duration') : '',
      para('Geplante Termindauer: ' + window.duration + ' Minuten', 'muted duration'),
      node('div', { className: 'slot-grid' }, leadingSlots, controls))
  })
  return node('div', {}, bookable ? '' : para('Derzeit ist kein weiterer Termin buchbar.', 'muted'),
    node('div', { className: 'days' }, days),
    node('ul', { className: 'slot-legend', 'ariaLabel': 'Legende' },
      ...Object.entries(labels).map(([state, label]) => node('li', { className: state }, label))))
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
      ? 'Andreas Weber meldet sich per E-Mail mit den Details zur Besichtigung.'
      : 'Sie erhalten eine Bestätigung per E-Mail.'),
    para('Sie können den Termin bis zwei Stunden vor Beginn absagen oder umbuchen.'),
    addressLink(result.object.listingUrl),
    node('a', { href: link.href, className: 'text-link cancel-link' }, 'Termin absagen'),
  ))
}

function addressLink(url) {
  return url ? node('p', { className: 'listing-link' }, 'Die genaue Adresse erhalten Sie über das Inserat. ',
    node('a', { href: url, target: '_blank', rel: 'noopener noreferrer', className: 'text-link' }, 'Hier geht’s zur Adresse')) : ''
}

function contactFields(withEmail) {
  return [
    node('div', { className: 'columns' }, field(withEmail ? 'Vorname (optional)' : 'Vorname',
      { name: 'first', required: !withEmail, autocomplete: 'given-name', maxLength: 80 }),
      field('Nachname', { name: 'last', autocomplete: 'family-name', maxLength: 80 })),
    field('Telefonnummer', { name: 'phone', type: 'tel', autocomplete: 'tel', maxLength: 40 }),
    ...(withEmail ? [field('E-Mail-Adresse', { name: 'email', type: 'email', autocomplete: 'email', maxLength: 254 })] : []),
  ]
}

function noteField() {
  return node('label', {}, 'Anmerkungen (optional)', node('textarea', { name: 'note', rows: 3, maxLength: 500 }))
}

async function bookingPage(id) {
  const endpoint = '/api/objects/' + id
  let data = await api(endpoint)
  let selected
  const selection = node('div')
  const selectionText = para('Bitte wählen Sie zuerst einen freien Termin.', 'muted')
  const callback = node('input', { type: 'checkbox', name: 'callback', onchange: () => {
    selected = undefined
    renderPicker(false)
    renderMode()
  } })
  const preference = field('Gewünschte Terminzeit (optional)', { name: 'preference', required: false, maxLength: 250 })
  const bookingForm = form([
    node('label', { className: 'callback-option' }, callback, 'Keinen passenden Termin gefunden? Rückruf anfordern'),
    ...contactFields(true), preference, noteField(),
  ], 'Termin verbindlich buchen', values => {
    if (values.callback) return api(endpoint + '/callback', values)
    if (!selected) throw new Error('Bitte wählen Sie zuerst einen freien Termin.')
    return api(endpoint + '/book', { ...values, ...selected })
  }, result => {
    if (result.manage) return confirmed(result)
    app.replaceChildren(heading('Rückruf angefragt', data.object),
      section(para('Andreas Weber meldet sich telefonisch bei Ihnen.')))
  }, async () => {
    data = await api(endpoint)
    selected = undefined
    renderPicker(false)
    renderMode()
  })
  const contactSection = section(node('h2', {}, 'Ihre Kontaktdaten'), selectionText,
    para('Mit * markierte Felder sind Pflichtfelder.', 'muted required-hint'), bookingForm)
  function renderMode() {
    const bookable = data.windows.some(window => window.slots.some(slot => slot.state === 'free'))
    selectionText.textContent = callback.checked ? 'Für den Rückruf ist keine Terminwahl erforderlich.'
      : selected?.label ?? (bookable ? 'Bitte wählen Sie zuerst einen freien Termin.'
        : 'Aktuell ist kein Termin buchbar. Sie können einen Rückruf anfordern.')
    preference.hidden = !callback.checked
    preference.querySelector('input').disabled = !callback.checked
    bookingForm.querySelector('button[type="submit"]').textContent = callback.checked
      ? 'Rückruf anfordern' : 'Termin verbindlich buchen'
  }
  function renderPicker(focus) {
    selection.replaceChildren(picker(data.windows, null, slot => {
      callback.checked = false
      selected = slot
      renderMode()
      renderPicker(true)
    }, selected))
    if (focus) selection.querySelector('[aria-pressed="true"]')?.focus()
  }
  renderPicker(false)
  renderMode()
  const bookingHeading = heading('Besichtigung buchen', data.object)
  bookingHeading.classList.add('booking-heading')
  app.replaceChildren(bookingHeading,
    section(node('h2', {}, 'Termin auswählen'),
      para(data.manualCustomerMail
        ? 'Nach der Buchung meldet sich Andreas Weber per E-Mail mit den Details zur Besichtigung.'
        : 'Nach der Buchung erhalten Sie eine Bestätigung per E-Mail.'),
      addressLink(data.object.listingUrl), selection),
    contactSection)
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

function windowFields(window) {
  const formatTime = at => [Math.floor(at / 60), at % 60].map(part => String(part).padStart(2, '0')).join(':')
  const end = window?.end ?? 1080
  return [
    field('Datum', { name: 'day', type: 'date', value: window?.day ?? '' }),
    node('div', { className: 'columns' },
      field('Von', { name: 'from', type: 'time', step: 900, value: formatTime(window?.start ?? 840) }),
      field('Bis', end === 1440 ? { name: 'to', type: 'text', maxLength: 5, value: '24:00' }
        : { name: 'to', type: 'time', step: 900, value: formatTime(end) })),
    select('Dauer pro Termin', 'duration', [['30', '30 Minuten'], ['45', '45 Minuten']]),
  ]
}

function windowData(values) {
  return { day: values.day, start: minutes(values.from), end: minutes(values.to), duration: Number(values.duration) }
}

function editWindow(window) {
  const editor = form(windowFields(window), 'Änderungen speichern',
    values => api('/api/admin/windows/' + window.id, windowData(values)), adminPage)
  editor.elements.namedItem('duration').value = String(window.duration)
  return node('details', { className: 'window-editor' }, node('summary', {}, 'Zeitfenster bearbeiten'), editor)
}

function bookingRow(booking) {
  const row = node('li', {}, node('strong', {}, booking.time + ' Uhr'),
    ' · ' + bookingName(booking) + ' · ' + booking.phone)
  if (booking.note) row.append(para(booking.note, 'booking-note'))
  const feedback = status()
  const cancel = button('Ausbuchen', async () => {
    if (!confirm(bookingName(booking) + ' um ' + booking.time + ' Uhr ausbuchen?')) return
    cancel.disabled = true
    feedback.textContent = ''
    try {
      await api('/api/admin/bookings/' + booking.id + '/cancel', {})
      await adminPage()
    } catch (error) {
      feedback.textContent = error.message
      cancel.disabled = false
    }
  }, 'secondary')
  row.append(node('div', { className: 'row-actions' }, cancel), feedback)
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

const bookingName = booking => [booking.first, booking.last].filter(Boolean).join(' ')
const phoneLink = phone => node('a', { href: 'tel:' + phone.replace(/[^+\d]/g, '') }, phone)

function todayOverview(bookings, today) {
  const rows = bookings.filter(booking => booking.day === today && booking.status !== 'canceled')
  const next = rows.find(booking => booking.status === 'upcoming')
  return section(node('h2', {}, 'Heutige Termine'),
    rows.length ? node('ul', { className: 'today-bookings' }, rows.map(booking =>
      node('li', { className: booking === next ? 'next-booking' : '' },
        node('div', {}, node('strong', {}, booking.time + ' Uhr'),
          booking === next ? node('span', { className: 'booking-status upcoming' }, 'Als Nächstes') : ''),
        node('div', {}, node('strong', {}, booking.title),
          para(bookingName(booking), 'muted'),
          booking.note ? para(booking.note, 'booking-note') : ''),
        phoneLink(booking.phone))))
      : para('Heute sind keine Besichtigungen gebucht.', 'muted'))
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
          node('td', {}, bookingName(booking),
            booking.note ? node('small', { className: 'booking-note' }, booking.note) : ''),
          node('td', {}, phoneLink(booking.phone)),
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
    field('Inseratslink (optional)', { name: 'listingUrl', type: 'url', required: false, maxLength: 2048 }),
  ], 'Objekt anlegen', values => api('/api/admin/objects', values), adminPage)
  const windowForm = form([
    select('Objekt', 'objectId', data.objects.map(object => [object.id, object.title])),
    ...windowFields(),
  ], 'Zeitfenster anlegen', values => api('/api/admin/windows', {
    objectId: values.objectId, ...windowData(values),
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
      form([select('Freier Termin', 'slot', options), ...contactFields(true), noteField(),
        node('input', { type: 'hidden', name: 'waitlistId' })], 'Buchung speichern',
        submitBooking, adminPage)) : null
    const listing = node('details', { className: 'window-editor' }, node('summary', {}, 'Inseratslink bearbeiten'),
      form([field('Inseratslink (optional)', { name: 'listingUrl', type: 'url', required: false,
        maxLength: 2048, value: object.listing_url ?? '' })], 'Inseratslink speichern',
        values => api('/api/admin/objects/' + object.id + '/listing', values), adminPage))
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
        for (const name of ['first', 'last', 'phone', 'email', 'note']) formElement.elements.namedItem(name).value = row[name] ?? ''
        formElement.elements.namedItem('waitlistId').value = row.id
        formElement.elements.namedItem('slot').focus()
      }, 'secondary') : ''
      return node('li', {}, node('strong', {}, bookingName(row)), ' · ', phoneLink(row.phone),
        row.email ? para(row.email, 'muted') : '',
        row.preference ? para(row.preference, 'muted') : '',
        row.note ? para(row.note, 'booking-note') : '',
        node('div', { className: 'row-actions' }, use, close), feedback)
    })
    return section(node('h2', {}, object.title), object.meeting ? para(object.meeting, 'muted') : '',
      shareLink(new URL('/buchen/' + object.id, location.origin), 'Buchungslink für Interessenten'),
      listing,
      ...(manual ? [manual] : []),
      ...(requests.length ? [node('div', { className: 'admin-window' }, node('h3', {}, 'Rückrufanfragen und Vormerkungen'),
        node('ul', { className: 'appointments' }, requests))] : []),
      object.windows.map(window => node('div', { className: 'admin-window' },
        node('h3', {}, dayLabel(window.day)), para(window.range + ' · ' + window.duration + ' Minuten pro Termin', 'muted'),
        editWindow(window),
        window.bookings.length ? node('ul', { className: 'appointments' }, window.bookings.map(bookingRow))
          : para('Noch keine Buchungen.', 'muted'))))
  })
  app.replaceChildren(heading('Besichtigungen verwalten'),
    todayOverview(data.bookingOverview ?? [], data.today),
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
