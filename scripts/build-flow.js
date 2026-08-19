import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const sourcePath = path.join(root, 'flows', 'CamperControl_NodeRED.json');
const dashboardPath = path.join(root, 'dashboard', 'camper-dashboard.html');
const publicPath = path.join(root, 'dist', 'CamperControl_NodeRED.json');
fs.mkdirSync(path.dirname(publicPath), { recursive: true });
const tabId = 'b7be72c8b69bf30e';
const dashboardId = 'dec0785f657dc7d1';

let flows = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const dashboard = fs.readFileSync(dashboardPath, 'utf8');
const get = id => {
  const node = flows.find(item => item.id === id);
  if (!node) throw new Error(`Node fehlt: ${id}`);
  return node;
};
const replaceOnce = (source, before, after, label) => {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: erwartete genau eine Fundstelle, gefunden ${count}`);
  return source.replace(before, after);
};
const removeIds = ids => {
  const unwanted = new Set(ids);
  flows = flows.filter(node => !unwanted.has(node.id));
  for (const node of flows) {
    if (!Array.isArray(node.wires)) continue;
    node.wires = node.wires.map(output => Array.isArray(output) ? output.filter(id => !unwanted.has(id)) : output);
  }
};
const add = node => {
  if (flows.some(item => item.id === node.id)) throw new Error(`Doppelte Node-ID: ${node.id}`);
  flows.push(node);
};
const inputNode = (id, name, pathValue, type, y, topicId) => ({
  id,
  type: 'victron-input-custom',
  z: tabId,
  service: 'com.victronenergy.platform',
  path: pathValue,
  serviceObj: { service: 'com.victronenergy.platform', name: 'Venus platform' },
  pathObj: { path: pathValue, type, name: pathValue },
  name,
  onlyChanges: false,
  roundValues: '3',
  x: 230,
  y,
  wires: [[topicId]]
});
const topicNode = (id, topic, y) => ({
  id,
  type: 'change',
  z: tabId,
  name: `→ ${topic}`,
  rules: [
    { t: 'set', p: 'topic', pt: 'msg', to: topic, tot: 'str' },
    { t: 'set', p: '_camperSeen', pt: 'msg', to: '', tot: 'date' }
  ],
  action: '', property: '', from: '', to: '', reg: false,
  x: 535,
  y,
  wires: [['external_wifi_state_update']]
});
const outputNode = (id, name, pathValue, type, y) => ({
  id,
  type: 'victron-output-custom',
  z: tabId,
  service: 'com.victronenergy.platform',
  path: pathValue,
  serviceObj: { service: 'com.victronenergy.platform', name: 'Venus platform' },
  pathObj: { path: pathValue, name: pathValue, type },
  initial: '',
  name,
  onlyChanges: false,
  x: 1305,
  y,
  wires: []
});

// Die Dashboard-Datei ist die einzige UI-Quelle. Detailseiten behalten die
// untere Navigation; WLAN-Zugangsdaten werden dort nie persistiert.
get(dashboardId).format = dashboard;

// Reale D-Bus-/Geräteänderungen werden weiterhin sofort gepusht. Der periodische
// Komplett-Snapshot ist nur ein Fallback und darf die alte Cerbo-CPU nicht alle
// zwei Sekunden mit der großen Aggregator-Funktion belasten.
const snapshotFallback = get('3a031e0c8fe40790');
snapshotFallback.name = 'Fallback-Zustand alle 10 Sekunden';
snapshotFallback.repeat = '10';
snapshotFallback.once = true;
snapshotFallback.onceDelay = 5;

// Ruuvi wird nicht gesucht. Der vorhandene Sensor FB31 ist fest und nativ dem
// Victron-Temperaturdienst /24 als Deckenfühler zugeordnet. Ein Bodenfühler
// bleibt bis zu seiner ausdrücklichen Service-Zuordnung offline; dadurch kann
// sich die Rollenverteilung nach Neustarts oder neuen Bluetooth-Geräten nie
// selbständig ändern.
const ruuviLegacyIds = [
  'camper_ruuvi_discovery_tick', 'camper_ruuvi_discovery_exec',
  'camper_ruuvi_discovery_parse', 'camper_ruuvi_discovery_note',
  'ruuvi_ceiling_temperature_in', 'ruuvi_ceiling_temperature_topic',
  'ruuvi_ceiling_humidity_in', 'ruuvi_ceiling_humidity_topic',
  'ruuvi_ceiling_pressure_in', 'ruuvi_ceiling_pressure_topic',
  'ruuvi_ceiling_battery_in', 'ruuvi_ceiling_battery_topic',
  'ruuvi_ceiling_batteryVoltage_in', 'ruuvi_ceiling_batteryVoltage_topic',
  'ruuvi_ceiling_name_in', 'ruuvi_ceiling_name_topic',
  'ruuvi_ceiling_deviceName_in', 'ruuvi_ceiling_deviceName_topic',
  'ruuvi_manual_adapter', 'ruuvi_manual_note'
];
removeIds(ruuviLegacyIds);
const ruuviService = 'com.victronenergy.temperature/24';
const ruuviInput = (id, name, pathValue, type, y, topicId) => ({
  id,
  // Der eigentliche Temperaturwert nutzt den offiziellen spezialisierten
  // Victron-Knoten; Zusatzwerte benötigen die freie Pfadauswahl des Custom-
  // Eingangs, bleiben aber auf demselben fest ausgewählten Venus-Dienst.
  type: pathValue === '/Temperature' ? 'victron-input-temperature' : 'victron-input-custom',
  z: tabId,
  service: ruuviService,
  path: pathValue,
  serviceObj: { service: ruuviService, name: 'Ruuvi FB31 · Decke' },
  pathObj: { path: pathValue, type, name: pathValue },
  name,
  onlyChanges: true,
  roundValues: '3',
  x: 245,
  y,
  wires: [[topicId]]
});
const ruuviTopic = (id, topic, y) => ({
  id,
  type: 'change',
  z: tabId,
  name: `→ ${topic}`,
  rules: [
    { t: 'set', p: 'topic', pt: 'msg', to: topic, tot: 'str' },
    { t: 'set', p: '_camperSeen', pt: 'msg', to: '', tot: 'date' }
  ],
  action: '', property: '', from: '', to: '', reg: false,
  x: 545,
  y,
  wires: [['ruuvi_manual_adapter']]
});
const ruuviFields = [
  ['temperature', '/Temperature', 'number', 8650],
  ['humidity', '/Humidity', 'number', 8695],
  ['pressure', '/Pressure', 'number', 8740],
  ['batteryVoltage', '/BatteryVoltage', 'number', 8785],
  ['deviceName', '/DeviceName', 'string', 8830]
];
for (const [field, pathValue, type, y] of ruuviFields) {
  add(ruuviInput(`ruuvi_ceiling_${field}_in`, `Ruuvi FB31 Decke · ${pathValue}`, pathValue, type, y, `ruuvi_ceiling_${field}_topic`));
  add(ruuviTopic(`ruuvi_ceiling_${field}_topic`, `ruuvi.ceiling.${field}`, y));
}
add({
  id: 'ruuvi_manual_adapter', type: 'function', z: tabId,
  name: 'Ruuvi fest zuordnen · Decke /24 · Boden nicht konfiguriert',
  func: String.raw`
const unwrap = value => value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'value') ? value.value : value;
const parts = String(msg.topic || '').split('.');
if (parts.length !== 3 || parts[0] !== 'ruuvi' || parts[1] !== 'ceiling') return null;
const field = parts[2];
const allowed = ['temperature', 'humidity', 'pressure', 'batteryVoltage', 'deviceName'];
if (!allowed.includes(field)) return null;
const raw = unwrap(msg.payload);
const stored = flow.get('camperManualTemperatureSensors') || {};
const ceiling = Object.assign({ configured: true, service: 'com.victronenergy.temperature/24', label: 'Ruuvi Decke' }, stored.ceiling || {});
if (field === 'deviceName') ceiling.deviceName = String(raw == null ? '' : raw).trim().slice(0, 96);
else if (raw != null && raw !== '' && typeof raw !== 'boolean' && Number.isFinite(Number(raw))) {
    const value = Number(raw);
    if (field !== 'temperature' || (value >= -50 && value <= 80)) ceiling[field] = value;
}
if (field === 'temperature' && Number.isFinite(Number(ceiling.temperature))) ceiling.seen = Number(msg._camperSeen || Date.now());
stored.ceiling = ceiling;
stored.floor = Object.assign({ configured: false, service: '', label: 'Ruuvi Boden', seen: 0 }, stored.floor || {}, { configured: false, service: '', seen: 0 });
flow.set('camperManualTemperatureSensors', stored);
flow.set('camperTemperatureAssignment', {
    mode: 'manual',
    ceilingService: 'com.victronenergy.temperature/24',
    ceilingDeviceName: ceiling.deviceName || 'Ruuvi FB31',
    floorService: '',
    floorConfigured: false,
    updatedAt: Date.now()
});
if (!Number.isFinite(Number(ceiling.temperature)) || !Number.isFinite(Number(ceiling.seen))) return null;
const reading = {
    temp: Math.round(Number(ceiling.temperature) * 10) / 10,
    humidity: Number.isFinite(Number(ceiling.humidity)) ? Number(ceiling.humidity) : null,
    pressure: Number.isFinite(Number(ceiling.pressure)) ? Number(ceiling.pressure) : null,
    batteryVoltage: Number.isFinite(Number(ceiling.batteryVoltage)) ? Number(ceiling.batteryVoltage) : null,
    seen: Number(ceiling.seen),
    label: 'Ruuvi Decke',
    source: 'cerbo',
    service: 'com.victronenergy.temperature/24',
    deviceName: ceiling.deviceName || 'Ruuvi FB31'
};
return [[
    { topic: 'ruuvi1', payload: reading },
    { topic: 'ruuvi2', payload: { temp: null, humidity: null, pressure: null, batteryVoltage: null, seen: 0, label: 'Ruuvi Boden · nicht konfiguriert', source: 'manual', service: '', configured: false } },
    { topic: 'ruuvi3', payload: Object.assign({}, reading, { label: 'Raumwert · Decke' }) }
]];
`,
  outputs: 1, timeout: 0, noerr: 0, initialize: '', finalize: '', libs: [],
  x: 875, y: 8740, wires: [['12f9ef01215ad8d3']]
});
add({
  id: 'ruuvi_manual_note', type: 'comment', z: tabId,
  name: 'Ruuvi fest: FB31 = Decke (/24). Boden erst nach eigener DeviceInstance manuell ergänzen.',
  info: 'Keine automatische Suche und keine dynamische Rollenvergabe. Die fünf nativen Victron-Eingänge lesen ausschließlich com.victronenergy.temperature/24. Der zweite RuuviTag bleibt bis zur ausdrücklichen Zuordnung offline.',
  x: 525, y: 8880, wires: []
});

// Der verbliebene Service-Status darf niemals überlappen. Ein hängender Lauf
// blockiert nur weitere Statusabfragen, statt immer neue Prozesse zu erzeugen.
removeIds(['camper_service_status_guard', 'camper_service_status_unlock']);
const serviceTick = get('camper_service_status_tick');
serviceTick.name = 'Service-Status alle 60 Sekunden';
serviceTick.repeat = '60';
serviceTick.once = true;
serviceTick.onceDelay = 8;
serviceTick.wires = [['camper_service_status_guard']];
const serviceExec = get('camper_service_status_exec');
serviceExec.timer = '';
serviceExec.wires = [['camper_service_status_parse'], [], ['camper_service_status_unlock']];
add({
  id: 'camper_service_status_guard', type: 'function', z: tabId,
  name: 'Service-Status · nur ein Prozess gleichzeitig',
  func: "if (flow.get('camperServiceStatusBusy') === true) return null;\nflow.set('camperServiceStatusBusy', true);\nreturn msg;",
  outputs: 1, timeout: 0, noerr: 0, initialize: '', finalize: '', libs: [],
  x: 365, y: 7520, wires: [['camper_service_status_exec']]
});
add({
  id: 'camper_service_status_unlock', type: 'function', z: tabId,
  name: 'Service-Status · Prozess freigeben',
  func: "flow.set('camperServiceStatusBusy', false);\nreturn null;",
  outputs: 1, timeout: 0, noerr: 0, initialize: '', finalize: '', libs: [],
  x: 795, y: 7560, wires: []
});
get('camper_service_status_parse').func = String.raw`
const text = String(msg.payload == null ? '' : msg.payload);
const numeric = new Set([
    'status_version', 'timestamp', 'route_present', 'internet_reachable',
    'forwarding', 'bridge_forward', 'nat_eth0', 'nat_wlan0', 'ap_dns',
    'node_red_up', 'bluetooth_service_up', 'bluetooth_adapter_count', 'preferred_uplink_active',
    'bluetooth_sensor_count', 'cpu_temperature'
]);
const status = {};
for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    status[key] = numeric.has(key) && raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw;
}
status.receivedAt = Date.now();
status.valid = status.status_version === 1;
const previous = flow.get('camperServiceStatus') || {};
for (const [key, value] of Object.entries(previous)) if (key.startsWith('external_wifi_')) status[key] = value;
flow.set('camperServiceStatus', status);
flow.set('camperServiceStatusBusy', false);
msg.topic = 'service.status';
msg.payload = status;
return msg;
`;

// Shelly S1PM G4 wird bereits von Venus als AC-Load veröffentlicht. Schalten
// erfolgt deshalb ebenfalls über denselben D-Bus-Pfad, nicht über eine feste IP.
removeIds(['shelly_grid_rpc_on', 'shelly_grid_rpc_off']);
const shellyOutputOld = get('shelly_grid_state_out');
const shellyOutputIndex = flows.indexOf(shellyOutputOld);
flows[shellyOutputIndex] = {
  id: shellyOutputOld.id,
  type: 'victron-output-custom',
  z: shellyOutputOld.z,
  service: 'com.victronenergy.acload/50',
  path: '/SwitchableOutput/0/State',
  serviceObj: { service: 'com.victronenergy.acload/50', name: 'S1PMG4 - channel 0' },
  pathObj: { path: '/SwitchableOutput/0/State', name: '/SwitchableOutput/0/State', type: 'number' },
  initial: '',
  name: 'Shelly INDEVOLT · Stromzufuhr über Victron D-Bus',
  onlyChanges: false,
  x: shellyOutputOld.x,
  y: shellyOutputOld.y,
  wires: []
};

// Orion XS: /Mode ist der aktuelle native Steuerpfad (1 = Laden erlaubt,
// 4 = Aus). /State bleibt die Betriebszustandsanzeige und ist nicht der Schalter.
const orionOutput = get('orion_mode_out');
orionOutput.type = 'victron-output-alternator';
orionOutput.service = 'com.victronenergy.alternator/289';
orionOutput.path = '/Mode';
orionOutput.serviceObj = { service: 'com.victronenergy.alternator/289', name: 'Orion XS 12/12-50A Charger' };
orionOutput.pathObj = { path: '/Mode', name: '/Mode', type: 'enum', enum: { 1: 'On', 4: 'Off' }, mode: 'both' };
orionOutput.name = 'Orion XS · Laden erlauben / ausschalten';

// Auch die Orion-Messwerte kommen direkt aus den nativen Victron-Nodes. Der
// frühere 10-s-Abruf des gesamten /victron/cache war auf der alten Cerbo-CPU
// unnötig teuer und verzögerte außerdem die Schaltbestätigung.
const orionReadIds = [
  'orion_cache_poll', 'orion_cache_request', 'orion_cache_parse',
  'orion_power_in', 'orion_power_topic',
  'orion_voltage_in', 'orion_voltage_topic',
  'orion_current_in', 'orion_current_topic',
  'orion_inputVoltage_in', 'orion_inputVoltage_topic',
  'orion_inputPower_in', 'orion_inputPower_topic',
  'orion_state_in', 'orion_state_topic',
  'orion_mode_in', 'orion_mode_topic',
  'orion_error_in', 'orion_error_topic'
];
removeIds(orionReadIds);
const nativeInput = (id, name, service, pathValue, type, y, topicId) => ({
  id,
  type: 'victron-input-alternator',
  z: tabId,
  service,
  path: pathValue,
  serviceObj: { service, name: service === 'com.victronenergy.alternator/289' ? 'Orion XS 12/12-50A Charger' : service },
  pathObj: { path: pathValue, type, name: pathValue },
  name,
  onlyChanges: true,
  roundValues: '3',
  x: 240,
  y,
  wires: [[topicId]]
});
const sensorTopic = (id, name, topic, y) => ({
  id,
  type: 'change',
  z: tabId,
  name,
  rules: [
    { t: 'set', p: 'topic', pt: 'msg', to: topic, tot: 'str' },
    { t: 'set', p: '_camperSeen', pt: 'msg', to: '', tot: 'date' }
  ],
  action: '', property: '', from: '', to: '', reg: false,
  x: 560,
  y,
  wires: [['bb6668fefec83068']]
});
const orionFields = [
  ['power', '/Dc/0/Power', 8400],
  ['voltage', '/Dc/0/Voltage', 8445],
  ['current', '/Dc/0/Current', 8490],
  ['inputVoltage', '/Dc/In/V', 8535],
  ['inputPower', '/Dc/In/P', 8580],
  ['state', '/State', 8625],
  ['mode', '/Mode', 8670],
  ['error', '/ErrorCode', 8715]
];
for (const [field, pathValue, y] of orionFields) {
  add(nativeInput(`orion_${field}_in`, `Orion XS · ${pathValue}`, 'com.victronenergy.alternator/289', pathValue, 'number', y, `orion_${field}_topic`));
  add(sensorTopic(`orion_${field}_topic`, `→ orion.${field}`, `orion.${field}`, y));
}

// Harte Kanaltrennung: Warnlicht ist ausschließlich STAR-Power CH 8
// (/SwitchableOutput/7/State), Hecklicht ausschließlich CH 11
// (/SwitchableOutput/10). Der Warnblinker wechselt nur den State von CH 8;
// der Dimming-Ausgang von CH 8 wird bewusst vollständig entfernt. CH-11-
// Feedback läuft niemals durch die Warnblink-Zustandsmaschine.
const forceStarPowerOutput = (id, channel, suffix, type, label) => {
  const node = get(id);
  const index = channel - 1;
  node.service = 'com.victronenergy.switch/0';
  node.path = `/SwitchableOutput/${index}/${suffix}`;
  node.serviceObj = { service: 'com.victronenergy.switch/0', name: 'StarPower_55:6E (0)' };
  node.pathObj = Object.assign({}, node.pathObj || {}, {
    path: node.path,
    type,
    name: `STAR-Power CH ${channel} ${suffix.toLowerCase()}`,
    mode: 'both'
  });
  node.name = label;
};
forceStarPowerOutput('959137a3ca444583', 8, 'State', 'enum', 'CH 8 Warnlicht schalten');
forceStarPowerOutput('4afab948e3bba101', 11, 'State', 'enum', 'CH 11 Hecklicht schalten');
forceStarPowerOutput('d1a6f2d556b5e888', 11, 'Dimming', 'integer', 'CH 11 Hecklicht dimmen');
removeIds(['60540243db20bc53']);
const starRouter = get('6a22df3c7ebe02fc');
starRouter.wires[7] = ['959137a3ca444583'];
starRouter.wires[10] = ['4afab948e3bba101'];
starRouter.wires[13] = [];
starRouter.wires[16] = ['d1a6f2d556b5e888'];
const warningController = get('e0809a11d6ca3b34');
warningController.name = 'Warnlicht CH 8 · State-only';
warningController.outputs = 1;
warningController.wires = [['6a22df3c7ebe02fc']];
warningController.func = String.raw`
const WHITE_CHANNEL = 7;
const WARNING_CHANNEL = 8;
const INTERVAL_MS = 500;
let warning = flow.get('frontWarningBlink') || {
    active: false, phase: false, pending: false,
    intervalMs: INTERVAL_MS, startedAt: 0, lastCommandAt: 0, lastAckAt: 0
};
const physical = (channel, value) => ({
    topic: 'ui',
    payload: { action: 'toggle', channel, value, _warningPhysical: true }
});
const stopTimer = () => {
    const timer = context.get('blinkTimer');
    if (timer) clearTimeout(timer);
    context.set('blinkTimer', null);
};
const scheduleNextEdge = () => {
    stopTimer();
    if (!warning.active || warning.pending) return;
    const timer = setTimeout(() => {
        context.set('blinkTimer', null);
        const current = flow.get('frontWarningBlink') || {};
        if (current.active !== true || current.pending === true) return;
        current.phase = current.phase !== true;
        current.pending = true;
        current.lastCommandAt = Date.now();
        flow.set('frontWarningBlink', current);
        // Genau ein physischer Pfad: STAR-Power CH 8 State.
        node.send(physical(WARNING_CHANNEL, current.phase ? 1 : 0));
    }, INTERVAL_MS);
    context.set('blinkTimer', timer);
};

