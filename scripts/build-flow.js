import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const sourcePath = path.join(root, 'flows', 'CamperControl_NodeRED.json');
const dashboardPath = path.join(root, 'dashboard', 'camper-dashboard.html');
const dashboardV2MarkupPath = path.join(root, 'dashboard', 'camper-dashboard-v2.html');
const dashboardV2CssPath = path.join(root, 'dashboard', 'camper-dashboard-v2.css');
const transitDarkPath = path.join(root, 'dashboard', 'assets', 'transit-line-symbol-dark.png');
const transitLightPath = path.join(root, 'dashboard', 'assets', 'transit-line-symbol-light.png');
const publicPath = path.join(root, 'dist', 'CamperControl_NodeRED.json');
fs.mkdirSync(path.dirname(publicPath), { recursive: true });
const tabId = 'b7be72c8b69bf30e';
const dashboardId = 'dec0785f657dc7d1';

let flows = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const dashboardTemplate = fs.readFileSync(dashboardPath, 'utf8');
const transitDataUri = filePath => `data:image/png;base64,${fs.readFileSync(filePath).toString('base64')}`;
const injectTransitAssets = source => source
  .replace('__CC2_TRANSIT_DARK_DATA_URI__', transitDataUri(transitDarkPath))
  .replace('__CC2_TRANSIT_LIGHT_DATA_URI__', transitDataUri(transitLightPath));
const dashboardV2Markup = injectTransitAssets(fs.readFileSync(dashboardV2MarkupPath, 'utf8')).trim();
const dashboardV2Css = fs.readFileSync(dashboardV2CssPath, 'utf8').trim();
const composeDashboard = () => {
  const markupToken = '<!-- CAMPERCONTROL_V2_MARKUP -->';
  const cssToken = '/* CAMPERCONTROL_V2_CSS */';
  if (dashboardTemplate.split(markupToken).length !== 2) throw new Error('V2-Markup-Platzhalter muss genau einmal vorkommen');
  if (dashboardTemplate.split(cssToken).length !== 2) throw new Error('V2-CSS-Platzhalter muss genau einmal vorkommen');
  return dashboardTemplate.replace(markupToken, dashboardV2Markup).replace(cssToken, dashboardV2Css);
};
const dashboard = composeDashboard();
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
  onlyChanges: true,
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

// Das Dashboard wird deterministisch aus dem V1/SFC-Rahmen und den separaten
// Transit-Horizon-V2-Fragmenten zusammengesetzt. Detailseiten behalten die
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

// Node-RED may persist context values to disk. Native Timeout objects are
// circular, non-serialisable handles and must therefore never be stored in
// context/flow/global. A 100/150 ms Trigger still allowed the large snapshot
// aggregator to run 6-10 times per second under a continuous Victron event
// stream. Both hot feedback paths therefore use the core Delay node as a
// one-message-per-second rate gate and drop intermediate ticks. The
// normalisers have already stored the newest state before this point, so the
// next emitted tick always samples current values without queue growth.
const configureSnapshotRateLimit = (id, name, rate = '1') => {
  const node = get(id);
  for (const key of ['func', 'noerr', 'initialize', 'finalize', 'libs', 'op1', 'op2', 'op1type', 'op2type', 'duration', 'extend', 'overrideDelay', 'reset', 'bytopic', 'topic']) delete node[key];
  Object.assign(node, {
    type: 'delay',
    name,
    pauseType: 'rate',
    timeout: '1',
    timeoutUnits: 'seconds',
    rate,
    nbRateUnits: '1',
    rateUnits: 'second',
    randomFirst: '1',
    randomLast: '5',
    randomUnits: 'seconds',
    drop: true,
    allowrate: false,
    outputs: 1
  });
};
configureSnapshotRateLimit('d36a1adac492ce3e', 'STAR-Power Snapshot maximal 1/s');
configureSnapshotRateLimit('cff2c4d32221ccd8', 'Gesamt-Snapshot maximal 2/s', '2');

// Dieses Fahrzeug besitzt keinen Abwassertanksensor. Die beiden alten,
// ungenutzten Eingänge werden count-neutral durch den zentralen Wetterpfad
// ersetzt. Der Provider gehört dem CamperControl-D-Bus-Dienst; Node-RED liest
// ausschließlich dessen kompakten, changed-only JSON-Zustand.
removeIds(['ad733d7d09846816', 'feb53f815117a12b', 'weather_state_in', 'weather_state_validate']);
add({
  id: 'weather_state_in', type: 'victron-input-custom', z: tabId,
  service: 'com.victronenergy.campercontrol/0', path: '/State/Weather',
  serviceObj: { service: 'com.victronenergy.campercontrol/0', name: 'CamperControl bridge' },
  pathObj: { path: '/State/Weather', type: 'string', name: '/State/Weather' },
  name: 'Wetter · CamperControl D-Bus', onlyChanges: true, roundValues: '3',
  x: 230, y: 3420, wires: [['weather_state_validate']]
});
add({
  id: 'weather_state_validate', type: 'function', z: tabId,
  name: 'Wetter-JSON prüfen & übernehmen', outputs: 1, timeout: 0, noerr: 0,
  initialize: '', finalize: '', libs: [], x: 555, y: 3420,
  wires: [['ada9353cc6ea4a4c']],
  func: String.raw`
const MAX_BYTES = 16 * 1024;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const unwrap = value => value && typeof value === 'object' && own(value, 'value') ? value.value : value;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value, max, optional = false) => optional && value == null ? null : (typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined);
const number = (value, min, max) => value == null ? null : (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : undefined);
const required = (object, key, parser) => own(object, key) ? parser(object[key]) : undefined;
const timestamp = (value, optional = false) => {
    if (optional && value == null) return null;
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : undefined;
};
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) ? value : undefined;
const reject = reason => { node.status({ fill: 'red', shape: 'ring', text: String(reason).slice(0, 32) }); return null; };
let raw = unwrap(msg.payload);
if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_BYTES) return reject('JSON fehlt oder >16 KiB');
let source;
try { source = JSON.parse(raw); } catch (error) { return reject('ungültiges JSON'); }
if (!object(source) || source.schema !== 1 || !Array.isArray(source.hourly) || source.hourly.length > 48 || !Array.isArray(source.daily) || source.daily.length > 6) return reject('Schema oder Länge ungültig');
if (!object(source.station) || !object(source.sun)) return reject('Metadaten fehlen');
const station = { id: required(source.station, 'id', value => string(value, 32)), name: required(source.station, 'name', value => string(value, 160)) };
const sun = { date: required(source.sun, 'date', date), riseUtc: required(source.sun, 'riseUtc', value => timestamp(value, true)), setUtc: required(source.sun, 'setUtc', value => timestamp(value, true)), origin: required(source.sun, 'origin', value => string(value, 32)) };
const hourly = source.hourly.map(item => object(item) ? {
    t: required(item, 't', timestamp), tempC: required(item, 'tempC', value => number(value, -90, 70)), precipProbabilityPct: required(item, 'precipProbabilityPct', value => number(value, 0, 100)),
    precipMm: required(item, 'precipMm', value => number(value, 0, 500)), ww: required(item, 'ww', value => number(value, 0, 999)), icon: required(item, 'icon', value => string(value, 32)),
    windKmh: required(item, 'windKmh', value => number(value, 0, 500)), windDeg: required(item, 'windDeg', value => number(value, 0, 360)), gustKmh: required(item, 'gustKmh', value => number(value, 0, 500))
} : null);
const daily = source.daily.map(item => object(item) ? {
    date: required(item, 'date', date), minC: required(item, 'minC', value => number(value, -90, 70)), maxC: required(item, 'maxC', value => number(value, -90, 70)), precipMm: required(item, 'precipMm', value => number(value, 0, 5000)),
    maxHourlyPrecipProbabilityPct: required(item, 'maxHourlyPrecipProbabilityPct', value => number(value, 0, 100)), ww: required(item, 'ww', value => number(value, 0, 999)), icon: required(item, 'icon', value => string(value, 32)),
    windMaxKmh: required(item, 'windMaxKmh', value => number(value, 0, 500)), gustMaxKmh: required(item, 'gustMaxKmh', value => number(value, 0, 500)), riseUtc: required(item, 'riseUtc', value => timestamp(value, true)), setUtc: required(item, 'setUtc', value => timestamp(value, true))
} : null);
const validValues = value => object(value) && !Object.values(value).some(item => typeof item === 'undefined');
if (!validValues(station) || !validValues(sun) || !hourly.every(validValues) || !daily.every(validValues)) return reject('Wetterfeld ungültig');
let tides;
if (own(source, 'tides') && source.tides != null) {
    const tideSource = source.tides;
    const tideStation = object(tideSource) && object(tideSource.station) ? {
        id: required(tideSource.station, 'id', value => string(value, 64)),
        name: required(tideSource.station, 'name', value => string(value, 160)),
        distanceKm: required(tideSource.station, 'distanceKm', value => number(value, 0, 60))
    } : null;
    const tideEvent = item => object(item) ? {
        t: required(item, 't', timestamp),
        heightM: required(item, 'heightM', value => number(value, -200, 200))
    } : null;
    let tideCurve;
    let tideCurveValid = true;
    if (object(tideSource) && own(tideSource, 'curve')) {
        tideCurveValid = Array.isArray(tideSource.curve) && tideSource.curve.length >= 2 && tideSource.curve.length <= 25;
        if (tideCurveValid) {
            tideCurve = tideSource.curve.map(item => object(item) ? {
                t: required(item, 't', timestamp),
                heightM: required(item, 'heightM', value => number(value, -200, 200, false))
            } : null);
            tideCurveValid = tideCurve.every(item => validValues(item) && Number.isFinite(item.heightM)) && tideCurve.every((item, index) => index === 0 || Date.parse(item.t) > Date.parse(tideCurve[index - 1].t));
        }
    }
    const candidate = object(tideSource) ? {
        source: required(tideSource, 'source', value => value === 'BSH' ? value : undefined),
        attribution: required(tideSource, 'attribution', value => string(value, 256)),
        station: tideStation,
        updatedUtc: required(tideSource, 'updatedUtc', timestamp),
        stale: tideSource.stale,
        referenceLevel: required(tideSource, 'referenceLevel', value => value === 'PNP' ? value : undefined),
        nextHigh: tideEvent(tideSource.nextHigh),
        nextLow: tideEvent(tideSource.nextLow)
    } : null;
    if (candidate && tideCurve !== undefined) candidate.curve = tideCurve;
    if (tideCurveValid && validValues(candidate) && validValues(tideStation) && validValues(candidate.nextHigh) && validValues(candidate.nextLow) && typeof candidate.stale === 'boolean') tides = candidate;
}
const weather = {
    schema: 1, source: required(source, 'source', value => string(value, 128)), attribution: required(source, 'attribution', value => string(value, 256)), station,
    modelRunUtc: required(source, 'modelRunUtc', value => timestamp(value, true)), fetchedAtUtc: required(source, 'fetchedAtUtc', timestamp), stale: source.stale,
    timezone: required(source, 'timezone', value => string(value, 64)), sun, hourly, daily
};
if (tides) weather.tides = tides;
if (!validValues(weather) || typeof weather.stale !== 'boolean') return reject('Metadaten ungültig');
const canonical = JSON.stringify(weather);
if (Buffer.byteLength(canonical, 'utf8') > MAX_BYTES) return reject('normalisiert >16 KiB');
let previousJson = '';
try { const previous = flow.get('camperWeather'); previousJson = previous ? JSON.stringify(previous) : ''; } catch (error) {}
if (previousJson === canonical) return null;
flow.set('camperWeather', weather);
node.status({ fill: weather.stale ? 'yellow' : 'green', shape: 'dot', text: hourly.length + ' h · ' + daily.length + ' d' });
return { topic: 'weather', payload: weather };
`
});

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
  const input = nativeInput(`orion_${field}_in`, `Orion XS · ${pathValue}`, 'com.victronenergy.alternator/289', pathValue, 'number', y, `orion_${field}_topic`);
  // /Mode ist ein gelatchter Steuerzustand und ändert sich im Normalbetrieb
  // minuten- oder stundenlang nicht. Wiederholte/initiale Werte dürfen deshalb
  // nicht vom Input-Node verworfen werden; die Aggregation koppelt den zuletzt
  // validierten Wert zusätzlich an frische Orion-Telemetrie.
  if (field === 'mode') input.onlyChanges = false;
  add(input);
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
warningController.outputs = 2;
warningController.wires = [['6a22df3c7ebe02fc'], ['199eabbda79b02de']];
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
const cancelClock = () => ({ topic: 'front-warning-clock', reset: true });
const scheduleClock = () => ({ topic: 'front-warning-clock', payload: '' });

