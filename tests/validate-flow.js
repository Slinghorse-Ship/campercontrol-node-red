import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const sourcePath = path.join(root, 'flows', 'CamperControl_NodeRED.json');
const publicPath = path.join(root, 'dist', 'CamperControl_NodeRED.json');
const dashboardPath = path.join(root, 'dashboard', 'camper-dashboard.html');
const sourceText = fs.readFileSync(sourcePath, 'utf8');
const publicText = fs.readFileSync(publicPath, 'utf8');
const dashboard = fs.readFileSync(dashboardPath, 'utf8');
const flows = JSON.parse(sourceText);

const failures = [];
let assertions = 0;
const check = (condition, label) => {
  assertions += 1;
  if (!condition) failures.push(label);
};
const byId = new Map();
for (const node of flows) {
  check(node && typeof node.id === 'string' && node.id.length > 0, 'Jede Node besitzt eine ID');
  check(!byId.has(node.id), `Node-ID ist eindeutig: ${node.id}`);
  byId.set(node.id, node);
}
const get = id => byId.get(id) || {};
const targetsOf = id => (get(id).wires || []).flat();
const nodesAt = (service, pathValue, type) => flows.filter(node =>
  node.service === service && node.path === pathValue && (!type || node.type === type));

const compileVueScript = (markup, label) => {
  const match = String(markup).match(/<script>\s*([\s\S]*?)\s*<\/script>/);
  check(Boolean(match), `${label} enthält ein Script`);
  if (!match) return;
  try {
    new Function(match[1].replace(/^\s*export\s+default/, 'return'));
    check(true, `${label} Script ist syntaktisch gültig`);
  } catch (error) {
    check(false, `${label} Script ist syntaktisch gültig: ${error.message}`);
  }
};

let wiresChecked = 0;
let functionsChecked = 0;
for (const node of flows) {
  for (const output of Array.isArray(node.wires) ? node.wires : []) {
    for (const target of Array.isArray(output) ? output : []) {
      wiresChecked += 1;
      check(byId.has(target), `Wire ${node.id} -> ${target}`);
    }
  }
  if (node.type === 'function') {
    functionsChecked += 1;
    try {
      new Function('msg', 'flow', 'context', 'node', 'env', 'RED', node.func || '');
    } catch (error) {
      failures.push(`Function-Syntax ${node.id}: ${error.message}`);
    }
  }
}

check(sourceText === publicText, 'Master- und Import-Flow sind bytegleich');
check(get('dec0785f657dc7d1').format === dashboard, 'Dashboard-Node entspricht der HTML-Quelle');
check(get('3a031e0c8fe40790').repeat === '10', 'Fallback-Snapshot läuft alle 10 s');
check(!dashboard.includes('v-if="!detail"'), 'Untere Navigation bleibt auf Detailseiten sichtbar');
check(dashboard.includes("@click=\"detail='';page='home'\""), 'Navigation schließt Detailseiten explizit');
check(dashboard.includes('.fs-detail-page{height:calc(100vh - 160px)!important'), 'Detailseiten reservieren Platz für die Navigation');

