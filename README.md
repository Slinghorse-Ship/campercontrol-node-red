# CamperControl Node-RED

Eigenständiges Repository für das CamperControl-Backend auf dem Victron Cerbo GX.
Die Ford-SYNC-QML-App liegt getrennt im Repository `sync3-camper`.

## Verzeichnisstruktur

- `flows/CamperControl_NodeRED.json` – aktueller und einziger Flow-Master
- `dashboard/camper-dashboard.html` – V1-Dashboard, gemeinsame Live-Bindings und deterministischer V2-Einfügepunkt
- `dashboard/camper-dashboard-v2.html` – Transit-Horizon-V2-Struktur mit Live-State/Commands
- `dashboard/camper-dashboard-v2.css` – aus der verbindlichen Touch-50-V2-Quelle übernommene Gestaltung
- `cerbo-service/` – persistente lokale Cerbo-Dienste und Reparaturskripte
- `scripts/build-flow.js` – erzeugt den importierbaren Flow unter `dist/`
- `tests/validate-flow.js` – statische Gesamtprüfung ohne Hardwarezugriff
- `tests/runtime-readonly.js` – ausschließlich lesender Laufzeittest gegen den Cerbo
- `docs/` – technische Dokumentation

## Arbeiten mit dem Repository

```text
npm run build
npm run validate
npm run test:live
npm run preview
```

`npm run build` aktualisiert den Master deterministisch und schreibt den
importierbaren Export nach `dist/CamperControl_NodeRED.json`. Das Verzeichnis
`dist/` wird nicht versioniert, weil es jederzeit aus dem Master erzeugt wird.

`npm run preview` startet unter `http://127.0.0.1:4175/` eine ausschließlich
lesende Designabnahme. Sie setzt exakt dieselben drei Dashboard-Quellen wie der
Flow-Build zusammen und lädt bei jedem Seitenaufruf einen echten
`/camper/api/v2/state`-Snapshot vom Cerbo; sie besitzt keine Demo-Fallbackwerte
und sendet keine Gerätebefehle. Direkte Abnahme-URLs sind beispielsweise
`/?page=lights`, `/?page=energy&pane=sources` und
`/?page=energy&pane=solar-detail`. `/?design=v1` rendert denselben Live-Snapshot
im unveränderten V1-Zweig. Mit `--cerbo http://172.24.24.1:1880` und
`--port 4175` lassen sich Quelle und Port explizit setzen.

## Regeln

- Keine Passwörter, WLAN-Schlüssel, API-Tokens oder SSH-Zugangsdaten committen.
- Keine alten Flow-Kopien als zweiten Master ablegen; Änderungen werden über Git verfolgt.
- Victron-Geräte möglichst mit den offiziellen Victron-Node-RED-Nodes anbinden.
- Hardwarebefehle erst nach erfolgreicher Validierung und mit vorherigem Live-Backup deployen.
- Die lokale Camper-API verwendet HTTP auf Port 1880 und darf nicht ins Internet weitergeleitet werden.

## Cerbo-CPU-Lüftung

- Relais 1 schaltet die Abluft, Relais 2 die Zuluft; beide laufen immer gemeinsam.
- Der manuelle Schalter hat Vorrang vor der Automatik.
- Die Automatik schaltet standardmäßig ab 65 °C ein und bei 60 °C wieder aus.
- Beide GX-Relais müssen in Venus OS auf `Manuell` konfiguriert sein.

## Auswählbares Dashboard-Design

- Unter **Einstellungen → Oberfläche** kann dauerhaft zwischen `Design V1` und
  `Design V2 · Transit Horizon` gewechselt werden.
- Gespeichert wird ausschließlich `ui.designVersion` mit dem validierten Wert
  `v1` oder `v2` in der vorhandenen `camperConfig`-Dateiablage des Flow-Kontexts.
  Ungültige oder fehlende Werte werden auf `v2` normalisiert.
- `GET /camper/api/v2/settings` liefert die Auswahl als
  `config.ui.designVersion`; der normale Zustandssnapshot veröffentlicht sie als
  `state.ui.designVersion`.
- Ein Wechsel verwendet den bestehenden Settings-Patch
  `{"target":"settings","action":"patch","patch":{"ui":{"designVersion":"v1"}}}`
  beziehungsweise `v2`. Es gibt keinen zweiten Geräte- oder Befehlspfad: Beide
  Designs verwenden dieselben realen Zustände und dieselben validierten
  Schaltbefehle.
- V1 und V2 sind getrennte Template-Zweige. V1 bleibt die bisherige Oberfläche;
  V2 bildet die Transit-Horizon-Struktur mit Home, Licht, Klima, Energie,
  Wasser und System ab. `scripts/build-flow.js` setzt die drei Dashboard-Quellen
  mechanisch in den 358-Node-Master ein.
- V2 enthält keine Messwert-Demos. Batterie, Solar, drei MPPT-Regler,
  INDEVOLT, Orion, MultiPlus, STAR-Power, Autoterm, MaxxFan und Wasser lesen den
  vorhandenen Snapshot. Nicht verfügbare Werte erscheinen als Strich; Orion
  und nicht bestätigte Schalter sind deaktiviert.
- Die Lichtseite nutzt die sechs konfigurierten Licht-IDs sowie den manuellen
  Fernlichtausgang, dieselben STAR-Power-Befehle wie V1, klickbare Foto-Hotspots
  und Karten sowie den permanenten Dimmer. Die beiden Fahrzeugbilder werden
  weiterhin unter `/camper-assets/VehicleLightsLeft.png` und
  `/camper-assets/VehicleLightsRight.png` vom bestehenden Flow ausgeliefert.
