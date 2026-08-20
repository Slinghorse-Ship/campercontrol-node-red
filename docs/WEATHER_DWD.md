# Cerbo-zentraler DWD-Wetterdienst mit optionalen BSH-Gezeiten

Der Cerbo ist die einzige Instanz, die Wetterdaten aus dem Internet lädt,
normalisiert und cached. GX Touch, Remote Console/WASM und Ford SYNC lesen nur
den fertigen Zustand; sie kontaktieren weder DWD noch BSH selbst.

## Quelle und Datenweg

- Quelle: **Deutscher Wetterdienst, MOSMIX_L Open Data**
- Einzelstation: `MOSMIX_L_LATEST_{STATION}.kmz`
- Parameter: `TTT`, `R101`, `RR1c`, `ww`, `FF`, `FX1`, `DD`
- Station: nächster Eintrag des offiziellen MOSMIX-Stationskatalogs zum aktiven
  GX-GPS-Dienst (`/GpsService`, danach `/Position/Latitude` und
  `/Position/Longitude`)
- Optionaler manueller Fallback: eine fünfstellige Stations-ID in
  `/data/campercontrol/weather-station.conf`
- Cache: `/data/campercontrol/cache/weather-v1.json` (atomarer Austausch)
- D-Bus/MQTT: `com.victronenergy.campercontrol`, Instanz 0,
  `/State/Weather` (nur lesbar)

Der Venus-`dbus`-CLI liefert je nach Dienst entweder `value = ...` oder einen
plain Scalar. Der Provider akzeptiert beide realen Formen. Ein führender Slash
in der Zeitzone (beispielsweise `/UTC`) wird vor der `ZoneInfo`-Prüfung
entfernt; leere Ausgaben, Fehlertexte und ungültige Zeitzonen werden verworfen.

Der DWD-Cache enthält weder GPS-Koordinaten noch eine daraus abgeleitete
Entfernung. Er enthält nur die ausgewählte Stations-ID und den Stationsnamen.
Nach zwölf Stunden ohne erfolgreichen Abruf wird `stale:true` veröffentlicht;
vorhandene zukünftige Werte bleiben sichtbar.

## Optionale Ebbe-/Flutdaten vom BSH

CamperControl nutzt zusätzlich ausschließlich die JSON-Daten, die auch die
offizielle Website des Bundesamts für Seeschifffahrt und Hydrographie (BSH)
anzeigt:

- Katalog: <https://gezeiten.bsh.de/data/tides_overview.json>
- Pegel: `https://gezeiten.bsh.de/data/DE_{BSHNR links auf 5 Zeichen mit _ aufgefüllt}_tides.json`
- Quelle/Attribution: `© Bundesamt für Seeschifffahrt und Hydrographie (BSH)`

`gauge_group:3` (Ostsee) wird ausdrücklich verworfen. Nur Gruppen 1 und 2 der
Nordsee beziehungsweise ihrer tidebeeinflussten Flüsse sind auswählbar. Der
nächste Pegel wird aus dem aktuellen GX-GPS-Fix bestimmt. Ab mehr als 60 km
Entfernung fehlt `tides` vollständig; so erscheint im Binnenland keine nur
geometrisch „nächste“ Gezeitenstation. Die exakten GPS-Koordinaten werden nie
persistiert oder geloggt. Nur Stations-ID/-name und die auf 0,1 km gerundete
Entfernung liegen im kompakten Tide-Cache.

Die BSH-Rohdaten enthalten Jahresobjekte und unter
`hwnw_prediction.data` Ereignisse mit `timestamp`, `height` (cm), `type`
(`HW`/`NW`), `moon` und `phase`. CamperControl übernimmt ausschließlich
zukünftige HW/NW, rechnet cm in Meter um und verlangt das eindeutige
Bezugsniveau `PNP` (Pegelnullpunkt). Eine Höhe ist daher **keine Wassertiefe**.
Fehlt ein gültiges HW-/NW-Paar oder ist das Bezugsniveau nicht eindeutig, wird
der Tide-Teil fail-closed ausgeblendet.

Die Rohzeit steht beim BSH ganzjährig mit explizitem Offset `+01:00` (MEZ),
auch im Sommer. Der Provider deutet sie nicht als lokale Sommerzeit um, sondern
konvertiert den angegebenen Zeitpunkt verlustfrei nach UTC (`Z`). Erst der
Client formatiert UTC in seine Gerätezeitzone. Beispiel: BSH
`2026-08-20 13:30:00+01:00` wird `2026-08-20T12:30:00Z` und in
`Europe/Berlin` als 14:30 MESZ angezeigt.