// Schnellzugriff: vier generische, backendvalidierte Aktionen statt einer
// fest verdrahteten Lichtauswahl. Alte v4-Lichtbelegungen werden migriert.
const settingsFunction = get('47003434a27acbe7').func || '';
const snapshotFunction = get('ada9353cc6ea4a4c').func || '';
check(settingsFunction.includes('cfg.version = 5'), 'Konfigurationsschema ist v5');
check(settingsFunction.includes('source.ui.quickAccessLightIds.map'), 'v4-Lichtbelegungen werden auf generische IDs migriert');
check(settingsFunction.includes('cfg.ui = { quickAccessIds,'), 'Settings speichern generische Schnellzugriff-IDs');
check(settingsFunction.includes("designVersion: cfg.ui && cfg.ui.designVersion === 'v1' ? 'v1' : 'v2'"), 'Settings validieren Design V1/V2 und verwenden V2 als Fallback');
for (const id of ['switch:water_pump', 'switch:starlink', 'switch:dc_outlets_left', 'light:inside_main']) {
  check(settingsFunction.includes(id), `Generischer Standard-Schnellzugriff enthält ${id}`);
}
for (const target of ['device:inverter', 'device:orion', 'device:indevolt_grid', 'device:heater', 'device:maxxfan']) {
  check(snapshotFunction.includes(target), `Schnellzugriff-Katalog enthält ${target}`);
}
check(snapshotFunction.includes('quickAccessOptions, externalWifiTileEnabled'), 'Snapshot veröffentlicht Auswahl, Katalog und aufgelöste Aktionen');
check(snapshotFunction.includes("designVersion: cfg.ui && cfg.ui.designVersion === 'v1' ? 'v1' : 'v2'"), 'Snapshot veröffentlicht die persistierte Designversion');
check(snapshotFunction.includes("target: 'waterPump', action: 'set'"), 'Wasserpumpen-Schnellzugriff nutzt den validierten Router');
check(snapshotFunction.includes("target: 'scene', action: 'run'"), 'Szenen sind als Schnellzugriff auswählbar');
check(dashboard.includes('v-for="q in quickItems"'), 'Dashboard rendert generische Schnellzugriffe');
check(dashboard.includes('quickActivate(q)'), 'Dashboard führt den vom Backend aufgelösten Befehl aus');
check(dashboard.includes("settingsPatch({ui:{quickAccessIds:ids}})"), 'Dashboard speichert generische IDs');
check(dashboard.includes("designV2?'design-v2':'design-v1'"), 'Dashboard aktiviert V1/V2 über eine gemeinsame Template-Wurzel');
check(dashboard.includes("setDesignVersion('v1')") && dashboard.includes("setDesignVersion('v2')"), 'Dashboard-Einstellungen bieten Design V1 und V2 an');
check(dashboard.includes('this.settingsPatch({ui:{designVersion:version}})'), 'Dashboard speichert die Auswahl über den bestehenden Settings-Patch');
check((dashboard.match(/command\(target,action,value,extra=/g) || []).length === 1, 'V1 und V2 teilen exakt dieselbe Command-Methode');
check(dashboard.includes('id="fs-selectable-designs-v2"'), 'Dashboard enthält die eigenständige Transit-Horizon-Gestaltung');
const settingsDashboard = get('aec5cc044fa2963f').format || '';
check(settingsDashboard.includes('class="design-picker"'), 'Separate Einstellungsseite bietet die Designauswahl an');
check(settingsDashboard.includes("this.patch({ui:{designVersion:v}})"), 'Separate Einstellungsseite nutzt denselben Settings-Patch');
compileVueScript(dashboard, 'Camper-Dashboard');
compileVueScript(settingsDashboard, 'Einstellungs-Dashboard');

const legacyQuickStore = new Map([['camperConfig', {
  version: 4,
  ui: { quickAccessLightIds: ['inside_main', 'outside_front_amber', 'outside_right', 'high_beam'] },
  mappings: { hardwareProfile: 'transit-highbeam-v2' }
}]]);
const legacyQuickFlow = {
  get: key => legacyQuickStore.get(key),
  set: (key, value) => legacyQuickStore.set(key, value)
};
const runSettings = new Function('msg', 'flow', 'context', 'node', 'env', 'RED', settingsFunction);
const migratedOutput = runSettings({ req: { method: 'GET' }, payload: {} }, legacyQuickFlow, {}, {}, {}, {});
const migratedConfig = migratedOutput?.[1]?.payload?.config || {};
check(migratedConfig.version === 5, 'v4-Konfiguration wird zur Laufzeit auf v5 migriert');
check(migratedConfig.ui?.designVersion === 'v2', 'Bestehende Konfigurationen erhalten Design V2 als sicheren Standard');
check(JSON.stringify(migratedConfig.ui?.quickAccessIds) === JSON.stringify([
  'light:inside_main', 'light:outside_front_amber', 'light:outside_right', 'switch:high_beam_manual'
]), 'Bestehende vier Lichtbelegungen bleiben bei der Migration erhalten');

const designMemory = new Map();
const designFile = new Map([['camperConfig', migratedConfig]]);
const designFlow = {
  get: (key, store) => store === 'file' ? designFile.get(key) : designMemory.get(key),
  set: (key, value, store) => (store === 'file' ? designFile : designMemory).set(key, value)
};
let designOutput = runSettings({ topic: 'ui.settings', payload: { action: 'patch', patch: { ui: { designVersion: 'v1' } } } }, designFlow, {}, {}, {}, {});
check(designOutput?.[0]?.payload?.config?.ui?.designVersion === 'v1', 'Settings-Patch schaltet auf Design V1');
check(designFile.get('camperConfig')?.ui?.designVersion === 'v1', 'Design V1 wird im Datei-Kontext dauerhaft gespeichert');
designOutput = runSettings({ topic: 'ui.settings', payload: { action: 'patch', patch: { ui: { designVersion: 'unbekannt' } } } }, designFlow, {}, {}, {}, {});
check(designOutput?.[0]?.payload?.config?.ui?.designVersion === 'v2', 'Ungültige Designwerte werden auf V2 normalisiert');
check(designFile.get('camperConfig')?.ui?.designVersion === 'v2', 'Normalisierte Designauswahl wird dauerhaft gespeichert');

const commandStore = new Map([['camperConfig', migratedConfig], ['camperCommands', []], ['camperWsClients', {}]]);
const commandFlow = {
  get: key => commandStore.get(key),
  set: (key, value) => commandStore.set(key, value)
};
const runCommandRouter = new Function('msg', 'flow', 'context', 'node', 'env', 'RED', get('6265bf6f9bade1e5').func || '');
const designCommandOutput = runCommandRouter({ payload: { target: 'settings', action: 'patch', patch: { ui: { designVersion: 'v1' } } } }, commandFlow, {}, {}, {}, {});
check(designCommandOutput?.[4]?.topic === 'ws.settings' && designCommandOutput?.[4]?.payload?.patch?.ui?.designVersion === 'v1', 'Designwechsel nutzt den vorhandenen Settings-Router');
check([0, 1, 2, 3, 9, 11].every(index => designCommandOutput?.[index] == null), 'Designwechsel erzeugt keinen Hardwarebefehl');

// Ruuvi: feste native Service-Zuordnung, kein Discovery/Exec/Cache.
const ruuviNodes = {
  ruuvi_ceiling_temperature_in: ['/Temperature', 'victron-input-temperature'],
  ruuvi_ceiling_humidity_in: ['/Humidity', 'victron-input-custom'],
  ruuvi_ceiling_pressure_in: ['/Pressure', 'victron-input-custom'],
  ruuvi_ceiling_batteryVoltage_in: ['/BatteryVoltage', 'victron-input-custom'],
  ruuvi_ceiling_deviceName_in: ['/DeviceName', 'victron-input-custom']
};
for (const [id, [pathValue, expectedType]] of Object.entries(ruuviNodes)) {
  const node = get(id);
  check(node.type === expectedType, `${id} nutzt ${expectedType}`);
  check(node.service === 'com.victronenergy.temperature/24', `${id} ist fest auf Temperaturdienst /24`);
  check(node.path === pathValue, `${id} liest ${pathValue}`);
  check(node.onlyChanges === true, `${id} sendet nur Änderungen`);
}
check(get('ruuvi_manual_adapter').type === 'function', 'Ruuvi-FB31-Werte werden ohne Discovery normalisiert');
check(get('ruuvi_manual_adapter').func.includes("ceilingService: 'com.victronenergy.temperature/24'"), 'Deckenrolle ist fest /24');
check(get('ruuvi_manual_adapter').func.includes("floorService: ''"), 'Bodenrolle bleibt unkonfiguriert/offline');
check(!flows.some(node => String(node.id).includes('ruuvi_discovery')), 'Keine Ruuvi-Discovery-Nodes');
check(!sourceText.includes('read-temperature-sensors.sh'), 'Kein Ruuvi-Shellprozess');
check(!sourceText.includes('/victron/cache'), 'Kein Ruuvi-Cache-Polling');

check(get('camper_service_status_tick').repeat === '60', 'Service-Status läuft höchstens alle 60 s');
check(get('camper_service_status_guard').type === 'function', 'Service-Status besitzt eine Prozesssperre');

// Cerbo-CPU-Lüftung: korrekte Relaiszuordnung sowie Handbetrieb ODER
// Temperaturautomatik mit 5-K-Hysterese.
const ventilationController = get('614274d83b9a4241');
check(get('edaf4c40dd44c239').path === '/Relay/0/State' && /Abluft/.test(get('edaf4c40dd44c239').name), 'Relais 1 ist Abluft');
check(get('06b5677f5f5ddd99').path === '/Relay/1/State' && /Zuluft/.test(get('06b5677f5f5ddd99').name), 'Relais 2 ist Zuluft');
check(ventilationController.func.includes("if (manualOn)"), 'Manueller Lüfterlauf hat Vorrang');
check(ventilationController.func.includes('temperature <= onTemperature - hysteresis'), 'CPU-Lüftung besitzt eine Rückschalthysterese');
check(get('ada9353cc6ea4a4c').func.includes('manualOn: ventilation.manualOn === true'), 'Snapshot veröffentlicht den Handbetrieb');
check(dashboard.includes('LÜFTER MANUELL'), 'Dashboard besitzt einen manuellen Lüfterknopf');

const ventilationStore = new Map([
  ['camperConfig', { ventilation: { enabled: true, manualOn: false, onTemperature: 65, hysteresis: 5 } }]
]);
const ventilationFlow = {
  get: key => ventilationStore.get(key),
  set: (key, value) => ventilationStore.set(key, value)
};
const runVentilation = new Function('msg', 'flow', 'context', 'node', 'env', 'RED', ventilationController.func);
const ventilationRun = msg => runVentilation(msg, ventilationFlow, {}, {}, {}, {});
let ventilationOutput = ventilationRun({ topic: 'ventilation.cpu', payload: 64 });
check(ventilationStore.get('ventilationState').active === false, '64 °C bleibt unter der Einschaltschwelle');
ventilationOutput = ventilationRun({ topic: 'ventilation.cpu', payload: 65 });
check(ventilationStore.get('ventilationState').active === true, '65 °C schaltet beide Lüfter ein');
check(ventilationOutput[0]?.payload === 1 && ventilationOutput[1]?.payload === 1, 'Übertemperatur schaltet beide Relais');
ventilationRun({ topic: 'ventilation.cpu', payload: 61 });
check(ventilationStore.get('ventilationState').active === true, '61 °C hält die Lüfter innerhalb der Hysterese an');
ventilationOutput = ventilationRun({ topic: 'ventilation.cpu', payload: 60 });
check(ventilationStore.get('ventilationState').active === false, '60 °C schaltet beide Lüfter wieder aus');
ventilationStore.set('camperConfig', { ventilation: { enabled: false, manualOn: true, onTemperature: 65, hysteresis: 5 } });
ventilationOutput = ventilationRun({ topic: 'tick' });
check(ventilationStore.get('ventilationState').active === true, 'Handbetrieb funktioniert auch bei ausgeschalteter Automatik');
check(ventilationOutput[0]?.payload === 1 && ventilationOutput[1]?.payload === 1, 'Handbetrieb schaltet beide Relais');
ventilationRun({ topic: 'ventilation.relay1', payload: 1 });
check(ventilationStore.get('ventilationState').exhaustFeedback === true, 'Rückmeldung Relais 1 gehört zur Abluft');
ventilationRun({ topic: 'ventilation.relay2', payload: 1 });
check(ventilationStore.get('ventilationState').supplyFeedback === true, 'Rückmeldung Relais 2 gehört zur Zuluft');

// Shelly: nur der native, durch Venus OS registrierte Dienst.
const shellyOut = get('shelly_grid_state_out');
check(shellyOut.type === 'victron-output-custom', 'Shelly-Freigabe nutzt nativen Victron-Ausgang');
check(shellyOut.service === 'com.victronenergy.acload/50', 'Shelly-Service ist acload/50');
check(shellyOut.path === '/SwitchableOutput/0/State', 'Shelly schaltet /SwitchableOutput/0/State');
check(!sourceText.includes('172.24.24.159'), 'Keine feste Shelly-IP im Export');
check(!flows.some(node => /shelly.*rpc/i.test(`${node.id} ${node.name || ''}`)), 'Keine Shelly-RPC-Nodes');

// Orion XS: native Messwerte; /Mode ist der einzige Schaltpfad (1=Ein, 4=Aus).
const orionOut = get('orion_mode_out');
check(orionOut.type === 'victron-output-alternator', 'Orion XS nutzt den offiziellen Alternator-Ausgang');
check(orionOut.service === 'com.victronenergy.alternator/289', 'Orion-Service ist alternator/289');
check(orionOut.path === '/Mode', 'Orion schaltet /Mode');
check(get('6265bf6f9bade1e5').func.includes("item.value ? 1 : 4"), 'Orion verwendet Mode 1/4');
check(get('6265bf6f9bade1e5').func.includes('for (const index of [0, 1, 2, 3, 9, 11]) output[index] = [];'), 'Orion-/Shelly-Router initialisiert seine Nachrichtenlisten');
check(get('6265bf6f9bade1e5').func.includes('for (const index of [0, 1, 2, 3, 9, 11]) if (!output[index].length) output[index] = null;'), 'Orion-/Shelly-Router bereinigt leere Listen');
const orionPaths = {
  orion_power_in: '/Dc/0/Power', orion_voltage_in: '/Dc/0/Voltage',
  orion_current_in: '/Dc/0/Current', orion_inputVoltage_in: '/Dc/In/V',
  orion_inputPower_in: '/Dc/In/P', orion_state_in: '/State',
  orion_mode_in: '/Mode', orion_error_in: '/ErrorCode'
};
for (const [id, pathValue] of Object.entries(orionPaths)) {
  const node = get(id);
  check(node.type === 'victron-input-alternator', `${id} nutzt den offiziellen Alternator-Eingang`);
  check(node.service === 'com.victronenergy.alternator/289', `${id} nutzt alternator/289`);
  check(node.path === pathValue, `${id} liest ${pathValue}`);
  check(node.onlyChanges === true, `${id} sendet nur Änderungen`);
}
check(!flows.some(node => String(node.id).startsWith('orion_cache_')), 'Kein Orion-Cache-Polling');
const stateAggregator = get('ada9353cc6ea4a4c').func || '';
check(stateAggregator.includes("orionModeNumber === 4 ? 'AUS'"), 'Orion zeigt AUS ausschließlich bei Mode 4');
check(stateAggregator.includes("'FREIGEGEBEN · WARTET'"), 'Orion Mode 1 mit State 0/null wird als freigegeben und wartend angezeigt');
check(!stateAggregator.includes("const orionStateNames = { 0: 'AUS'"), 'Orion State 0 wird nicht mehr eigenständig als AUS interpretiert');
check(stateAggregator.includes('stateText: orionStateText'), 'Snapshot verwendet die modebewusste Orion-Zustandsanzeige');

// Warnlicht/Heck: physisch und strukturell strikt getrennt.
const warningOut = get('959137a3ca444583');
const rearStateOut = get('4afab948e3bba101');
const rearDimOut = get('d1a6f2d556b5e888');
const warning = get('e0809a11d6ca3b34');
const starRouter = get('6a22df3c7ebe02fc');
check(warningOut.path === '/SwitchableOutput/7/State', 'Warnlicht schaltet ausschließlich CH 8 State');
check(rearStateOut.path === '/SwitchableOutput/10/State', 'Hecklicht schaltet ausschließlich CH 11 State');
check(rearDimOut.path === '/SwitchableOutput/10/Dimming', 'Hecklicht dimmt ausschließlich CH 11');
check(warningOut.id !== rearStateOut.id && warningOut.path !== rearStateOut.path, 'Warnlicht und Heck besitzen getrennte Ausgänge');
check(nodesAt('com.victronenergy.switch/0', '/SwitchableOutput/7/Dimming', 'victron-output-switch').length === 0, 'Warnlicht besitzt keinen Dimming-Ausgang');
check(!byId.has('60540243db20bc53'), 'Alter Warnlicht-Dimming-Ausgang ist entfernt');
check(warning.outputs === 1, 'Warnblink-Controller hat nur einen Ausgang');
check(JSON.stringify(warning.wires) === JSON.stringify([['6a22df3c7ebe02fc']]), 'Warnblink-Controller führt nur zum STAR-Power-Router');
check(warning.func.includes("msg.topic === 'state:8'"), 'Warnblink-Takt wird durch CH-8-State bestätigt');
check(!warning.func.includes("msg.topic === 'dim:8'"), 'Warnblink-Takt verwendet keine Dimming-Bestätigung');
check(!warning.func.includes('WARNING_LEVEL') && !warning.func.includes('dimming('), 'Warnblink-Controller erzeugt keine Dimming-Befehle');
check(!warning.func.includes('SwitchableOutput/10') && !warning.func.includes('WARNING_CHANNEL = 11'), 'Warnblink-Controller kann CH 11 nicht ansprechen');
check(JSON.stringify(starRouter.wires?.[7] || []) === JSON.stringify(['959137a3ca444583']), 'STAR-Power State CH 8 führt exakt zum Warnlicht-Ausgang');
check((starRouter.wires?.[13] || []).length === 0, 'STAR-Power Dimming CH 8 ist unverdrahtet');
check(JSON.stringify(starRouter.wires?.[10] || []) === JSON.stringify(['4afab948e3bba101']), 'STAR-Power State CH 11 führt exakt zum Hecklicht-Ausgang');
check(JSON.stringify(starRouter.wires?.[16] || []) === JSON.stringify(['d1a6f2d556b5e888']), 'STAR-Power Dimming CH 11 führt exakt zum Hecklicht-Ausgang');
for (const id of ['7b14fa6e29773eb5', '4ae22adfa536b4be']) {
  check(!targetsOf(id).includes('e0809a11d6ca3b34'), `${id} umgeht den Warnblink-Controller`);
  check(targetsOf(id).includes('6a22df3c7ebe02fc') && targetsOf(id).includes('d36a1adac492ce3e'), `${id} geht direkt zu Zustand und Aggregator`);
}
check(get('199eabbda79b02de').topic === 'front-warning-reset' && get('199eabbda79b02de').once === true, 'Deploy initialisiert ausschließlich Warnlicht sicher AUS');

// Externes WLAN: native Plattformpfade für Status/Schalten/Scan und sicherer
// loopback-only ConnMan-Helfer für neue Zugangsdaten.
const wifiPaths = {
  external_wifi_services_in: '/Network/Services',
  external_wifi_enabled_in: '/Network/Wifi/GatewayEnabled',
  external_wifi_state_in: '/Network/Wifi/State',
  external_wifi_signal_in: '/Network/Wifi/SignalStrength',
  external_wifi_gateway_out: '/Network/Wifi/GatewayEnabled',
  external_wifi_scan_out: '/Network/Wifi/Scan'
};
for (const [id, pathValue] of Object.entries(wifiPaths)) {
  check(get(id).service === 'com.victronenergy.platform', `${id} nutzt Venus platform`);
  check(get(id).path === pathValue, `${id} nutzt ${pathValue}`);
}
check(!flows.some(node => node.path === '/Network/SetValue' || node.id === 'external_wifi_setvalue_out'), 'Kein riskanter /Network/SetValue-Pfad');
check(!sourceText.includes('/Network/SetValue'), 'SetValue kommt auch in keinem Function-Code vor');
check(get('external_wifi_helper_health_request').type === 'http request' && get('external_wifi_helper_health_request').url === 'http://127.0.0.1:18543/health', 'WLAN-Helper-Health ist loopback-only');
check(get('external_wifi_connect_request').type === 'http request' && get('external_wifi_connect_request').url === 'http://127.0.0.1:18543/connect', 'WLAN-Connect ist loopback-only');
check(get('external_wifi_connect_prepare').func.includes("'x-camper-control': 'node-red'"), 'WLAN-Helper erhält festen lokalen Caller-Header');
check(get('external_wifi_connect_prepare').func.includes('JSON.stringify({ service, passphrase, ssid'), 'WLAN-Passwort wird nur als HTTP-Body übergeben');
check(!flows.some(node => node.type === 'exec' && /wifi|connman/i.test(`${node.id} ${node.name || ''} ${node.command || ''}`)), 'WLAN-Passwort gelangt nicht in Exec-Argumente');
check(get('camper_service_action_router').outputs === 9, 'Service-Router besitzt neun Ausgänge');
check((get('camper_service_action_router').wires?.[8] || []).includes('external_wifi_connect_prepare'), 'wifiConnect führt nur zum sicheren Prepare-Node');
check(get('6265bf6f9bade1e5').func.includes("'wifiConnect'"), 'Zentraler Router kennt wifiConnect');
check(get('external_wifi_state_update').func.includes('source.wifi'), 'WLAN-Parser verarbeitet die verschachtelte Venus-Struktur');
check(get('ada9353cc6ea4a4c').func.includes('externalWifi: externalWifiStatus'), 'Snapshot enthält strukturierten WLAN-Status');
check(dashboard.includes('autocomplete="new-password"'), 'Dashboard nutzt ein nicht vorbefülltes WLAN-Passwortfeld');
check(dashboard.includes("this.wifiPassphrase=''"), 'Dashboard löscht das WLAN-Passwort nach dem Senden');

check(!sourceText.includes(':1881'), 'Node-RED-Flow enthält keinen HTTPS-Port 1881');
for (const term of ['apiToken', 'x-camper-token', 'tokenConfigured', 'allowReadWithoutToken', 'stratificationWarning', 'stratification:']) {
  check(!sourceText.includes(term), `Kein Legacy-Feld ${term}`);
}
check(!sourceText.includes('theo1234'), 'Kein SSH-Passwort im Export');
check(!/"(password|passphrase|psk)"\s*:\s*"[^"{]+"/i.test(sourceText), 'Keine statisch gespeicherten WLAN-Zugangsdaten');

console.log(JSON.stringify({
  ok: failures.length === 0,
  nodes: flows.length,
  functions: functionsChecked,
  wiresChecked,
  assertions,
  failures
}, null, 2));
if (failures.length) process.exit(1);
