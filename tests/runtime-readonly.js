import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const flows = JSON.parse(fs.readFileSync(path.join(root, 'flows', 'CamperControl_NodeRED.json'), 'utf8'));
const byId = new Map(flows.map(node => [node.id, node]));
const store = new Map();
const flow = { get: key => store.get(key), set: (key, value) => store.set(key, value) };
const contextStore = new Map();
const context = { get: key => contextStore.get(key), set: (key, value) => contextStore.set(key, value) };
const nodeApi = { warn() {}, error() {}, status() {}, send() {} };
const run = (id, msg) => {
  const item = byId.get(id);
  if (!item || typeof item.func !== 'string') throw new Error(`Function-Node fehlt: ${id}`);
  return new Function('msg', 'flow', 'context', 'node', 'env', 'RED', item.func)(msg, flow, context, nodeApi, {}, {});
};
const read = (service, pathValue) => cache[service] && cache[service][pathValue];
const finite = value => value !== null && value !== '' && Number.isFinite(Number(value));
const bool = value => value === true;

const response = await fetch('http://venus.local:1880/victron/cache');
if (!response.ok) throw new Error(`Victron-Cache HTTP ${response.status}`);
const cache = await response.json();

// Reale, ausschließlich lesende Plattformdaten durch den Flow-Parser schicken.
const platform = cache['com.victronenergy.platform'] || {};
for (const [topic, pathValue] of [
  ['externalWifi.services', '/Network/Services'],
  ['externalWifi.enabled', '/Network/Wifi/GatewayEnabled'],
  ['externalWifi.state', '/Network/Wifi/State'],
  ['externalWifi.signal', '/Network/Wifi/SignalStrength']
]) run('external_wifi_state_update', { topic, payload: platform[pathValue] });

const wifi = store.get('camperServiceStatus') || {};
const networks = wifi.external_wifi_networks || [];
const connected = networks.find(item => item.connected);
const wifiAssertions = {
  available: wifi.external_wifi_available === 1,
  interface: wifi.external_wifi_interface === 'wlan0',
  networksFound: networks.length > 0,
  connectedNetworkFound: Boolean(connected),
  servicesAreConnmanIds: networks.every(item => /^\/net\/connman\/service\/[A-Za-z0-9_]+$/.test(item.service)),
  noPasswordFields: networks.every(item => !Object.keys(item).some(key => /pass|psk|secret/i.test(key)))
};

// FB31 (/24) und B7B8 (/25) werden fest gelesen; der Test simuliert nur die
// Verkabelung der nativen Input-Nodes zum Adapter und verändert nichts.
const temperatureServices = {
  ceiling: 'com.victronenergy.temperature/24',
  floor: 'com.victronenergy.temperature/25'
};
const temperatureValues = Object.fromEntries(Object.entries(temperatureServices).map(([role, service]) => [role, {
  deviceName: read(service, '/DeviceName'),
  batteryVoltage: read(service, '/BatteryVoltage'),
  pressure: read(service, '/Pressure'),
  humidity: read(service, '/Humidity'),
  temperature: read(service, '/Temperature')
}]));
let ruuviResult = null;
for (const [role, values] of Object.entries(temperatureValues)) {
  for (const [field, value] of Object.entries(values)) {
    const result = run('ruuvi_manual_adapter', {
      topic: `ruuvi.${role}.${field}`,
      payload: value,
      _camperSeen: Date.now()
    });
    if (result) ruuviResult = result;
  }
}
const ruuviMessages = Array.isArray(ruuviResult) && Array.isArray(ruuviResult[0]) ? ruuviResult[0] : [];
const assignment = store.get('camperTemperatureAssignment') || {};
const ceilingMessage = ruuviMessages.find(msg => msg.topic === 'ruuvi1');
const floorMessage = ruuviMessages.find(msg => msg.topic === 'ruuvi2');
const comfortMessage = ruuviMessages.find(msg => msg.topic === 'ruuvi3');
const ruuviAssertions = {
  servicesExist: Object.values(temperatureServices).every(service => Boolean(cache[service])),
  fixedCeilingService: assignment.ceilingService === temperatureServices.ceiling,
  fixedFloorService: assignment.floorConfigured === true && assignment.floorService === temperatureServices.floor,
  deviceNamesMatch: String(temperatureValues.ceiling.deviceName || '').toUpperCase().includes('FB31') && String(temperatureValues.floor.deviceName || '').toUpperCase().includes('B7B8'),
  temperaturesRead: finite(temperatureValues.ceiling.temperature) && finite(temperatureValues.floor.temperature),
  humidityRead: finite(temperatureValues.ceiling.humidity) && finite(temperatureValues.floor.humidity),
  pressureRead: finite(temperatureValues.ceiling.pressure) && finite(temperatureValues.floor.pressure),
  batteryVoltageRead: finite(temperatureValues.ceiling.batteryVoltage) && finite(temperatureValues.floor.batteryVoltage),
  ceilingOutputProduced: finite(ceilingMessage?.payload?.temp),
  floorOutputProduced: finite(floorMessage?.payload?.temp) && floorMessage?.payload?.service === temperatureServices.floor,
  comfortOutputProduced: finite(comfortMessage?.payload?.temp)
};

