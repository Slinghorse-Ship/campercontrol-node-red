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

### Wettercode `ww`

Die Zuordnung folgt vollständig der offiziellen DWD-Tabelle
`Wettercode ww` (Stand der DWD-Datei: 15.03.2021) und nicht einem groben
Zahlenbereich. Dadurch werden insbesondere Regenschauer 80/81/82 nicht als
Schnee interpretiert. CamperControl gruppiert die aktuell von MOSMIX
veröffentlichten Codes so:

- 0 klar/keine Wolkenentwicklung; 1/2 teilweise bewölkt; 3 bewölkt
- 45/49 Nebel beziehungsweise Eisnebel
- 51/53/55 Sprühregen
- 56/57 gefrierender Sprühregen; 66/67 gefrierender Regen
- 61/63/65 Regen
- 68/69 sowie 83/84 Schneeregen
- 71/73/75 sowie 85/86 Schnee beziehungsweise Schneeschauer
- 80/81/82 Regenschauer
- 95 Gewitter mit Regen oder Schnee

Für den repräsentativen Tagescode gilt die Prioritätsreihenfolge derselben
DWD-Tabelle; die numerisch größte Kennzahl gewinnt ausdrücklich nicht. Die
aktuelle MOSMIX-Liste enthält **keinen eigenen Hagelcode**. Falls eine spätere
DWD-Ausgabe die üblichen defensiv unterstützten Codes 96 oder 99 liefert,
zeigt CamperControl ein Hagelgewitter. Code 95 wird nicht als Hagel ausgegeben.
Andere unbekannte Werte bleiben neutral `unknown`, statt einen Zustand zu
erfinden.

## Optionale Ebbe-/Flutdaten vom BSH

CamperControl verwendet ausschließlich die dokumentierte OGC-API des
Bundesamts für Seeschifffahrt und Hydrographie (BSH):

- Landing/OpenAPI: <https://gdi.bsh.de/ldproxy/rest/services/WaterLevelForecast>
- Collection: `waterlevelforecastdata`
- Pegel: `.../collections/waterlevelforecastdata/items/{featureId}?f=json`
- Parametervertrag (Stand 27.05.2026):
  <https://www2.bsh.de/aktdat/wvd/api/parameter_documentation.pdf>
- Lizenz: CC BY 4.0; sichtbare Attribution:
  `© Bundesamt für Seeschifffahrt und Hydrographie (BSH)`

Die API kennzeichnet die Region jedes Pegels direkt. Es werden ausschließlich
Features mit `region:"north_sea"`, `licence:"CC BY 4.0"`, Punktgeometrie und
zukünftigen HW-/NW-Daten ausgewählt; `baltic_sea` wird fail-closed verworfen.
Der Cerbo sucht in wachsenden 10-/25-/60-km-Bounding-Boxes. Zuerst wird mit
`result-type=hitsOnly` nur die Trefferzahl gelesen, danach die kleinste
nichtleere Box in Seiten von höchstens zehn Features. Mehr als 48 Treffer,
mehr als 1,5 MiB pro Seite oder 4 MiB für die gesamte Auswahl brechen die
Suche ab. Ab mehr als 60 km Entfernung fehlt `tides` vollständig.

Der aktuelle GPS-Fix existiert nur im Arbeitsspeicher und in der daraus
gebildeten BSH-Bounding-Box; er wird nie persistiert oder geloggt. Im atomaren
Tide-Cache stehen nur die amtlichen Stationskoordinaten, Feature-ID/-name und
die auf 0,1 km gerundete aktuelle Entfernung. Solange der Pegel höchstens
10 km entfernt bleibt, kann seine gecachte ID direkt wiederverwendet werden.

`properties.high_water_low_water` liefert zukünftige Ereignisse mit
`event_timestamp`, `event` (`HW`/`NW`) und `tidal_prediction_value`. Für
`nextHigh`/`nextLow` wird bewusst diese amtliche Gezeitenvorausberechnung
verwendet; `forecast_value` und MOS-Werte werden nicht stillschweigend mit der
astronomischen Gezeitenhöhe vermischt. Fehlt ein HW- oder NW-Typ, werden seine
Extrema aus `curve.tidal_prediction` abgeleitet. Alle Höhen sind laut
Parameterdokumentation Zentimeter über dem lokalen Pegelnullpunkt (PNP), werden
in Meter umgerechnet und sind **keine Wassertiefe**.

