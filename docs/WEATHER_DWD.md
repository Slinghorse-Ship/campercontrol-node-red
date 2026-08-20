# Cerbo-zentraler DWD-Wetterdienst

Der Cerbo ist die einzige Instanz, die Wetterdaten aus dem Internet lädt,
normalisiert und cached. GX Touch, Remote Console/WASM und Ford SYNC lesen nur
den fertigen Zustand; sie kontaktieren den DWD nicht selbst.

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

Der Cache enthält keine GPS-Koordinaten. Er enthält nur die ausgewählte
Stations-ID, den Stationsnamen und die berechnete Entfernung. Nach zwölf
Stunden ohne erfolgreichen Abruf wird `stale:true` veröffentlicht; vorhandene
zukünftige Werte bleiben sichtbar.

## Transportvertrag

`/State/Weather` ist ein kompaktes JSON-Objekt (Schema 1):

- `source`, `attribution`, `station`, `modelRunUtc`, `fetchedAtUtc`, `stale`
- `timezone` und lokal berechnete `sun`-Zeiten (`riseUtc`, `setUtc`)
- `hourly`: 48 Stunden mit `t`, `tempC`, `precipProbabilityPct`, `precipMm`,
  `ww`, `icon`, `windKmh`, `windDeg`, `gustKmh`
- `daily`: sechs lokale Kalendertage mit Min/Max, Niederschlagssumme,
  **maximaler stündlicher** Niederschlagswahrscheinlichkeit, Wettercode,
  Wind/Gust und Sonnenauf-/untergang

`maxHourlyPrecipProbabilityPct` ist bewusst keine mathematische
Tageswahrscheinlichkeit. Fehlwerte bleiben `null` und werden nie als Null
erfunden. `TTT` wird Kelvin → °C, Wind wird m/s → km/h umgerechnet.

## Betrieb und Fehlerverhalten

Der Provider läuft als eigener Thread im bestehenden
`campercontrol-dbus.py`-Dienst. Netzwerk- oder Parserfehler stoppen weder
Node-RED noch den D-Bus-Dienst. Nach Fehlern wird nach 15, 30 und 60 Minuten,
danach höchstens alle drei Stunden erneut versucht. Downloads und KMZ/KML-
Inhalte haben feste Größenlimits und ZIP-Dateien werden nicht ins Dateisystem
extrahiert.

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

Rechtlicher Quellenhinweis in allen sichtbaren UIs und im JSON-Feld
`attribution`: `Quelle: Deutscher Wetterdienst`. Die Tageswerte sind aus den
stündlichen DWD-Einzelwerten berechnet; `sun` ist eine lokale astronomische
Berechnung und kein DWD-Parameter.