## Transportvertrag

`/State/Weather` ist ein kompaktes JSON-Objekt (Schema 1):

- `source`, `attribution`, `station`, `modelRunUtc`, `fetchedAtUtc`, `stale`
- `timezone` und lokal berechnete `sun`-Zeiten (`riseUtc`, `setUtc`)
- `hourly`: 48 Stunden mit `t`, `tempC`, `precipProbabilityPct`, `precipMm`,
  `ww`, `icon`, `windKmh`, `windDeg`, `gustKmh`
- `daily`: sechs lokale Kalendertage mit Min/Max, Niederschlagssumme,
  **maximaler stündlicher** Niederschlagswahrscheinlichkeit, Wettercode,
  Wind/Gust und Sonnenauf-/untergang
- optional `tides`:
  - `source:"BSH"`, `attribution`, `updatedUtc`, `stale`,
    `referenceLevel:"PNP"`
  - `station:{id,name,distanceKm}`
  - `nextHigh:{t,heightM}` und `nextLow:{t,heightM}`; beide Zeiten sind UTC,
    `heightM` darf bei einem Pegel ohne Höhenangabe `null` sein

`maxHourlyPrecipProbabilityPct` ist bewusst keine mathematische
Tageswahrscheinlichkeit. Fehlwerte bleiben `null` und werden nie als Null
erfunden. `TTT` wird Kelvin → °C, Wind wird m/s → km/h umgerechnet.

Node-RED validiert diesen Wert erneut (Schema 1, maximal 48 Stunden/sechs Tage
und 16 KiB) und veröffentlicht ihn als `state.weather` für Dashboard und Ford
SYNC. Dieser read-only Eingang ersetzt die zwei nicht verwendeten
Abwasser-Nodes, sodass der Master bei 358 Nodes bleibt. Die D-Bus-Bridge lässt
`weather` in `compact_state()` bewusst aus und verhindert damit Feedback.

## Betrieb und Fehlerverhalten

Der Provider läuft als eigener Thread im bestehenden
`campercontrol-dbus.py`-Dienst. Netzwerk- oder Parserfehler stoppen weder
Node-RED noch den D-Bus-Dienst. Nach Fehlern wird nach 15, 30 und 60 Minuten,
danach höchstens alle drei Stunden erneut versucht. Downloads und KMZ/KML-
Inhalte haben feste Größenlimits und ZIP-Dateien werden nicht ins Dateisystem
extrahiert.

Ein BSH-Fehler ist additiv und lässt einen erfolgreichen DWD-Snapshot nicht
scheitern. Der BSH-Teil versucht frühestens beim nächsten sechs-stündlichen
Wetterzyklus erneut (kein schneller Zusatz-Timer). Ein erfolgreich geladener
Pegel wird 24 Stunden genutzt, nach 48 Stunden als `stale:true` markiert und
nach sieben Tagen fail-closed entfernt. Der Stationskatalog wird höchstens alle
30 Tage erneuert. Bei Netzfehlern bleiben nur ein gültiger Cache derselben
GPS-basiert ausgewählten Station und noch zukünftige Ereignisse nutzbar.

Für einen manuellen Stationstest:

1. fünfstellige ID in `/data/campercontrol/weather-station.conf` schreiben,
2. den Dienst `campercontrol-dbus` neu starten,
3. `/Status/WeatherError` und `/State/Weather` read-only prüfen.

MOSMIX_L wird viermal täglich mit bis zu 240 Stunden Vorhersagezeitraum
veröffentlicht. CamperControl fragt nach erfolgreichem Abruf nach sechs Stunden
erneut ab; damit sind höchstens vier reguläre Abrufe pro Tag nötig. Der
Stationskatalog wird nach 30 Tagen erneuert und bei einem Netzfehler weiterhin
aus dem lokalen Cache gelesen.

## Ressourcenprofil auf dem Cerbo

- Ein Wetterabruf läuft beim Start des D-Bus-Dienstes und danach frühestens
  alle sechs Stunden. Fehlerwiederholungen sind auf 15, 30 und 60 Minuten sowie
  anschließend drei Stunden begrenzt; es gibt keinen schnellen Poll-Timer.