Für die 24-Stunden-Kurve wird pro Rohpunkt zuerst
`curve.automated_curve_forecast` verwendet (automatisch erzeugte
Wasserstandsprognose des BSH), bei fehlendem/ungültigem Wert ausschließlich
`curve.tidal_prediction`. `measurement` wird für die Zukunft nicht verwendet.
Die etwa zehnminütige Rohkurve bleibt nur während des Parsens im RAM. Der Cache
enthält höchstens 145 reduzierte Punkte für 72 Stunden. Das entspricht ungefähr
einem Halbstundenraster und hält die öffentliche 24-Stunden-Kurve auch während
des kompletten 48-Stunden-Stale-Fensters vollständig. Dabei bleiben die beiden
Randpunkte sowie lokale Hoch-/Niedrigwasser-Extrema erhalten. Veröffentlicht
werden höchstens 27 chronologisch sortierte Punkte für exakt jetzt bis +24
Stunden: bei vollständigen BSH-Daten 25 innere Kurvenpunkte plus zwei bei Bedarf
linear interpolierte Randwerte.

Alle Zeitfelder tragen laut BSH-Vertrag einen expliziten UTC-Offset. Der
Provider übernimmt diesen Offset unverändert, normalisiert anschließend nach
UTC (`Z`) und erfindet keine Zeitzone. Beispiel:
`2026-08-20 14:30:00+02:00` wird `2026-08-20T12:30:00Z`. Winterwerte mit
`+01:00` werden nach derselben Regel verarbeitet; erst der Client formatiert
UTC in seine Gerätezeitzone.

## Transportvertrag

`/State/Weather` ist ein kompaktes JSON-Objekt (Schema 1):

- `source`, `attribution`, `license`, `licenseUrl`, `changes`, `station`,
  `modelRunUtc`, `fetchedAtUtc`, `stale`
- `timezone` und lokal berechnete `sun`-Zeiten (`riseUtc`, `setUtc`)
- `hourly`: 48 Stunden mit `t`, `tempC`, `precipProbabilityPct`, `precipMm`,
  `ww`, `icon`, `windKmh`, `windDeg`, `gustKmh`
- `daily`: sechs lokale Kalendertage mit Min/Max, Niederschlagssumme,
  **maximaler stündlicher** Niederschlagswahrscheinlichkeit, Wettercode,
  Wind/Gust und Sonnenauf-/untergang
- optional `tides`:
  - `source:"BSH"`, `attribution`, `license`, `licenseUrl`, `changes`,
    `updatedUtc`, `stale`,
    `referenceLevel:"PNP"`
  - `station:{id,name,distanceKm}`
  - `nextHigh:{t,heightM}` und `nextLow:{t,heightM}`; beide Zeiten sind UTC,
    `heightM` darf bei einem Pegel ohne Höhenangabe `null` sein
  - optional `curve:[{t,heightM},...]`: höchstens 27 UTC-Punkte für exakt
    jetzt bis +24 Stunden. Das sind 25 ressourcenschonend ausgewählte
    Kurvenpunkte plus zwei interpolierte Randpunkte; Hoch- und
    Niedrigwasser-Extrema bleiben beim Ausdünnen erhalten. Die Werte sind
    chronologisch und in Meter über PNP.

`maxHourlyPrecipProbabilityPct` ist bewusst keine mathematische
Tageswahrscheinlichkeit. Fehlwerte bleiben `null` und werden nie als Null
erfunden. `TTT` wird Kelvin → °C, Wind wird m/s → km/h umgerechnet.

Node-RED validiert diesen Wert erneut (Schema 1, maximal 48 Stunden/sechs Tage
und 16 KiB) und veröffentlicht ihn als `state.weather` für Dashboard und Ford
SYNC. Dieser read-only Eingang ersetzt die zwei nicht verwendeten
Abwasser-Nodes, sodass der Master bei 358 Nodes bleibt. Die D-Bus-Bridge lässt
`weather` in `compact_state()` bewusst aus und verhindert damit Feedback.
Sollte ein außergewöhnlich großer DWD-Snapshot zusammen mit den Gezeiten die
16-KiB-Grenze erreichen, entfällt zuerst nur `tides.curve`, danach nötigenfalls
der gesamte optionale Tide-Teil; der DWD-Snapshot bleibt verfügbar.