// Shelly und Orion werden nur gelesen. Der Test prüft reale Dienste/Pfade und
// vergleicht sie mit der exportierten Node-Konfiguration.
const shellyService = 'com.victronenergy.acload/50';
const shellyValue = read(shellyService, '/SwitchableOutput/0/State');
const shellyNode = byId.get('shelly_grid_state_out') || {};
const shellyPowered = Boolean(cache[shellyService]);
const shellyAssertions = {
  optionalPowerStateHandled: !shellyPowered || Number(shellyValue) === 0 || Number(shellyValue) === 1,
  flowServiceMatches: shellyNode.service === shellyService,
  flowPathMatches: shellyNode.path === '/SwitchableOutput/0/State'
};

// Die Batterieleistung muss wie in gui-v2 aus der aktiven, zentral vom Cerbo
// berechneten Systembatterie kommen. Eine feste SmartShunt-Instanz wäre hier
// falsch und könnte SYNC trotz vorhandener GX-Anzeige einen Nullwert liefern.
const systemService = 'com.victronenergy.system';
const systemBatteryPowerPath = '/Dc/Battery/Power';
const systemBatteryPower = read(systemService, systemBatteryPowerPath);
const systemBatteryPowerNode = byId.get('ec2c675c3d08f88c') || {};
const batteryPowerTopicNode = byId.get('357fe2bdfa339671') || {};
const batteryAssertions = {
  systemServiceExists: Boolean(cache[systemService]),
  systemBatteryPowerReadable: finite(systemBatteryPower),
  flowUsesSystemService: systemBatteryPowerNode.type === 'victron-input-system'
    && systemBatteryPowerNode.service === systemService,
  flowUsesGxBatteryPowerPath: systemBatteryPowerNode.path === systemBatteryPowerPath,
  syncSnapshotTopicPreserved: batteryPowerTopicNode.rules?.some(rule =>
    rule.p === 'topic' && rule.to === 'battery.power') === true
};

const orionService = 'com.victronenergy.alternator/289';
const orionNode = byId.get('orion_mode_out') || {};
const orionModeInput = byId.get('orion_mode_in') || {};
const orionReadPaths = ['/Dc/0/Power', '/Dc/0/Voltage', '/Dc/0/Current', '/Dc/In/V', '/Dc/In/P', '/State', '/Mode', '/ErrorCode'];
const orionAssertions = {
  serviceExists: Boolean(cache[orionService]),
  modeReadable: [1, 4].includes(Number(read(orionService, '/Mode'))),
  configuredReadPathsExist: orionReadPaths.every(pathValue => Object.prototype.hasOwnProperty.call(cache[orionService] || {}, pathValue)),
  flowServiceMatches: orionNode.service === orionService,
  flowPathMatches: orionNode.path === '/Mode',
  modeInputAcceptsRefresh: orionModeInput.service === orionService && orionModeInput.path === '/Mode' && orionModeInput.onlyChanges === false
};

// End-to-End-Struktur der beiden kritischen Lichtkanäle; weiterhin ohne Write.
const warningNode = byId.get('959137a3ca444583') || {};
const rearNode = byId.get('4afab948e3bba101') || {};
const warningController = byId.get('e0809a11d6ca3b34') || {};
const starRouter = byId.get('6a22df3c7ebe02fc') || {};
const lightAssertions = {
  warningStateOnly: warningNode.path === '/SwitchableOutput/7/State',
  rearStateOnly: rearNode.path === '/SwitchableOutput/10/State',
  distinctPaths: warningNode.path !== rearNode.path,
  noWarningDimmingOutput: !flows.some(node => node.type === 'victron-output-switch' && node.path === '/SwitchableOutput/7/Dimming'),
  warningPhysicalAndClockWiresExact: JSON.stringify(warningController.wires) === JSON.stringify([['6a22df3c7ebe02fc'], ['199eabbda79b02de']]),
  routerCh8Exact: JSON.stringify(starRouter.wires?.[7] || []) === JSON.stringify(['959137a3ca444583']),
  routerCh11Exact: JSON.stringify(starRouter.wires?.[10] || []) === JSON.stringify(['4afab948e3bba101'])
};

