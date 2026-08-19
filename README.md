# CamperControl Node-RED

Eigenständiges Repository für das CamperControl-Backend auf dem Victron Cerbo GX.
Die Ford-SYNC-QML-App liegt getrennt im Repository `sync3-camper`.

## Verzeichnisstruktur

- `flows/CamperControl_NodeRED.json` – aktueller und einziger Flow-Master
- `dashboard/camper-dashboard.html` – Dashboard-Quelle
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
```

`npm run build` aktualisiert den Master deterministisch und schreibt den
importierbaren Export nach `dist/CamperControl_NodeRED.json`. Das Verzeichnis
`dist/` wird nicht versioniert, weil es jederzeit aus dem Master erzeugt wird.

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