## Betrieb und Fehlerverhalten

Der Provider läuft als eigener Thread im bestehenden
`campercontrol-dbus.py`-Dienst. Netzwerk- oder Parserfehler stoppen weder
Node-RED noch den D-Bus-Dienst. Nach Fehlern wird nach 15, 30 und 60 Minuten,
danach höchstens alle drei Stunden erneut versucht. Downloads und KMZ/KML-
Inhalte haben feste Größenlimits und ZIP-Dateien werden nicht ins Dateisystem
extrahiert.

Ein BSH-Fehler ist additiv und lässt einen erfolgreichen DWD-Snapshot nicht
scheitern. Der BSH-Teil versucht frühestens beim nächsten sechs-stündlichen
Wetterzyklus erneut (kein schneller Zusatz-Timer). Eine erfolgreiche
Stationsantwort wird sechs Stunden genutzt und danach mit ihrer gecachten
HTTP-`ETag` bedingt abgefragt; ein unveränderter Stand liefert `304` ohne
JSON-Payload. Nach 48 Stunden wird der Tide-Teil als `stale:true` markiert und
nach sieben Tagen fail-closed entfernt. Bei Netzfehlern bleiben nur ein
gültiger Cache derselben GPS-basiert ausgewählten Station und noch zukünftige
Ereignisse nutzbar.

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
- Für BSH kommt atomar nur `bsh-tides-v1.json` hinzu (Limit 16 KiB, höchstens
  32 zukünftige Ereignisse und 145 auf etwa halbstündliche Abstände reduzierte
  Kurvenpunkte für 72 Stunden). Die
  OGC-Rohkurve wird nie auf Flash geschrieben. Hits-Antworten sind auf 16 KiB,
  Stationsseiten auf 1,5 MiB je Seite/4 MiB insgesamt und der direkte Pegel auf
  512 KiB dekomprimiert begrenzt. Gzip wird mit getrenntem komprimiertem und
  dekomprimiertem Limit verarbeitet. Regulär fällt höchstens ein bedingter
  Pegelabruf pro sechs Stunden an; `304` spart den Payload.
- KMZ-Downloads sind auf 1 MiB, entpacktes KML auf 4 MiB begrenzt. Die
  Vorhersage enthält maximal 48 Stunden und sechs Tage.
- Der GX-GPS-Fix existiert nur während der Stationsauswahl im Arbeitsspeicher
  und der HTTPS-Bounding-Box. Weder Cache, D-Bus-Payload noch Log enthalten den
  Fix. Nur die öffentlichen Koordinaten des ausgewählten BSH-Pegels dürfen im
  internen Cache stehen; sie werden nicht veröffentlicht.
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
- BSH WaterLevelForecast, OGC-Landing und CC-BY-4.0-Nutzungshinweise:
  <https://gdi.bsh.de/ldproxy/rest/services/WaterLevelForecast>
- BSH OpenAPI 3.0.3:
  <https://gdi.bsh.de/ldproxy/rest/services/WaterLevelForecast/api?lang=en&f=json>
- BSH-Parameterdokumentation:
  <https://www2.bsh.de/aktdat/wvd/api/parameter_documentation.pdf>

Rechtlicher Quellenhinweis in allen sichtbaren UIs und im JSON-Feld
`attribution`: `Quelle: Deutscher Wetterdienst`. Die Tageswerte sind aus den
stündlichen DWD-Einzelwerten berechnet; `sun` ist eine lokale astronomische
Berechnung und kein DWD-Parameter.

Die OGC-Landingpage kennzeichnet den Datensatz als frei und ohne Registrierung
abrufbaren hochwertigen Datensatz unter CC BY 4.0. CamperControl nennt den BSH,
verlinkt die Lizenz und beschreibt hier seine Änderungen (Auswahl des nächsten
Pegels, UTC-Normalisierung, cm→m und Kurvenreduktion). Es gibt keinen Abruf
hinter einer AGB-Checkbox. Die BSH-Parameterdokumentation weist zugleich darauf
hin, dass API-Informationen falsch oder veraltet sein können und die offiziell
veröffentlichten Vorhersagen auf `www.bsh.de` nicht ersetzen. Die Anzeige ist
daher informativ; unerwartete Felder, Einheiten, Regionen, Lizenzen oder
Größenüberschreitungen werden fail-closed ausgeblendet.
