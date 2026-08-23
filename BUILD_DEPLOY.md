# Build und Deployment – CamperControl Node-RED/Cerbo

Diese Anleitung gilt für den freigegebenen V2-only-Quellstand
`fbf29b334c5c1fc5b05ebeb6f2ce76bc28e036b7` (`campercontrol-node-red`
4.5.0). Sie beschreibt reproduzierbaren Build, Offline-Tests, Artefakte und den
sicheren Produktionsweg. Zugangsdaten, private Schlüssel, WLAN-Passwörter und
API-Tokens gehören weder in dieses Repository noch in ein Releasepaket.

## Architektur und Verantwortungsgrenze

Der Cerbo ist die einzige Backend-Instanz. Er besitzt und validiert Zustand,
Cache, DWD-/BSH-Wetter, Persistenz, Schutzlogik, Szenen und Hardwarebefehle.
Node-RED stellt daraus die lokale HTTP-v2-API bereit; der Dienst
`com.victronenergy.campercontrol/0` transportiert kompakte Zustände und
Befehle über D-Bus/MQTT zu GX und WASM. Ford SYNC ist ebenfalls nur Client.

Für alle Clients gilt:

- V2-only; kein V1-Dashboard und keine Designumschaltung;
- keine eigene Wetter-, Gezeiten-, Cache- oder Schutzlogik;
- GX/WASM greifen nicht direkt aus dem Browser auf Port 1880 zu;
- ein Client sendet nur validierte Absichten mit seinem Ursprung;
- der Cerbo entscheidet abschließend, ob ein Befehl ausgeführt wird.

## Festgeschriebener Quell- und Flowstand

| Merkmal | Releasewert |
|---|---:|
| Quellcommit | `fbf29b334c5c1fc5b05ebeb6f2ce76bc28e036b7` |
| Paketversion | `4.5.0` |
| Flow-Master | `flows/CamperControl_NodeRED.json` |
| Importartefakt | `dist/CamperControl_NodeRED.json` |
| Nodes | `358` |
| Bytes | `691785` |
| SHA-256, Master und Importartefakt | `DE30F112B02124F5EB09520FF4AE15875EF00B1CF7A995D074322672FAB62038` |

Der Hash gilt nur für den oben genannten Commit. Eine spätere Quelländerung
erfordert Build, Tests und einen neu festgeschriebenen Hash.

## Voraussetzungen

### Buildrechner

- Git;
- Node.js 18 oder neuer und `npm`; das Deploy-Hilfsskript benötigt globales
  `fetch` und `AbortSignal.timeout`;
- Python 3;
- PowerShell 7 für die nachstehenden Hashprüfungen;
- Netzwerkzugriff nur für den optionalen read-only Livetest beziehungsweise
  für ein bewusst bestätigtes Deployment.

Das Projekt deklariert keine npm-Abhängigkeiten. Für Build und Validator ist
daher kein `npm install` und kein `node_modules` erforderlich.

### Cerbo/Venus OS

- die für das Gesamtrelease freigegebene Venus-Version und Architektur;
- Node-RED auf Port 1880 mit revisionierter Admin-API v2;
- `/usr/bin/python3`, D-Bus/GLib und runit;
- eine Venus-`vedbus.py` an einem der im Dienst fest hinterlegten Pfade;
- die im Flow referenzierten Victron-Nodes und realen D-Bus-Dienste;
- ausgehendes HTTPS für DWD und optional BSH;
- SSH-Zugriff per bereits eingerichteter Schlüsseldatei für das
  Releasewerkzeug.

Die lokale HTTP-API darf nicht ins Internet weitergeleitet werden.

## Quellstand prüfen

Im Repository-Stamm in PowerShell:

