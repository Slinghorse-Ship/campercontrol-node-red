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