if (msg.topic === 'front-warning-reset' || msg.topic === 'init') {
    warning = {
        active: false, phase: false, pending: false,
        intervalMs: INTERVAL_MS, startedAt: 0,
        lastCommandAt: Date.now(), lastAckAt: 0
    };
    flow.set('frontWarningBlink', warning);
    // Sicherer Startzustand nur für CH 8; CH 11 bleibt unangetastet. Das
    // originale init erreicht zusätzlich den STAR-Power-Dashboardzustand.
    const output = [physical(WARNING_CHANNEL, 0)];
    if (msg.topic === 'init') output.push(msg);
    return [output, cancelClock()];
}

if (msg.topic === 'front-warning-clock') {
    if (warning.active !== true || warning.pending === true) return null;
    warning.phase = warning.phase !== true;
    warning.pending = true;
    warning.lastCommandAt = Date.now();
    flow.set('frontWarningBlink', warning);
    // Genau ein physischer Pfad: STAR-Power CH 8 State.
    return [physical(WARNING_CHANNEL, warning.phase ? 1 : 0), null];
}

if (msg.topic === 'state:8') {
    const feedback = Number(msg.payload);
    const expected = warning.phase ? 1 : 0;
    if (warning.active && warning.pending && (feedback === 0 || feedback === 1) && feedback === expected) {
        warning.pending = false;
        warning.lastAckAt = Date.now();
        flow.set('frontWarningBlink', warning);
        return [msg, scheduleClock()];
    }
    // Rückmeldung zusätzlich an die normale STAR-Power-Auswertung geben.
    return [msg, null];
}

if (msg.topic !== 'ui' || !msg.payload || typeof msg.payload !== 'object') return [msg, null];
const action = msg.payload;
const channel = Number(action.channel);

if (action.action === 'toggle' && channel === WARNING_CHANNEL && action._warningPhysical !== true) {
    const enabled = Number(action.value) === 1;
    warning.active = enabled;
    warning.phase = enabled;
    warning.pending = enabled;
    warning.startedAt = enabled ? Date.now() : 0;
    warning.lastCommandAt = Date.now();
    flow.set('frontWarningBlink', warning);
    const messages = [];
    if (enabled) messages.push(physical(WHITE_CHANNEL, 0));
    messages.push(physical(WARNING_CHANNEL, enabled ? 1 : 0));
    return [messages, cancelClock()];
}

if (action.action === 'toggle' && channel === WHITE_CHANNEL && Number(action.value) === 1 && action._warningPhysical !== true) {
    warning.active = false;
    warning.phase = false;
    warning.pending = false;
    warning.startedAt = 0;
    warning.lastCommandAt = Date.now();
    flow.set('frontWarningBlink', warning);
    return [[physical(WARNING_CHANNEL, 0), msg], cancelClock()];
}