```powershell
$sourceCommit = 'fbf29b334c5c1fc5b05ebeb6f2ce76bc28e036b7'
git cat-file -e "$sourceCommit`^{commit}"
if ($LASTEXITCODE -ne 0) { throw "Node-RED-Quellcommit fehlt: $sourceCommit" }
git merge-base --is-ancestor $sourceCommit HEAD
if ($LASTEXITCODE -ne 0) {
    throw "HEAD enthält den freigegebenen Node-RED-Quellcommit nicht"
}
$sourceChanges = @(git diff --name-only $sourceCommit -- . ':(exclude)BUILD_DEPLOY.md')
if ($sourceChanges.Count -ne 0) {
    throw "Quellinhalt weicht vom Releasecommit ab: $($sourceChanges -join ', ')"
}
$trackedChanges = @(git status --porcelain --untracked-files=no)
if ($trackedChanges.Count -ne 0) {
    throw "Versionierte Dateien sind geändert: $($trackedChanges -join ', ')"
}
```

Für einen Releasebuild wird vorzugsweise ein eigener, abgetrennter Worktree
dieses Commits verwendet. So können lokale Vorschauen oder unversionierte
Notizen nicht in die Artefaktübergabe geraten.

## Build und Offline-Tests

`npm test` ist der kanonische Flow-Build mit anschließendem statischem
Validator:

```powershell
npm test
python tests/test-campercontrol-dbus.py
python tests/test-campercontrol-weather.py
python tests/test-device-http-bounded.py
python tests/test-shelly-ble-probe.py
```

`npm test` führt exakt `npm run build` und danach `npm run validate` aus.
`scripts/build-flow.js` liest den Flow-Master und diese Designquellen:

- `dashboard/camper-dashboard.html`;
- `dashboard/camper-dashboard-v2.html`;
- `dashboard/camper-dashboard-v2.css`;
- beide Transit-PNGs unter `dashboard/assets/`.

Der Build bettet die Quellen deterministisch ein, normalisiert den Master und
schreibt denselben JSON-Inhalt nach `dist/CamperControl_NodeRED.json`. Weil der
Build auch den versionierten Master normalisieren kann, muss danach das Diff
leer bleiben:

```powershell
git diff --exit-code -- flows/CamperControl_NodeRED.json
```

Die vier Python-Suiten prüfen D-Bus-/Command-Grenzen, bounded HTTP, DWD/BSH,
Cache-/Dateigrößen, Installer-/runit-Verträge und den optionalen
Shelly-BLE-Parser. Sie verwenden Fakes beziehungsweise lokale Fixtures und
schalten keine Hardware.

Für Commit `fbf29b33...` lautet die erwartete grüne Ausgabe:

- Validator: 358 Nodes, 60 Function-Nodes, 380 geprüfte Verbindungen,
  1812 Assertions, 0 Fehler;
- D-Bus: 11/11 Tests;
- Wetter/Tide: 22/22 Tests;
- bounded Device-HTTP: 4/4 Tests;
- Shelly-BLE-Parser: 5/5 Tests.

## Artefakte und unabhängige Prüfung

### Node-RED-Flow

Das deploybare Flowartefakt ist:

```text
dist/CamperControl_NodeRED.json
```

PowerShell-Prüfung:

```powershell
$master = '.\flows\CamperControl_NodeRED.json'
$artifact = '.\dist\CamperControl_NodeRED.json'
$expectedHash = 'DE30F112B02124F5EB09520FF4AE15875EF00B1CF7A995D074322672FAB62038'