if (msg.topic === 'front-warning-reset') {
    stopTimer();
    warning = {
        active: false, phase: false, pending: false,
        intervalMs: INTERVAL_MS, startedAt: 0,
        lastCommandAt: Date.now(), lastAckAt: 0
    };
    flow.set('frontWarningBlink', warning);
    // Sicherer Startzustand nur für CH 8; CH 11 bleibt unangetastet.
    return [physical(WARNING_CHANNEL, 0)];
}

if (msg.topic === 'state:8') {
    const feedback = Number(msg.payload);
    const expected = warning.phase ? 1 : 0;
    if (warning.active && warning.pending && (feedback === 0 || feedback === 1) && feedback === expected) {
        warning.pending = false;
        warning.lastAckAt = Date.now();
        flow.set('frontWarningBlink', warning);
        scheduleNextEdge();
    }
    // Rückmeldung zusätzlich an die normale STAR-Power-Auswertung geben.
    return [msg];
}

if (msg.topic !== 'ui' || !msg.payload || typeof msg.payload !== 'object') return [msg];
const action = msg.payload;
const channel = Number(action.channel);

if (action.action === 'toggle' && channel === WARNING_CHANNEL && action._warningPhysical !== true) {
    const enabled = Number(action.value) === 1;
    stopTimer();
    warning.active = enabled;
    warning.phase = enabled;
    warning.pending = enabled;
    warning.startedAt = enabled ? Date.now() : 0;
    warning.lastCommandAt = Date.now();
    flow.set('frontWarningBlink', warning);
    const messages = [];
    if (enabled) messages.push(physical(WHITE_CHANNEL, 0));
    messages.push(physical(WARNING_CHANNEL, enabled ? 1 : 0));
    return [messages];
}