// API/UI-Befehle bis zum jeweiligen nativen Ausgang simulieren. Die Function-
// Nodes werden ausgeführt, die Victron-Output-Nodes selbst jedoch bewusst nicht.
const route = request => run('6265bf6f9bade1e5', { payload: Object.assign({ requestId: `readonly-${Date.now()}-${Math.random()}` }, request) });
const orionOnRoute = route({ target: 'orion', action: 'set', value: true });
const orionOffRoute = route({ target: 'orion', action: 'set', value: false });
const shellyOnRoute = route({ target: 'indevoltGrid', action: 'set', value: true });
const shellyOffRoute = route({ target: 'indevoltGrid', action: 'set', value: false });

const warningStart = run('e0809a11d6ca3b34', { topic: 'ui', payload: { action: 'toggle', channel: 8, value: 1 } });
const warningPhysical = Array.isArray(warningStart?.[0]) ? warningStart[0] : [];
const warningRouterOutputs = warningPhysical.map(message => run('6a22df3c7ebe02fc', message));
const warningOutputIndexes = [...new Set(warningRouterOutputs.flatMap(result =>
  result.map((value, index) => value != null && index !== 18 ? index : -1).filter(index => index >= 0)))].sort((a, b) => a - b);
const rearPass = run('e0809a11d6ca3b34', { topic: 'ui', payload: { action: 'toggle', channel: 11, value: 1 } });
const rearRouterOutput = run('6a22df3c7ebe02fc', rearPass[0]);
const rearOutputIndexes = rearRouterOutput.map((value, index) => value != null && index !== 18 ? index : -1).filter(index => index >= 0);

const routingAssertions = {
  orionOnGoesToOutput9Mode1: Number(orionOnRoute?.[9]?.[0]?.payload) === 1,
  orionOffGoesToOutput9Mode4: Number(orionOffRoute?.[9]?.[0]?.payload) === 4,
  shellyOnGoesToOutput11State1: Number(shellyOnRoute?.[11]?.[0]?.payload) === 1,
  shellyOffGoesToOutput11State0: Number(shellyOffRoute?.[11]?.[0]?.payload) === 0,
  warningProducesOnlyWhiteOffAndCh8State: JSON.stringify(warningOutputIndexes) === JSON.stringify([6, 7]),
  warningNeverProducesRearOutputs: !warningOutputIndexes.includes(10) && !warningOutputIndexes.includes(16),
  rearProducesOnlyCh11State: JSON.stringify(rearOutputIndexes) === JSON.stringify([10])
};

const groups = { wifi: wifiAssertions, ruuvi: ruuviAssertions, battery: batteryAssertions, shelly: shellyAssertions, orion: orionAssertions, lights: lightAssertions, routing: routingAssertions };
const failures = Object.entries(groups).flatMap(([group, values]) =>
  Object.entries(values).filter(([, value]) => !bool(value)).map(([key]) => `${group}.${key}`));

console.log(JSON.stringify({
  ok: failures.length === 0,
  liveReadOnly: true,
  wifi: { networkCount: networks.length, connectedSsid: connected?.ssid || '', state: wifi.external_wifi_state, signal: wifi.external_wifi_signal },
  ruuvi: {
    ceiling: { service: temperatureServices.ceiling, deviceName: temperatureValues.ceiling.deviceName, temperature: temperatureValues.ceiling.temperature },
    floor: { service: temperatureServices.floor, deviceName: temperatureValues.floor.deviceName, temperature: temperatureValues.floor.temperature },
    comfortTemperature: comfortMessage?.payload?.temp,
    floorConfigured: assignment.floorConfigured === true
  },
  battery: { service: systemService, path: systemBatteryPowerPath, power: systemBatteryPower, snapshotTopic: 'battery.power' },
  shelly: { service: shellyService, powered: shellyPowered, state: shellyValue, expectedOfflineWithout230V: !shellyPowered },
  orion: { service: orionService, mode: read(orionService, '/Mode'), state: read(orionService, '/State'), voltage: read(orionService, '/Dc/0/Voltage') },
  lights: { warningPath: warningNode.path, rearPath: rearNode.path, stateOnly: lightAssertions.noWarningDimmingOutput },
  simulatedEndToEnd: {
    orion: { on: orionOnRoute?.[9]?.[0]?.payload, off: orionOffRoute?.[9]?.[0]?.payload, output: 9 },
    shelly: { on: shellyOnRoute?.[11]?.[0]?.payload, off: shellyOffRoute?.[11]?.[0]?.payload, output: 11 },
    warningOutputIndexes,
    rearOutputIndexes
  },
  failures
}, null, 2));
if (failures.length) process.exit(1);