// Warnlicht ist absichtlich nicht dimmbar. Auch ein veralteter Client darf
// niemals einen CH-8-Dimming-Befehl oder einen anderen Kanal ansteuern.
if (action.action === 'dim' && channel === WARNING_CHANNEL) return null;
return [msg, null];
`;
warningController.initialize = "flow.set('frontWarningBlink', { active: false, phase: false, pending: false, intervalMs: 500, startedAt: 0, lastCommandAt: Date.now(), lastAckAt: 0 });";
warningController.finalize = "flow.set('frontWarningBlink', { active: false, phase: false, pending: false, intervalMs: 500, startedAt: 0, lastCommandAt: Date.now(), lastAckAt: 0 });";
const warningClock = get('199eabbda79b02de');
for (const key of ['props', 'repeat', 'crontab', 'once', 'onceDelay', 'topic']) delete warningClock[key];
Object.assign(warningClock, {
  type: 'trigger',
  name: 'Warnlicht · nächster Takt nach 500 ms',
  op1: '',
  op2: '',
  op1type: 'nul',
  op2type: 'str',
  duration: '500',
  extend: false,
  overrideDelay: false,
  units: 'ms',
  reset: '',
  bytopic: 'all',
  topic: 'topic',
  outputs: 1,
  wires: [['e0809a11d6ca3b34']]
});
// Der bestehende Dashboard-Init übernimmt zugleich den sicheren AUS-Befehl;
// die Trigger-Node bleibt dadurch ausschließlich der serielle 500-ms-Takt.
get('86d942fcb177ccae').onceDelay = 0.2;
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
    const next = unwrap(msg.payload);
    let encoded = '';
    try { encoded = typeof next === 'string' ? next : JSON.stringify(next); } catch (error) { return null; }
    if (Buffer.byteLength(encoded, 'utf8') > 64 * 1024) return null;
    raw[field] = next;
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
entries = entries.slice(0, 64);
const pick = (object, keys, fallback = '') => {
    for (const key of keys) if (object && object[key] != null) return unwrap(object[key]);
    return fallback;
};
const bool = value => value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true' || String(value).toLowerCase() === 'yes';
const networks = [];
for (const [entryKey, value] of entries) {
    if (!value || typeof value !== 'object') continue;
    const service = String(pick(value, ['Service', 'service', 'Path', 'path'], entryKey)).slice(0, 512);
    const type = String(pick(value, ['Type', 'type', 'Technology', 'technology'], '')).toLowerCase().slice(0, 32);
    if (type && !type.includes('wifi') && !type.includes('wireless')) continue;
    if (!type && !/wifi|wireless|wlan/i.test(service)) continue;
    const ssid = String(pick(value, ['Name', 'name', 'SSID', 'ssid'], /^\/net\//.test(entryKey) ? '' : entryKey)).trim().slice(0, 128);
    if (!ssid) continue;
    const state = String(pick(value, ['State', 'state'], '')).toLowerCase().slice(0, 32);
    const securedRaw = pick(value, ['Secured', 'secured'], null);
    const securityRaw = pick(value, ['Security', 'security'], '');
    const security = Array.isArray(securityRaw) ? securityRaw.join(',') : String(securityRaw || '');
    const strengthValue = Number(pick(value, ['Strength', 'strength', 'SignalStrength', 'signalStrength'], NaN));
    const ipv4 = pick(value, ['Ipv4', 'IPv4', 'ipv4'], {});
    const address = String(pick(ipv4, ['Address', 'address'], pick(value, ['Address', 'address'], '')) || '').slice(0, 64);
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
const climateAutomationController = get('ec5c5c0618d69359');
if (!state.func.includes('externalWifiTileEnabled')) {
  state.func = replaceOnce(
    state.func,
    "    ui: { quickAccessLightIds: cfg.ui && Array.isArray(cfg.ui.quickAccessLightIds) ? cfg.ui.quickAccessLightIds : ['outside_front_white','outside_front_amber','inside_main','outside_right'] },",
    "    ui: { quickAccessLightIds: cfg.ui && Array.isArray(cfg.ui.quickAccessLightIds) ? cfg.ui.quickAccessLightIds : ['outside_front_white','outside_front_amber','inside_main','outside_right'], externalWifiTileEnabled: !(cfg.ui && cfg.ui.externalWifiTileEnabled === false) },",
    'WLAN-Kachel im Snapshot'
  );
}
if (state.func.includes('Number(victronSolar || 0) + Number(indevoltSolar || 0)')) {
  state.func = replaceOnce(
    state.func,
    'totalSolarPower: (victronSolar == null && indevoltSolar == null) ? null : Number(victronSolar || 0) + Number(indevoltSolar || 0)',
    'totalSolarPower: victronSolar == null ? null : Number(victronSolar)',
    'Solar gesamt ausschließlich aus Victron /Dc/Pv/Power'
  );
}

// Batterie-Details behalten bewusst den direkten SmartShunt-Messwert. Die
// originale gui-v2-Kachel "DC Loads" liest davon getrennt
// com.victronenergy.system /Dc/System/Power (Global.system.dc.power). Fuer
// denselben Wert wird das nicht vorhandene Abwasser-/Remaining-Eingangspaar
// count-neutral wiederverwendet; dieses Fahrzeug besitzt keinen Abwassertank.
const batteryPowerInput = get('ec2c675c3d08f88c');
Object.assign(batteryPowerInput, {
  type: 'victron-input-battery',
  service: 'com.victronenergy.battery/277',
  path: '/Dc/0/Power',
  serviceObj: { service: 'com.victronenergy.battery/277', name: 'SmartShunt 500A/50mV' },
  pathObj: { path: '/Dc/0/Power', type: 'number', name: '/Dc/0/Power' },
  name: 'SmartShunt Leistung'
});
const dcSystemPowerInput = get('6b67bafd0f8833d1');
Object.assign(dcSystemPowerInput, {
  type: 'victron-input-system',
  service: 'com.victronenergy.system',
  path: '/Dc/System/Power',
  serviceObj: { service: 'com.victronenergy.system', name: 'Venus system' },
  pathObj: { path: '/Dc/System/Power', type: 'number', name: '/Dc/System/Power' },
  name: 'Victron DC-Verbrauch gesamt'
});
const dcSystemPowerTopic = get('d097a007d7fe4bbb');
dcSystemPowerTopic.name = '→ dc.system.power';
const dcSystemTopicRule = dcSystemPowerTopic.rules.find(rule => rule.t === 'set' && rule.p === 'topic');
if (!dcSystemTopicRule) throw new Error('Topic-Regel fuer DC-Systemleistung fehlt');
dcSystemTopicRule.to = 'dc.system.power';
if (!state.func.includes("const dcSystemPower = sensor('dc.system.power');")) {
  state.func = replaceOnce(
    state.func,
    "const victronSolar = sensor('solar.total.power');",
    "const victronSolar = sensor('solar.total.power');\nconst dcSystemPower = sensor('dc.system.power');",
    'DC-Systemleistung aus originalem gui-v2-Pfad'
  );
}
if (!state.func.includes('        dcSystemPower,')) {
  state.func = replaceOnce(
    state.func,
    "    energy: {\n        name: cardName('energy'),\n        battery:",
    "    energy: {\n        name: cardName('energy'),\n        dcSystemPower,\n        battery:",
    'DC-Systemleistung im zentralen Snapshot'
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
    const genericFavoriteFallback = ['switch:water_pump', 'device:inverter', 'device:heater', 'device:maxxfan'];
    const genericQuick = value.ui && Array.isArray(value.ui.quickAccessIds) ? value.ui.quickAccessIds : null;
    const genericFavorites = value.ui && Array.isArray(value.ui.favoriteIds) ? value.ui.favoriteIds : null;
    const legacyQuick = value.ui && Array.isArray(value.ui.quickAccessLightIds)
      ? value.ui.quickAccessLightIds.map(id => id === 'high_beam' ? 'switch:high_beam_manual' : 'light:' + id)
      : null;
    value.version = 5;
    value.ui = {
      quickAccessIds: genericQuick || legacyQuick || genericQuickFallback,
      favoriteIds: genericFavorites || genericFavoriteFallback,
      externalWifiTileEnabled: !(value.ui && value.ui.externalWifiTileEnabled === false)
    };
    value.lightingScenes = Object.assign({
      camping: { inside_main: 70 },
      night: {
        inside_main: 15,
        outside_front_white: 0,
        outside_front_amber: 0,
        outside_right: 0,
        outside_rear: 0,
        outside_left: 0
      },
      all_off: {
        inside_main: 0,
        outside_front_white: 0,
        outside_front_amber: 0,
        outside_right: 0,
        outside_rear: 0,
        outside_left: 0
      }
    }, value.lightingScenes || {});
    delete value.security;
    value.access = { scope: 'local-network', unrestricted: true };
    value.temperatureSensors = Object.assign({}, value.temperatureSensors || {}, {
      ceilingService: 'com.victronenergy.temperature/24',
      floorService: ''
    });
    const legacyClimateAutomation = value.climateAutomation || {};
    const climateControlMode = ['off', 'manual', 'auto'].includes(legacyClimateAutomation.controlMode)
      ? legacyClimateAutomation.controlMode
      : (legacyClimateAutomation.enabled === true ? 'auto' : 'manual');
    value.climateAutomation = Object.assign({}, legacyClimateAutomation, {
      controlMode: climateControlMode,
      enabled: climateControlMode === 'auto'
    });
    value.ventilation = Object.assign({}, value.ventilation || {}, {
      enabled: true,
      manualOn: false,
      onTemperature: Number(value.ventilation?.onTemperature || 65),
      hysteresis: Number(value.ventilation?.hysteresis || 5),
      supplyRelay: 2,
      exhaustRelay: 1
    });
    // Hard upper bounds keep the persistent history below 4,685 points:
    // one detailed day, one month of trends and one year of daily values.
    value.history = { minuteHours: 24, quarterDays: 30, dailyDays: 365 };
    delete value.temperatureSensors.stratificationWarning;
    return prefix + JSON.stringify(value) + suffix;
  }
);

// Venus OS exposes its persistent localfilesystem context as the default
// store. Older flow revisions addressed a non-existent store named "file",
// which caused warnings and repeated fallback writes. Preserve persistence by
// using the configured default store without naming an unavailable backend.
const useDefaultContextStore = source => source
  .replace(
    /(\b(?:context|flow|global)\.(?:get|set)\([^\n;]*?),\s*(['"])file\2\s*\)/g,
    '$1)'
  )
  // Nach dem Entfernen des nicht vorhandenen Stores darf der frühere
  // Fallback nicht denselben persistenten Default-Schreibvorgang ein zweites
  // Mal ausführen. Das vermeidet doppelte Flash-Writes pro Änderung.
  .replace(
    /^([ \t]*)(context|flow|global)\.set\(([^;\r\n]+)\);\r?\n[ \t]*try \{ \2\.set\(\3\); \} catch \([^\r\n)]+\) \{\}\r?$/gm,
    '$1$2.set($3);'
  );

settings.func = cleanEmbeddedDefaults(settings.func)
  .replace(
    /minuteHours: Math\.round\(number\(cfg\.history && cfg\.history\.minuteHours, \d+, 1, \d+\)\)/,
    'minuteHours: Math.round(number(cfg.history && cfg.history.minuteHours, 24, 1, 24))'
  )
  .replace(
    /quarterDays: Math\.round\(number\(cfg\.history && cfg\.history\.quarterDays, \d+, 7, \d+\)\)/,
    'quarterDays: Math.round(number(cfg.history && cfg.history.quarterDays, 30, 7, 30))'
  )
  .replace(
    /dailyDays: Math\.round\(number\(cfg\.history && cfg\.history\.dailyDays, \d+, 30, \d+\)\)/,
    'dailyDays: Math.round(number(cfg.history && cfg.history.dailyDays, 365, 30, 365))'
  )
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
  )
  .replace(
    "    cfg.ui = { quickAccessIds, externalWifiTileEnabled: boolean(cfg.ui && cfg.ui.externalWifiTileEnabled, true), designVersion: cfg.ui && cfg.ui.designVersion === 'v1' ? 'v1' : 'v2' };",
    "    cfg.ui = { quickAccessIds, externalWifiTileEnabled: boolean(cfg.ui && cfg.ui.externalWifiTileEnabled, true) };"
  );

if (!settings.func.includes('delete source.ui.designVersion;')) {
  settings.func = settings.func.replace(
    '    delete source.ui.quickAccessLightIds;',
    '    delete source.ui.quickAccessLightIds;\n    delete source.ui.designVersion;'
  );
}

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

if (!settings.func.includes("const favoriteFallback = ['switch:water_pump'")) {
  settings.func = replaceOnce(
    settings.func,
    `    const quickSeen = new Set();
    const quickSource = cfg.ui && Array.isArray(cfg.ui.quickAccessIds) ? cfg.ui.quickAccessIds : quickFallback;
    const quickAccessIds = quickSource.map(value => String(value)).filter(id => quickAllowed.has(id) && !quickSeen.has(id) && quickSeen.add(id)).slice(0, 4);
    for (const id of quickFallback) if (quickAccessIds.length < 4 && quickAllowed.has(id) && !quickSeen.has(id)) { quickSeen.add(id); quickAccessIds.push(id); }
    cfg.ui = { quickAccessIds, externalWifiTileEnabled: boolean(cfg.ui && cfg.ui.externalWifiTileEnabled, true) };`,
    `    const quickSeen = new Set();
    const quickSource = cfg.ui && Array.isArray(cfg.ui.quickAccessIds) ? cfg.ui.quickAccessIds : quickFallback;
    const quickAccessIds = quickSource.map(value => String(value)).filter(id => quickAllowed.has(id) && !quickSeen.has(id) && quickSeen.add(id)).slice(0, 4);
    for (const id of quickFallback) if (quickAccessIds.length < 4 && quickAllowed.has(id) && !quickSeen.has(id)) { quickSeen.add(id); quickAccessIds.push(id); }
    const favoriteFallback = ['switch:water_pump', 'device:inverter', 'device:heater', 'device:maxxfan'];
    const favoriteConfigured = source.ui && Array.isArray(source.ui.favoriteIds);
    const favoriteSource = favoriteConfigured ? cfg.ui.favoriteIds : favoriteFallback;
    const favoriteSeen = new Set();
    const favoriteIds = favoriteSource.map(value => String(value)).filter(id => quickAllowed.has(id) && !favoriteSeen.has(id) && favoriteSeen.add(id)).slice(0, 4);
    cfg.ui = { quickAccessIds, favoriteIds, externalWifiTileEnabled: boolean(cfg.ui && cfg.ui.externalWifiTileEnabled, true) };`,
    'Eigenständige Favoriten-Konfiguration'
  );
}

if (!settings.func.includes('const sanitizeLightingScene = sceneId =>')) {
  settings.func = replaceOnce(
    settings.func,
    '    if (!cfg.scenes.length) cfg.scenes = clone(DEFAULTS.scenes);',
    `    if (!cfg.scenes.length) cfg.scenes = clone(DEFAULTS.scenes);
    // Camping und Nacht besitzen ein eigenes, benutzerfreundlich editierbares
    // Lichtprofil. Fehlende Einträge bedeuten bewusst "unverändert". So
    // bleiben bestehende Pumpen-/Lüfteraktionen der generischen Szene erhalten.
    const configuredLightingScenes = object(cfg.lightingScenes) ? cfg.lightingScenes : {};
    const defaultLightingScenes = object(DEFAULTS.lightingScenes) ? DEFAULTS.lightingScenes : {};
    const lightById = new Map(cfg.lights.map(light => [light.id, light]));
    const sanitizeLightingScene = sceneId => {
        const sourceProfile = object(configuredLightingScenes[sceneId]) ? configuredLightingScenes[sceneId] : defaultLightingScenes[sceneId];
        const profile = {};
        if (!object(sourceProfile)) return profile;
        for (const [lightId, rawValue] of Object.entries(sourceProfile).slice(0, 12)) {
            const light = lightById.get(String(lightId));
            const value = Number(rawValue);
            if (!light || !Number.isFinite(value)) continue;
            const bounded = Math.max(0, Math.min(100, Math.round(value)));
            profile[light.id] = light.dimmable === false ? (bounded > 0 ? 100 : 0) : bounded;
        }
        return profile;
    };
    cfg.lightingScenes = {
        camping: sanitizeLightingScene('camping'),
        night: sanitizeLightingScene('night'),
        all_off: sanitizeLightingScene('all_off')
    };`,
    'Validierte Lichtprofile für Camping und Nacht'
  );
}
settings.func = settings.func.replace(
  `    cfg.lightingScenes = {
        camping: sanitizeLightingScene('camping'),
        night: sanitizeLightingScene('night')
    };`,
  `    cfg.lightingScenes = {
        camping: sanitizeLightingScene('camping'),
        night: sanitizeLightingScene('night'),
        all_off: sanitizeLightingScene('all_off')
    };`
);

if (!settings.func.includes('const sourceClimateAutomation = object(source.climateAutomation)')) {
  settings.func = replaceOnce(
    settings.func,
    `    cfg.climateAutomation = {
        enabled: boolean(cfg.climateAutomation && cfg.climateAutomation.enabled, false),
        mode: ['auto', 'heat', 'cool'].includes(cfg.climateAutomation && cfg.climateAutomation.mode) ? cfg.climateAutomation.mode : 'auto',
        targetTemperature: number(cfg.climateAutomation && cfg.climateAutomation.targetTemperature, 22, 10, 30),
        hysteresis: number(cfg.climateAutomation && cfg.climateAutomation.hysteresis, 1, 0.5, 5),
        fanSpeed: Math.round(number(cfg.climateAutomation && cfg.climateAutomation.fanSpeed, 50, 10, 100))
    };`,
    `    const sourceClimateAutomation = object(source.climateAutomation) ? source.climateAutomation : {};
    const climateControlMode = ['off', 'manual', 'auto'].includes(sourceClimateAutomation.controlMode)
        ? sourceClimateAutomation.controlMode
        : (sourceClimateAutomation.enabled === true ? 'auto' : 'manual');
    cfg.climateAutomation = {
        enabled: climateControlMode === 'auto',
        controlMode: climateControlMode,
        mode: ['auto', 'heat', 'cool'].includes(cfg.climateAutomation && cfg.climateAutomation.mode) ? cfg.climateAutomation.mode : 'auto',
        targetTemperature: number(cfg.climateAutomation && cfg.climateAutomation.targetTemperature, 22, 10, 30),
        hysteresis: number(cfg.climateAutomation && cfg.climateAutomation.hysteresis, 1, 0.5, 5),
        fanSpeed: Math.round(number(cfg.climateAutomation && cfg.climateAutomation.fanSpeed, 50, 10, 100))
    };`,
    'Dreistufige Klima-Betriebsart mit Altbestand-Migration'
  );
}

if (!climateAutomationController.func.includes("const controlMode = ['off', 'manual', 'auto']")) {
  climateAutomationController.func = replaceOnce(
    climateAutomationController.func,
    "const settings = Object.assign({ enabled: false, mode: 'auto', targetTemperature: 22, hysteresis: 1, fanSpeed: 50 }, cfg.climateAutomation || {});",
    `const settings = Object.assign({ enabled: false, controlMode: 'manual', mode: 'auto', targetTemperature: 22, hysteresis: 1, fanSpeed: 50 }, cfg.climateAutomation || {});