if (-not (Test-Path -LiteralPath $artifact)) { throw 'Flowartefakt fehlt' }
if ((Get-Item -LiteralPath $artifact).Length -ne 691785) { throw 'Falsche Artefaktgröße' }
if ((Get-Content -Raw -LiteralPath $master) -cne (Get-Content -Raw -LiteralPath $artifact)) {
    throw 'Master und Importartefakt sind nicht bytegleich'
}
$hash = (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash
if ($hash -ne $expectedHash) { throw "Falscher Flowhash: $hash" }
$nodes = (Get-Content -Raw -LiteralPath $artifact | ConvertFrom-Json).Count
if ($nodes -ne 358) { throw "Falsche Node-Zahl: $nodes" }
```

### Cerbo-Dienst

Der Cerbo-Dienst wird nicht kompiliert. Das deploybare Set sind ausschließlich
die von Git verfolgten Dateien unter `cerbo-service/`; lokale `__pycache__`- oder
`.pyc`-Dateien dürfen nie übernommen werden. Ein reproduzierbares
Übergabearchiv des festgeschriebenen Commits entsteht so:

```powershell
$commit = 'fbf29b334c5c1fc5b05ebeb6f2ce76bc28e036b7'
New-Item -ItemType Directory -Force -Path .\dist | Out-Null
git archive --format=tar.gz `
  --output=.\dist\CamperControl-CerboService-fbf29b3.tar.gz `
  $commit cerbo-service
Get-FileHash -LiteralPath .\dist\CamperControl-CerboService-fbf29b3.tar.gz -Algorithm SHA256
```

Der ausgegebene Archivhash wird zusammen mit dem Flowhash und Quellcommit in
das Manifest des Gesamtreleases übernommen. Vor dem Freeze wird das Archiv in
einen neuen leeren Ordner entpackt und mit `git ls-tree -r --name-only` gegen
den Commit verglichen.

Das vollständige Set umfasst genau diese 19 Dateien:

```text
cerbo-service/bluetooth-repair.sh
cerbo-service/campercontrol-dbus-service/run
cerbo-service/campercontrol-dbus.py
cerbo-service/campercontrol_weather.py
cerbo-service/cerbo-reboot.sh
cerbo-service/device-http-bounded.py
cerbo-service/ensure-campercontrol-dbus.sh
cerbo-service/ensure-wifi-connect-http.sh
cerbo-service/install-campercontrol-dbus.sh
cerbo-service/install-privileges.sh
cerbo-service/install-wifi-connect-http.sh
cerbo-service/network-repair.sh
cerbo-service/node-red-restart.sh
cerbo-service/prefer-lan.sh
cerbo-service/starlink-read-status.sh
cerbo-service/status.sh
cerbo-service/sudoers-campercontrol
cerbo-service/vanturtle-discovery.py
cerbo-service/vanturtle-discovery-service/run
cerbo-service/wifi-connect-connman.py
cerbo-service/wifi-connect-http-service/run
```

Beim Release-Assembly wird `starlink-read-status.sh` zusätzlich gezielt als
`/data/campercontrol/starlink/read-status.sh` installiert, weil genau diesen
Pfad der Flow aufruft. Die optionale Binärdatei `grpcurl` ist kein
Repository-Artefakt und bleibt getrennt unter
`/data/campercontrol/starlink/grpcurl`. Der experimentelle Shelly-BLE-Probe
gehört nicht in das produktive Cerbo-Servicepaket.

## Optionaler read-only Livetest

Nach grünen Offline-Tests und vor jeder Mutation:

```powershell
npm run test:live
```

Der Test liest fest `http://venus.local:1880/victron/cache`, führt ausgewählte
Function-Nodes nur lokal aus und aktiviert keine Victron-Output-Nodes. Daher
muss `venus.local` auf genau den freizugebenden Cerbo zeigen. Der Test ist
zusätzlich zu den Offline-Suiten auszuführen, nicht an ihrer Stelle.

`npm run preview` ist eine read-only Designvorschau und kein Release-Gate.

## Release zusammenstellen

Produktiv wird weder `cerbo-service/` direkt überschrieben noch der Flow aus
einem beliebigen Arbeitsbaum importiert. Die geprüften Dateien werden in ein
checksumgesichertes `campercontrol-release` übernommen:

```text
artifacts/cerbo-service/                 <- getracktes Dienstset des Commits
artifacts/node-red/flows.json            <- bytegleiches dist-Artefakt
release.json                             <- Commit, Hash, Größe und 358 Nodes
checksums.sha256                         <- vollständige Releaseprüfsummen
```

Die Installationsreihenfolge des Gesamtreleases ist zwingend:

1. Cerbo-D-Bus-/Wetterdienst;
2. Node-RED-Flow;
3. native GX-Oberfläche;
4. WASM/Remote Console;
5. Ford SYNC separat per USB.

## Sicherer Upload und Produktionsdeployment

Das Wartungswerkzeug prüft lokal alle Checksummen, führt zuerst einen
read-only Cerbo-Audit aus, lädt in einen eindeutigen Incoming-Pfad unter
`/data/campercontrol/incoming`, installiert eine persistente Releasekopie und
erzeugt vor der Aktivierung ein gehashtes Preapply-Backup. Ein vorhandener
beschädigter Releasebaum oder ein bereits vorhandener Stage blockiert den
Lauf und wird nicht überschrieben.

In PowerShell aus dem final gefrorenen Releaseverzeichnis:

```powershell
$cerboHost = '172.24.24.1'
$identityFile = "$env:USERPROFILE\.ssh\id_ed25519"
$reportDirectory = Join-Path (Get-Location) 'reports\preapply-node-red'

.\tools\verify-release.ps1
.\tools\CamperControl-Maintenance.ps1 `
  -CerboHost $cerboHost `
  -IdentityFile $identityFile `
  -ReportDirectory $reportDirectory
```

Nur wenn Verifier und Audit ohne Fehler enden und `release.json` exakt den oben
genannten Node-Commit sowie den Flowhash enthält:

```powershell
.\tools\CamperControl-Maintenance.ps1 `
  -CerboHost $cerboHost `
  -IdentityFile $identityFile `
  -ReportDirectory $reportDirectory `
  -Apply `
  -Confirm
```

`-ForceFirmwareMismatch` ist kein regulärer Deploymentweg. Ein unbekannter
SSH-Hostschlüssel wird nicht ungeprüft akzeptiert. Das Werkzeug fragt ein
gegebenenfalls nötiges Passwort interaktiv ab; ein Passwort wird nie als
Befehlsargument oder in dieser Datei gespeichert.

### Warum das Dienstverzeichnis in-place aktualisiert wird

Der von runit überwachte Pfad
`/data/campercontrol/service/campercontrol-dbus-service` darf nicht als ganzes
Verzeichnis verschoben oder ausgetauscht werden. `runsv` hält dessen Inode und
`supervise`-Zustand offen. Das Releasewerkzeug sichert daher den vorherigen
Dienst und ersetzt nur die normalen Dateien einschließlich `run` im
bestehenden Verzeichnis. Danach ruft es den idempotenten Installer auf.

Das checksumgeprüfte Dienstset besitzt drei getrennte Aktivierungsschritte,
die das Gesamtrelease in dieser Reihenfolge ausführt:

```sh
/data/campercontrol/service/install-privileges.sh
/data/campercontrol/service/install-wifi-connect-http.sh
/data/campercontrol/service/install-campercontrol-dbus.sh
```

Der erste Schritt validiert `/etc/sudoers.d/campercontrol` mit `visudo`; der
zweite aktiviert den loopback-only ConnMan-HTTP-Helfer
`/service/camper-wifi-connect`; der dritte aktiviert
`/service/campercontrol-dbus`. Vorher müssen der aktuelle `/data/rc.local`-
Stand, die normalen Dienstdateien und beide `run`-Dateien im Preapply-Backup
liegen. Die einmaligen Dateien `/data/rc.local.before-*` sind kein Ersatz für
dieses unmittelbar vor dem Deployment erzeugte Backup.

Das Repository-eigene `scripts/deploy-flow.js` ist nur ein kontrollierter
Flow-only-Entwicklerweg. Es sichert zwar die revisionierte Liveantwort lokal
unter `../backups/node-red-live/` und führt einen Healthcheck aus, besitzt aber
keinen automatischen Restore. Für ein Produktionsrelease wird deshalb der
obige transaktionale Gesamtweg verwendet.

## Verifikation nach dem Deployment

Read-only vom Buildrechner:

```powershell
ssh -i $identityFile "root@$cerboHost" "svstat /service/campercontrol-dbus; svstat /service/node-red-venus"
ssh -i $identityFile "root@$cerboHost" "svstat /service/camper-wifi-connect"
ssh -i $identityFile "root@$cerboHost" "dbus -y com.victronenergy.campercontrol /Status/ApiConnected GetValue"
ssh -i $identityFile "root@$cerboHost" "dbus -y com.victronenergy.campercontrol /State/Ui GetValue"
ssh -i $identityFile "root@$cerboHost" "dbus -y com.victronenergy.campercontrol /Status/WeatherError GetValue"
ssh -i $identityFile "root@$cerboHost" "dbus -y com.victronenergy.campercontrol /State/Weather GetValue"
npm run test:live
```

Zusätzlich sind im finalen Wartungsbericht zu bestätigen:

- aktiver Flowhash `DE30F112...` und 358 Nodes;
- gültige `/camper/api/v2/state`- und Diagnoseantworten;
- stabile Bridge und Node-RED-Prozesse ohne Neustartschleife;
- Wetter kleiner/gleich 16 KiB; fehlende Gezeiten bleiben optional;
- keine ungebremst wachsenden Context-, Log-, Queue- oder Cachedateien;
- VRM-Monitorbetrieb bleibt read-only und Remote-Starlink-Aus wird zentral
  abgelehnt;
- lokale Bedienung, Szenen, Orion, INDEVOLT/Shelly, Klima und Wasser liefern
  reale Rückmeldungen.

Ein entfernter Starlink-AUS-Befehl ist kein zulässiger Healthcheck.

## Rollback

Schlägt ein einzelner Aktivierungs- oder Healthschritt während `-Apply` fehl,
stellt das Releasewerkzeug den unmittelbar vorherigen Dienst beziehungsweise
Flow automatisch wieder her und startet den betroffenen runit-Dienst erneut.
Der Fehler darf nicht durch einen weiteren manuellen Kopiervorgang verdeckt
werden.

Ein bewusstes Rollback nach bereits erfolgreicher Abnahme erfolgt durch das
erneute Anwenden des vorherigen, ebenfalls gefrorenen und checksumgeprüften
Gesamtreleases. Nach bewusster Navigation in dessen konkretes Releaseverzeichnis:

```powershell
.\tools\verify-release.ps1
.\tools\CamperControl-Maintenance.ps1 `
  -CerboHost $cerboHost `
  -IdentityFile $identityFile `
  -ReportDirectory (Join-Path (Get-Location) 'reports\rollback') `
  -Apply `
  -Confirm
```

Vorher sind dessen Manifest, Firmwarepin und persistente Checksummen erneut zu
prüfen. Backups unter `/data/campercontrol/backups` werden nur über ihren
exakten, vom Werkzeug ausgegebenen Dateinamen und nach `sha256sum -c`
verwendet. Niemals werden `/data`, `/service`, das Node-RED-Benutzerverzeichnis
oder ein Elternverzeichnis per Wildcard gelöscht beziehungsweise ersetzt.

## Firmware-Update

`/data/campercontrol` bleibt persistent; Firmware und aktive GUI-Bäume können
sich ändern. Nach einem Venus-Update gilt deshalb:

1. read-only Audit ausführen;
2. Firmware, Build und Architektur gegen die Release-Matrix prüfen;
3. Integrität der persistenten Releasekopie und des Preapply-Backups prüfen;
4. nur bei exakter Kompatibilität dasselbe gefrorene Release erneut anwenden;
5. Dienst, Flow, GX, WASM und erst danach SYNC erneut abnehmen.

Es gibt keinen automatischen Port auf eine unbekannte Firmware.