if (action.action === 'toggle' && channel === WHITE_CHANNEL && Number(action.value) === 1 && action._warningPhysical !== true) {
    stopTimer();
    warning.active = false;
    warning.phase = false;
    warning.pending = false;
    warning.startedAt = 0;
    warning.lastCommandAt = Date.now();
    flow.set('frontWarningBlink', warning);
    return [[physical(WARNING_CHANNEL, 0), msg]];
}

// Warnlicht ist absichtlich nicht dimmbar. Auch ein veralteter Client darf
// niemals einen CH-8-Dimming-Befehl oder einen anderen Kanal ansteuern.
if (action.action === 'dim' && channel === WARNING_CHANNEL) return null;
return [msg];
`;
warningController.finalize = "const timer = context.get('blinkTimer');\nif (timer) clearTimeout(timer);\ncontext.set('blinkTimer', null);";
get('9bfddf1c91f0016b').wires = [['6a22df3c7ebe02fc', 'd36a1adac492ce3e']];
get('7b14fa6e29773eb5').wires = [['6a22df3c7ebe02fc', 'd36a1adac492ce3e']];
get('4ae22adfa536b4be').wires = [['6a22df3c7ebe02fc', 'd36a1adac492ce3e']];

// Externes WLAN über den bereits vorhandenen Venus-platform-D-Bus. Es gibt
// keine freie Shell-Eingabe und kein gespeichertes Passwort.
const wifiIds = [
  'external_wifi_services_in', 'external_wifi_services_topic',
  'external_wifi_enabled_in', 'external_wifi_enabled_topic',
  'external_wifi_state_in', 'external_wifi_state_topic',
  'external_wifi_signal_in', 'external_wifi_signal_topic',
  'external_wifi_state_update', 'external_wifi_gateway_out',
  'external_wifi_scan_out', 'external_wifi_scan_refresh', 'external_wifi_setvalue_out',
  'external_wifi_helper_health_tick', 'external_wifi_helper_health_request',
  'external_wifi_helper_health_parse', 'external_wifi_helper_health_catch',
  'external_wifi_helper_health_error', 'external_wifi_connect_prepare',
  'external_wifi_connect_request', 'external_wifi_connect_result',
  'external_wifi_connect_catch', 'external_wifi_connect_error',
  'external_wifi_connect_note'
];
removeIds(wifiIds);
add(inputNode('external_wifi_services_in', 'Externes WLAN · Netzwerke', '/Network/Services', 'string', 9000, 'external_wifi_services_topic'));
add(topicNode('external_wifi_services_topic', 'externalWifi.services', 9000));
add(inputNode('external_wifi_enabled_in', 'Externes WLAN · Uplink freigegeben', '/Network/Wifi/GatewayEnabled', 'number', 9045, 'external_wifi_enabled_topic'));
add(topicNode('external_wifi_enabled_topic', 'externalWifi.enabled', 9045));
add(inputNode('external_wifi_state_in', 'Externes WLAN · Zustand', '/Network/Wifi/State', 'string', 9090, 'external_wifi_state_topic'));
add(topicNode('external_wifi_state_topic', 'externalWifi.state', 9090));
add(inputNode('external_wifi_signal_in', 'Externes WLAN · Signal', '/Network/Wifi/SignalStrength', 'number', 9135, 'external_wifi_signal_topic'));
add(topicNode('external_wifi_signal_topic', 'externalWifi.signal', 9135));

add({
  id: 'external_wifi_state_update', type: 'function', z: tabId,
  name: 'Externes WLAN · Status ohne Zugangsdaten',
  func: String.raw`
const unwrap = value => value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'value') ? value.value : value;
const parseJson = value => {
    value = unwrap(value);
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '{}')); } catch (error) { return {}; }
};
const raw = flow.get('camperExternalWifiRaw') || {};
const field = String(msg.topic || '').split('.').pop();
if (['services', 'enabled', 'state', 'signal'].includes(field)) {
    raw[field] = unwrap(msg.payload);
    raw.receivedAt = Date.now();
}
flow.set('camperExternalWifiRaw', raw);

const source = parseJson(raw.services);
const wifiSource = source && source.wifi && typeof source.wifi === 'object'
    ? source.wifi
    : (source && source.Wifi && typeof source.Wifi === 'object' ? source.Wifi : source);