const controlMode = ['off', 'manual', 'auto'].includes(settings.controlMode) ? settings.controlMode : (settings.enabled === true ? 'auto' : 'manual');
const automationEnabled = controlMode === 'auto';`,
    'Klima-Betriebsart im Controller'
  );
  climateAutomationController.func = replaceOnce(
    climateAutomationController.func,
    "const previousDemand = state.demand || 'idle';",
    "const previousDemand = state.demand || 'idle';\nconst previousControlMode = ['off', 'manual', 'auto'].includes(state.controlMode) ? state.controlMode : (state.enabled === true ? 'auto' : 'manual');",
    'Vorheriger Klima-Betriebsmodus'
  );
  climateAutomationController.func = replaceOnce(
    climateAutomationController.func,
    `if (settings.enabled !== true) {
    demand = 'idle';
    state.reason = 'Klimaautomatik aus';`,
    `if (!automationEnabled) {
    demand = 'idle';
    state.reason = controlMode === 'off' ? 'Klima aus' : 'Manuelle Bedienung';`,
    'Auto-Regelung nur in Betriebsart Auto'
  );
  climateAutomationController.func = replaceOnce(
    climateAutomationController.func,
    'const fanRunning = fan.on === true;',
    "const fanRunning = fan.on === true;\nconst forceOff = controlMode === 'off';",
    'Klima-Aus erzwingt Gerätestopp'
  );
  climateAutomationController.func = replaceOnce(
    climateAutomationController.func,
    `    if (state.heaterOwned && heaterRunning && heater.cooling !== true) heaterMessages.push({ topic: 'ui', payload: { action: 'stop', _climateAutomation: true } });
    if (state.fanOwned && fanRunning) fanMessages.push({ topic: 'ui', payload: { action: 'set', value: false, _climateAutomation: true } });`,
    `    if ((state.heaterOwned || forceOff) && heaterRunning && heater.cooling !== true) heaterMessages.push({ topic: 'ui', payload: { action: 'stop', _climateAutomation: true } });
    if ((state.fanOwned || forceOff) && fanRunning) fanMessages.push({ topic: 'ui', payload: { action: 'set', value: false, _climateAutomation: true } });`,
    'Manuell gibt Automatikgeräte frei, Aus stoppt beide Geräte'
  );
  climateAutomationController.func = replaceOnce(
    climateAutomationController.func,
    'state.enabled = settings.enabled === true;',
    "state.enabled = automationEnabled;\nstate.controlMode = controlMode;",
    'Klima-Betriebsart im Controllerzustand'
  );
  climateAutomationController.func = replaceOnce(
    climateAutomationController.func,
    'const changed = previousDemand !== demand;',
    'const changed = previousDemand !== demand || previousControlMode !== controlMode;',
    'Betriebsartwechsel aktualisiert Snapshot'
  );
}

if (!state.func.includes("controlMode: ['off', 'manual', 'auto'].includes(climateAutomation.controlMode)")) {
  state.func = replaceOnce(
    state.func,
    `        automation: {
            enabled: climateAutomation.enabled === true,`,
    `        automation: {
            enabled: climateAutomation.enabled === true,
            controlMode: ['off', 'manual', 'auto'].includes(climateAutomation.controlMode)
                ? climateAutomation.controlMode
                : (climateAutomation.enabled === true ? 'auto' : 'manual'),`,
    'Klima-Betriebsart im Zustandssnapshot'
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

// VRM darf den eigenen Internet-Uplink niemals abschalten. Der Guard arbeitet
// auf jeder primitiven Aktion, nicht nur auf dem äußeren Request. Dadurch
// werden alle Aktionen einer Szene vollständig geprüft, bevor auch nur eine
// Hardware-Nachricht erzeugt wird. Die Effektauflösung folgt exakt den
// bestehenden STAR-Power- und Wasserpumpen-Routen, sodass auch eine später auf
// Kanal 5 konfigurierte Pumpe den Remote-Uplink nicht abschalten kann.
if (!commandRouter.func.includes('const isRemoteLinkProtected = item =>')) {
  if (commandRouter.func.includes('const remoteLinkProtection = ')) {
    commandRouter.func = commandRouter.func.replace(
      /const remoteLinkProtection = [^;]+;/,
      `const starpowerToggleEffect = item => {
    const itemTarget = String(item && item.target || '');
    const itemAction = String(item && item.action || '');
    if (itemTarget === 'starpower' && itemAction === 'set') {
        const channel = Number(item && item.channel);
        const value = Number(item && item.value);
        return Number.isInteger(channel) && [0, 1].includes(value) ? { channel, value } : null;
    }
    if (itemTarget === 'waterPump' && itemAction === 'set' && typeof item.value === 'boolean') {
        return { channel: Number(cfg.mappings.waterPumpChannel), value: item.value ? 1 : 0 };
    }
    return null;
};
const isRemoteLinkProtected = item => {
    const effect = starpowerToggleEffect(item);
    return origin === 'vrm' && effect !== null && effect.channel === 5 && effect.value === 0;
};`
    );
  } else {
    commandRouter.func = replaceOnce(
      commandRouter.func,
      "const action = String(request.action || '');\nconst now = Date.now();",
      `const action = String(request.action || '');
const origin = String(request.origin || '');
const starpowerToggleEffect = item => {
    const itemTarget = String(item && item.target || '');
    const itemAction = String(item && item.action || '');
    if (itemTarget === 'starpower' && itemAction === 'set') {
        const channel = Number(item && item.channel);
        const value = Number(item && item.value);
        return Number.isInteger(channel) && [0, 1].includes(value) ? { channel, value } : null;
    }
    if (itemTarget === 'waterPump' && itemAction === 'set' && typeof item.value === 'boolean') {
        return { channel: Number(cfg.mappings.waterPumpChannel), value: item.value ? 1 : 0 };
    }
    return null;
};
const isRemoteLinkProtected = item => {
    const effect = starpowerToggleEffect(item);
    return origin === 'vrm' && effect !== null && effect.channel === 5 && effect.value === 0;
};
const now = Date.now();`,
      'Zentraler VRM-Linkschutz'
    );
  }
}
commandRouter.func = commandRouter.func
  .replace(
    "if (remoteLinkProtection) { accepted = false; error = 'remote_link_protection'; }",
    "if (isRemoteLinkProtected(request)) { accepted = false; error = 'remote_link_protection'; }"
  );
if (!commandRouter.func.includes("if (isRemoteLinkProtected(item)) return 'remote_link_protection';")) {
  commandRouter.func = replaceOnce(
    commandRouter.func,
    "const validateItem = item => {\n",
    "const validateItem = item => {\n    if (isRemoteLinkProtected(item)) return 'remote_link_protection';\n",
    'VRM-Linkschutz in Einzelaktionsvalidierung'
  );
}
if (!commandRouter.func.includes('const validationError = validateItem(item);')) {
  commandRouter.func = replaceOnce(
    commandRouter.func,
    "const dispatch = (item, parentId) => {\n",
    "const dispatch = (item, parentId) => {\n    const validationError = validateItem(item);\n    if (validationError) return { ok: false, error: validationError };\n",
    'Einzelaktionsvalidierung vor Hardware-Dispatch'
  );
}
if (!commandRouter.func.includes('const configuredLightProfile = cfg.lightingScenes')) {
  commandRouter.func = replaceOnce(
    commandRouter.func,
    `        const expanded = [];
        for (const item of scene.actions || []) {`,
    `        const expanded = [];
        const configuredLightProfile = cfg.lightingScenes && cfg.lightingScenes[scene.id];
        const sourceActions = configuredLightProfile && typeof configuredLightProfile === 'object' && !Array.isArray(configuredLightProfile)
            ? (scene.actions || []).filter(item => item && item.target !== 'starpower').concat(Object.entries(configuredLightProfile).map(([lightId, rawValue]) => {
                const light = (cfg.lights || []).find(candidate => candidate.id === lightId);
                const value = Math.max(0, Math.min(100, Math.round(Number(rawValue))));
                if (!light || !Number.isFinite(value)) return null;
                return value === 0 || light.dimmable === false
                    ? { target: 'starpower', action: 'set', channel: Number(light.channel), value: value > 0 ? 1 : 0 }
                    : { target: 'starpower', action: 'dim', channel: Number(light.channel), value };
            }).filter(Boolean))
            : (scene.actions || []);
        for (const item of sourceActions) {`,
    'Camping-/Nacht-Lichtprofil vor atomarem Szenenlauf auflösen'
  );
}
if (!commandRouter.func.includes('const commandsBefore = JSON.stringify(commands);')) {
  commandRouter.func = replaceOnce(
    commandRouter.func,
    "let commands = flow.get('camperCommands') || [];\nconst existing = commands.find(item => item.requestId === requestId);",
    "let commands = flow.get('camperCommands') || [];\nconst commandsBefore = JSON.stringify(commands);\nconst existing = commands.find(item => item.requestId === requestId);",
    'Kommandohistorie changed-only vorbereiten'
  );
}
commandRouter.func = commandRouter.func
  .replace('} else expanded.push(item);', '} else expanded.push(Object.assign({}, item));')
  .replace(
    `        else for (const item of expanded) {
            item.sceneId = scene.id;
            const result = dispatch(item, requestId);
            childIds.push(result.record.requestId);
        }`,
    `        else {
            const commandCountBeforeScene = commands.length;
            const routeLengthsBeforeScene = new Map([0, 1, 2, 3, 9, 11].map(index => [index, output[index].length]));
            for (const item of expanded) {
                item.sceneId = scene.id;
                const result = dispatch(item, requestId);
                if (!result.ok || !result.record) { accepted = false; error = result.error || 'scene_dispatch_failed'; break; }
                childIds.push(result.record.requestId);
            }
            if (!accepted) {
                commands.length = commandCountBeforeScene;
                for (const [index, length] of routeLengthsBeforeScene) output[index].length = length;
                childIds = [];
            }
        }`
  )
  .replace(
    "source: msg._session ? 'sync3-websocket' : (msg.req ? 'http' : 'dashboard'), error: ''",
    "source: origin || (msg._session ? 'sync3-websocket' : (msg.req ? 'http' : 'dashboard')), error: ''"
  )
  .replace(
    "commands = commands.slice(-Math.max(10, Number(cfg.commands && cfg.commands.retainCount || 40)));\nflow.set('camperCommands', commands);",
    "commands = commands.slice(-Math.max(10, Number(cfg.commands && cfg.commands.retainCount || 40)));\nif (JSON.stringify(commands) !== commandsBefore) flow.set('camperCommands', commands);"
  );
commandRouter.func = commandRouter.func
  .replace(
    "(request.value === false || Number(request.value) === 0)",
    "(request.value === false || request.value === 0)"
  )
  .replace(
    "source: msg.req ? 'http' : (msg._session ? 'sync3-websocket' : 'dashboard'), error: '', childIds",
    "source: origin || (msg.req ? 'http' : (msg._session ? 'sync3-websocket' : 'dashboard')), error: '', childIds"
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

// /Mode ist kein Telemetriemesswert, sondern ein gelatchter Schaltzustand. Ein
// unveränderter Wert darf nach staleSeconds nicht zu null werden, solange ein
// anderer Orion-Pfad die aktuelle Geräteverbindung belegt. Sobald auch die
// Telemetrie veraltet ist, bleibt das Gerät wie bisher offline und Mode wird
// nicht aus einem alten Datensatz vorgetäuscht.
state.func = state.func.replace(
  "const orionMode = sensor('orion.mode');\nconst orionState = sensor('orion.state');\nconst orionSeen = Math.max(seen('orion.mode'), seen('orion.state'), seen('orion.power'), seen('orion.voltage'));\nconst orionOnline = orionSeen > now - staleMs;\nconst orionModeNumber = orionMode == null || orionMode === '' ? null : Number(orionMode);\nconst orionStateNumber = orionState == null || orionState === '' ? null : Number(orionState);",
  "const orionModeRecord = sensors['orion.mode'];\nconst orionModeSeen = seen('orion.mode');\nconst orionTelemetrySeen = Math.max(seen('orion.state'), seen('orion.power'), seen('orion.voltage'), seen('orion.current'), seen('orion.inputVoltage'), seen('orion.inputPower'), seen('orion.error'));\nconst orionSeen = Math.max(orionModeSeen, orionTelemetrySeen);\nconst orionOnline = orionSeen > now - staleMs;\nconst orionModeValue = orionModeRecord && [1, 4].includes(Number(orionModeRecord.value)) ? Number(orionModeRecord.value) : null;\nconst orionModeNumber = orionOnline ? orionModeValue : null;\nconst orionMode = orionModeNumber;\nconst orionState = sensor('orion.state');\nconst orionStateNumber = orionState == null || orionState === '' ? null : Number(orionState);"
);
state.func = state.func.replace(
  `    lightScenes: ['camping', 'night'].map(sceneId => {
        const scene = (cfg.scenes || []).find(item => item.id === sceneId);
        return { id: sceneId, name: scene ? scene.name : (sceneId === 'camping' ? 'Camping' : 'Nacht'), values: Object.assign({}, cfg.lightingScenes && cfg.lightingScenes[sceneId] || {}) };
    }),
`,
  ''
);
if (!state.func.includes('lightScenes: [\'camping\', \'night\', \'all_off\']')) {
  state.func = replaceOnce(
    state.func,
    `    scenes: (cfg.scenes || []).filter(scene => scene.visible !== false).map(scene => ({ id: scene.id, name: scene.name, icon: scene.icon, actionCount: (scene.actions || []).length })),`,
    `    scenes: (cfg.scenes || []).filter(scene => scene.visible !== false).map(scene => ({ id: scene.id, name: scene.name, icon: scene.icon, actionCount: (scene.actions || []).length })),
    lightScenes: ['camping', 'night', 'all_off'].map(sceneId => {
        const scene = (cfg.scenes || []).find(item => item.id === sceneId);
        return { id: sceneId, name: scene ? scene.name : (sceneId === 'camping' ? 'Camping' : sceneId === 'night' ? 'Nacht' : 'Alles aus'), values: Object.assign({}, cfg.lightingScenes && cfg.lightingScenes[sceneId] || {}) };
    }),`,
    'Editierbare Lichtprofile im Snapshot'
  );
}

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
if (!state.func.includes('const favoriteIds = cfg.ui')) {
  state.func = replaceOnce(
    state.func,
    'const quickAccess = quickAccessIds.map(id => {',
    'const resolveQuickOption = id => {',
    'Gemeinsamer Schnellzugriff-/Favoriten-Resolver'
  );
  state.func = replaceOnce(
    state.func,
    `    return result;
}).filter(Boolean);

const weatherStored = flow.get('camperWeather');`,
    `    return result;
};
const quickAccess = quickAccessIds.map(resolveQuickOption).filter(Boolean);
const favoriteFallback = ['switch:water_pump', 'device:inverter', 'device:heater', 'device:maxxfan'];
const favoriteIds = cfg.ui && Array.isArray(cfg.ui.favoriteIds) ? cfg.ui.favoriteIds : favoriteFallback;
const favorites = favoriteIds.map(resolveQuickOption).filter(Boolean);

const weatherStored = flow.get('camperWeather');`,
    'Eigenständig aufgelöste Favoriten im Snapshot'
  );
}
if (state.func.includes('ui: { quickAccessLightIds:')) {
  state.func = state.func.replace(
    /ui: \{ quickAccessLightIds:[^\n]+\},/,
    "ui: { quickAccessIds, quickAccess, quickAccessOptions, externalWifiTileEnabled: !(cfg.ui && cfg.ui.externalWifiTileEnabled === false) },"
  );
}
state.func = state.func.replace(
  "ui: { quickAccessIds, quickAccess, quickAccessOptions, externalWifiTileEnabled: !(cfg.ui && cfg.ui.externalWifiTileEnabled === false), designVersion: cfg.ui && cfg.ui.designVersion === 'v1' ? 'v1' : 'v2' },",
  "ui: { quickAccessIds, quickAccess, quickAccessOptions, externalWifiTileEnabled: !(cfg.ui && cfg.ui.externalWifiTileEnabled === false) },"
);
state.func = state.func.replace(
  "ui: { quickAccessIds, quickAccess, quickAccessOptions, externalWifiTileEnabled: !(cfg.ui && cfg.ui.externalWifiTileEnabled === false) },",
  "ui: { quickAccessIds, quickAccess, quickAccessOptions, favoriteIds, favorites, externalWifiTileEnabled: !(cfg.ui && cfg.ui.externalWifiTileEnabled === false) },"
);

if (!state.func.includes("const weatherStored = flow.get('camperWeather');")) {
  state.func = replaceOnce(
    state.func,
    'const snapshot = {',
    `const weatherStored = flow.get('camperWeather');
const weather = weatherStored && typeof weatherStored === 'object' && weatherStored.schema === 1 ? weatherStored : null;

const snapshot = {`,
    'Validiertes Wetter im Zustandssnapshot'
  );
}
if (!state.func.includes('\n    weather,\n')) {
  state.func = replaceOnce(
    state.func,
    "ui: { quickAccessIds, quickAccess, quickAccessOptions, externalWifiTileEnabled: !(cfg.ui && cfg.ui.externalWifiTileEnabled === false) },",
    "ui: { quickAccessIds, quickAccess, quickAccessOptions, externalWifiTileEnabled: !(cfg.ui && cfg.ui.externalWifiTileEnabled === false) },\n    weather,",
    'Wetterfeld im Zustandssnapshot'
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

settingsUi.format = settingsUi.format.replace(
  '<label><input type="checkbox" v-model="cfg.climateAutomation.enabled" @change="saveClimateAutomation"> Klimaautomatik aktiv</label>',
  '<label>Betriebsart<select v-model="cfg.climateAutomation.controlMode" @change="saveClimateAutomation"><option value="off">Aus</option><option value="manual">Manuell</option><option value="auto">Automatik</option></select></label>'
);

settingsUi.format = settingsUi.format
  .replace(/\s*<section class="design-choice">[\s\S]*?<\/section>\s*(?=<section>\s*<h2>System<\/h2>)/, '\n  ')
  .replace(",selectDesign(v){if(!['v1','v2'].includes(v))return;this.cfg.ui=Object.assign({},this.cfg.ui||{},{designVersion:v});this.patch({ui:{designVersion:v}})}", '')
  .replace(",ui:{designVersion:'v2'}", '')
  .replace(/<style id="settings-selectable-designs-v2">[\s\S]*?<\/style>/, '');

for (const node of flows) {
  for (const field of ['func', 'initialize', 'finalize']) {
    if (typeof node[field] === 'string') {
      node[field] = useDefaultContextStore(cleanEmbeddedDefaults(node[field]));
    }
  }
}

// Nach der Umstellung auf den persistenten Default-Store sind die früheren
// Store-Fallbackzweige nicht nur überflüssig, sondern konnten denselben Wert
// zweimal markieren. AUTOTERM und Settings verwenden deshalb genau einen
// Default-Store-Zugriff und schreiben Konfiguration ausschließlich bei einer
// echten Änderung/Migration.
const autotermController = get('12f9ef01215ad8d3');
autotermController.func = autotermController.func
  .replace(
    "let persistentStore = 'file';\nlet saved = {};\ntry {\n    saved = flow.get('autotermPersistent') || {};\n} catch (error) {\n    persistentStore = null;\n    saved = flow.get('autotermPersistent') || {};\n}",
    "const saved = flow.get('autotermPersistent') || {};"
  )
  .replace(
    "    try {\n        if (persistentStore) flow.set('autotermPersistent', persistent);\n        else flow.set('autotermPersistent', persistent);\n    } catch (error) {\n        persistentStore = null;\n        flow.set('autotermPersistent', persistent);\n        st.storageError = String(error.message || error);\n    }\n    flow.set('_autotermPersistentJson', persistentJson);\n}\nst.storagePersistent = persistentStore === 'file';\nif (st.storagePersistent) delete st.storageError;",
    "    flow.set('autotermPersistent', persistent);\n    flow.set('_autotermPersistentJson', persistentJson);\n}\nst.storagePersistent = true;\ndelete st.storageError;"
  );

settings.func = settings.func
  .replace(
    "let persistent = true;\nlet stored = {};\ntry { stored = flow.get('camperConfig') || {}; }\ncatch (error) { persistent = false; stored = flow.get('camperConfig') || {}; }",
    "const persistent = true;\nconst stored = flow.get('camperConfig') || {};"
  )
  .replace(
    "const persist = () => {\n    flow.set('camperConfig', cfg);\n    try {\n        if (persistent) flow.set('camperConfig', cfg);\n    } catch (error) {\n        persistent = false;\n        flow.set('camperConfig', cfg);\n    }\n};",
    "const persist = () => flow.set('camperConfig', cfg);"
  )
  .replace("\nelse flow.set('camperConfig', cfg);", '');

// Der große Aggregator läuft maximal zweimal pro Sekunde. Dennoch darf er den
// persistenten Default-Context nicht bei jedem Lauf mit unveränderten Events,
// Historie, Kommandos, Clients oder einer zweiten globalen Snapshot-Kopie
// markieren. Nur der aktuelle API-Snapshot selbst bleibt ein notwendiger
// Laufzeit-Write; alle übrigen Sammlungen werden changed-only geschrieben.
state.func = state.func
  .replace(
    "const starpowerCfg = (() => {\n    try { return flow.get('starpowerConfig') || {}; }\n    catch (error) { return flow.get('starpowerConfig') || {}; }\n})();",
    "const starpowerCfg = flow.get('starpowerConfig') || {};"
  )
  .replace(
    "let events = flow.get('camperEvents');\nif (!Array.isArray(events)) {\n    try { events = flow.get('camperEvents') || []; }\n    catch (error) { events = []; }\n}\nflow.set('camperEvents', events);",
    "let events = flow.get('camperEvents');\nif (!Array.isArray(events)) events = [];"
  )
  .replace(
    "let history = flow.get('camperHistory');\nif (!history || !Array.isArray(history.minute)) {\n    try { history = flow.get('camperHistory') || {}; }\n    catch (error) { history = {}; }\n}",
    "let history = flow.get('camperHistory');\nif (!history || !Array.isArray(history.minute)) history = {};"
  )
  .replace(
    "sample(history.daily, 86400000, Number(cfg.history.dailyDays || 730) * 86400000);\nflow.set('camperHistory', history);",
    "sample(history.daily, 86400000, Number(cfg.history.dailyDays || 730) * 86400000);"
  )
  .replace(
    "flow.set('camperActiveAlertIds', currentAlerts);",
    "if (JSON.stringify(currentAlerts) !== JSON.stringify(previousAlerts)) flow.set('camperActiveAlertIds', currentAlerts);"
  )
  .replace(
    "let deviceStats = flow.get('camperDeviceStats') || {};",
    "let deviceStats = flow.get('camperDeviceStats') || {};\nconst deviceStatsBefore = JSON.stringify(deviceStats);"
  )
  .replace(
    "flow.set('camperDeviceStats', deviceStats);",
    "if (JSON.stringify(deviceStats) !== deviceStatsBefore) flow.set('camperDeviceStats', deviceStats);"
  )
  .replace(
    "    sequence: Number(flow.get('camperSequence') || 0) + 1,",
    "    sequence: Number((flow.get('camperSnapshot') || {}).sequence || 0) + 1,"
  )
  .replace("flow.set('camperSequence', snapshot.sequence);\n", '')
  .replace("global.set('camper.snapshot', snapshot);\n", '')
  .replace(
    "const clients = flow.get('camperWsClients') || {};\nconst messages = [];",
    "const clients = flow.get('camperWsClients') || {};\nlet clientsChanged = false;\nconst messages = [];"
  )
  .replace(
    "        delete clients[id];\n        continue;",
    "        delete clients[id];\n        clientsChanged = true;\n        continue;"
  )
  .replace(
    "flow.set('camperWsClients', clients);\nreturn [{ payload: snapshot }, messages];",
    "if (clientsChanged) flow.set('camperWsClients', clients);\nreturn [{ payload: snapshot }, messages];"
  );

// Die Buildquelle ist selbst der jeweils zuletzt generierte Master. Diese
// Normalisierung hält die changed-only-Guards deshalb auch bei wiederholten
// Builds exakt einmal vorhanden.
state.func = state.func
  .replace(/(?:const deviceStatsBefore = JSON\.stringify\(deviceStats\);\n)+/g, 'const deviceStatsBefore = JSON.stringify(deviceStats);\n')
  .replace(/(?:if \(JSON\.stringify\(currentAlerts\) !== JSON\.stringify\(previousAlerts\)\) )+flow\.set\('camperActiveAlertIds', currentAlerts\);/g, "if (JSON.stringify(currentAlerts) !== JSON.stringify(previousAlerts)) flow.set('camperActiveAlertIds', currentAlerts);")
  .replace(/(?:if \(JSON\.stringify\(deviceStats\) !== deviceStatsBefore\) )+flow\.set\('camperDeviceStats', deviceStats\);/g, "if (JSON.stringify(deviceStats) !== deviceStatsBefore) flow.set('camperDeviceStats', deviceStats);")
  .replace(/(?:if \(clientsChanged\) )+flow\.set\('camperWsClients', clients\);/g, "if (clientsChanged) flow.set('camperWsClients', clients);");

// Even corrupted legacy context cannot exceed the physical point budget.
// 24 h at one minute + 30 d at 15 minutes + 365 daily values = 4,685.
state.func = state.func
  .replace(
    /const sample = \(list, period, keepMs(?:, maxPoints)?\) => \{[\s\S]*?\n\};\nsample\(history\.minute,[^\n]+\);\nsample\(history\.quarterHour,[^\n]+\);\nsample\(history\.daily,[^\n]+\);/,
    `const sample = (list, period, keepMs, maxPoints) => {
    if (list.length > maxPoints) { list.splice(0, list.length - maxPoints); historyChanged = true; }
    const bucket = Math.floor(now / period);
    const previous = list[list.length - 1];
    if (!previous || Math.floor(previous.timestamp / period) !== bucket) { list.push(historyPoint); historyChanged = true; }
    const minimum = now - keepMs;
    const firstFreshIndex = list.findIndex(point => Number(point && point.timestamp) >= minimum);
    if (firstFreshIndex < 0 && list.length) { list.splice(0, list.length); historyChanged = true; }
    else if (firstFreshIndex > 0) { list.splice(0, firstFreshIndex); historyChanged = true; }
    if (list.length > maxPoints) { list.splice(0, list.length - maxPoints); historyChanged = true; }
};
sample(history.minute, 60000, Number(cfg.history.minuteHours || 24) * 3600000, 1440);
sample(history.quarterHour, 900000, Number(cfg.history.quarterDays || 30) * 86400000, 2880);
sample(history.daily, 86400000, Number(cfg.history.dailyDays || 365) * 86400000, 365);`
  );

// Der vollständige Snapshot ist auf dem Cerbo die mit Abstand größte
// Context-Struktur. Selbst der gemeinsame 2-Hz-Gate darf den persistenten
// localfilesystem-Store nicht für identische Zustände markieren. Sequenz und
// Zeitstempel beschreiben deshalb die letzte echte Inhaltsänderung und werden
// beim Vergleich bewusst ausgeblendet.
if (!state.func.includes('const snapshotChanged = !previousSnapshot')) {
  state.func = replaceOnce(
    state.func,
    "flow.set('camperSnapshot', snapshot);\n\nconst clients = flow.get('camperWsClients') || {};",
    `const previousSnapshot = flow.get('camperSnapshot');
const comparableSnapshot = Object.assign({}, snapshot);
delete comparableSnapshot.sequence;
delete comparableSnapshot.timestamp;
const previousComparable = previousSnapshot ? Object.assign({}, previousSnapshot) : null;
if (previousComparable) {
    delete previousComparable.sequence;
    delete previousComparable.timestamp;
}
const snapshotChanged = !previousSnapshot || JSON.stringify(comparableSnapshot) !== JSON.stringify(previousComparable);
if (snapshotChanged) flow.set('camperSnapshot', snapshot);

const clients = flow.get('camperWsClients') || {};`,
    'Snapshot nur bei Inhaltsänderung persistieren'
  );
}
if (!state.func.includes('const MAX_SNAPSHOT_BYTES = 256 * 1024;')) {
  state.func = replaceOnce(
    state.func,
    "if (eventsChanged) {\n    events = events.slice(-500);",
    `const MAX_SNAPSHOT_BYTES = 256 * 1024;
if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > MAX_SNAPSHOT_BYTES) {
    node.error('snapshot_too_large');
    return null;
}

const retainedEvents = events.slice(-500);
if (retainedEvents.length !== events.length) eventsChanged = true;
events = retainedEvents;
if (eventsChanged) {`,
    'Snapshot- und Event-Retention begrenzen'
  );
}
state.func = state.func
  .replace(
    /const messages = \[\];\n(?:const stateMessagePayload = snapshotChanged \? JSON\.stringify\(\{ type: 'state', data: snapshot \}\) : '';\n)?/,
    "const messages = [];\nconst stateMessagePayload = snapshotChanged ? JSON.stringify({ type: 'state', data: snapshot }) : '';\n"
  )
  .replace(
    /^(\s*)(?:if \(snapshotChanged\) )?messages\.push\(\{ _session: client\.session, payload: (?:JSON\.stringify\(\{ type: 'state', data: snapshot \}\)|stateMessagePayload) \}\);$/m,
    "$1if (snapshotChanged) messages.push({ _session: client.session, payload: stateMessagePayload });"
  )
  .replace(
    "if (clientsChanged) flow.set('camperWsClients', clients);\nreturn [{ payload: snapshot }, messages];",
    "if (clientsChanged) flow.set('camperWsClients', clients);\nif (!snapshotChanged) return null;\nreturn [{ payload: snapshot }, messages];"
  )
  .replace(/(?:if \(!snapshotChanged\) return null;\n)+/g, 'if (!snapshotChanged) return null;\n');

if (!state.func.includes('let commandsChanged = false;')) {
  state.func = replaceOnce(
    state.func,
    "let commands = flow.get('camperCommands') || [];\nconst commandMatch = command => {",
    "let commands = flow.get('camperCommands') || [];\nlet commandsChanged = false;\nconst commandMatch = command => {",
    'Changed-only-Kommandozustand'
  )
    .replace("    if (matched.ok) {\n        command.status", "    if (matched.ok) {\n        commandsChanged = true;\n        command.status")
    .replace("    } else if (matched.failed) {\n        command.status", "    } else if (matched.failed) {\n        commandsChanged = true;\n        command.status")
    .replace("    } else if (now >= Number(command.deadlineAt || 0)) {\n        command.status", "    } else if (now >= Number(command.deadlineAt || 0)) {\n        commandsChanged = true;\n        command.status");
  state.func = replaceOnce(
    state.func,
    "commands = commands.slice(-Math.max(10, Number(cfg.commands && cfg.commands.retainCount || 40)));\nflow.set('camperCommands', commands);",
    "const retainedCommands = commands.slice(-Math.max(10, Number(cfg.commands && cfg.commands.retainCount || 40)));\nif (retainedCommands.length !== commands.length) commandsChanged = true;\ncommands = retainedCommands;\nif (commandsChanged) flow.set('camperCommands', commands);",
    'Begrenzte Kommandos changed-only speichern'
  );
}

// CH 5 arrives with an initial value and afterwards only on a real D-Bus
// change. The Function keeps a second changed-only guard so a node regression
// can neither dirty persistent context nor trigger snapshots repeatedly.
get('59c75d840f413ba9').onlyChanges = true;
get('camper_starlink_power_gate').func = `
const powered = Number(msg.payload) === 1;
const previous = flow.get('starlinkState') || {};
const known = typeof previous.powered === 'boolean';
const wasPowered = previous.powered === true;
if (known && wasPowered === powered) return null;
const now = Date.now();
let state;
if (!powered) {
    state = { powered: false, online: false, status: 'Ausgeschaltet', lastSeen: 0, updatedAt: now, alerts: [] };
} else {
    state = Object.assign({}, previous, { powered: true, online: false, status: 'Starlink startet', updatedAt: now });
}
flow.set('starlinkState', state);
return [powered && !wasPowered ? { topic: 'starlink.poll', payload: '', _starlinkPowered: true } : null, { topic: 'tick', _camperSource: 'starlink-power' }];
`;

const indevoltDiscovery = get('d92d04ca2b1964f9');
indevoltDiscovery.func = `
const MAX_PAYLOAD_BYTES = 4096;
const MAX_RESPONSES_PER_SCAN = 4;
const SCAN_WINDOW_MS = 10000;
const now = Date.now();
const storedScan = flow.get('indevoltScan') || {};
if (storedScan.active !== true || !Number.isFinite(Number(storedScan.started)) || now - Number(storedScan.started) < 0 || now - Number(storedScan.started) > SCAN_WINDOW_MS) return null;
const text = Buffer.isBuffer(msg.payload) ? msg.payload.toString('utf8') : String(msg.payload || '');
if (!text || Buffer.byteLength(text, 'utf8') > MAX_PAYLOAD_BYTES) return null;
let device;
try { device = JSON.parse(text.trim()); } catch (error) { return null; }
if (!device || typeof device !== 'object' || Array.isArray(device)) return null;
const ip = String(device.ip || msg.ip || '').trim();
const serial = String(device.sn || '').trim().slice(0, 64);
const parts = ip.split('.');
if (parts.length !== 4 || !parts.every(part => /^\\d{1,3}$/.test(part) && Number(part) <= 255)) return null;

const scan = Object.assign({}, storedScan, {
    results: Array.isArray(storedScan.results) ? storedScan.results.slice(-8).map(item => Object.assign({}, item)) : [],
    acceptedIps: Array.isArray(storedScan.acceptedIps) ? storedScan.acceptedIps.slice(0, MAX_RESPONSES_PER_SCAN).map(String) : []
});
if (scan.acceptedIps.includes(ip) || scan.acceptedIps.length >= MAX_RESPONSES_PER_SCAN) return null;
scan.acceptedIps.push(ip);

const storedRegistry = flow.get('indevoltRegistry') || {};
const registry = Object.fromEntries(Object.entries(storedRegistry).slice(-8).map(([key, value]) => [key, Object.assign({}, value)]));
const registryBefore = JSON.stringify(registry);
const previousDevice = Object.values(registry).sort((a, b) => Math.max(Number(b.lastSeen || 0), Number(b.lastDiscovered || 0)) - Math.max(Number(a.lastSeen || 0), Number(a.lastDiscovered || 0)))[0] || {};
for (const oldIp of Object.keys(registry)) if (oldIp !== ip) delete registry[oldIp];
const existing = registry[ip] || null;
const firmware = String(device.fw || (existing && existing.firmware) || previousDevice.firmware || '').slice(0, 64);
const openData = String(device.opendata_ver || (existing && existing.openData) || '').slice(0, 32);
const nextDevice = Object.assign({ ip, firstSeen: now, lastSeen: 0, online: false }, existing || {}, {
    ip,
    serial: String(serial || (existing && existing.serial) || previousDevice.serial || '').slice(0, 64),
    firmware,
    openData,
    source: 'udp'
});
const metadataChanged = !existing || ['ip', 'serial', 'firmware', 'openData', 'source'].some(key => nextDevice[key] !== existing[key]);
nextDevice.lastDiscovered = metadataChanged ? now : Number(existing.lastDiscovered || now);
registry[ip] = nextDevice;
if (JSON.stringify(registry) !== registryBefore) flow.set('indevoltRegistry', registry);

const result = { ip, serial: nextDevice.serial, firmware: nextDevice.firmware, openData: nextDevice.openData };
const index = scan.results.findIndex(item => item.ip === ip || (serial && item.serial === serial));
if (index >= 0) scan.results[index] = result; else scan.results.push(result);
scan.results = scan.results.slice(-8);
if (JSON.stringify(scan) !== JSON.stringify(storedScan)) flow.set('indevoltScan', scan);
return { topic: 'indevolt.discovered', payload: { ip } };
`;
const indevoltDirectory = get('99e30f749692fa13');
indevoltDirectory.func = indevoltDirectory.func.replace(
  "const next = { active: true, started: Date.now(), token: Date.now().toString(36), results: [], error: '' };",
  "const next = { active: true, started: Date.now(), token: Date.now().toString(36), results: [], acceptedIps: [], error: '' };"
).replace(
  '    if (scan.active) return null;',
  "    const scanAge = Date.now() - Number(scan.started || 0);\n    if (scan.active && scanAge >= 0 && scanAge <= 10000) return null;"
);

// Every external response and every delayed action must have a hard memory
// bound.  Device HTTP nodes return raw bytes so the Function can reject an
// oversized body before JSON.parse allocates a second large object.
for (const id of ['7a397c289a9a3fc2', 'a553dda137d3e5bf']) get(id).ret = 'bin';

const indevoltMerge = get('51f0c8be7e1b4dbe');
if (!indevoltMerge.func.includes('const MAX_DEVICE_RESPONSE_BYTES = 64 * 1024;')) {
  indevoltMerge.func = indevoltMerge.func.replace(
    "const STALE_MS = 90000;",
    "const STALE_MS = 90000;\nconst MAX_DEVICE_RESPONSE_BYTES = 64 * 1024;"
  ).replace(
    "let payload = msg.payload;\nif (typeof payload === 'string') {",
    `let payload = msg.payload;
if (Buffer.isBuffer(payload)) {
    if (payload.length > MAX_DEVICE_RESPONSE_BYTES) return null;
    payload = payload.toString('utf8');
} else if (typeof payload === 'string' && Buffer.byteLength(payload, 'utf8') > MAX_DEVICE_RESPONSE_BYTES) {
    return null;
}
if (typeof payload === 'string') {`
  ).replace(
    "ip, serial: String(payload['0'] || previous.serial || ''), online: true,",
    "ip, serial: String(payload['0'] || previous.serial || '').slice(0, 64), online: true,"
  );
}

const vanturtleState = get('30de81a830592ed2');
vanturtleState.func = `
const MAX_DEVICE_RESPONSE_BYTES = 64 * 1024;
const warnRateLimited = (key, text) => {
    const now = Date.now();
    const previous = Number(context.get(key) || 0);
    if (now - previous < 60000) return;
    context.set(key, now);
    node.warn(text);
};
let state = msg.payload;
if (Buffer.isBuffer(state)) {
    if (state.length > MAX_DEVICE_RESPONSE_BYTES) return null;
    state = state.toString('utf8');
} else if (typeof state === 'string' && Buffer.byteLength(state, 'utf8') > MAX_DEVICE_RESPONSE_BYTES) {
    return null;
}
if (typeof state === 'string') {
    try { state = JSON.parse(state); }
    catch (error) { warnRateLimited('_vanturtleInvalidAt', 'VanTurtle: ungültiger Statusframe'); return null; }
}
if (!state || typeof state !== 'object' || Array.isArray(state) || state.type === 'log') return null;
if (typeof state.active !== 'boolean' || !Number.isFinite(Number(state.speed))) return null;

const speedStep = Math.max(1, Math.min(10, Math.round(Number(state.speed))));
const direction = Number(state.direction) === 1 ? 1 : 0;
const adapters = flow.get('camperAdapters') || {};
adapters['maxxfan.state'] = {
    on: state.active,
    speed: state.active ? speedStep * 10 : 0,
    speedStep,
    direction,
    mode: direction === 1 ? 'reverse' : 'forward',
    autoHold: state.auto_hold === true || Number(state.auto_hold) === 1,
    voltage: Number.isFinite(Number(state.voltage)) ? Number(state.voltage) : null,
    current: Number.isFinite(Number(state.current)) ? Number(state.current) : null,
    power: Number.isFinite(Number(state.power)) ? Number(state.power) : null,
    calibrated: state.has_calibration === true,
    calibrating: state.is_calibrating === true,
    seen: Date.now()
};
flow.set('camperAdapters', adapters);
return { topic: 'tick' };
`;

// The Starlink helper emits at most 64 KiB (+ one overflow sentinel byte).
// This second guard is deliberate defence in depth before JSON parsing and
// before any value reaches persistent Node-RED context.
get('camper_starlink_parse').func = `
const MAX_STARLINK_RESPONSE_BYTES = 64 * 1024;
let data = msg.payload;
if (Buffer.isBuffer(data)) {
    if (data.length > MAX_STARLINK_RESPONSE_BYTES) return null;
    data = data.toString('utf8');
} else if (typeof data === 'string' && Buffer.byteLength(data, 'utf8') > MAX_STARLINK_RESPONSE_BYTES) {
    return null;
}
if (typeof data === 'string') {
    try { data = JSON.parse(data); }
    catch (error) { return null; }
}
if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
if (data.powered === false) {
    const off = { powered: false, online: false, status: 'Ausgeschaltet', lastSeen: 0, updatedAt: Date.now(), alerts: [] };
    flow.set('starlinkState', off);
    return { topic: 'tick', _camperSource: 'starlink-off' };
}
const diagnostics = data.dishGetDiagnostics;
if (!diagnostics || typeof diagnostics !== 'object' || Array.isArray(diagnostics)) return null;
const text = (value, limit) => String(value == null ? '' : value).slice(0, limit);
const alertObject = diagnostics.alerts && typeof diagnostics.alerts === 'object' && !Array.isArray(diagnostics.alerts) ? diagnostics.alerts : {};
const alerts = Object.keys(alertObject).filter(key => alertObject[key] === true).slice(0, 32).map(key => text(key, 64));
const rawAlignment = diagnostics.alignmentStats && typeof diagnostics.alignmentStats === 'object' && !Array.isArray(diagnostics.alignmentStats) ? diagnostics.alignmentStats : {};
const alignment = {};
for (const key of ['boresightAzimuthDeg', 'boresightElevationDeg', 'desiredBoresightAzimuthDeg', 'desiredBoresightElevationDeg', 'attitudeUncertaintyDeg']) {
    if (Number.isFinite(Number(rawAlignment[key]))) alignment[key] = Number(rawAlignment[key]);
}
const disablementCode = text(diagnostics.disablementCode || 'UNKNOWN', 64);
const state = {
    powered: true,
    online: true,
    status: disablementCode && disablementCode !== 'OKAY' ? disablementCode : 'Online',
    id: text(diagnostics.id, 128),
    hardwareVersion: text(diagnostics.hardwareVersion, 64),
    softwareVersion: text(diagnostics.softwareVersion, 128),
    disablementCode,
    stowed: diagnostics.stowed === true,
    alerts,
    alignment,
    lastSeen: Date.now(),
    updatedAt: Date.now(),
    error: ''
};
flow.set('starlinkState', state);
return { topic: 'tick', _camperSource: 'starlink-diagnostics' };
`;

// Coalesce every delayed refresh.  The AUTOTERM queue retains only the newest
// normal command; an explicit stop first clears the pending item and is then
// queued itself, so a safety stop can never be hidden by a telemetry burst.
for (const id of ['19bb36cb2ea4a5c4', 'camper_network_repair_delay', 'camper_bluetooth_repair_delay', 'external_wifi_scan_refresh']) get(id).drop = true;
const autotermSession = get('152e2fdda301b9e4');
if (!autotermSession.func.includes("node.send([[{ reset: true, topic: 'autoterm.reset' }, stopMessage], null, null]);")) {
  autotermSession.func = autotermSession.func.replace(
    "    msg.payload = outgoing;\n    return [msg, null, null];",
    `    msg.payload = outgoing;
    if (outgoingCommand === 0x03) {
        const stopMessage = Object.assign({}, msg, { payload: outgoing });
        node.send([[{ reset: true, topic: 'autoterm.reset' }, stopMessage], null, null]);
        return null;
    }
    return [msg, null, null];`
  );
}

// Service calls can restart processes and therefore need a fixed, in-memory
// cooldown before fan-out.  The map contains only this static allowlist.
get('camper_service_action_router').func = `
const request = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
const action = String(request.action || '');
const output = Array(9).fill(null);
const notice = (level, text) => { output[5] = { topic: 'service.notice', payload: { level, text } }; };
const cooldowns = { refresh: 3, wifiEnable: 5, wifiScan: 20, wifiConnect: 10, networkRepair: 60, bluetoothRepair: 30, nodeRedRestart: 90, cerboReboot: 180 };
const accept = key => {
    const now = Date.now();
    const previous = context.get('serviceCooldowns') || {};
    const waitMs = Number(cooldowns[key] || 30) * 1000;
    if (now - Number(previous[key] || 0) < waitMs) { notice('info', 'Aktion läuft bereits oder wurde gerade ausgeführt.'); return false; }
    const next = {};
    for (const allowedKey of Object.keys(cooldowns)) if (Number.isFinite(Number(previous[allowedKey]))) next[allowedKey] = Number(previous[allowedKey]);
    next[key] = now;
    context.set('serviceCooldowns', next);
    return true;
};
if (action === 'refresh') {
    if (accept(action)) output[4] = { topic: 'service.refresh', payload: '' };
    return output;
}
if (action === 'wifiEnable') {
    if (typeof request.value !== 'boolean') { notice('error', 'Ungültiger WLAN-Schaltwert abgelehnt.'); return output; }
    if (!accept(action)) return output;
    output[6] = { payload: request.value ? 1 : 0 };
    notice('info', request.value ? 'Externer WLAN-Uplink wird aktiviert.' : 'Externer WLAN-Uplink wird deaktiviert.');
    return output;
}
if (action === 'wifiScan') {
    if (!accept(action)) return output;
    flow.set('camperExternalWifiScanUntil', Date.now() + 15000);
    output[7] = { payload: 1 };
    notice('info', 'WLAN-Suche wurde gestartet.');
    return output;
}
if (action === 'wifiConnect') {
    const service = String(request.service || '').slice(0, 256);
    const ssid = String(request.ssid || '').slice(0, 64);
    const passphrase = typeof request.passphrase === 'string' ? request.passphrase.slice(0, 63) : '';
    if (!service || !ssid || !accept(action)) return output;
    output[8] = { payload: { service, ssid, passphrase } };
    return output;
}
const allowed = { networkRepair: 0, bluetoothRepair: 1, nodeRedRestart: 2, cerboReboot: 3 };
if (!Object.prototype.hasOwnProperty.call(allowed, action)) {
    notice('error', 'Unbekannte Service-Aktion abgelehnt.');
    return output;
}
if (!accept(action)) return output;
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

// Identische invalid frames must not produce an unbounded platform log.  The
// fixed per-node timestamps are written at most once per minute.
const installRateLimitedWarning = (id, replacements) => {
  const node = get(id);
  if (!node.func.includes('const warnRateLimited = (key, text) => {')) {
    node.func = `const warnRateLimited = (key, text) => {
    const now = Date.now();
    const previous = Number(context.get(key) || 0);
    if (now - previous < 60000) return;
    context.set(key, now);
    node.warn(text);
};
` + node.func;
  }
  for (const [before, after] of replacements) node.func = node.func.replace(before, after);
};
installRateLimitedWarning('163774a1197dbe4a', [
  ["node.warn('AUTOTERM-Paket mit ungültiger Struktur oder CRC verworfen');", "warnRateLimited('_autotermPacketWarnAt', 'AUTOTERM-Paket mit ungültiger Struktur oder CRC verworfen');"]
]);
installRateLimitedWarning('152e2fdda301b9e4', [
  ["node.warn('Ungültiger AUTOTERM-Sendepuffer verworfen');", "warnRateLimited('_autotermTxWarnAt', 'Ungültiger AUTOTERM-Sendepuffer verworfen');"],
  ["node.warn('AUTOTERM-Empfangspaket mit ungültiger Struktur oder CRC verworfen');", "warnRateLimited('_autotermRxWarnAt', 'AUTOTERM-Empfangspaket mit ungültiger Struktur oder CRC verworfen');"]
]);
installRateLimitedWarning('e063b67ea21aacaf', [
  ["node.warn('VanTurtle: nicht unterstützter MaxxFan-Befehl ' + action);", "warnRateLimited('_vanturtleCommandWarnAt', 'VanTurtle: nicht unterstützter MaxxFan-Befehl ' + action);"]
]);

state.func = state.func.replace(
  "    node.error('snapshot_too_large');\n    return null;",
  `    const lastOversizeLog = Number(context.get('_snapshotOversizeLogAt') || 0);
    if (now - lastOversizeLog >= 60000) {
        context.set('_snapshotOversizeLogAt', now);
        node.error('snapshot_too_large');
    }
    return null;`
).replace(/(?:const lastOversizeLog = Number\(context\.get\('_snapshotOversizeLogAt'\) \|\| 0\);\n\s*if \(now - lastOversizeLog >= 60000\) \{\n\s*context\.set\('_snapshotOversizeLogAt', now\);\n\s*node\.error\('snapshot_too_large'\);\n\s*\}\n\s*return null;)+/g, `const lastOversizeLog = Number(context.get('_snapshotOversizeLogAt') || 0);
    if (now - lastOversizeLog >= 60000) {
        context.set('_snapshotOversizeLogAt', now);
        node.error('snapshot_too_large');
    }
    return null;`);

// WebSocket-Sessions sind flüchtig und werden bereits nach 65 s ohne
// Heartbeat entfernt. Zusätzlich verhindert das harte 32-Client-Limit, dass
// ein lokaler fehlerhafter Browser beliebig viele Context-Einträge anlegt.
if (!commandRouter.func.includes('const saveClients = () => {')) {
  commandRouter.func = commandRouter.func.replace(/flow\.set\('camperWsClients', clients\);/g, 'saveClients();');
  commandRouter.func = replaceOnce(
    commandRouter.func,
    "const clients = flow.get('camperWsClients') || {};",
    `const clients = flow.get('camperWsClients') || {};
const saveClients = () => {
    const ids = Object.keys(clients).sort((a, b) => Number(clients[b] && clients[b].lastSeen || 0) - Number(clients[a] && clients[a].lastSeen || 0));
    for (const staleId of ids.slice(32)) delete clients[staleId];
    flow.set('camperWsClients', clients);
};`,
    'Begrenzte WebSocket-Clientliste'
  );
}

// Diese globalen Spiegel wurden im gesamten Master nicht gelesen. Die
// kanonischen flow-Zustände bleiben bestehen; das Entfernen spart identische
// persistente Kopien ohne einen Daten- oder Commandpfad zu verändern.
for (const node of flows) {
  if (typeof node.func === 'string') {
    node.func = node.func
      .replace("global.set('camper.indevolt', state);\n", '')
      .replace("global.set('camper.starlink', state);\n", '');
  }
}

// Sämtliche Snapshot-Anlässe laufen durch genau einen gemeinsamen Core-Gate.
// STAR-Power behält zusätzlich seinen 1-Hz-Vorgate. Die Normalisierer legen
// den jeweils neuesten Zustand vor dem Gate ab; Drop kann daher niemals einen
// neueren Sensorwert verlieren. Damit ist auch bei kombinierten D-Bus-,
// Settings-, Command- und Wetterbursts die Aggregator-Rate hart auf 2/s
// begrenzt, ohne Function-Timer oder persistente Handles.
const aggregateGateId = 'cff2c4d32221ccd8';
const aggregateId = 'ada9353cc6ea4a4c';
for (const node of flows) {
  if (node.id === aggregateGateId || !Array.isArray(node.wires)) continue;
  node.wires = node.wires.map(output => Array.isArray(output)
    ? [...new Set(output.map(target => target === aggregateId ? aggregateGateId : target))]
    : output);
}
get(aggregateGateId).wires = [[aggregateId]];

// Die zuvor benannten File-Store-Fallbacks sind nun Default-Store-Zugriffe.
// Entferne eventuell daraus entstandene unmittelbare Doppelwrites auch aus
// dem Command-Router und den übrigen Functions.
for (const node of flows) {
  for (const field of ['func', 'initialize', 'finalize']) {
    if (typeof node[field] === 'string') node[field] = useDefaultContextStore(node[field]);
  }
}

const namedFileStoreUsers = flows.filter(node => ['func', 'initialize', 'finalize'].some(field =>
  typeof node[field] === 'string'
  && /\b(?:context|flow|global)\.(?:get|set)\([^\n;]*,\s*(['"])file\1\s*\)/.test(node[field])
));
if (namedFileStoreUsers.length) {
  throw new Error('Unbekannter Context-Store file verbleibt in Nodes: ' + namedFileStoreUsers.map(node => node.id).join(', '));
}

const duplicateContextWrites = flows.filter(node => ['func', 'initialize', 'finalize'].some(field =>
  typeof node[field] === 'string'
  && /^(?:[ \t]*)(context|flow|global)\.set\(([^;\r\n]+)\);\r?\n[ \t]*(?:try \{ )?\1\.set\(\2\);/m.test(node[field])
));
if (duplicateContextWrites.length) {
  throw new Error('Unmittelbare doppelte Context-Writes verbleiben in Nodes: ' + duplicateContextWrites.map(node => node.id).join(', '));
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
