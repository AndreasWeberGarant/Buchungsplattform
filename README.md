# Besichtigungskalender

Die Anwendung läuft als einzelner Node.js-24-Dienst mit SQLite. Sie braucht keinen Paketmanager und keinen separaten Datenbankserver.

## Hosten

Für einen Docker-Host das Projekt entpacken und das Image bauen.

```sh
docker build -t besichtigungskalender .
docker run -d --restart unless-stopped --name besichtigungskalender \
  -p 127.0.0.1:3000:3000 --env-file .env \
  -v besichtigungsdaten:/app/data besichtigungskalender
```

Auf einem verwalteten Docker-Host den öffentlichen HTTPS-Zugang auf Container-Port 3000 richten und einen dauerhaften Schreibspeicher unter `/app/data` einbinden. Bei einem eigenen Server den lokalen Port 3000 hinter einem HTTPS-Reverse-Proxy veröffentlichen. Eine Instanz betreiben und das SQLite-Volume sichern. Für einen lokalen Start ohne Docker genügen Node.js 24, die unten genannten Umgebungsvariablen und `node server.mjs`.

Die Datei `.env` für Docker selbst anlegen und privat halten. Bei verwalteten Hosts die Werte als Umgebungsvariablen hinterlegen.

```dotenv
ADMIN_PASSWORD=hier-ein-eigenes-langes-zufallspasswort-eintragen
RESEND_API_KEY=hier-den-api-schluessel-eintragen
MAIL_FROM=Besichtigungen <termine@deine-verifizierte-domain.de>
MAIL_TO=deine-empfaengeradresse@example.de
PUBLIC_ORIGIN=https://deine-buchungsdomain.de
```

Für den Versand einen Resend-API-Schlüssel mit Sendeberechtigung und eine dort eingerichtete Absenderdomain verwenden. `PUBLIC_ORIGIN` ist die öffentliche Adresse der App, beispielsweise die vom Hoster bereitgestellte HTTPS-Adresse. Die Plattform nutzt sie für die persönlichen Terminlinks in den Kundenmails. Bei einem Domainwechsel den Wert aktualisieren. Die Verwaltung zeigt wartende Nachrichten an. Vor dem Versenden echter Buchungslinks eine Testbuchung samt Umbuchung und Absage durchführen und beide Posteingänge prüfen.

## Benutzen

1. `/admin` öffnen und als **admin** mit dem gesetzten Passwort anmelden.
2. Einen öffentlichen Objektnamen ohne Adresse und separat die genaue Adresse samt Treffpunkt anlegen. Ein Datum mit Start, Ende und 30 oder 45 Minuten pro Termin hinterlegen.
3. Den Buchungslink des Objekts kopieren und an Interessenten schicken. Der Link enthält eine zufällige Kennung und kann weitergegeben werden.
4. Nach der Buchung oder Umbuchung erhalten Interessenten eine Bestätigungsmail mit genauer Adresse, Treffpunkt und persönlichem Terminlink. Sie können den Termin bis zwei Stunden vor Beginn online ändern. Die Verwaltung erhält eine E-Mail zu Buchungen, Umbuchungen, Absagen und neuen Vormerkungen.
5. Über „Interessenten einbuchen“ kannst du freie Termine selbst vergeben. Gibt es keinen buchbaren Termin, können Interessenten sich mit Telefonnummer und Wunschzeit vormerken lassen. Du entscheidest, wen du anrufst und einbuchst.

Das 15-Minuten-Raster gilt je Zeitfenster für die erste Buchung. Danach sind nur direkt angrenzende Startzeiten verfügbar. Eine buchbare Lücke durch eine Absage hat Vorrang vor neuen Randterminen. Bei einer Umbuchung wird die aktuelle Buchung bei der Berechnung ausgenommen und bleibt bis zur erfolgreichen Auswahl reserviert. Zeitangaben gelten für Deutschland (`Europe/Berlin`).