let entries = [];
if (Array.isArray(wifiSource)) entries = wifiSource.map((item, index) => [String(item && (item.Service || item.service) || index), item]);
else if (Array.isArray(wifiSource.Services)) entries = wifiSource.Services.map((item, index) => [String(item && (item.Service || item.service) || index), item]);
else if (Array.isArray(wifiSource.services)) entries = wifiSource.services.map((item, index) => [String(item && (item.Service || item.service) || index), item]);
else if (wifiSource && typeof wifiSource === 'object') entries = Object.entries(wifiSource);
const pick = (object, keys, fallback = '') => {
    for (const key of keys) if (object && object[key] != null) return unwrap(object[key]);
    return fallback;
};
const bool = value => value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true' || String(value).toLowerCase() === 'yes';
const networks = [];
for (const [entryKey, value] of entries) {
    if (!value || typeof value !== 'object') continue;
    const service = String(pick(value, ['Service', 'service', 'Path', 'path'], entryKey));
    const type = String(pick(value, ['Type', 'type', 'Technology', 'technology'], '')).toLowerCase();
    if (type && !type.includes('wifi') && !type.includes('wireless')) continue;
    if (!type && !/wifi|wireless|wlan/i.test(service)) continue;
    const ssid = String(pick(value, ['Name', 'name', 'SSID', 'ssid'], /^\/net\//.test(entryKey) ? '' : entryKey)).trim();
    if (!ssid) continue;
    const state = String(pick(value, ['State', 'state'], '')).toLowerCase();
    const securedRaw = pick(value, ['Secured', 'secured'], null);
    const securityRaw = pick(value, ['Security', 'security'], '');
    const security = Array.isArray(securityRaw) ? securityRaw.join(',') : String(securityRaw || '');
    const strengthValue = Number(pick(value, ['Strength', 'strength', 'SignalStrength', 'signalStrength'], NaN));
    const ipv4 = pick(value, ['Ipv4', 'IPv4', 'ipv4'], {});
    const address = String(pick(ipv4, ['Address', 'address'], pick(value, ['Address', 'address'], '')) || '');
    networks.push({
        ssid,
        service,
        state,
        strength: Number.isFinite(strengthValue) ? Math.max(0, Math.min(100, strengthValue)) : null,
        secured: securedRaw == null ? (security !== '' && !/none|open/i.test(security)) : bool(securedRaw),
        favorite: bool(pick(value, ['Favorite', 'favorite'], false)),
        connected: /^(online|ready)$/.test(state),
        connecting: /^(association|configuration)$/.test(state),
        address
    });
}
networks.sort((a, b) => Number(b.connected) - Number(a.connected) || Number(b.strength || -1) - Number(a.strength || -1) || a.ssid.localeCompare(b.ssid));
const connected = networks.find(item => item.connected) || {};
const enabledValue = raw.enabled === true || Number(raw.enabled) === 1;
const scanUntil = Number(flow.get('camperExternalWifiScanUntil') || 0);
const status = Object.assign({}, flow.get('camperServiceStatus') || {}, {
    external_wifi_available: raw.receivedAt > 0 && (networks.length > 0 || raw.enabled != null || raw.state != null) ? 1 : 0,
    external_wifi_enabled: enabledValue ? 1 : 0,
    external_wifi_state: String(raw.state == null ? (connected.state || '') : raw.state),
    external_wifi_signal: Number.isFinite(Number(raw.signal)) ? Number(raw.signal) : (connected.strength == null ? null : connected.strength),
    external_wifi_ssid: connected.ssid || '',
    external_wifi_connected_ssid: connected.ssid || '',
    external_wifi_interface: 'wlan0',
    external_wifi_connect_supported: flow.get('camperExternalWifiConnectSupported') === true ? 1 : 0,
    external_wifi_scan_active: Date.now() < scanUntil ? 1 : 0,
    external_wifi_address: connected.address || '',
    external_wifi_networks: networks.map(item => ({ ssid: item.ssid, service: item.service, state: item.state, strength: item.strength, secured: item.secured, favorite: item.favorite, connected: item.connected, connecting: item.connecting, address: item.address })),
    external_wifi_received_at: raw.receivedAt
});
flow.set('camperServiceStatus', status);
return { topic: 'service.status', payload: status };
`,
  outputs: 1, timeout: 0, noerr: 0, initialize: '', finalize: '', libs: [],
  x: 835, y: 9070,
  wires: [['camper_service_ui', dashboardId, 'ada9353cc6ea4a4c']]
});
add(outputNode('external_wifi_gateway_out', 'Externes WLAN · Internet-Uplink Ein/Aus', '/Network/Wifi/GatewayEnabled', 'number', 9185));
add(outputNode('external_wifi_scan_out', 'Externes WLAN · Scan starten', '/Network/Wifi/Scan', 'number', 9230));
add({
  id: 'external_wifi_scan_refresh', type: 'delay', z: tabId,
  name: 'WLAN-Scanstatus nach 16 s aktualisieren',
  pauseType: 'delay', timeout: '16', timeoutUnits: 'seconds', rate: '1', nbRateUnits: '1', rateUnits: 'second',
  randomFirst: '1', randomLast: '5', randomUnits: 'seconds', drop: false, allowrate: false,
  outputs: 1, x: 1315, y: 9315, wires: [['external_wifi_state_update']]
});

// Neue WLAN-Zugangsdaten werden nur über den root-eigenen, loopback-only
// ConnMan-Helfer übergeben. Es gibt keinen Exec-Knoten, kein Passwort im
// Kommandozeilenargument und weiterhin ausdrücklich kein /Network/SetValue.
add({
  id: 'external_wifi_helper_health_tick', type: 'inject', z: tabId,
  name: 'WLAN-Helfer prüfen · 60 s', props: [
    { p: 'payload' }, { p: 'topic', vt: 'str' }
  ], repeat: '60', crontab: '', once: true, onceDelay: 12,
  topic: 'externalWifi.helper.health', payload: '', payloadType: 'date',
  x: 240, y: 9360, wires: [['external_wifi_helper_health_request']]
});
add({
  id: 'external_wifi_helper_health_request', type: 'http request', z: tabId,
  name: 'WLAN-Helfer · loopback health', method: 'GET', ret: 'obj', paytoqs: 'ignore',
  url: 'http://127.0.0.1:18543/health', tls: '', persist: false, proxy: '',
  insecureHTTPParser: false, authType: '', senderr: true, headers: [],
  x: 545, y: 9360, wires: [['external_wifi_helper_health_parse']]
});
add({
  id: 'external_wifi_helper_health_parse', type: 'function', z: tabId,
  name: 'WLAN-Helfer · Fähigkeit veröffentlichen',
  func: String.raw`
const body = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
const healthy = Number(msg.statusCode || 0) === 200 && body.ok === true && body.status === 'ready' && body.interface === 'wlan0';
flow.set('camperExternalWifiConnectSupported', healthy);
return { topic: 'externalWifi.helper', payload: healthy };
`,
  outputs: 1, timeout: 0, noerr: 0, initialize: '', finalize: '', libs: [],
  x: 865, y: 9360, wires: [['external_wifi_state_update']]
});
add({
  id: 'external_wifi_helper_health_catch', type: 'catch', z: tabId,
  name: 'WLAN-Helfer · Health-Fehler', scope: ['external_wifi_helper_health_request'],
  uncaught: false, x: 540, y: 9400, wires: [['external_wifi_helper_health_error']]
});
add({
  id: 'external_wifi_helper_health_error', type: 'function', z: tabId,
  name: 'WLAN-Helfer · nicht verfügbar',
  func: "flow.set('camperExternalWifiConnectSupported', false);\nreturn { topic: 'externalWifi.helper', payload: false };",
  outputs: 1, timeout: 0, noerr: 0, initialize: '', finalize: '', libs: [],
  x: 860, y: 9400, wires: [['external_wifi_state_update']]
});
add({
  id: 'external_wifi_connect_prepare', type: 'function', z: tabId,
  name: 'WLAN verbinden · prüfen & Secret nur im HTTP-Body',
  func: String.raw`
const request = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
const reject = text => [null, { topic: 'service.notice', payload: { level: 'error', text } }];
if (flow.get('camperExternalWifiConnectSupported') !== true) return reject('WLAN-Verbindungshelfer ist nicht verfügbar.');
if (flow.get('camperExternalWifiConnectBusy') === true) return reject('Eine WLAN-Verbindung wird bereits aufgebaut.');
const service = String(request.service || '');
const passphrase = typeof request.passphrase === 'string' ? request.passphrase : '';
const status = flow.get('camperServiceStatus') || {};
const networks = Array.isArray(status.external_wifi_networks) ? status.external_wifi_networks : [];
const selected = networks.find(item => item && item.service === service);
if (!selected || !/^\/net\/connman\/service\/wifi_[A-Za-z0-9_]+$/.test(service) || service.length > 512) {
    return reject('Das WLAN stammt nicht aus der aktuellen Netzwerksuche.');
}
if (selected.secured && ((!selected.favorite && passphrase.length < 8) || (passphrase.length > 0 && passphrase.length < 8) || passphrase.length > 256)) {
    return reject('Für dieses geschützte WLAN ist ein gültiges Kennwort erforderlich.');
}
if (!selected.secured && passphrase.length > 256) return reject('Das WLAN-Kennwort ist zu lang.');
flow.set('camperExternalWifiConnectBusy', true);
return [{
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-camper-control': 'node-red' },
    payload: JSON.stringify({ service, passphrase, ssid: String(selected.ssid || request.ssid || '').slice(0, 128) })
}, null];
`,
  outputs: 2, timeout: 0, noerr: 0, initialize: '', finalize: '', libs: [],
  x: 390, y: 9460,
  wires: [['external_wifi_connect_request'], ['camper_service_ui', dashboardId]]
});
add({
  id: 'external_wifi_connect_request', type: 'http request', z: tabId,
  name: 'WLAN verbinden · lokaler ConnMan-Helfer', method: 'POST', ret: 'obj', paytoqs: 'ignore',
  url: 'http://127.0.0.1:18543/connect', tls: '', persist: false, proxy: '',
  insecureHTTPParser: false, authType: '', senderr: true, headers: [],
  x: 760, y: 9460, wires: [['external_wifi_connect_result']]
});
add({
  id: 'external_wifi_connect_result', type: 'function', z: tabId,
  name: 'WLAN-Verbindung · Ergebnis ohne Secret',
  func: String.raw`
flow.set('camperExternalWifiConnectBusy', false);
const body = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
const ok = body.ok === true && Number(msg.statusCode || 0) >= 200 && Number(msg.statusCode || 0) < 300;
const labels = {
    authentication_failed: 'WLAN-Kennwort wurde abgelehnt.',
    service_not_available: 'Das ausgewählte WLAN ist nicht mehr verfügbar.',
    connection_busy: 'Eine WLAN-Verbindung wird bereits aufgebaut.',
    connection_timeout: 'Zeitüberschreitung beim WLAN-Verbindungsaufbau.'
};
flow.set('camperExternalWifiScanUntil', Date.now() + 15000);
const text = ok
    ? 'Externes WLAN wurde verbunden.'
    : (labels[String(body.error || '')] || 'WLAN-Verbindung konnte nicht hergestellt werden.');
return [
    { topic: 'service.notice', payload: { level: ok ? 'info' : 'error', text } },
    { payload: 1 }
];
`,
  outputs: 2, timeout: 0, noerr: 0, initialize: '', finalize: '', libs: [],
  x: 1090, y: 9460,
  wires: [['camper_service_ui', dashboardId], ['external_wifi_scan_out', 'external_wifi_scan_refresh']]
});
add({
  id: 'external_wifi_connect_catch', type: 'catch', z: tabId,
  name: 'WLAN-Verbindung · Transportfehler', scope: ['external_wifi_connect_request'],
  uncaught: false, x: 760, y: 9500, wires: [['external_wifi_connect_error']]
});
add({
  id: 'external_wifi_connect_error', type: 'function', z: tabId,
  name: 'WLAN-Verbindung · sicher freigeben',
  func: "flow.set('camperExternalWifiConnectBusy', false);\nreturn { topic: 'service.notice', payload: { level: 'error', text: 'Lokaler WLAN-Verbindungsdienst ist nicht erreichbar.' } };",
  outputs: 1, timeout: 0, noerr: 0, initialize: '', finalize: '', libs: [],
  x: 1090, y: 9500, wires: [['camper_service_ui', dashboardId]]
});
add({
  id: 'external_wifi_connect_note', type: 'comment', z: tabId,
  name: 'Kein Secret in Datei, Context, argv oder Debug · POST nur 127.0.0.1:18543',
  info: 'Das Kennwort existiert nur transient im HTTP-Body zwischen dem Node-RED-Request und dem root-eigenen ConnMan-Helfer. Der Service-Pfad muss exakt aus /Network/Services stammen.',
  x: 560, y: 9540, wires: []
});

// Service-Aktionen bleiben eine feste Whitelist. Die Ziel-Service-ID muss aus
// dem unmittelbar zuvor vom Cerbo gelieferten Scan stammen.
const serviceRouter = get('camper_service_action_router');
serviceRouter.func = String.raw`
const request = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
const action = String(request.action || '');
const output = Array(9).fill(null);
const notice = (level, text) => { output[5] = { topic: 'service.notice', payload: { level, text } }; };
if (action === 'refresh') {
    output[4] = { topic: 'service.refresh', payload: '' };
    return output;
}
if (action === 'wifiEnable') {
    if (typeof request.value !== 'boolean') { notice('error', 'Ungültiger WLAN-Schaltwert abgelehnt.'); return output; }
    output[6] = { payload: request.value ? 1 : 0 };
    notice('info', request.value ? 'Externer WLAN-Uplink wird aktiviert.' : 'Externer WLAN-Uplink wird deaktiviert.');
    return output;
}
if (action === 'wifiScan') {
    flow.set('camperExternalWifiScanUntil', Date.now() + 15000);
    output[7] = { payload: 1 };
    notice('info', 'WLAN-Suche wurde gestartet.');
    return output;
}
if (action === 'wifiConnect') {
    output[8] = { payload: {
        service: String(request.service || ''),
        ssid: String(request.ssid || ''),
        passphrase: typeof request.passphrase === 'string' ? request.passphrase : ''
    } };
    return output;
}
const allowed = { networkRepair: 0, bluetoothRepair: 1, nodeRedRestart: 2, cerboReboot: 3 };
if (!Object.prototype.hasOwnProperty.call(allowed, action)) {
    notice('error', 'Unbekannte Service-Aktion abgelehnt.');
    return output;
}
const labels = {
    networkRepair: 'Netzwerk-Reparatur gestartet. Die Verbindung kann kurz unterbrochen werden.',
    bluetoothRepair: 'Bluetooth-Dienst wird neu gestartet und der Adapterzustand geprüft.',
    nodeRedRestart: 'Node-RED wird neu gestartet. Das Dashboard benötigt anschließend einige Minuten.',
    cerboReboot: 'Cerbo-Neustart wurde ausgelöst.'
};
output[allowed[action]] = { topic: 'service.action', payload: '' };
notice('info', labels[action]);
return output;
`;
serviceRouter.outputs = 9;
serviceRouter.wires = [
  ['camper_network_repair_exec'],
  ['camper_bluetooth_repair_exec'],
  ['camper_node_red_restart_exec'],
  ['camper_cerbo_reboot_exec'],
  ['camper_service_status_guard'],
  ['camper_service_ui', dashboardId],
  ['external_wifi_gateway_out'],
  ['external_wifi_scan_out', 'external_wifi_scan_refresh'],
  ['external_wifi_connect_prepare']
];

// Der zentrale Router akzeptiert WLAN nur als feste Service-Aktionen und reicht
// nur die bestätigten Aktionen weiter. Ein WLAN-Kennwort wird weder in die
// Kommandohistorie noch in Flow-/Global-Context geschrieben.
const commandRouter = get('6265bf6f9bade1e5');
if (!commandRouter.func.includes("'wifiEnable', 'wifiScan'")) {
  commandRouter.func = replaceOnce(
    commandRouter.func,
    "if (target === 'service') {\n    const allowed = ['networkRepair', 'bluetoothRepair', 'nodeRedRestart', 'cerboReboot', 'refresh'];\n    if (!allowed.includes(action)) { accepted = false; error = 'invalid_service_action'; }\n    else output[10] = { topic: 'ui.service', payload: { action } };\n} else if (target === 'settings') {",
    "if (target === 'service') {\n    const allowed = ['networkRepair', 'bluetoothRepair', 'nodeRedRestart', 'cerboReboot', 'refresh', 'wifiEnable', 'wifiScan'];\n    if (!allowed.includes(action)) { accepted = false; error = 'invalid_service_action'; }\n    else if (action === 'wifiEnable' && typeof request.value !== 'boolean') { accepted = false; error = 'invalid_wifi_enable_value'; }\n    else output[10] = { topic: 'ui.service', payload: { action, value: request.value } };\n} else if (target === 'settings') {",
    'Zentraler WLAN-Service-Router'
  );
}
commandRouter.func = commandRouter.func.replace(
  /if \(target === 'service'\) \{[\s\S]*?\} else if \(target === 'settings'\) \{/,
  `if (target === 'service') {
    const allowed = ['networkRepair', 'bluetoothRepair', 'nodeRedRestart', 'cerboReboot', 'refresh', 'wifiEnable', 'wifiScan', 'wifiConnect'];
    if (!allowed.includes(action)) { accepted = false; error = 'invalid_service_action'; }
    else if (action === 'wifiEnable' && typeof request.value !== 'boolean') { accepted = false; error = 'invalid_wifi_enable_value'; }
    else if (action === 'wifiConnect') {
        const service = String(request.service || '');
        const ssid = String(request.ssid || '');
        const passphrase = request.passphrase;
        if (!/^\\/net\\/connman\\/service\\/wifi_[A-Za-z0-9_]+$/.test(service) || service.length > 512 || typeof passphrase !== 'string' || passphrase.length > 256 || ssid.length > 128) {
            accepted = false; error = 'invalid_wifi_connect_request';
        } else output[10] = { topic: 'ui.service', payload: { action, service, ssid, passphrase } };
    } else output[10] = { topic: 'ui.service', payload: { action, value: request.value } };
} else if (target === 'settings') {`
);

// UI-Konfiguration und Zustandssnapshot enthalten nur den Kachel-Schalter und
// bereinigte Statusdaten; kein Passwort und keine fest eingetragene SSID.
const settings = get('47003434a27acbe7');
if (!settings.func.includes('externalWifiTileEnabled')) {
  settings.func = replaceOnce(
    settings.func,
    '    cfg.ui = { quickAccessLightIds };',
    '    cfg.ui = { quickAccessLightIds, externalWifiTileEnabled: boolean(cfg.ui && cfg.ui.externalWifiTileEnabled, true) };',
    'WLAN-Kachel-Einstellung'
  );
}
const state = get('ada9353cc6ea4a4c');
if (!state.func.includes('externalWifiTileEnabled')) {
  state.func = replaceOnce(
    state.func,
    "    ui: { quickAccessLightIds: cfg.ui && Array.isArray(cfg.ui.quickAccessLightIds) ? cfg.ui.quickAccessLightIds : ['outside_front_white','outside_front_amber','inside_main','outside_right'] },",
    "    ui: { quickAccessLightIds: cfg.ui && Array.isArray(cfg.ui.quickAccessLightIds) ? cfg.ui.quickAccessLightIds : ['outside_front_white','outside_front_amber','inside_main','outside_right'], externalWifiTileEnabled: !(cfg.ui && cfg.ui.externalWifiTileEnabled === false) },",
    'WLAN-Kachel im Snapshot'
  );
}

// Cerbo-Gehäuselüftung: reale Verdrahtung Relais 1 = Abluft und Relais 2 =
// Zuluft. Beide Relais laufen gemeinsam. Ein manueller Dauerlauf hat Vorrang;
// ansonsten schaltet die CPU-Automatik mit Hysterese.
get('d9dfa5db2a5bb99a').name = 'Cerbo Relais 1 Rückmeldung · Abluft';
get('a157af67cff27109').name = 'Cerbo Relais 2 Rückmeldung · Zuluft';
get('edaf4c40dd44c239').name = 'Cerbo Relais 1 · Abluft';
get('06b5677f5f5ddd99').name = 'Cerbo Relais 2 · Zuluft';
get('072c2bcdc760dd56').name = 'Cerbo-CPU: Relais 1 Abluft · Relais 2 Zuluft';
const ventilationController = get('614274d83b9a4241');
ventilationController.name = 'CPU-Lüftung · manuell oder Temperatur';
ventilationController.func = String.raw`
const cfg = flow.get('camperConfig') || {};
const settings = Object.assign({ enabled: true, manualOn: false, onTemperature: 65, hysteresis: 5 }, cfg.ventilation || {});
let state = flow.get('ventilationState') || {
    active: false,
    manualOn: false,
    supplyOn: false,
    exhaustOn: false,
    supplyFeedback: null,
    exhaustFeedback: null,
    cpuTemperature: null,
    sensorOnline: false,
    reason: 'Initialisierung',
    updatedAt: 0
};

// Reale Verdrahtung: Relais 1 = Abluft, Relais 2 = Zuluft.
if (msg.topic === 'ventilation.relay1') state.exhaustFeedback = Number(msg.payload) === 1;
if (msg.topic === 'ventilation.relay2') state.supplyFeedback = Number(msg.payload) === 1;

if (msg.topic === 'ventilation.cpu' && Number.isFinite(Number(msg.payload))) {
    state.cpuTemperature = Number(msg.payload);
    state.cpuSeen = Date.now();
}

const temperature = Number(state.cpuTemperature);
const sensorValid = Number.isFinite(temperature) && Date.now() - Number(state.cpuSeen || 0) < 30000;
state.sensorOnline = sensorValid;
state.sensorName = 'Cerbo GX CPU';
const onTemperature = Math.max(30, Math.min(95, Number(settings.onTemperature || 65)));
const hysteresis = Math.max(2, Math.min(20, Number(settings.hysteresis || 5)));
const manualOn = settings.manualOn === true;
let desired = state.active === true;

if (manualOn) {
    desired = true;
    state.reason = 'Manuell eingeschaltet';
} else if (settings.enabled !== true) {
    desired = false;
    state.reason = 'Automatik aus';
} else if (!sensorValid) {
    // Ohne aktuelle Temperatur schaltet nur der bewusste Handbetrieb ein.
    desired = false;
    state.reason = 'CPU-Temperatur nicht verfügbar';
} else if (desired && temperature <= onTemperature - hysteresis) {
    desired = false;
    state.reason = 'Unter Ausschalttemperatur';
} else if (!desired && temperature >= onTemperature) {
    desired = true;
    state.reason = 'CPU-Temperatur zu hoch';
} else {
    state.reason = desired ? 'Temperatur halten · Lüftung läuft' : 'Temperatur im Sollbereich';
}

const changed = state.active !== desired || state.supplyOn !== desired || state.exhaustOn !== desired;
state.active = desired;
state.manualOn = manualOn;
state.supplyOn = desired;
state.exhaustOn = desired;
state.enabled = settings.enabled === true;
state.onTemperature = onTemperature;
state.offTemperature = onTemperature - hysteresis;
state.hysteresis = hysteresis;
state.updatedAt = Date.now();
flow.set('ventilationState', state);

const relay1 = state.exhaustFeedback === desired && !changed ? null : { payload: desired ? 1 : 0 };
const relay2 = state.supplyFeedback === desired && !changed ? null : { payload: desired ? 1 : 0 };
const refresh = changed || msg.topic === 'ventilation.relay1' || msg.topic === 'ventilation.relay2'
    ? { topic: 'tick', _camperSource: 'ventilation' }
    : null;
return [relay1, relay2, refresh];
`;
if (!state.func.includes('manualOn: ventilation.manualOn === true')) {
  state.func = replaceOnce(
    state.func,
    '            enabled: ventilation.enabled === true,',
    '            enabled: ventilation.enabled === true,\n            manualOn: ventilation.manualOn === true,',
    'Manueller Lüfterstatus im Snapshot'
  );
}

// Das aktuelle Schema ist rein lokal und unbeschränkt. Frühere Token-Felder
// werden weder übernommen noch nach außen gespiegelt. Ebenso bleibt die
// Temperaturseite bei den realen Messpunkten; eine Schichtungswarnung gehört
// nicht mehr zum aktuellen Modell.
const cleanEmbeddedDefaults = source => source.replace(
  /(const DEFAULTS = |\|\| )(\{"version":[45][^\n]*\})(;)/g,
  (match, prefix, json, suffix) => {
    const value = JSON.parse(json);
    const genericQuickFallback = ['switch:water_pump', 'switch:starlink', 'switch:dc_outlets_left', 'light:inside_main'];
    const genericQuick = value.ui && Array.isArray(value.ui.quickAccessIds) ? value.ui.quickAccessIds : null;
    const legacyQuick = value.ui && Array.isArray(value.ui.quickAccessLightIds)
      ? value.ui.quickAccessLightIds.map(id => id === 'high_beam' ? 'switch:high_beam_manual' : 'light:' + id)
      : null;
    value.version = 5;
    value.ui = {
      quickAccessIds: genericQuick || legacyQuick || genericQuickFallback,
      externalWifiTileEnabled: !(value.ui && value.ui.externalWifiTileEnabled === false)
    };
    delete value.security;
    value.access = { scope: 'local-network', unrestricted: true };
    value.temperatureSensors = Object.assign({}, value.temperatureSensors || {}, {
      ceilingService: 'com.victronenergy.temperature/24',
      floorService: ''
    });
    value.ventilation = Object.assign({}, value.ventilation || {}, {
      enabled: true,
      manualOn: false,
      onTemperature: Number(value.ventilation?.onTemperature || 65),
      hysteresis: Number(value.ventilation?.hysteresis || 5),
      supplyRelay: 2,
      exhaustRelay: 1
    });
    delete value.temperatureSensors.stratificationWarning;
    return prefix + JSON.stringify(value) + suffix;
  }
);

settings.func = cleanEmbeddedDefaults(settings.func)
  .replace(
    "    cfg.ventilation = {\n        enabled: boolean(cfg.ventilation && cfg.ventilation.enabled, false),\n        onTemperature: number(cfg.ventilation && cfg.ventilation.onTemperature, 65, 30, 95),\n        hysteresis: number(cfg.ventilation && cfg.ventilation.hysteresis, 5, 2, 20),\n        // Die Hardwarezuordnung ist fest: Cerbo Relais 1 = Zuluft,\n        // Cerbo Relais 2 = Abluft. Sie ist nicht frei umkonfigurierbar.\n        supplyRelay: 1,\n        exhaustRelay: 2\n    };",
    "    cfg.ventilation = {\n        enabled: boolean(cfg.ventilation && cfg.ventilation.enabled, true),\n        manualOn: boolean(cfg.ventilation && cfg.ventilation.manualOn, false),\n        onTemperature: number(cfg.ventilation && cfg.ventilation.onTemperature, 65, 30, 95),\n        hysteresis: number(cfg.ventilation && cfg.ventilation.hysteresis, 5, 2, 20),\n        // Die Hardwarezuordnung ist fest: Cerbo Relais 1 = Abluft,\n        // Cerbo Relais 2 = Zuluft. Sie ist nicht frei umkonfigurierbar.\n        supplyRelay: 2,\n        exhaustRelay: 1\n    };"
  )
  .replace(
    "    cfg.temperatureSensors = {\n        ceilingService: text(cfg.temperatureSensors && cfg.temperatureSensors.ceilingService, '', 180),\n        floorService: text(cfg.temperatureSensors && cfg.temperatureSensors.floorService, '', 180),\n        stratificationWarning: number(cfg.temperatureSensors && cfg.temperatureSensors.stratificationWarning, 4, 1, 10)\n    };",
    "    cfg.temperatureSensors = {\n        ceilingService: 'com.victronenergy.temperature/24',\n        floorService: ''\n    };"
  )
  .replace(
    "    cfg.temperatureSensors = {\n        ceilingService: text(cfg.temperatureSensors && cfg.temperatureSensors.ceilingService, '', 180),\n        floorService: text(cfg.temperatureSensors && cfg.temperatureSensors.floorService, '', 180)\n    };",
    "    cfg.temperatureSensors = {\n        ceilingService: 'com.victronenergy.temperature/24',\n        floorService: ''\n    };"
  )
  .replace(
    "    cfg.security.apiToken = text(cfg.security.apiToken, DEFAULTS.security.apiToken, 96);\n    cfg.security.allowReadWithoutToken = true;",
    "    delete cfg.security;\n    cfg.access = { scope: 'local-network', unrestricted: true };"
  )
  .replace(
    "const suppliedToken = () => {\n    const headers = msg.req && msg.req.headers || {};\n    const query = msg.req && msg.req.query || {};\n    const body = object(msg.payload) ? msg.payload : {};\n    return String(headers['x-camper-token'] || query.token || body.token || '');\n};\nconst authorized = () => true;\n",
    ''
  )
  .replace(
    "const publicConfig = () => {\n    const output = clone(cfg);\n    output.security = {\n        allowReadWithoutToken: true,\n        rateLimited: false,\n        tokenConfigured: false\n    };\n    return output;\n};",
    "const publicConfig = () => clone(cfg);"
  )
  .replace(
    "        const currentToken = cfg.security.apiToken;\n        cfg = sanitize(action.backup.config);\n        cfg.security.apiToken = currentToken;\n        changed = true;\n        networkChanged = true;\n        notice = 'Konfiguration wiederhergestellt. Der aktuelle API-Token wurde beibehalten.';",
    "        cfg = sanitize(action.backup.config);\n        changed = true;\n        networkChanged = true;\n        notice = 'Konfiguration wiederhergestellt.';"
  );

if (!settings.func.includes('const sourceVersion = Number(value && value.version || 0);')) {
  settings.func = replaceOnce(
    settings.func,
    "    const cfg = object(value) && Number(value.version) === 4 ? merge(DEFAULTS, value) : clone(DEFAULTS);\n    cfg.version = 4;",
    `    const sourceVersion = Number(value && value.version || 0);
    const source = object(value) && [4, 5].includes(sourceVersion) ? clone(value) : {};
    source.ui = object(source.ui) ? source.ui : {};
    if (!Array.isArray(source.ui.quickAccessIds) && Array.isArray(source.ui.quickAccessLightIds)) {
        source.ui.quickAccessIds = source.ui.quickAccessLightIds.map(id => id === 'high_beam' ? 'switch:high_beam_manual' : 'light:' + id);
    }
    delete source.ui.quickAccessLightIds;
    const cfg = merge(DEFAULTS, source);
    cfg.version = 5;`,
    'Migration des Schnellzugriffs von v4 auf v5'
  );
}

if (!settings.func.includes("const quickFallback = ['switch:water_pump'")) {
  settings.func = replaceOnce(
    settings.func,
    `    const quickAllowed = new Set([...DEFAULTS.lights.map(light => light.id), 'high_beam']);
    const quickFallback = ['outside_front_white', 'outside_front_amber', 'inside_main', 'outside_right'];
    const quickSeen = new Set();
    const quickSource = cfg.ui && Array.isArray(cfg.ui.quickAccessLightIds) ? cfg.ui.quickAccessLightIds : quickFallback;
    const quickAccessLightIds = quickSource.map(value => String(value)).filter(id => quickAllowed.has(id) && !quickSeen.has(id) && quickSeen.add(id)).slice(0, 4);
    for (const id of quickFallback) if (quickAccessLightIds.length < 4 && !quickSeen.has(id)) { quickSeen.add(id); quickAccessLightIds.push(id); }
    cfg.ui = { quickAccessLightIds, externalWifiTileEnabled: boolean(cfg.ui && cfg.ui.externalWifiTileEnabled, true) };`,
    `    const quickAllowed = new Set([
        ...cfg.lights.map(light => 'light:' + light.id),
        ...cfg.switches.map(item => 'switch:' + item.id),
        'device:inverter', 'device:orion', 'device:indevolt_grid', 'device:heater', 'device:maxxfan',
        ...(Array.isArray(cfg.scenes) ? cfg.scenes : []).filter(object).map(scene => 'scene:' + text(scene.id, '', 24).replace(/[^a-zA-Z0-9_-]/g, '_'))
    ]);
    const quickFallback = ['switch:water_pump', 'switch:starlink', 'switch:dc_outlets_left', 'light:inside_main'];
    const quickSeen = new Set();
    const quickSource = cfg.ui && Array.isArray(cfg.ui.quickAccessIds) ? cfg.ui.quickAccessIds : quickFallback;
    const quickAccessIds = quickSource.map(value => String(value)).filter(id => quickAllowed.has(id) && !quickSeen.has(id) && quickSeen.add(id)).slice(0, 4);
    for (const id of quickFallback) if (quickAccessIds.length < 4 && quickAllowed.has(id) && !quickSeen.has(id)) { quickSeen.add(id); quickAccessIds.push(id); }
    cfg.ui = { quickAccessIds, externalWifiTileEnabled: boolean(cfg.ui && cfg.ui.externalWifiTileEnabled, true) };`,
    'Generische Schnellzugriff-Konfiguration'
  );
}

const defaultMatch = settings.func.match(/const DEFAULTS = (\{"version":5[^\n]*\});/);
if (!defaultMatch) throw new Error('Bereinigte v5-Defaults nicht gefunden');
const defaultJson = defaultMatch[1];

const apiState = get('31af354fc4963c6c');
apiState.name = 'API Zustand · lokales Netz';
apiState.func = `
const cfg = flow.get('camperConfig') || ${defaultJson};
msg.statusCode = 200;
const rawAddress = String(msg.req && msg.req.socket && msg.req.socket.remoteAddress || '').replace(/^::ffff:/, '');
const viaVictronAp = /^172\\.24\\.24\\./.test(rawAddress);
const networkType = viaVictronAp ? 'victron-ap' : (cfg.network && cfg.network.topology === 'starlink' ? 'starlink' : 'local-network');
msg.payload = { ok: true, state: flow.get('camperSnapshot') || null, connection: { networkType, clientAddress: rawAddress, viaVictronAp } };
msg.headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
return msg;
`;

const apiResources = get('d33ff00d8dc2dcde');
apiResources.name = 'API Ereignisse / Verlauf / Diagnose / Backup';
apiResources.func = `
const cfg = flow.get('camperConfig') || ${defaultJson};
const query = msg.req && msg.req.query || {};
msg.headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const resource = String(msg._camperResource || '');
if (resource === 'events') msg.payload = { ok: true, events: (flow.get('camperEvents') || []).slice().reverse() };
else if (resource === 'commands') msg.payload = { ok: true, commands: (flow.get('camperCommands') || []).slice().reverse() };
else if (resource === 'diagnostics') msg.payload = { ok: true, diagnostics: ((flow.get('camperSnapshot') || {}).operations || {}).devices || [] };
else if (resource === 'history') {
    const history = flow.get('camperHistory') || {};
    const resolution = ['minute', 'quarterHour', 'daily'].includes(String(query.resolution)) ? String(query.resolution) : 'quarterHour';
    const since = Number(query.since || 0);
    const points = (Array.isArray(history[resolution]) ? history[resolution] : []).filter(point => !since || point.timestamp >= since).slice(-5000);
    msg.payload = { ok: true, resolution, points };
} else if (resource === 'backup') {
    msg.payload = { ok: true, backup: { schema: 'campercontrol-config-v5', exportedAt: new Date().toISOString(), config: JSON.parse(JSON.stringify(cfg)) } };
} else { msg.statusCode = 404; msg.payload = { ok: false, error: 'resource_not_found' }; return msg; }
msg.statusCode = 200;
return msg;
`;

commandRouter.name = 'Befehle validieren & routen';
commandRouter.func = cleanEmbeddedDefaults(commandRouter.func)
  .replace("const headers = msg.req && msg.req.headers || {};\nconst token = String(headers['x-camper-token'] || body.token || request.token || '');\n", '')
  .replace("const trustedInternal = !msg.req && !msg._session;\n", '')
  .replace("    if (false) {\n        if (msg._session) output[6] = ws({ type: 'error', error: 'unauthorized' });\n        return output;\n    }\n", '')
  .replace("        publicCfg.security = { allowReadWithoutToken: true, rateLimited: false, tokenConfigured: false };\n", "        publicCfg.access = { scope: 'local-network', unrestricted: true };\n")
  .replace("if (false) {\n    const error = { ok: false, error: 'unauthorized' };\n    if (msg.req) output[5] = http(401, error);\n    else if (msg._session) output[6] = ws(Object.assign({ type: 'command-result' }, error));\n    return output;\n}\n\n", '')
  .replace(
    "const timeout = item.target === 'heater' ? Number(cfg.commands && cfg.commands.heaterTimeoutSeconds || 180) : (item.target === 'indevoltGrid' ? 12 : Number(cfg.commands && cfg.commands.defaultTimeoutSeconds || 8));",
    "const timeout = item.target === 'heater' ? Number(cfg.commands && cfg.commands.heaterTimeoutSeconds || 180) : (item.target === 'orion' ? 15 : (item.target === 'indevoltGrid' ? 12 : Number(cfg.commands && cfg.commands.defaultTimeoutSeconds || 8)));"
  )
  .replace(
    'for (let index = 0; index < 4; index++) output[index] = [];',
    'for (const index of [0, 1, 2, 3, 9, 11]) output[index] = [];'
  )
  .replace(
    'for (let index = 0; index < 4; index++) if (!output[index].length) output[index] = null;',
    'for (const index of [0, 1, 2, 3, 9, 11]) if (!output[index].length) output[index] = null;'
  );

state.func = cleanEmbeddedDefaults(state.func)
  .replace(
    "const orionMode = sensor('orion.mode');\nconst orionState = sensor('orion.state');\nconst orionSeen = Math.max(seen('orion.mode'), seen('orion.state'), seen('orion.power'), seen('orion.voltage'));\nconst orionOnline = orionSeen > now - staleMs;\nconst orionStateNames = { 0: 'AUS', 2: 'FEHLER', 3: 'BULK', 4: 'ABSORPTION', 5: 'FLOAT', 6: 'STORAGE', 7: 'EQUALIZE', 11: 'NETZTEIL', 252: 'EXTERNE STEUERUNG' };",
    "const orionMode = sensor('orion.mode');\nconst orionState = sensor('orion.state');\nconst orionSeen = Math.max(seen('orion.mode'), seen('orion.state'), seen('orion.power'), seen('orion.voltage'));\nconst orionOnline = orionSeen > now - staleMs;\nconst orionModeNumber = orionMode == null || orionMode === '' ? null : Number(orionMode);\nconst orionStateNumber = orionState == null || orionState === '' ? null : Number(orionState);\nconst orionStateNames = { 2: 'FEHLER', 3: 'BULK', 4: 'ABSORPTION', 5: 'FLOAT', 6: 'STORAGE', 7: 'EQUALIZE', 11: 'NETZTEIL', 252: 'EXTERNE STEUERUNG' };\nconst orionStateText = !orionOnline ? 'NICHT VERFÜGBAR' : (orionModeNumber === 4 ? 'AUS' : (orionModeNumber === 1 && (orionStateNumber == null || orionStateNumber === 0) ? 'FREIGEGEBEN · WARTET' : (orionStateNames[orionStateNumber] || (orionModeNumber === 1 ? 'FREIGEGEBEN' : 'UNBEKANNT'))));"
  )
  .replace(
    "            on: Number(orionMode) === 1,\n            mode: orionMode,\n            state: orionState,\n            stateText: orionStateNames[Number(orionState)] || 'UNBEKANNT',",
    "            on: orionModeNumber === 1,\n            mode: orionMode,\n            state: orionState,\n            stateText: orionStateText,"
  )
  .replace("const stratificationDelta = ceilingTemperature.online && floorTemperature.online ? Math.round((ceilingTemperature.temp - floorTemperature.temp) * 10) / 10 : null;\nconst stratificationThreshold = Number(cfg.temperatureSensors && cfg.temperatureSensors.stratificationWarning || 4);\n", '')
  .replace("            stratification: { delta: stratificationDelta, threshold: stratificationThreshold, warning: stratificationDelta != null && Math.abs(stratificationDelta) >= stratificationThreshold },\n", '');

if (!state.func.includes('const externalWifiStatus =')) {
  state.func = replaceOnce(
    state.func,
    "const serviceStatus = flow.get('camperServiceStatus') || {};",
    `const serviceStatus = flow.get('camperServiceStatus') || {};
const externalWifiStatus = {
    available: Number(serviceStatus.external_wifi_available) === 1,
    enabled: Number(serviceStatus.external_wifi_enabled) === 1,
    state: String(serviceStatus.external_wifi_state || ''),
    signalStrength: serviceStatus.external_wifi_signal == null ? null : Number(serviceStatus.external_wifi_signal),
    connectedSsid: String(serviceStatus.external_wifi_ssid || serviceStatus.external_wifi_connected_ssid || ''),
    interface: String(serviceStatus.external_wifi_interface || ''),
    scanActive: Number(serviceStatus.external_wifi_scan_active) === 1,
    connectSupported: Number(serviceStatus.external_wifi_connect_supported) === 1,
    address: String(serviceStatus.external_wifi_address || ''),
    networks: Array.isArray(serviceStatus.external_wifi_networks) ? serviceStatus.external_wifi_networks : []
};`,
    'Strukturierter externer WLAN-Status'
  );
}
state.func = state.func.replace(
  "network: { configuredTopology: cfg.network && cfg.network.topology || 'cerbo-ap', cerboAddress: cfg.network && cfg.network.cerboAddress || '172.24.24.1' },",
  "network: { configuredTopology: cfg.network && cfg.network.topology || 'cerbo-ap', cerboAddress: cfg.network && cfg.network.cerboAddress || '172.24.24.1', externalWifi: externalWifiStatus },"
);

if (!state.func.includes('const quickAccessOptions = [];')) {
  state.func = replaceOnce(
    state.func,
    'const snapshot = {',
    `const quickAccessOptions = [];
const quickOptionById = {};
const addQuickOption = option => {
    if (!option || !option.id || quickOptionById[option.id]) return;
    const clean = {
        id: String(option.id), name: String(option.name || option.id), icon: String(option.icon || 'power'),
        group: String(option.group || 'System'), kind: String(option.kind || 'toggle')
    };
    quickAccessOptions.push(clean);
    quickOptionById[clean.id] = clean;
};
const quickLightIcons = {
    outside_front_white: 'lightbar', outside_front_amber: 'warningbar', inside_main: 'bulb',
    outside_right: 'right-light', outside_rear: 'down-light', outside_left: 'left-light'
};
for (const light of lights) addQuickOption({ id: 'light:' + light.id, name: light.name, icon: quickLightIcons[light.id] || 'bulb', group: 'Licht' });
const quickSwitchIcons = { dc_outlets_left: 'outlet', water_pump: 'pump', high_beam_manual: 'highbeam', dc_outlets_right: 'outlet', starlink: 'satellite', maxxfan_power: 'fan' };
for (const item of dcChannels) addQuickOption({ id: 'switch:' + item.id, name: item.name, icon: quickSwitchIcons[item.id] || 'plug', group: '12 V' });
addQuickOption({ id: 'device:inverter', name: 'MultiPlus 230 V', icon: 'plug', group: 'Geräte' });
addQuickOption({ id: 'device:orion', name: 'Orion XS', icon: 'battery', group: 'Geräte' });
addQuickOption({ id: 'device:indevolt_grid', name: 'INDEVOLT Stromzufuhr', icon: 'plug', group: 'Geräte' });
addQuickOption({ id: 'device:heater', name: cfg.devices.heaterName, icon: 'heater', group: 'Klima' });
addQuickOption({ id: 'device:maxxfan', name: cfg.devices.fanName, icon: 'fan', group: 'Klima' });
for (const scene of (cfg.scenes || []).filter(item => item.visible !== false)) addQuickOption({ id: 'scene:' + scene.id, name: scene.name, icon: 'home', group: 'Szenen', kind: 'action' });

const quickFallback = ['switch:water_pump', 'switch:starlink', 'switch:dc_outlets_left', 'light:inside_main'];
const quickAccessIds = cfg.ui && Array.isArray(cfg.ui.quickAccessIds) ? cfg.ui.quickAccessIds : quickFallback;
const quickAccess = quickAccessIds.map(id => {
    const option = quickOptionById[id];
    if (!option) return null;
    const result = Object.assign({ active: false, available: false, status: 'NICHT VERFÜGBAR', command: null }, option);
    if (id.indexOf('light:') === 0) {
        const light = lights.find(item => item.id === id.slice(6));
        if (!light) return result;
        result.active = light.on === true; result.available = light.online === true; result.status = result.active ? 'EIN' : 'AUS';
        result.command = { target: 'starpower', action: 'set', value: result.active ? 0 : 1, channel: Number(light.channel) };
    } else if (id.indexOf('switch:') === 0) {
        const item = dcChannels.find(entry => entry.id === id.slice(7));
        if (!item) return result;
        result.active = item.on === true; result.available = item.online === true;
        result.status = item.id === 'starlink' && result.active ? (starlinkOnline ? 'ONLINE' : 'VERBINDET') : (result.active ? 'EIN' : 'AUS');
        result.command = item.id === 'water_pump'
            ? { target: 'waterPump', action: 'set', value: !result.active }
            : { target: 'starpower', action: 'set', value: result.active ? 0 : 1, channel: Number(item.channel) };
    } else if (id === 'device:inverter') {
        result.active = inverterOn; result.available = multiOnline; result.status = result.active ? '230 V EIN' : 'AUS';
        result.command = { target: 'inverter', action: 'set', value: !result.active };
    } else if (id === 'device:orion') {
        result.active = orionModeNumber === 1; result.available = orionOnline; result.status = orionStateText;
        result.command = { target: 'orion', action: 'set', value: !result.active };
    } else if (id === 'device:indevolt_grid') {
        result.active = shellyGridOn; result.available = shellyGridOnline; result.status = result.active ? 'FREIGEGEBEN' : 'GETRENNT';
        result.command = { target: 'indevoltGrid', action: 'set', value: !result.active };
    } else if (id === 'device:heater') {
        result.active = heater.running === true || heater.cooling === true;
        result.available = heater.serialReady === true && heater.cooling !== true;
        result.status = heater.cooling ? 'NACHLAUF' : (heater.running ? 'HEIZT' : 'AUS');
        result.command = { target: 'heater', action: heater.running ? 'stop' : 'start', value: null };
    } else if (id === 'device:maxxfan') {
        const fanOnline = now - Number(adapterFan.seen || 0) <= staleMs;
        result.active = typeof adapterFan.on === 'boolean' ? adapterFan.on : Number(fanPowerChannel.state) === 1;
        result.available = fanOnline; result.status = result.active ? Math.round(Number(adapterFan.speed || 0)) + ' %' : 'AUS';
        result.command = { target: 'maxxfan', action: 'set', value: !result.active };
    } else if (id.indexOf('scene:') === 0) {
        const scene = (cfg.scenes || []).find(item => item.id === id.slice(6));
        result.available = Boolean(scene); result.status = scene ? 'STARTEN' : 'NICHT VERFÜGBAR';
        result.command = scene ? { target: 'scene', action: 'run', value: scene.id, sceneId: scene.id } : null;
    }
    return result;
}).filter(Boolean);

const snapshot = {`,
    'Aufgelöste generische Schnellzugriffe im Snapshot'
  );
}
if (state.func.includes('ui: { quickAccessLightIds:')) {
  state.func = state.func.replace(
    /ui: \{ quickAccessLightIds:[^\n]+\},/,
    "ui: { quickAccessIds, quickAccess, quickAccessOptions, externalWifiTileEnabled: !(cfg.ui && cfg.ui.externalWifiTileEnabled === false) },"
  );
}

const settingsUi = get('aec5cc044fa2963f');
settingsUi.format = String(settingsUi.format || '')
  .replace(
    'Die höchste Linux-Thermal-Zone des Cerbo steuert Relais 1 (Zuluft) und Relais 2 (Abluft).',
    'Die höchste Linux-Thermal-Zone des Cerbo steuert Relais 1 (Abluft) und Relais 2 (Zuluft).'
  )
  .replace(
    '<label><input type="checkbox" v-model="cfg.ventilation.enabled" @change="saveVentilation"> CPU-Lüftung aktiv</label>',
    '<label><input type="checkbox" v-model="cfg.ventilation.enabled" @change="saveVentilation"> CPU-Automatik aktiv</label><label><input type="checkbox" v-model="cfg.ventilation.manualOn" @change="saveVentilation"> Lüfter manuell dauerhaft EIN</label>'
  )
  .replace('Relais 1 Zuluft · Relais 2 Abluft', 'Relais 1 Abluft · Relais 2 Zuluft')
  .replace(
    'Die Sicherung enthält Namen, Anordnung, Zuordnungen, Szenen und Wartungsplan. Der API-Token wird aus Sicherheitsgründen nicht exportiert und beim Import beibehalten.',
    'Die Sicherung enthält Namen, Anordnung, Zuordnungen, Szenen und Wartungsplan.'
  )
  .replace(
    '<section class="security"><h2>Lokale API</h2><p>HTTP- und WebSocket-Zustände, Einstellungen und Befehle sind im lokalen Cerbo-/Starlink-Netz ohne Token und ohne Anfragebegrenzung verfügbar. Node-RED nicht per Portweiterleitung ins Internet freigeben; Fernzugriff nur per VPN oder Victron-Diensten.</p></section>',
    '<section class="local-access"><h2>Lokaler Zugriff</h2><p>HTTP- und WebSocket-Zustände, Einstellungen und Befehle sind im lokalen Cerbo-/Starlink-Netz frei verfügbar. Node-RED nicht per Portweiterleitung ins Internet freigeben; Fernzugriff nur per VPN oder Victron-Diensten.</p></section>'
  )
  .replace("network:{},commands:{},history:{},security:{}},persistent:false,notice:'',apiToken:'',lastBackupId:''", "network:{},commands:{},history:{},access:{}},persistent:false,notice:'',lastBackupId:''")
  .replace(",saveToken(){this.patch({security:{apiToken:this.apiToken}});this.apiToken=''}", '')
  .replace(/\.security p\{/g, '.local-access p{')
  .replace(/\.security label\{/g, '.local-access label{');

for (const node of flows) {
  if (typeof node.func === 'string') node.func = cleanEmbeddedDefaults(node.func);
}

const forbidden = ['apiToken', 'x-camper-token', 'tokenConfigured', 'allowReadWithoutToken', 'unauthorized', 'stratificationWarning', 'stratification:'];
const leftovers = flows.filter(node => forbidden.some(term => JSON.stringify(node).includes(term)));
if (leftovers.length) throw new Error('Legacy-Felder verbleiben in Nodes: ' + leftovers.map(node => node.id).join(', '));

fs.writeFileSync(sourcePath, JSON.stringify(flows, null, 2) + '\n');
fs.writeFileSync(publicPath, JSON.stringify(flows, null, 2) + '\n');
console.log(JSON.stringify({
  sourcePath,
  publicPath,
  nodes: flows.length,
  dashboardBytes: dashboard.length,
  ruuvi: 'fixed native com.victronenergy.temperature/24 · no discovery',
  serviceStatus: '60 s / process mutex',
  shelly: 'com.victronenergy.acload/50 /SwitchableOutput/0/State',
  orion: 'native com.victronenergy.alternator/289 · /Mode (1/4)',
  externalWifi: 'Victron platform status/scan + loopback ConnMan helper'
}, null, 2));