- Der normalisierte D-Bus-Wert ist auf 16 KiB begrenzt und wird nur bei einer
  inhaltlichen Änderung neu nach `/State/Weather` geschrieben.
- Dauerhaft liegen nur die atomar ausgetauschte JSON-Datei
  `weather-v1.json` (höchstens 16 KiB) und der Stationskatalog
  `mosmix-stations-v1.cfg` (Downloadlimit 2 MiB). KMZ/KML werden nur im RAM
  verarbeitet und nie auf Flash geschrieben; temporäre Cachedateien werden
  nach `os.replace()` entfernt.
- Für BSH kommen atomar `bsh-tides-overview-v1.json` (Limit 128 KiB) und der
  normalisierte `bsh-tides-v1.json` (Limit 16 KiB, höchstens 32 zukünftige
  Ereignisse) hinzu. Das Pegel-Jahres-JSON hat ein Downloadlimit von 2 MiB,
  wird nur im RAM verarbeitet und nie auf Flash abgelegt. Regulär fällt
  höchstens ein Pegelabruf pro 24 Stunden an.
- KMZ-Downloads sind auf 1 MiB, entpacktes KML auf 4 MiB begrenzt. Die
  Vorhersage enthält maximal 48 Stunden und sechs Tage.
- GPS-Koordinaten existieren nur während der Stationsauswahl im Arbeitsspeicher.
  Weder Cache noch D-Bus-Payload oder Log enthalten Breite/Länge.
- Wetterfehler ändern nicht den 1-Hz-Node-RED-Zustandspoller und erzeugen keine
  Rückkopplung in den CamperControl-Flow. Der Wetterthread wartet unabhängig
  mit `Event.wait()` und schreibt keine periodischen Node-RED-Dateien.

Offizielle Primärquellen:

- Produkt und Aktualisierung:
  <https://www.dwd.de/DE/leistungen/met_verfahren_mosmix/met_verfahren_mosmix.html>
- Einzelstationsdaten:
  <https://opendata.dwd.de/weather/local_forecasts/mos/MOSMIX_L/single_stations/>
- KML-/Elementdefinition:
  <https://opendata.dwd.de/weather/lib/MetElementDefinition.xml>
- Open-Data-Lizenz: CC BY 4.0:
  <https://www.dwd.de/DE/leistungen/opendata/faqs_opendata.html>
- Vorgabe für die Quellenangabe:
  <https://www.dwd.de/DE/service/rechtliche_hinweise/vorlagen_quellenangabe.html>
- BSH-Gezeitenübersicht, amtliche Gezeitendaten und Haftungshinweis:
  <https://gezeiten.bsh.de/>
- BSH-Bedingungen für digitale Daten (auf der BSH-Seite verlinktes
  Entgeltverzeichnis einschließlich AGB und gesonderter Nutzungsbedingungen):
  <https://www.bsh.de/DE/Das_BSH/Gebuehren_Preise_Liz/Gebuehren_und_Preise/_Anlagen/Downloads/Entgeltverzeichnis-digitale-Daten.html>

Rechtlicher Quellenhinweis in allen sichtbaren UIs und im JSON-Feld
`attribution`: `Quelle: Deutscher Wetterdienst`. Die Tageswerte sind aus den
stündlichen DWD-Einzelwerten berechnet; `sun` ist eine lokale astronomische
Berechnung und kein DWD-Parameter.

Die sichtbaren BSH-Seiten kennzeichnen die Werte als amtliche
Gezeitenvorausberechnungen gemäß §1 SeeAufG, übernehmen dafür keine Gewähr und
weisen darauf hin, dass aktuelle Windverhältnisse nicht einbezogen werden. Die
für Downloadprodukte geltenden AGB/Nutzungsbedingungen bleiben zu beachten.
CamperControl umgeht keinen zustimmungspflichtigen Download: Es liest nur die
für die öffentliche Website sichtbaren JSON-Daten, speichert keinen
Jahresdatensatz dauerhaft und transportiert ausschließlich das nächste HW/NW
mit BSH-Attribution. Da diese JSON-Endpunkte keine versionierte öffentliche API
darstellen, bleibt eine mögliche künftige Vertrags-/Formatänderung ein
explizites Betriebsrisiko; der Parser blendet bei Abweichungen fail-closed aus.
