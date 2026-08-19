# External WLAN: sichere ConnMan-Anbindung

`wifi-connect-connman.py` spricht direkt mit `net.connman`. Es verwendet
bewusst **nicht** den Venus-Pfad `/Network/SetValue`, weil ein ungültiges
Kommando dort den Plattformdienst beenden kann.

Node-RED übergibt das Kennwort nicht an einen `exec`-Node: Dessen Option
`addpay` hängt den Payload als sichtbares Shell-Argument an. Stattdessen läuft
der Helfer als kleiner, über `supervise` überwachter HTTP-Dienst ausschließlich
auf `127.0.0.1:18543`. Er schreibt weder Requests noch Kennwörter in ein Log.

## Node-RED-Vertrag

HTTP-Request-Node:

- Methode: `POST`
- feste URL: `http://127.0.0.1:18543/connect`
- Rückgabe: geparstes JSON-Objekt
- Header: `Content-Type: application/json`
- Header: `X-Camper-Control: node-red`
- Body:

```json
{
  "service": "/net/connman/service/wifi_9cc9eb1d42e3_..._managed_psk",
  "passphrase": "nur-im-arbeitsspeicher",
  "ssid": "Anzeigename"
}
```

Vor dem HTTP-Request kann ein Function-Node exakt diese Felder setzen:

```javascript
const request = msg.payload || {};
msg.method = "POST";
msg.url = "http://127.0.0.1:18543/connect";
msg.headers = {
  "content-type": "application/json",
  "x-camper-control": "node-red"
};
msg.payload = JSON.stringify({
  service: request.service,
  passphrase: request.passphrase !== undefined ? request.passphrase : request.password,
  ssid: request.ssid || ""
});
return msg;
```

Der Flow darf an diesem Zweig keinen Debug-Node mit vollständigem `msg`
enthalten. URL und Header sind konstant; das Kennwort kommt ausschließlich in
den HTTP-Body. `password` wird am Helfer als Alias zu `passphrase` akzeptiert,
neue Flows sollen jedoch `passphrase` verwenden. Der `service`-Wert muss
unverändert aus dem vorherigen ConnMan-Scan stammen.

Antwort bei Erfolg:

```json
{"ok":true,"status":"connected","service":"...","ssid":"...","interface":"wlan0","state":"ready"}
```

Die Antwort enthält niemals das Kennwort. Nicht erfolgreiche Verbindungen
liefern `ok:false` und stabile Fehlercodes, beispielsweise
`authentication_failed`, `service_not_available`, `connection_busy` oder
`connection_timeout`. Ein Timeout verwendet HTTP 504, ein bereits laufender
Versuch HTTP 409.

Nach einer erfolgreichen Anmeldung übernimmt ConnMan das WLAN-Profil samt
Kennwort in seinem eigenen persistenten Speicher unter
`/data/var/lib/connman/<service>/settings`. Diese Datei gehört `root:root` und
hat Modus `0600`. App, Dashboard, Node-RED-Flow und Helfer speichern das
Kennwort selbst nicht; bei späteren Neustarts verbindet ConnMan das bekannte
Netz mit seinem geschützten Profil erneut.

Für eine reine Funktionsprüfung gibt es:

```text
GET http://127.0.0.1:18543/health
```

## Persistente Installation auf Venus OS

Folgende Dateien werden nach `/data/campercontrol/service/` kopiert:

```text
wifi-connect-connman.py
ensure-wifi-connect-http.sh
install-wifi-connect-http.sh
wifi-connect-http-service/run
```

Danach einmal als root ausführen:

```sh
chmod 0755 /data/campercontrol/service/install-wifi-connect-http.sh
/data/campercontrol/service/install-wifi-connect-http.sh
```

Der Installer:

1. setzt nur die erforderlichen Ausführungsrechte,
2. legt `/service/camper-wifi-connect` als Link auf den Dienst unter `/data` an,
3. ergänzt `/data/rc.local` idempotent um
   `/data/campercontrol/service/ensure-wifi-connect-http.sh`,
4. bewahrt die erste vorherige `rc.local` als
   `/data/rc.local.before-camper-wifi-connect` auf.

Damit startet `svscan` den Dienst sofort, überwacht ihn ohne zusätzlichen
Supervisorprozess und startet ihn nach einem Fehler automatisch neu. Der
`rc.local`-Eintrag stellt den `/service`-Link nach jedem Venus-Neustart wieder
her. Der Prozess hält zusätzlich einen Lock und schreibt seine PID nur nach
`/run/camper-wifi-connect-http.pid`; beides ist flüchtig und enthält keine
Zugangsdaten.

Prüfung auf dem Cerbo:

```sh
curl -s http://127.0.0.1:18543/health
cat /run/camper-wifi-connect-http.pid
```

Ein sudoers-Eintrag für den Python-Helfer ist nicht erforderlich. Node-RED kann
nur den lokalen HTTP-Endpunkt ansprechen; der überwachte Dienst selbst läuft im
Venus-Servicekontext.

## Sicherheits- und Betriebsgrenzen

- Der Socket bindet hart ausschließlich an `127.0.0.1`.
- POST akzeptiert höchstens 16 KiB, nur `application/json`, keine
  Transfer-Encoding und nur den festen Caller-Header.
- Es gibt absichtlich kein CORS. Webseiten können den Steuerendpunkt daher
  nicht per Browser-Preflight freischalten.
- Es wird höchstens ein Verbindungsversuch gleichzeitig ausgeführt.
- Der Helfer protokolliert oder speichert das Kennwort nicht und gibt es nie
  zurück. Nur ConnMan persistiert ein erfolgreiches WLAN-Profil geschützt mit
  `root:root` und Modus `0600`.
- Der ConnMan-Agent existiert nur während des Aufrufs und wird anschließend
  wieder abgemeldet.
- Browser-Portale, WPS und Enterprise-Anmeldungen werden nicht erfunden oder
  automatisch bestätigt; dafür kommt ein klarer Fehler zurück.
- `Connect()` wird asynchron mit einem begrenzten Timeout ausgeführt.
- Der Helfer trennt kein Interface und ändert weder Default-Route noch LAN-
  Priorität. Die bestehende LAN-vor-WLAN-Regel bleibt unabhängig bestehen.
