import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const sourcePath = path.join(root, 'flows', 'CamperControl_NodeRED.json');
const publicPath = path.join(root, 'dist', 'CamperControl_NodeRED.json');
const dashboardPath = path.join(root, 'dashboard', 'camper-dashboard.html');
const dashboardV2MarkupPath = path.join(root, 'dashboard', 'camper-dashboard-v2.html');
const dashboardV2CssPath = path.join(root, 'dashboard', 'camper-dashboard-v2.css');
const transitDarkPath = path.join(root, 'dashboard', 'assets', 'transit-line-symbol-dark.png');
const transitLightPath = path.join(root, 'dashboard', 'assets', 'transit-line-symbol-light.png');
const previewPath = path.join(root, 'tools', 'preview', 'server.mjs');
const packagePath = path.join(root, 'package.json');
const starlinkHelperPath = path.join(root, 'cerbo-service', 'starlink-read-status.sh');
const deviceHttpHelperPath = path.join(root, 'cerbo-service', 'device-http-bounded.py');
const normalizeNewlines = value => value.replace(/\r\n?/g, '\n');
const sourceText = fs.readFileSync(sourcePath, 'utf8');
const publicText = fs.readFileSync(publicPath, 'utf8');
const dashboardTemplate = normalizeNewlines(fs.readFileSync(dashboardPath, 'utf8'));
const dashboardV2MarkupSource = normalizeNewlines(fs.readFileSync(dashboardV2MarkupPath, 'utf8'));
const transitDark = fs.readFileSync(transitDarkPath);
const transitLight = fs.readFileSync(transitLightPath);
const dashboardV2Markup = dashboardV2MarkupSource
  .replace('__CC2_TRANSIT_DARK_DATA_URI__', `data:image/png;base64,${transitDark.toString('base64')}`)
  .replace('__CC2_TRANSIT_LIGHT_DATA_URI__', `data:image/png;base64,${transitLight.toString('base64')}`)
  .trim();
const dashboardV2Css = normalizeNewlines(fs.readFileSync(dashboardV2CssPath, 'utf8')).trim();
const previewSource = fs.readFileSync(previewPath, 'utf8');
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const starlinkHelperSource = fs.readFileSync(starlinkHelperPath, 'utf8');
const deviceHttpHelperSource = fs.readFileSync(deviceHttpHelperPath, 'utf8');
const dashboard = dashboardTemplate
  .replace('<!-- CAMPERCONTROL_V2_MARKUP -->', dashboardV2Markup)
  .replace('/* CAMPERCONTROL_V2_CSS */', dashboardV2Css);
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
    for (const field of ['func', 'initialize', 'finalize']) {
      const code = node[field] || '';
      try {
        new Function('msg', 'flow', 'context', 'node', 'env', 'RED', code);
      } catch (error) {
        failures.push(`Function-Syntax ${node.id}.${field}: ${error.message}`);
      }
    }
    const serverCode = `${node.func || ''}\n${node.initialize || ''}\n${node.finalize || ''}`;
    check(!/\b(?:setTimeout|setInterval|clearTimeout|clearInterval)\s*\(/.test(serverCode), `${node.id} enthält keinen serverseitigen Function-Timer`);
    check(!/(?:context|flow|global)\.set\s*\(\s*['"`][^'"`]*(?:timer|timeout|interval|handle)[^'"`]*['"`]/i.test(serverCode), `${node.id} persistiert keinen Timer-/Handle-Schlüssel`);
    check(!/\b(?:context|flow|global)\.(?:get|set)\([^\n;]*,\s*(['"])file\1\s*\)/.test(serverCode), `${node.id} verwendet keinen unbekannten Context-Store file`);
  }
}

// Vollständiger Ressourcen-/Zyklus-Audit. Tarjan erfasst auch indirekte
// Node-RED-Zyklen; jeder erlaubte Zyklus muss eine echte Zeit- oder
// Benutzergrenze besitzen. Reine Function-/Change-Rückkopplungen sind damit
// als Regression ausgeschlossen.
let sccIndex = 0;
const sccStack = [];
const sccOnStack = new Set();
const sccIndices = new Map();
const sccLowLinks = new Map();
const cyclicComponents = [];
const visitScc = id => {
  sccIndices.set(id, sccIndex);
  sccLowLinks.set(id, sccIndex);
  sccIndex += 1;
  sccStack.push(id);
  sccOnStack.add(id);
  for (const target of targetsOf(id)) {
    if (!sccIndices.has(target)) {
      visitScc(target);
      sccLowLinks.set(id, Math.min(sccLowLinks.get(id), sccLowLinks.get(target)));
    } else if (sccOnStack.has(target)) {
      sccLowLinks.set(id, Math.min(sccLowLinks.get(id), sccIndices.get(target)));
    }
  }
  if (sccLowLinks.get(id) !== sccIndices.get(id)) return;
  const component = [];
  let member;
  do {
    member = sccStack.pop();
    sccOnStack.delete(member);
    component.push(member);
  } while (member !== id);
  if (component.length > 1 || targetsOf(id).includes(id)) cyclicComponents.push(component);
};
for (const node of flows) if (!sccIndices.has(node.id)) visitScc(node.id);
check(cyclicComponents.length === 3, 'Flow besitzt nur die drei bekannten, begrenzten Interaktionszyklen');
const cycleBoundaryTypes = new Set(['delay', 'trigger', 'ui-template', 'http request', 'exec']);
for (const component of cyclicComponents) {
  check(component.some(id => cycleBoundaryTypes.has(get(id).type)), `Zyklus ${component.join(',')} besitzt eine Zeit-/Benutzergrenze`);
  check(component.filter(id => get(id).type === 'ui-template').every(id => get(id).passthru === false), `UI-Grenzen in Zyklus ${component.join(',')} haben passthru=false`);
}

const repeatingInjects = flows.filter(node => node.type === 'inject' && String(node.repeat || '') !== '');
check(repeatingInjects.length === 11, 'Es existieren exakt elf periodische Injects');
for (const node of repeatingInjects) check(Number(node.repeat) >= 5, `${node.id} läuft nicht schneller als alle fünf Sekunden`);
const timedCoreNodes = flows.filter(node => node.type === 'delay' || node.type === 'trigger');
check(timedCoreNodes.length === 9, 'Alle neun Zeitgrenzen sind Core-Delay-/Trigger-Nodes');
check(flows.filter(node => node.type === 'debug').every(node => node.active === false && node.console !== true), 'Kein Debug-Node schreibt im Betrieb Logs');
check(!flows.some(node => ['file', 'file out', 'watch', 'tail'].includes(node.type)), 'Flow besitzt keinen Datei-Writer oder Dateiwächter');

const allFunctionCode = flows.filter(node => node.type === 'function').map(node => `${node.func || ''}\n${node.initialize || ''}\n${node.finalize || ''}`).join('\n');
const resourceSnapshotFunction = get('ada9353cc6ea4a4c').func || '';
const resourceSettingsFunction = get('47003434a27acbe7').func || '';
check(!/global\.set\('camper\.(?:snapshot|indevolt|starlink)'/.test(allFunctionCode), 'Keine ungenutzten globalen Duplikate persistieren Snapshot-, INDEVOLT- oder Starlink-State');
const hasImmediateDuplicateWrite = flows.filter(node => node.type === 'function').some(node => ['func', 'initialize', 'finalize'].some(field =>
  /^(?:[ \t]*)(context|flow|global)\.set\(([^;\r\n]+)\);\r?\n[ \t]*(?:try \{ )?\1\.set\(\2\);/m.test(node[field] || '')
));
check(!hasImmediateDuplicateWrite, 'Keine unmittelbar doppelten Context-Writes verbleiben');
check(!get('12f9ef01215ad8d3').func.includes('persistentStore') && (get('12f9ef01215ad8d3').func.match(/flow\.set\('autotermPersistent'/g) || []).length === 1, 'AUTOTERM besitzt genau einen persistenten Default-Store-Schreibpfad');
check(!resourceSettingsFunction.includes("else flow.set('camperConfig'") && resourceSettingsFunction.includes("const persist = () => flow.set('camperConfig', cfg);"), 'Settings schreiben Konfiguration nur bei echter Änderung oder Migration');
check(resourceSnapshotFunction.includes('const retainedEvents = events.slice(-25)') && resourceSnapshotFunction.includes('commands.slice(-Math.max(10'), 'Die letzten 25 Events und die Commands besitzen feste Retention einschließlich Legacy-Cleanup');
check(resourceSnapshotFunction.includes('const firstFreshIndex = list.findIndex') && !resourceSnapshotFunction.includes('list.shift()') && resourceSnapshotFunction.includes('list.splice(0, list.length - maxPoints)') && resourceSnapshotFunction.includes('recent: history.quarterHour.slice(-24)'), 'Historie wird linear nach Zeitfenster und harter Punktzahl beschnitten; der Snapshot enthält 24 Punkte');
check(resourceSnapshotFunction.includes('3600000, 1440);') && resourceSnapshotFunction.includes('86400000, 2880);') && resourceSnapshotFunction.includes('86400000, 365);'), 'Historie ist hart auf 1.440 Minuten-, 2.880 Viertelstunden- und 365 Tagespunkte begrenzt');
check(resourceSettingsFunction.includes('minuteHours, 24, 1, 24') && resourceSettingsFunction.includes('quarterDays, 30, 7, 30') && resourceSettingsFunction.includes('dailyDays, 365, 30, 365'), 'Historienkonfiguration bleibt bei höchstens 24 h, 30 d und 365 d');
check(resourceSettingsFunction.includes('retainCount: Math.round(number') && resourceSettingsFunction.includes('40, 10, 200'), 'Command-Retention ist auf höchstens 200 begrenzt');
check(resourceSettingsFunction.includes('.slice(0, 12).map((scene') && resourceSettingsFunction.includes('.slice(0, 30).map(item') && resourceSettingsFunction.includes('.slice(0, 20).map((task'), 'Szenen, Szenenaktionen und Wartungseinträge sind begrenzt');
check(get('6265bf6f9bade1e5').func.includes('ids.slice(32)') && resourceSnapshotFunction.includes('> 65000'), 'WebSocket-Clients sind auf 32 begrenzt und laufen nach 65 Sekunden ab');
check(get('d92d04ca2b1964f9').func.includes('MAX_PAYLOAD_BYTES = 4096') && get('d92d04ca2b1964f9').func.includes('MAX_RESPONSES_PER_SCAN = 4') && get('d92d04ca2b1964f9').func.includes('storedScan.active !== true') && get('d92d04ca2b1964f9').func.includes("typeof device !== 'object'") && get('d92d04ca2b1964f9').func.includes('scan.results = scan.results.slice(-8)'), 'INDEVOLT-Discovery akzeptiert nur aktive, begrenzte Objektantworten und höchstens acht Ergebnisse');
check(get('99e30f749692fa13').func.includes('scanAge >= 0 && scanAge <= 10000'), 'Ein hängen gebliebener INDEVOLT-Scan blockiert keinen späteren Scan');
check(get('external_wifi_state_update').func.includes('entries = entries.slice(0, 64)') && get('external_wifi_state_update').func.includes('64 * 1024'), 'WLAN-Zustand ist auf 64 Netze und 64 KiB Rohdaten begrenzt');
check(!resourceSnapshotFunction.includes("flow.set('camperSequence'") && !resourceSnapshotFunction.includes("global.set('camper.snapshot'"), 'Snapshot erzeugt keine redundanten Sequence-/Global-Writes');
check(resourceSnapshotFunction.includes('if (commandsChanged) flow.set') && resourceSnapshotFunction.includes('if (historyChanged)') && resourceSnapshotFunction.includes('if (clientsChanged) flow.set'), 'Große Context-Sammlungen werden changed-only gespeichert');
check(resourceSnapshotFunction.includes('const MAX_SNAPSHOT_BYTES = 256 * 1024') && resourceSnapshotFunction.includes("node.error('snapshot_too_large')"), 'Der vollständige lokale Snapshot ist hart auf 256 KiB begrenzt');
check(resourceSnapshotFunction.includes("const stateMessagePayload = snapshotChanged ? JSON.stringify") && resourceSnapshotFunction.includes("if (snapshotChanged) messages.push({ _session: client.session, payload: stateMessagePayload })"), 'WebSocket-Zustand wird bei Änderung genau einmal vorbereitet und erst danach verteilt');
check(get('59c75d840f413ba9').onlyChanges === true && get('camper_starlink_power_gate').func.includes('if (known && wasPowered === powered) return null;'), 'CH 5 und Starlink-State besitzen zwei changed-only-Grenzen');

const httpRequests = flows.filter(node => node.type === 'http request');
check(httpRequests.length === 2, 'Flow besitzt nur die zwei bekannten Loopback-WLAN-HTTP-Request-Nodes');
check(!httpRequests.some(node => /dwd|mosmix|weather/i.test(`${node.id} ${node.name || ''} ${node.url || ''}`)), 'Node-RED führt keinen Wetter-HTTP-Abruf aus');
check(!httpRequests.some(node => targetsOf(node.id).includes(node.id)), 'Kein HTTP-Request besitzt einen direkten Retry-Selbstloop');

check(sourceText === publicText, 'Master- und Import-Flow sind bytegleich');
check(flows.length === 372, 'Master bleibt exakt der validierte 372-Node-Flow');
check(get('vanturtle_rest_command_exec').command.endsWith('vanturtle-post'), 'VanTurtle-Sollzustände nutzen den begrenzten REST-POST');
check(get('e063b67ea21aacaf').wires[0].includes('vanturtle_rest_command_exec'), 'VanTurtle-Sollzustände laufen über begrenzten REST-Transport');
check(get('30de81a830592ed2').func.includes('selectedSpeed: speedStep * 10'), 'VanTurtle trennt Sollgeschwindigkeit und Laufzustand');
const vanturtleCommandFunction = get('e063b67ea21aacaf').func || '';
const runVanturtleCommand = (payload, current = {}) => new Function('msg', 'flow', 'context', 'node', 'env', 'RED', vanturtleCommandFunction)(
  { payload },
  { get: key => key === 'camperAdapters' ? { 'maxxfan.state': current } : undefined },
  {}, { warn: () => {} }, {}, {}
);
const decodeVanturtleRest = result => JSON.parse(Buffer.from(String(result?.[0]?.payload || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
check(JSON.stringify(decodeVanturtleRest(runVanturtleCommand({ action: 'set', value: true }, { selectedSpeed: 70 }))) === JSON.stringify({ speed: 7 })
  && JSON.stringify(decodeVanturtleRest(runVanturtleCommand({ action: 'speed', value: 40 }))) === JSON.stringify({ speed: 4 })
  && JSON.stringify(decodeVanturtleRest(runVanturtleCommand({ action: 'set', value: false }))) === JSON.stringify({ active: false })
  && JSON.stringify(decodeVanturtleRest(runVanturtleCommand({ action: 'mode', value: 'reverse' }, { mode: 'forward' }))) === JSON.stringify({ direction: 1 }), 'VanTurtle-RJ45 nutzt Herstellerbefehle für Ein, Aus, Drehzahl und freie Richtungswahl');
check(get('bd93a0e6de0de803').d === true, 'VanTurtle puffert keine periodischen WebSocket-get-Befehle während einer Trennung');
check(!get('dec0785f657dc7d1').format.includes("fanToggle(){let item=this.s.climate?.fan,next=!item?.on;if(item)item.on=next"), 'MaxxFan Ein/Aus wird nicht optimistisch verfälscht');
check(!get('dec0785f657dc7d1').format.includes('fanAuto(){')
  && !get('dec0785f657dc7d1').format.includes('@click="fanAuto"'), 'MaxxFan zeigt ohne dokumentierte Solltemperatur keine irreführende Auto-Hold-Taste');
check(packageJson.version === '4.5.0', 'Releaseversion ist 4.5.0');
check(get('dec0785f657dc7d1').format === dashboard, 'Dashboard-Node entspricht der HTML-Quelle');
check(get('3a031e0c8fe40790').repeat === '10', 'Fallback-Snapshot läuft alle 10 s');
check(!dashboard.includes('design-v1') && !dashboard.includes('fs-detail-page'), 'Dashboard enthält keine V1-Runtime oder V1-Detailseiten');
check(!dashboard.includes('detail=') && !dashboard.includes('v-if="!detail"'), 'V2 verwendet ausschließlich sein eigenes Seitenmodell');
check(dashboard.includes('@click="v2OpenPage(item.id)"'), 'V2-Navigation verwendet den gemeinsamen Seitenwechsel');

// Schnellzugriff: vier generische, backendvalidierte Aktionen statt einer
// fest verdrahteten Lichtauswahl. Alte v4-Lichtbelegungen werden migriert.
const settingsFunction = get('47003434a27acbe7').func || '';
const snapshotFunction = get('ada9353cc6ea4a4c').func || '';
check(settingsFunction.includes('cfg.version = 5'), 'Konfigurationsschema ist v5');
check(settingsFunction.includes('source.ui.quickAccessLightIds.map'), 'v4-Lichtbelegungen werden auf generische IDs migriert');
check(settingsFunction.includes('cfg.ui = { quickAccessIds,'), 'Settings speichern generische Schnellzugriff-IDs');
check(settingsFunction.includes('cfg.ui = { quickAccessIds, favoriteIds,') && settingsFunction.includes('favoriteSource.map') && settingsFunction.includes('.slice(0, 4)'), 'Settings validieren und speichern höchstens vier eigenständige Favoriten');
check(settingsFunction.includes('delete source.ui.designVersion;'), 'Settings entfernen alte V1/V2-Auswahl bei der Migration');
for (const id of ['switch:water_pump', 'switch:starlink', 'switch:dc_outlets_left', 'light:inside_main']) {
  check(settingsFunction.includes(id), `Generischer Standard-Schnellzugriff enthält ${id}`);
}
for (const target of ['device:inverter', 'device:orion', 'device:indevolt_grid', 'device:heater', 'device:maxxfan']) {
  check(snapshotFunction.includes(target), `Schnellzugriff-Katalog enthält ${target}`);
}
check(snapshotFunction.includes('quickAccessOptions, favoriteIds, favorites, weatherLocation: cfg.weatherLocation, externalWifiTileEnabled'), 'Snapshot veröffentlicht Favoriten und zentrale Wetterstandorte über den gemeinsamen Katalog');
check(snapshotFunction.includes('const resolveQuickOption = id =>') && snapshotFunction.includes('quickAccessIds.map(resolveQuickOption)') && snapshotFunction.includes('favoriteIds.map(resolveQuickOption)'), 'Schnellzugriff und Favoriten teilen genau einen sicheren Action-Resolver');
check(!snapshotFunction.includes('designVersion:'), 'Snapshot veröffentlicht keine veraltete Designauswahl');
check(snapshotFunction.includes("target: 'waterPump', action: 'set'"), 'Wasserpumpen-Schnellzugriff nutzt den validierten Router');
check(snapshotFunction.includes("target: 'scene', action: 'run'"), 'Szenen sind als Schnellzugriff auswählbar');
check(dashboard.includes('quickItems(){return Array.isArray(this.s.ui?.quickAccess)?this.s.ui.quickAccess:[]}'), 'Home-Schnellzugriff behält unverändert state.ui.quickAccess');
check(dashboard.includes('favoriteItems(){return Array.isArray(this.s.ui?.favorites)?this.s.ui.favorites:[]}') && dashboard.includes('v-for="q in favoriteItems"'), 'Linkes Sternpanel rendert ausschließlich die getrennten state.ui.favorites');
check(dashboard.includes('v2FavoriteClick(q,$event)') && dashboard.includes('this.quickActivate(item)'), 'Favoriten führen ausschließlich den vom Backend aufgelösten Befehl aus');
const favoriteToggleMethod = dashboard.match(/v2ToggleFavoriteOption\(item\)\{([^}]|\}(?!,v2EdgeStart))*\}/)?.[0] || '';
check(favoriteToggleMethod.includes('settingsPatch({ui:{favoriteIds:next}})') && !favoriteToggleMethod.includes('quickAccessIds'), 'Favoriteneditor schreibt nur ui.favoriteIds und lässt den Home-Schnellzugriff unangetastet');
check(!dashboard.includes('designV2') && !dashboard.includes('setDesignVersion'), 'Dashboard ist ausschließlich V2');
check((dashboard.match(/command\(target,action,value,extra=/g) || []).length === 1, 'V2 besitzt exakt eine gemeinsame Command-Methode');
check(dashboard.includes('id="campercontrol-v2-horizon"'), 'Dashboard enthält ausschließlich die eigenständige Transit-Horizon-Gestaltung');

// Transit Horizon V2: eigenständiges, aus der verbindlichen 800x480-Quelle
// übernommenes Markup/CSS mit denselben Live-Zuständen und Command-Helfern wie V1.
check((dashboardTemplate.match(/<!-- CAMPERCONTROL_V2_MARKUP -->/g) || []).length === 1, 'Dashboard-Template besitzt genau einen V2-Markup-Platzhalter');
check((dashboardTemplate.match(/\/\* CAMPERCONTROL_V2_CSS \*\//g) || []).length === 1, 'Dashboard-Template besitzt genau einen V2-CSS-Platzhalter');
check(!dashboard.includes('CAMPERCONTROL_V2_MARKUP') && !dashboard.includes('CAMPERCONTROL_V2_CSS'), 'Build löst beide V2-Platzhalter vollständig auf');
check(!dashboardTemplate.includes('<template v-else>') && !dashboardTemplate.includes('designV2'), 'V1-Templatezweig ist vollständig entfernt');
check(!dashboardTemplate.includes('fs-icon-sprite') && !dashboardTemplate.includes('designVersion'), 'V1-Symbole und V1-Payload sind entfernt');
check(!previewSource.includes("query.get('design')") && !previewSource.includes('designVersion:'), 'Read-only Preview kennt nur den V2-Stand');
check(dashboardV2Markup.includes('id="campercontrol-v2-horizon"'), 'V2 verwendet die Transit-Horizon-Wurzel der Designquelle');
for (const page of ['home', 'lights', 'climate', 'energy', 'water', 'system']) {
  check(dashboardV2Markup.includes(`data-page="${page}"`), `V2 enthält Seite ${page}`);
  check(dashboard.includes(`id:'${page}'`), `V2-Navigation enthält ${page}`);
}
check((dashboardV2Markup.match(/class="cc2-nav-button/g) || []).length === 0 && dashboardV2Markup.includes('v-for="item in v2Nav"'), 'V2 rendert die sechs Ziele aus genau einem Navigationsmodell');
check(dashboard.includes("v2Nav(){return[{id:'home'") && dashboard.includes("{id:'system',name:'System'"), 'V2-Navigationsmodell umfasst Home bis System');

// Edge-Swipe-Panels behalten unsichtbare Hotzones und erhalten zusätzlich zwei
// lokale Touch-Ziele im Header. Favoriten kommen aus dem zentralen Snapshot;
// Wetter ist read-only und kein Panel-Button darf Hardwarebefehle erzeugen.
check(dashboardV2Markup.includes('@pointerdown="v2EdgeStart"') && dashboardV2Markup.includes('@pointermove="v2EdgeMove"') && dashboardV2Markup.includes('@pointerup="v2EdgeEnd"'), 'Beide Panels werden über vollständige Edge-Swipe-Gesten geöffnet');
check(dashboard.includes("x<=24") && dashboard.includes("x>=rect.width-24") && dashboard.includes('Math.abs(dx)<64'), 'Unsichtbare Hotzones sind 24 px breit und erfordern 64 px Wischweg');
check(dashboard.includes("mode==='close-favorites'&&dx<0") && dashboard.includes("mode==='close-weather'&&dx>0"), 'Gegenwisch schließt linkes und rechtes Panel');
check(dashboardV2Markup.includes('class="cc2-panel-scrim"') && (dashboardV2Markup.match(/@click="v2ClosePanel"/g) || []).length >= 3, 'Scrim und beide Close-Schaltflächen schließen Panels');
check(!dashboardV2Markup.includes('cc2-panel-handle'), 'Unsichtbare Edge-Zonen bleiben ohne sichtbaren Griff');
check((dashboardV2Markup.match(/cc2-header-panel-button/g) || []).length === 2, 'Header enthält genau zwei sichtbare Panel-Schaltflächen');
check(dashboardV2Markup.includes('@click.stop="v2TogglePanel(\'favorites\')"') && dashboardV2Markup.includes('@click.stop="v2TogglePanel(\'weather\')"'), 'Stern und Wetterwolke öffnen ihre vorhandenen Panels lokal');
check(dashboardV2Markup.includes('href="#cc2-favorite-star"') && dashboardV2Markup.includes('href="#cc2-weather-partly"'), 'Header verwendet Stern und moderne Wetterwolke aus dem lokalen SVG-Satz');
check(dashboardV2Markup.includes('aria-controls="cc2-favorites-panel"') && dashboardV2Markup.includes('aria-controls="cc2-weather-panel"') && (dashboardV2Markup.match(/:aria-pressed="v2Panel===/g) || []).length === 2, 'Beide Touch-Ziele geben Ziel und aktiven Zustand barrierefrei aus');
check(/cc2-online[\s\S]*cc2-favorites-button[\s\S]*cc2-weather-button[\s\S]*cc2-theme-button[\s\S]*cc2-close-button/.test(dashboardV2Markup), 'Panel-Tasten liegen direkt hinter der Uhr und vor Theme/Schließen');
check(dashboardV2Css.includes('.cc2-header-panel-button {') && dashboardV2Css.includes('width: 42px;') && dashboardV2Css.includes('height: 42px;') && dashboardV2Css.includes('.cc2-favorites-button.is-active') && dashboardV2Css.includes('.cc2-weather-button.is-active'), '800x480-Header bietet 42-px-Touchziele mit sichtbarem Aktivzustand');
const headerReservedAt800 = 28 + 60 + 55 + 72 + 42 + 42 + 38 + 38;
check(dashboardV2Css.includes('width: 72px;') && dashboardV2Css.includes('flex: 0 0 72px;') && 800 - headerReservedAt800 >= 300, '800x480-Header reserviert feste Breiten und lässt mindestens 300 px für den Seitentitel');
const v2TogglePanelMethod = dashboard.match(/v2TogglePanel\(panel\)\{([^}]|\}(?!,v2ClosePanel))*\}/)?.[0] || '';
check(v2TogglePanelMethod.includes("panel!=='favorites'&&panel!=='weather'") && v2TogglePanelMethod.includes("this.v2Panel===panel?'':panel"), 'Ein einzelner validierter Panel-State hält die Drawer gegenseitig exklusiv');
check(!v2TogglePanelMethod.includes('this.command') && !v2TogglePanelMethod.includes('this.send'), 'Header-Panel-Tasten können keinen Backend- oder Hardwarebefehl auslösen');
check(dashboardV2Css.includes('width: min(340px, calc(100% - 44px))') && dashboardV2Css.includes('width: min(560px, calc(100% - 44px))'), 'Favoriten- und Wetterpanel besitzen 340/560 px Zielbreite');
check(dashboardV2Markup.includes('v-for="q in favoriteItems"') && dashboardV2Markup.includes(':aria-disabled="!q.available"'), 'Favoriten verwenden Auswahl, Zustand und Gating aus state.ui.favorites');
check(dashboardV2Markup.includes('v-for="option in v2FavoriteOptions"') && dashboard.includes('this.s.ui?.quickAccessOptions'), 'Favoriteneditor verwendet den vorhandenen Schnellzugriffskatalog ohne zweites Options-Payload');
check(dashboardV2Markup.includes("v2FavoriteEdit?'Favoriten auswählen':'Antippen zum Schalten'") && dashboardV2Css.includes('gap: 12px;') && dashboardV2Css.includes('text-overflow: ellipsis;'), 'Favoriten-Unterzeile bleibt kurz, begrenzt und kollisionsfrei neben Anpassen');
check(dashboard.includes('Date.now()-press.started>=600') && dashboard.includes('v2OpenFavoriteDetail(item)'), 'Langes Drücken öffnet nach 600 ms die vorhandene Detailseite ohne Timer');
check(dashboardV2Markup.includes('class="cc2-card cc2-quick-panel"') && dashboardV2Markup.includes('v-for="q in v2QuickSlots"') && dashboardV2Markup.includes('@click="quickActivate(q)"'), 'Home zeigt den eigenen Schnellzugriff immer als vier kompakte Live-Karten');
check(dashboard.includes("while(items.length<4)items.push({id:'quick-placeholder-'") && dashboardV2Markup.includes("q.placeholder?'is-placeholder':''"), 'Noch nicht geladene oder freie Schnellzugriffplätze bleiben sichtbar statt die Zeile verschwinden zu lassen');
check(dashboardV2Markup.indexOf('v-for="q in v2QuickSlots"') < dashboardV2Markup.indexOf('v-for="q in favoriteItems"'), 'Home-Schnellzugriff und linkes Favoritenpanel sind zwei getrennte Renderlisten');
check(dashboardV2Markup.includes('@click="v2OpenQuickEditor"') && dashboardV2Markup.includes('Favoriten im Sternpanel bleiben unverändert.'), 'Home besitzt einen eigenen, klar vom Favoritenpanel getrennten Schnellzugriff-Editor');
check(dashboard.includes('settingsPatch({ui:{quickAccessIds:ids}})') && dashboard.includes('this.v2QuickDraft.slice(0,4)'), 'Schnellzugriff-Editor speichert höchstens vier eigene IDs über Settings');
check(dashboardV2Css.includes('grid-template-rows: minmax(0, 1fr) 92px;') && dashboardV2Css.includes('.cc2-quick-grid { height: calc(100% - 22px);'), '800x480-Home reserviert eine feste 92-px-Schnellzugriffszeile ohne Seitenüberlauf');
const dashboardScript = dashboard.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1] || '';
check(!/\b(?:setTimeout|setInterval)\s*\(/.test(dashboardScript), 'V2-Dashboard erzeugt keine Browser-Timer');
check(!/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b/.test(dashboardScript), 'V2-Dashboard startet keinen eigenen Daten- oder Wettertransport');
check(!/\b(?:Chart|Highcharts|Plotly|ECharts)\b/.test(dashboard), 'Wetterchart benötigt keine externe Chart-Bibliothek');
check(dashboard.includes('this.s.weather') && dashboard.includes('hourly.slice(0,24)') && dashboard.includes('daily.slice(0,6)'), 'Wetterpanel liest genau 24 Stunden und sechs Tage aus state.weather');
check(dashboardV2Markup.includes('<polyline v-if="v2WeatherTempPoints"') && dashboardV2Markup.includes('v-for="bar in v2WeatherRainBars"'), 'Wetterchart zeigt Temperaturkurve und Niederschlagswahrscheinlichkeit nativ als SVG');
check(dashboardV2Markup.includes('Quelle: Deutscher Wetterdienst'), 'Wetterpanel zeigt die DWD-Attribution');
check(dashboardV2Markup.includes('cc2-weather-current')
  && dashboardV2Markup.includes('cc2-weather-chart-card')
  && dashboardV2Markup.includes('cc2-weather-forecast')
  && dashboardV2Markup.includes('Nächste 24 Stunden')
  && dashboardV2Markup.includes('6-Tage-Vorschau'), 'Node-RED verwendet dieselben drei Wetterbereiche wie die GX/WASM-Referenz');
check(dashboardV2Css.includes('.cc2-weather-content { position: absolute; left: 16px; top: 64px;')
  && dashboardV2Css.includes('.cc2-weather-current { left: 0; top: 0; width: 170px; height: 174px; }')
  && dashboardV2Css.includes('.cc2-weather-chart-card { left: 180px; top: 0;')
  && dashboardV2Css.includes('.cc2-weather-forecast { left: 0; top: 184px; width: 100%; height: 174px; }'), 'Wetterkarten übernehmen das feste 170/348/528-Pixel-Raster der GX/WASM-Referenz');
check(dashboardV2Markup.includes('cc2-weather-title-icon')
  && dashboardV2Markup.includes('<use href="#cc2-climate"></use>')
  && dashboardV2Css.includes('.cc2-weather-title-icon { position: absolute; left: 17px; top: 14px; width: 27px; height: 27px;'), 'Wetterkopf verwendet Geometrie und blaues Klima-Icon der GX/WASM-Referenz');
check(dashboardV2Markup.includes('@change="v2SetLocation(\'weather\',$event.target.value)"')
  && dashboardV2Markup.includes('@change="v2SetLocation(\'tide\',$event.target.value)"')
  && dashboardV2Markup.includes('BSH-Nordseestation'), 'Node-RED bietet unabhängige Wetter- und Tideauswahl im gemeinsamen V2-Design');
check(dashboardV2Markup.includes('<details class="cc2-data-license"><summary>Datenquellen &amp; Lizenzen</summary>')
  && dashboardV2Markup.includes('Quelle: Deutscher Wetterdienst · CC BY 4.0')
  && dashboardV2Markup.includes('© Bundesamt für Seeschifffahrt und Hydrographie (BSH) · CC BY 4.0')
  && dashboardV2Markup.includes('CamperControl-Software · PolyForm Noncommercial 1.0.0')
  && dashboardV2Css.includes('.cc2-data-license[open]'), 'Daten- und Softwarelizenzen bleiben standardmäßig geschlossen unter Wetter/Tide');
check(dashboard.includes("this.settingsPatch({weatherLocation:next})")
  && dashboard.includes('if(raw.length>1024)return')
  && dashboard.includes("sectionName!=='weather'&&sectionName!=='tide'"), 'Standortauswahl schreibt ausschließlich einen begrenzten validierten Settings-Patch');
check(dashboard.includes("id:'10113'") && dashboard.includes("id:'wilhelmshaven_alter_vorhafen'")
  && dashboard.includes("name:'GPS / automatisch'"), 'Node-RED nutzt dieselben benannten DWD-/BSH-Optionen und den GPS-Standard');
check(!/id:'[^']*(?:binnenpegel|binnenschifffahrt|wehr_unterpegel)/i.test(dashboard), 'Node-RED bietet keine Binnengewässer- oder Binnenpegelstation an');
const v2LightZoneOrder = [...((dashboard.match(/v2LightZones\(\)\{return\[(.*?)\]\}/) || [])[1] || '').matchAll(/key:'([^']+)'/g)].map(match => match[1]);
check(JSON.stringify(v2LightZoneOrder) === JSON.stringify(['inside', 'rear', 'left', 'right']), 'Lichtmatrix ordnet oben Innen/Hinten und darunter Links/Rechts an');

const weatherInput = get('weather_state_in');
const weatherValidator = get('weather_state_validate');
check(weatherInput.type === 'victron-input-custom' && weatherInput.service === 'com.victronenergy.campercontrol/0' && weatherInput.path === '/State/Weather', 'Wetter kommt ausschließlich vom zentralen CamperControl-D-Bus-Pfad');
check(weatherInput.onlyChanges === true && JSON.stringify(weatherInput.wires) === JSON.stringify([['weather_state_validate']]), 'Wetter-D-Bus-Eingang sendet nur Änderungen an den Validator');
check(weatherValidator.type === 'function' && JSON.stringify(weatherValidator.wires) === JSON.stringify([['cff2c4d32221ccd8']]), 'Validiertes Wetter läuft ausschließlich durch den gemeinsamen Snapshot-Gate');
check(weatherValidator.func.includes('const MAX_BYTES = 16 * 1024') && weatherValidator.func.includes('source.schema !== 1') && weatherValidator.func.includes('source.hourly.length > 48') && weatherValidator.func.includes('source.daily.length > 6'), 'Wettervalidator erzwingt 16 KiB, Schema 1, 48 Stunden und sechs Tage');
check(weatherValidator.func.includes("flow.get('camperWeather')") && weatherValidator.func.includes('if (previousJson === canonical) return null'), 'Wettertransport ist changed-only und erzeugt keinen Feedback-Loop');
check(!/\b(?:setTimeout|setInterval|fetch|XMLHttpRequest)\b/.test(weatherValidator.func), 'Wettervalidator besitzt weder Timer noch HTTP-Transport');
check(snapshotFunction.includes("const weatherStored = flow.get('camperWeather');") && snapshotFunction.includes('    weather,'), 'Snapshot veröffentlicht das validierte Wetter zentral für Ford und Dashboard');
const weatherLocationInput = get('weather_location_settings_in');
const weatherLocationValidator = get('weather_location_settings_validate');
const weatherLocationOutput = get('weather_location_settings_out');
check(weatherLocationInput.type === 'victron-input-custom'
  && weatherLocationInput.service === 'com.victronenergy.campercontrol/0'
  && weatherLocationInput.path === '/Settings/WeatherLocation'
  && weatherLocationInput.onlyChanges === true
  && JSON.stringify(weatherLocationInput.wires) === JSON.stringify([['weather_location_settings_validate']]), 'Node-RED liest Wetterstandorte changed-only vom zentralen Cerbo-Pfad');
check(weatherLocationValidator.type === 'function'
  && weatherLocationValidator.func.includes('const MAX_BYTES = 1024')
  && weatherLocationValidator.func.includes("_weatherLocationFromCerbo: true")
  && JSON.stringify(weatherLocationValidator.wires) === JSON.stringify([['47003434a27acbe7']]), 'Cerbo-Wetterstandorte werden begrenzt validiert in den vorhandenen Settings-Patch gespiegelt');
check(weatherLocationOutput.type === 'victron-output-custom'
  && weatherLocationOutput.service === 'com.victronenergy.campercontrol/0'
  && weatherLocationOutput.path === '/Settings/WeatherLocation'
  && weatherLocationOutput.onlyChanges === true, 'Settings schreiben ausschließlich den validierten zentralen Wetterstandort-Pfad');
check(get('47003434a27acbe7').outputs === 5
  && JSON.stringify(get('47003434a27acbe7').wires?.[4]) === JSON.stringify(['weather_location_settings_out']), 'Vorhandener Settings-Patch besitzt genau einen Wetterstandort-Ausgang zum Cerbo');
const runWeatherLocationValidator = payload => new Function('msg', 'flow', 'context', 'node', 'env', 'RED', weatherLocationValidator.func)(
  { payload }, {}, {}, {}, {}, {}
);
const validWeatherLocation = { schema: 1, weather: { mode: 'station', stationId: 'a1234' }, tide: { mode: 'station', stationId: 'wilhelmshaven_alter_vorhafen' } };
const mirroredWeatherLocation = runWeatherLocationValidator({ value: JSON.stringify(validWeatherLocation) });
check(mirroredWeatherLocation?._weatherLocationFromCerbo === true
  && mirroredWeatherLocation?.payload?.patch?.weatherLocation?.weather?.stationId === 'A1234'
  && mirroredWeatherLocation?.payload?.patch?.weatherLocation?.tide?.stationId === 'wilhelmshaven_alter_vorhafen', 'Zentrale Standortauswahl normalisiert DWD-ID und hält Tide getrennt');
check(runWeatherLocationValidator(JSON.stringify({ ...validWeatherLocation, tide: { mode: 'station', stationId: 'Baltic Gauge' } })) === null
  && runWeatherLocationValidator(JSON.stringify({ ...validWeatherLocation, weather: { mode: 'automatic', stationId: '' } })) === null
  && runWeatherLocationValidator('x'.repeat(1025)) === null, 'Ungültige Modi, Stations-IDs und übergroße Standortwerte erreichen den Settings-Patch nicht');
const weatherStore = new Map();
const weatherFlow = { get: key => weatherStore.get(key), set: (key, value) => weatherStore.set(key, value) };
const weatherNode = { status() {} };
const runWeatherValidator = payload => new Function('msg', 'flow', 'context', 'node', 'env', 'RED', weatherValidator.func)(
  { payload }, weatherFlow, {}, weatherNode, {}, {}
);
const weatherFixture = {
  schema: 1,
  source: 'DWD MOSMIX_L',
  attribution: 'Quelle: Deutscher Wetterdienst',
  license: 'CC BY 4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  changes: 'Stationsauswahl, Normalisierung und Tagesaggregation durch CamperControl',
  station: { id: '10641', name: 'Köln/Bonn' },
  modelRunUtc: '2026-08-20T00:00:00Z',
  fetchedAtUtc: '2026-08-20T05:00:00Z',
  stale: false,
  timezone: 'Europe/Berlin',
  sun: { date: '2026-08-20', riseUtc: '2026-08-20T04:20:00Z', setUtc: '2026-08-20T18:45:00Z', origin: 'calculated' },
  hourly: [{ t: '2026-08-20T06:00:00Z', tempC: 18.2, precipProbabilityPct: 30, precipMm: 0.2, ww: 61, icon: 'rain', windKmh: 12, windDeg: 240, gustKmh: 24, latitude: 50.8 }],
  daily: [{ date: '2026-08-20', minC: 12, maxC: 22, precipMm: 1.4, maxHourlyPrecipProbabilityPct: 60, ww: 61, icon: 'rain', windMaxKmh: 18, gustMaxKmh: 30, riseUtc: '2026-08-20T04:20:00Z', setUtc: '2026-08-20T18:45:00Z' }],
  tides: {
    source: 'BSH', attribution: '© Bundesamt für Seeschifffahrt und Hydrographie (BSH)',
    license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    changes: 'Nordseestationsauswahl, UTC-Normalisierung, cm→m und Kurvenreduktion durch CamperControl',
    station: { id: 'cuxhaven_steubenhoeft', name: 'Cuxhaven, Steubenhöft', distanceKm: 12.4, latitude: 53.86, longitude: 8.71 },
    updatedUtc: '2026-08-20T05:00:00Z', stale: false, referenceLevel: 'PNP',
    nextHigh: { t: '2026-08-20T08:20:00Z', heightM: 7.31 },
    nextLow: { t: '2026-08-20T14:35:00Z', heightM: 4.68 },
    curve: [
      { t: '2026-08-20T06:00:00Z', heightM: 5.8 },
      { t: '2026-08-20T07:00:00Z', heightM: 6.7 },
      { t: '2026-08-20T08:00:00Z', heightM: 7.3 }
    ]
  }
};
const acceptedWeather = runWeatherValidator({ value: JSON.stringify(weatherFixture) });
check(acceptedWeather?.topic === 'weather' && acceptedWeather?.payload?.schema === 1 && acceptedWeather.payload.license === 'CC BY 4.0' && acceptedWeather.payload.licenseUrl === 'https://creativecommons.org/licenses/by/4.0/' && acceptedWeather?.payload?.tides?.nextHigh?.heightM === 7.31 && acceptedWeather.payload.tides.license === 'CC BY 4.0' && acceptedWeather.payload.tides.curve.length === 3, 'Gültiges D-Bus-Wetter samt CC-BY-Hinweisen und kompakter Tidekurve wird als Snapshot-Änderung übernommen');
check(weatherStore.get('camperWeather')?.hourly?.[0]?.latitude === undefined && weatherStore.get('camperWeather')?.tides?.station?.latitude === undefined && weatherStore.get('camperWeather')?.tides?.station?.longitude === undefined, 'Wettervalidator whitelisted Felder und übernimmt keine GPS-Koordinaten');
check(runWeatherValidator(JSON.stringify(weatherFixture)) === null, 'Identisches Wetter erzeugt keine zweite Snapshot-Aktualisierung');
const nullHeightTides = { ...weatherFixture, fetchedAtUtc: '2026-08-20T05:00:01Z', tides: { ...weatherFixture.tides, nextLow: { ...weatherFixture.tides.nextLow, heightM: null } } };
check(runWeatherValidator(JSON.stringify(nullHeightTides))?.payload?.tides?.nextLow?.heightM === null, 'BSH-Ereignis ohne belastbare Höhe bleibt mit null erhalten und wird nicht zu 0 erfunden');
const wrongTideSource = { ...weatherFixture, fetchedAtUtc: '2026-08-20T05:00:02Z', tides: { ...weatherFixture.tides, source: 'unofficial' } };
check(runWeatherValidator(JSON.stringify(wrongTideSource))?.payload?.tides === undefined, 'Nur der explizite BSH-Tidevertrag wird akzeptiert');
const wrongTideLicense = { ...weatherFixture, fetchedAtUtc: '2026-08-20T05:00:02Z', tides: { ...weatherFixture.tides, license: 'proprietary' } };
check(runWeatherValidator(JSON.stringify(wrongTideLicense))?.payload?.tides === undefined, 'BSH-Tide ohne den validierten CC-BY-4.0-Hinweis wird fail-closed entfernt');
const invalidTideTime = { ...weatherFixture, fetchedAtUtc: '2026-08-20T05:00:03Z', tides: { ...weatherFixture.tides, nextHigh: { ...weatherFixture.tides.nextHigh, t: 'not-a-date' } } };
check(runWeatherValidator(JSON.stringify(invalidTideTime))?.payload?.tides === undefined, 'Ungültige BSH-Ereigniszeit wird fail-closed entfernt');
const acceptedBoundaryTideCurve = { ...weatherFixture, fetchedAtUtc: '2026-08-20T05:00:04Z', tides: { ...weatherFixture.tides, curve: Array.from({ length: 27 }, (_, index) => ({ t: new Date(Date.UTC(2026, 7, 20, 6 + index)).toISOString(), heightM: 5 })) } };
check(runWeatherValidator(JSON.stringify(acceptedBoundaryTideCurve))?.payload?.tides?.curve?.length === 27, '25 Tidekurvenpunkte plus zwei 24-h-Randpunkte werden akzeptiert');
const oversizedTideCurve = { ...weatherFixture, fetchedAtUtc: '2026-08-20T05:00:05Z', tides: { ...weatherFixture.tides, curve: Array.from({ length: 28 }, (_, index) => ({ t: new Date(Date.UTC(2026, 7, 20, 6 + index)).toISOString(), heightM: 5 })) } };
check(runWeatherValidator(JSON.stringify(oversizedTideCurve))?.payload?.tides === undefined, 'Mehr als 27 Tidepunkte werden ressourcenschonend verworfen');
const unsortedTideCurve = { ...weatherFixture, fetchedAtUtc: '2026-08-20T05:00:05Z', tides: { ...weatherFixture.tides, curve: [...weatherFixture.tides.curve].reverse() } };
check(runWeatherValidator(JSON.stringify(unsortedTideCurve))?.payload?.tides === undefined, 'Nicht chronologische Tidepunkte werden verworfen');
const nullTideCurve = { ...weatherFixture, fetchedAtUtc: '2026-08-20T05:00:06Z', tides: { ...weatherFixture.tides, curve: weatherFixture.tides.curve.map((point, index) => index === 1 ? { ...point, heightM: null } : point) } };
check(runWeatherValidator(JSON.stringify(nullTideCurve))?.payload?.tides === undefined, 'Tidekurven erfinden für fehlende Höhen keinen Nullpegel');
const farInlandTides = { ...weatherFixture, fetchedAtUtc: '2026-08-20T05:00:07Z', tides: { ...weatherFixture.tides, station: { ...weatherFixture.tides.station, distanceKm: 642.2 } } };
check(runWeatherValidator(JSON.stringify(farInlandTides))?.payload?.tides?.station?.distanceKm === 642.2, 'Gültige Nordsee-Fallback-Tide bleibt auch deutlich jenseits des 60-km-Suchradius sichtbar');
const invalidTides = { ...weatherFixture, fetchedAtUtc: '2026-08-20T05:00:08Z', tides: { ...weatherFixture.tides, station: { ...weatherFixture.tides.station, distanceKm: 20051 } } };
const acceptedWithoutInvalidTides = runWeatherValidator(JSON.stringify(invalidTides));
check(acceptedWithoutInvalidTides?.payload?.schema === 1 && acceptedWithoutInvalidTides.payload.tides === undefined, 'Physikalisch unmögliche Tideentfernung wird entfernt, ohne DWD-Wetter zu blockieren');
check(runWeatherValidator(JSON.stringify(weatherFixture))?.payload?.tides?.station?.id === 'cuxhaven_steubenhoeft', 'Nach einer ungültigen Tide kann der nächste gültige BSH-Zustand wieder übernommen werden');
const retainedWeather = JSON.stringify(weatherStore.get('camperWeather'));
check(runWeatherValidator(JSON.stringify({ ...weatherFixture, schema: 2 })) === null && JSON.stringify(weatherStore.get('camperWeather')) === retainedWeather, 'Ungültiges Wetterschema ersetzt den letzten gültigen Cache nicht');
const incompleteWeather = { ...weatherFixture, hourly: [{ ...weatherFixture.hourly[0] }] };
delete incompleteWeather.hourly[0].windDeg;
check(runWeatherValidator(JSON.stringify(incompleteWeather)) === null && JSON.stringify(weatherStore.get('camperWeather')) === retainedWeather, 'Fehlende Schemafelder werden nicht stillschweigend zu null normalisiert');
const invalidTimeWeather = { ...weatherFixture, hourly: [{ ...weatherFixture.hourly[0], t: 'not-a-date' }] };
check(runWeatherValidator(JSON.stringify(invalidTimeWeather)) === null && JSON.stringify(weatherStore.get('camperWeather')) === retainedWeather, 'Ungültige Wetterzeitstempel werden verworfen');
check(runWeatherValidator('x'.repeat(16 * 1024 + 1)) === null && JSON.stringify(weatherStore.get('camperWeather')) === retainedWeather, 'Überlanges Wetter wird verworfen ohne den Cache zu verändern');
check(dashboard.includes('v2Tides') && dashboard.includes('v2TidePoints') && dashboard.includes('v2TideScale') && dashboard.includes('v2WeatherChartWindow') && dashboard.includes('tide.length>=2?new Date(tide[0].date)') && dashboard.includes('24*60*60*1000') && dashboard.includes("return'BSH Tide '") && dashboardV2Markup.includes('cc2-weather-sun-tide') && dashboardV2Markup.includes('cc2-chart-tide'), 'Wetterpanel zeigt Sonne, BSH-HW/NW und die Tidekurve auf derselben echten 24-h-Zeitachse ohne einen gerundeten DWD-Rand abzuschneiden');
check(dashboard.includes("value?.license!=='CC BY 4.0'")
  && dashboard.includes("value?.licenseUrl!=='https://creativecommons.org/licenses/by/4.0/'")
  && dashboard.includes("typeof value?.changes!=='string'"), 'Dashboard akzeptiert Tide nur mit dem validierten CC-BY-Metadatenvertrag');
check(dashboard.includes('v2TemperatureScale') && dashboardV2Markup.includes('cc2-chart-temp-scale') && dashboardV2Markup.includes('v2TemperatureScale.min') && dashboardV2Markup.includes('v2TemperatureScale.max') && dashboardV2Css.includes('.cc2-chart-temp-scale text'), 'Wetterchart zeigt eine numerische linke Temperaturachse in Grad Celsius');
check(["'freezing-rain':'cc2-weather-freezing-rain'", "sleet:'cc2-weather-sleet'", "hail:'cc2-weather-hail'"].every(token => dashboard.includes(token)) && ['cc2-weather-freezing-rain', 'cc2-weather-sleet', 'cc2-weather-hail'].every(icon => dashboardV2Markup.includes(`id="${icon}"`)), 'Dashboard unterscheidet gefrierenden Niederschlag, Schneeregen und defensiven DWD-Hagel visuell');
check(dashboard.includes("||'cc2-weather-unknown'") && dashboardV2Markup.includes('id="cc2-weather-unknown"'), 'Unbekannte DWD-Codes bleiben neutral und werden nicht als bewölkt erfunden');
check(dashboardV2Markup.includes('--cc2-weather-line')
  && dashboardV2Markup.includes('--cc2-weather-sun')
  && dashboardV2Markup.includes('--cc2-weather-rain')
  && dashboardV2Css.includes('--cc2-weather-line: light-dark(#10161a, #f3f7fa)')
  && dashboardV2Css.includes('--cc2-weather-sun: light-dark(#9b5b00, #f4c94c)')
  && dashboardV2Css.includes('--cc2-weather-rain: light-dark(#006f9f, #59caff)'), 'Node-RED-Wettersymbole spiegeln die mehrfarbigen GX/WASM-Canvas-Linien für Kontur, Sonne und Niederschlag');
check(dashboardV2Css.includes('.cc2-chart-tide { fill: none; stroke: light-dark(#008da3, #63e6f2); stroke-width: 1.8;')
  && !dashboardV2Css.includes('stroke-dasharray'), 'Tide erscheint wie in GX/WASM als durchgezogene türkisfarbene Kurve');
check(!dashboardV2Markup.includes('DWD · MOSMIX')
  && !dashboardV2Markup.includes('cc2-weather-summary')
  && !dashboardV2Markup.includes('cc2-weather-freshness'), 'Die abweichende alte Node-RED-Wettergestaltung ist vollständig entfernt');

const transitSymbols = [...dashboardV2Markup.matchAll(/class="cc2-brand-line-(?:dark|light)" src="data:image\/png;base64,([^"]+)"/g)];
check((dashboardV2MarkupSource.match(/__CC2_TRANSIT_(?:DARK|LIGHT)_DATA_URI__/g) || []).length === 2, 'V2-Quelle bindet beide Transit-Symbole reproduzierbar aus dashboard/assets ein');
check(transitSymbols.length === 2, 'V2 bettet beide Transit-Liniensymbole updatefest ein');
const transitHashes = transitSymbols.map(match => crypto.createHash('sha256').update(Buffer.from(match[1], 'base64')).digest('hex'));
check(transitHashes[0] === 'f54f528af869c6f3cc2dec1a7b90ae730b6df1d431f67aeb55328ba1fd6aa605', 'Dunkles Transit-Liniensymbol ist das transparente SYNC-Referenzasset mit FORD-Grill');
check(transitHashes[1] === '2b67063319cdb66767cca2229996b9e6161a849eddd6b0941fb5f984cf1a594f', 'Helles Transit-Liniensymbol ist das transparente SYNC-Referenzasset mit FORD-Grill');
check(dashboardV2Css.includes('padding: 0;')
  && dashboardV2Css.includes('border-radius: 0;')
  && dashboardV2Css.includes('position: fixed !important;')
  && dashboardV2Css.includes('inset: 0 !important;')
  && dashboardV2Css.includes('.fs-app.day { background: #edf2f4 !important; }'), 'V2 löst sich aus dem Dashboard-Grid und zeichnet Tag/Nacht bis an alle vier Browserkanten');
check(dashboardV2Markup.includes('id="cc2-close"') && dashboardV2Markup.includes('@click="v2Close"'), 'V2 besitzt oben rechts die dedizierte Schließen-/Zurück-Aktion');
const v2CloseMethod = dashboard.match(/v2Close\(\)\{([^}]|\}(?!\s*,indevoltToggle))*\}/)?.[0] || '';
check(v2CloseMethod.includes('window.history.back()') && v2CloseMethod.includes('window.close()') && v2CloseMethod.includes('window.location.replace'), 'V2-Schließen verwendet Verlauf, Fenster oder sichere Browsernavigation');
check(!v2CloseMethod.includes('this.command') && !v2CloseMethod.includes('this.send'), 'V2-Schließen kann keinen Hardwarebefehl auslösen');

for (const asset of ['/camper-assets/VehicleLightsLeft.png', '/camper-assets/VehicleLightsRight.png']) {
  check(dashboardV2Markup.includes(asset), `V2 verwendet reales Fahrzeugbild ${asset}`);
}
for (const coordinate of ['left:63.7%;top:32.2%', 'left:77.69%;top:3.19%', 'left:73.29%;top:0', 'left:27.56%;top:6.41%', 'left:31.72%;top:32.2%', 'left:7.78%;top:4.86%', 'left:3.83%;top:0', 'left:40.9%;top:.6%']) {
  check(dashboardV2Markup.includes(coordinate), `V2-Fotohotspot entspricht der Designquelle: ${coordinate}`);
}
for (const geometry of ['x1="168" y1="49" x2="317" y2="49"', 'x="368" y="34" width="16" height="7"', 'x="432" y="5" width="14" height="14"', 'x1="263" y1="36" x2="399" y2="41"', 'x="63" y="41" width="16" height="7"', 'x="43" y="5" width="14" height="14"']) {
  check(dashboardV2Markup.includes(geometry), `Sichtbarer Lichtkörper sitzt in exakter 560x360-Assetgeometrie: ${geometry}`);
}
check(dashboardV2Markup.includes('class="cc2-transit-canvas"') && dashboardV2Css.includes('aspect-ratio: 560 / 360;'), 'Bild, SVG-Lichtkörper und Touchzonen teilen dieselbe unverzerrte 560x360-Fläche');
for (const id of ['inside_main', 'outside_left', 'outside_right', 'outside_rear', 'outside_front_white', 'outside_front_amber']) {
  check(dashboard.includes(id), `V2-Lichtmodell nutzt reale Licht-ID ${id}`);
}
check(dashboardV2Markup.includes('v2ToggleZone(zone.key)') && dashboard.includes("v2ToggleZone(zone){"), 'V2-Lichtkarten schalten über den gemeinsamen Live-Helfer');
check(dashboard.includes("this.lightToggle(item)") && dashboard.includes("this.highBeamToggle()"), 'V2-Licht und Fernlicht enden in den vorhandenen STAR-Power-Befehlen');
check(dashboardV2Markup.includes("@click=\"v2ToggleZone('highbeam')\"") && dashboardV2Markup.includes(':disabled="!highBeam.outputOnline"'), 'Fernlicht CH3 ist per Foto und Karte schaltbar und bei fehlendem Ausgang gesperrt');
check(dashboardV2Markup.includes('class="cc2-dimmer-range"') && dashboardV2Markup.includes('@change="v2Dim"'), 'V2 besitzt den permanenten Dimmer für die ausgewählte Zone');
check(dashboard.includes("this.lightDim(this.v2SelectedLight,event)"), 'V2-Dimmer verwendet den vorhandenen STAR-Power-Dimmbefehl');
for (const scene of ['camping', 'night', 'all_off']) check(dashboardV2Markup.includes(`v2Scene('${scene}')`), `V2-Lichtseite bietet reale Szene ${scene}`);
check(dashboardV2Markup.includes('@click="v2OpenLightSceneEditor(\'camping\')"')
  && dashboardV2Markup.includes('Lichtszenen Camping, Nacht und Alles aus anpassen')
  && dashboardV2Markup.includes('v2LightSceneEdit'), 'Die Lichtseite öffnet den Camping-/Nacht-Editor direkt über „Anpassen“');
check(dashboardV2Markup.includes('Wie zuvor')
  && dashboardV2Markup.includes("v2SetSceneLightMode(light,'off')")
  && dashboardV2Markup.includes("v2SetSceneLightMode(light,'on')")
  && dashboardV2Markup.includes('v2SetSceneLightDim(light,$event)'), 'Lichtprofile unterstützen unverändert, aus, ein und Dimmen');
check(dashboard.includes("settingsPatch({lightingScenes:{[this.v2LightSceneId]:values}})")
  && !dashboard.includes("command('lightingScenes'"), 'Szenen-Anpassen speichert ausschließlich über den Settings-Pfad und schaltet beim Bearbeiten keine Hardware');
check(settingsFunction.includes('const sanitizeLightingScene = sceneId =>')
  && settingsFunction.includes("camping: sanitizeLightingScene('camping')")
  && settingsFunction.includes("night: sanitizeLightingScene('night')")
  && settingsFunction.includes("all_off: sanitizeLightingScene('all_off')"), 'Cerbo validiert und besitzt ausschließlich die drei editierbaren Lichtprofile');
check(snapshotFunction.includes("lightScenes: ['camping', 'night', 'all_off'].map")
  && snapshotFunction.includes('cfg.lightingScenes && cfg.lightingScenes[sceneId]'), 'Snapshot verteilt die Cerbo-eigenen Lichtprofile an alle Oberflächen');

check(dashboardV2Markup.includes("v2EnergyPane='power'") && dashboardV2Markup.includes("v2EnergyPane='sources'"), 'V2-Energie behält 12/230 V und Quellen als zwei Ansichten');
check(dashboard.includes('v2PowerChannels(){return this.powerChannels.slice(0,5)}'), 'V2-Energie begrenzt die sichtbare DC-Verteilung auf fünf reale Verbraucher');
check(dashboardV2Markup.includes('v-for="item in v2PowerChannels"') && dashboardV2Markup.includes('@click="dcToggle(item)"'), 'Fünf DC-Karten verwenden reale Zustände und Befehle');
check(!dashboardV2Markup.includes('data-channel=') && !/>CH\s*\d/i.test(dashboardV2Markup), 'V2 zeigt weder Kanalnummern noch technische Kanaltexte');
check(dashboardV2Markup.includes('cc2-action-state">{{item.on') && dashboardV2Css.includes('.cc2-channel .cc2-action-state { position: absolute'), 'DC-Zustände sind nur barrierefrei und visuell/farblich, nicht als Statustext sichtbar');
check(dashboardV2Markup.includes('@click="inverterToggle"') && dashboardV2Markup.includes('s.power?.inverter?.outputPower'), '230-V-Karte verwendet MultiPlus-Live-State und bestehenden Befehl');
check(dashboardV2Markup.includes(':disabled="!s.energy?.orion?.online"') && dashboardV2Markup.includes("s.energy?.orion?.online?fmt(s.energy?.orion?.power,0):'–'"), 'Orion ist offline gesperrt und zeigt dann ausschließlich Striche');
check(dashboardV2Markup.includes('@click="orionToggle"') && dashboard.includes("command('orion','set'"), 'Lichtmaschine verwendet den realen Orion-Command');
check(dashboardV2Markup.includes('@click="indevoltToggle"') && dashboard.includes("command('indevoltGrid','set'"), 'INDEVOLT Netz verwendet den vorhandenen Shelly/Victron-Command');
check(dashboardV2Markup.includes(':disabled="!s.energy?.indevolt?.online"') && !dashboardV2Markup.includes(':disabled="!s.energy?.indevolt?.gridConnection?.available"'), 'INDEVOLT bleibt bei online sichtbarer Karte aktiv, auch wenn nur der Netzanschluss fehlt');
check(dashboardV2Markup.includes('data-energy-pane="solar-detail"') && dashboardV2Markup.includes('v-for="c in s.energy?.solar?.chargers||[]"'), 'Solar-Gesamtdetail rendert die echten Victron-Laderegler');
const energyCss = (dashboardV2Css.match(/\.cc2-energy-layout[\s\S]*?\.cc2-water-gauge/) || [''])[0];
check(energyCss.includes('height: 100%') && energyCss.includes('minmax(0, 1.65fr) minmax(210px, .85fr)') && energyCss.includes('grid-template-rows: repeat(2, 1fr)') && !/transform:\s*scale/.test(energyCss), 'Energie nutzt die volle Seite mit begrenzten Grid-Spalten ohne verzerrende Skalierung');
check(dashboardV2Markup.includes('s.energy?.indevolt?.solarPower') && dashboardV2Markup.includes('s.energy?.indevolt?.batteryPower'), 'Solar-Gesamtdetail enthält echte INDEVOLT-Werte');
check(snapshotFunction.includes('totalSolarPower: victronSolar == null ? null : Number(victronSolar)'), 'Solar gesamt verwendet ausschließlich den Victron-SystemCalc-MPPT-Aggregatwert');
check(!snapshotFunction.includes('Number(victronSolar || 0) + Number(indevoltSolar || 0)'), 'INDEVOLT-Solar wird nicht mehr in Solar gesamt eingerechnet');
const batteryPowerInput = get('ec2c675c3d08f88c');
check(batteryPowerInput.type === 'victron-input-system'
  && batteryPowerInput.service === 'com.victronenergy.system'
  && batteryPowerInput.path === '/Dc/Battery/Power'
  && batteryPowerInput.serviceObj?.service === 'com.victronenergy.system'
  && batteryPowerInput.pathObj?.path === '/Dc/Battery/Power', 'Batterieleistung nutzt exakt Global.system.battery.power aus der originalen gui-v2');
check(batteryPowerInput.onlyChanges === false
  && targetsOf(batteryPowerInput.id).includes('357fe2bdfa339671')
  && get('357fe2bdfa339671').rules?.some(rule => rule.p === 'topic' && rule.to === 'battery.power'), 'Cerbo-Systembatteriepfad behält Polling und das von SYNC gelesene Zieltopic bei');
const batteryTimeToGoInput = get('e5ad58b50715f803');
check(batteryTimeToGoInput.type === 'victron-input-battery'
  && batteryTimeToGoInput.service === 'com.victronenergy.battery/277'
  && batteryTimeToGoInput.path === '/TimeToGo'
  && batteryTimeToGoInput.onlyChanges === false
  && targetsOf(batteryTimeToGoInput.id).includes('b63589bfb672e634')
  && get('b63589bfb672e634').rules?.some(rule => rule.p === 'topic' && rule.to === 'battery.timeToGo'), 'SmartShunt-Restlaufzeit wird gepollt und kann bei unverändertem D-Bus-Wert nicht veralten');
const dcSystemPowerInput = get('6b67bafd0f8833d1');
check(dcSystemPowerInput.type === 'victron-input-system'
  && dcSystemPowerInput.service === 'com.victronenergy.system'
  && dcSystemPowerInput.path === '/Dc/System/Power'
  && dcSystemPowerInput.serviceObj?.service === 'com.victronenergy.system'
  && dcSystemPowerInput.pathObj?.path === '/Dc/System/Power', 'DC-Verbrauch nutzt exakt Global.system.dc.power aus der originalen gui-v2');
check(targetsOf(dcSystemPowerInput.id).includes('d097a007d7fe4bbb')
  && get('d097a007d7fe4bbb').rules?.some(rule => rule.p === 'topic' && rule.to === 'dc.system.power')
  && snapshotFunction.includes("const dcSystemPower = sensor('dc.system.power');")
  && snapshotFunction.includes('        dcSystemPower,'), 'DC-SystemCalc-Wert wird additiv in den zentralen Snapshot übernommen');
const sensorNormalizer = get('bb6668fefec83068').func || '';
const normalizedDcValues = new Map();
const normalizedDcFlow = {
  get: key => normalizedDcValues.get(key),
  set: (key, value) => normalizedDcValues.set(key, value)
};
const normalizedDcOutput = new Function('msg', 'flow', 'context', 'node', 'env', 'RED', sensorNormalizer)(
  { topic: 'dc.system.power', payload: 184, _camperSeen: 1234 }, normalizedDcFlow, {}, {}, {}, {}
);
check(normalizedDcOutput?.topic === 'tick'
  && normalizedDcValues.get('camperSensors')?.['dc.system.power']?.value === 184
  && normalizedDcValues.get('camperSensors')?.['dc.system.power']?.seen === 1234,
  'DC-SystemCalc-Wert passiert den gemeinsamen Sensor-Normalisierer bis zum Snapshot-Gate');
check(snapshotFunction.includes('const known = Number(state.seen || 0) > 0;')
  && snapshotFunction.includes('online: known'),
  'Changed-only STAR-Power-Zustände bleiben nach der ersten gültigen Rückmeldung bedienbar');
check(nodesAt('com.victronenergy.tank/1', '/Remaining').length === 0, 'Nicht vorhandener Abwassertank wird nicht länger abgefragt');
check(nodesAt('com.victronenergy.tank/21', '/Level').length === 1
  && nodesAt('com.victronenergy.tank/21', '/Remaining').length === 1,
  'Frischwasser verwendet die reale Cerbo-Tankinstanz 21');
check(dashboardV2Markup.includes('{{signed(s.energy?.dcSystemPower)}} W') && dashboardV2Markup.includes('DC-Verbrauch'), 'Home zeigt den originalen DC-Systemwert statt Batterieladeleistung');
check(!dashboardV2Markup.includes('{{signed(s.energy?.battery?.power)}} W'), 'Home verwechselt SmartShunt-Ladeleistung nicht mehr mit DC-Verbrauch');
check(dashboard.includes("v2BatteryFlow(){")
  && dashboard.includes("power>5")
  && dashboard.includes("power < -5")
  && dashboard.includes("mode:'charging'")
  && dashboard.includes("mode:'discharging'")
  && dashboard.includes("mode:'idle'"), 'Home leitet Laden, Entladen und Ruhe mit 5-W-Deadband aus dem unveränderten SmartShunt-Wert ab');
check(dashboardV2Markup.includes("'cc2-battery-flow','is-'+v2BatteryFlow.mode")
  && dashboardV2Markup.includes('{{v2BatteryFlow.label}}')
  && dashboardV2Markup.includes('{{v2BatteryFlow.value}}'), 'SOC-Bereich zeigt Richtung und Betrag der Batterieleistung kompakt an');
check(dashboardV2Css.includes('.cc2-battery-flow.is-charging')
  && dashboardV2Css.includes('.cc2-battery-flow.is-discharging')
  && dashboardV2Css.includes('width: 108px;'), 'Batterierichtung besitzt feste kollisionsfreie Geometrie und getrennte Lade-/Entladefarben');
check(dashboard.includes('v2BatteryRuntime(){')
  && dashboard.includes("seconds>=86400")
  && dashboard.includes("power>5)return{value:'Lädt'")
  && dashboardV2Markup.includes('class="cc2-battery-runtime"')
  && dashboardV2Markup.includes('{{v2BatteryRuntime.value}}'), 'Home zeigt reale SmartShunt-Restlaufzeit als Tage/Stunden oder beim Laden als „Lädt“');
check(!dashboardV2Markup.includes('duration(s.energy?.battery?.timeToGoSeconds)'), 'Restlaufzeit ist eine klar beschriftete Anzeige und kein unlesbarer Zusatz in der Spannungszeile');
check(dashboard.includes("v2PageLabel(){return({home:'Home',lights:'Licht',climate:'Klima',energy:'Energie'"), 'Solar-Detail behält Energie als Seitenkopf');
check(dashboardV2Markup.includes('{{v2ChargerName(c)}}') && dashboard.includes("if(instance===278)return'MPPT 100/30 · 1'") && dashboard.includes("if(instance===279)return'MPPT 100/30 · 2'") && dashboard.includes("if(instance===290)return'MPPT 150/45'"), 'Solar-Detail verwendet die kurzen MPPT-Titel der Designquelle');

check(dashboardV2Markup.includes('<strong>Klimaautomatik</strong>') && dashboardV2Markup.includes('<span>Autoterm</span>') && dashboardV2Markup.includes('<span>MaxxFan</span>'), 'Home erklärt Klimaautomatik mit Autoterm und MaxxFan eindeutig');
check(dashboardV2Markup.includes('{{v2QuickName(q)}}') && dashboard.includes("'light:outside_front_white':'Tagfahrlicht'") && dashboard.includes("'light:outside_front_amber':'Warnlicht'"), 'Favoriten kürzen Tagfahrlicht und Warnlicht konsistent');
check(dashboardV2Markup.includes('v-for="minutes in [0,30,60,120]"') && dashboardV2Markup.includes('v2RuntimeOpen'), 'Autoterm-Zeitlimit bleibt optional');
check(dashboardV2Markup.includes("v2RuntimeOpen?'Zeitlimit':'Zeitlimit hinzufügen'") && dashboardV2Markup.includes(":class=\"v2RuntimeOpen?'':'cc2-sr-only'\""), 'Autoterm zeigt das Zeitlimit erst nach ausdrücklicher Auswahl');
check((dashboardV2Markup.match(/v-for="mode in \['off','manual','auto'\]"/g) || []).length === 2
  && dashboardV2Markup.includes("mode==='off'?'Aus':mode==='manual'?'Manuell':'Auto'"), 'Home und Klimaseite bieten die drei klaren Betriebsarten Aus, Manuell und Auto');
const climateControlMethod = dashboard.match(/climateControlMode\(mode\)\{([^}]|\}(?!,climateTarget))*\}/)?.[0] || '';
check(climateControlMethod.includes("settingsPatch({climateAutomation:patch})") === false
  && climateControlMethod.includes('this.climatePatch({controlMode:mode})')
  && !climateControlMethod.includes("this.command('heater'")
  && !climateControlMethod.includes("this.command('maxxfan'"), 'Betriebsartschalter speichert nur einen Cerbo-Intent und schaltet keine Geräte direkt im Browser');
check(dashboardV2Markup.includes('@click="heaterToggle"') && dashboardV2Markup.includes('@change="fanSpeed"'), 'Klima verwendet echte Autoterm- und MaxxFan-Befehle');
check(dashboardV2Markup.includes('s.climate?.temperatureSensors?.comfort') === false && dashboard.includes('v2Humidity(){let value=this.s.climate?.temperatureSensors?.comfort?.humidity'), 'Home-Luftfeuchte stammt aus dem realen Komfortsensor');

check(dashboardV2Markup.includes('v2WaterAvailable') && dashboard.includes('v2WaterAvailable(){let value=this.s.water?.fresh?.level') && dashboardV2Markup.includes('s.water?.pump?.online'), 'Wasserseite verwendet nur Frischwasser- und Pumpen-Live-State');
for (const forbidden of ['Abwasser', 'Druck', 'Durchfluss']) check(!dashboardV2Markup.includes(forbidden), `V2-Wasserseite enthält kein ${forbidden}`);
check(dashboardV2Markup.includes(':disabled="!s.water?.pump?.online"') && dashboardV2Markup.includes('@click="pumpToggle"'), 'Wasserpumpe ist bei fehlender Rückmeldung gesperrt und sonst real schaltbar');

for (const frozen of ['35 W', '42,97', '42.97', '31 %', '29,7', '29.7', '7 / 10', 'v3.80']) check(!dashboardV2Markup.includes(frozen), `V2 enthält keinen eingefrorenen Prototypwert ${frozen}`);
for (const redundant of ['Raumklima', 'Dieselheizung', 'Dachlüfter', 'Transit Lichtzonen']) check(!dashboardV2Markup.includes(redundant), `V2 vermeidet redundante Beschriftung ${redundant}`);
check(!dashboardV2Markup.includes('setDesignVersion') && !dashboardV2Markup.includes('Design V1'), 'V2-Systemseite enthält keinen alten Designumschalter');
check(dashboardV2Markup.includes('@click="openVictron"') && dashboard.includes("window.location.hostname"), 'V2-Systemseite öffnet die originale Victron-Ansicht ohne erfundene API');
check(dashboardV2Css.includes('grid-template-columns: repeat(6, 1fr)')
  && dashboardV2Css.includes('.cc2-device {')
  && dashboardV2Css.includes('width: 100%;')
  && dashboardV2Css.includes('height: 100%;')
  && dashboardV2Css.includes('aspect-ratio: auto;')
  && !dashboardV2Css.includes('width: min(100%, 800px)'), 'V2 nutzt den gesamten Browser-Viewport und behält die Sechsfachnavigation');
check(dashboardV2Css.includes('.cc2-zone-card.is-on') && dashboardV2Css.includes('.cc2-vehicle-lamp.is-on'), 'V2-CSS zeigt Lichtstatus direkt an Karte und exakt positioniertem SVG-Lichtkörper');
const settingsDashboard = get('aec5cc044fa2963f').format || '';
check(!settingsDashboard.includes('class="design-picker"'), 'Separate Einstellungsseite enthält keinen V1/V2-Umschalter');
check(!settingsDashboard.includes('designVersion'), 'Separate Einstellungsseite erzeugt keine V1-Payload');
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
check(migratedConfig.ui?.designVersion === undefined, 'Bestehende Designauswahl wird bei der V2-Migration entfernt');
check(JSON.stringify(migratedConfig.ui?.quickAccessIds) === JSON.stringify([
  'light:inside_main', 'light:outside_front_amber', 'light:outside_right', 'switch:high_beam_manual'
]), 'Bestehende vier Lichtbelegungen bleiben bei der Migration erhalten');
check(JSON.stringify(migratedConfig.ui?.favoriteIds) === JSON.stringify([
  'switch:water_pump', 'device:inverter', 'device:heater', 'device:maxxfan'
]), 'Fehlende Favoriten erhalten den eigenen sicheren Standard statt einer Schnellzugriff-Kopie');
check(JSON.stringify(migratedConfig.ui?.favoriteIds) !== JSON.stringify(migratedConfig.ui?.quickAccessIds), 'Migration hält Favoriten und Home-Schnellzugriff sichtbar getrennt');
check(JSON.stringify(migratedConfig.weatherLocation) === JSON.stringify({
  schema: 1,
  weather: { mode: 'gps', stationId: '' },
  tide: { mode: 'gps', stationId: '' }
}), 'Migration ergänzt getrennte Wetter-/Tidestandorte im GPS-Standard');

const designFile = new Map([['camperConfig', migratedConfig]]);
const designFlow = {
  get: key => designFile.get(key),
  set: (key, value) => designFile.set(key, value)
};
const designOutput = runSettings({ topic: 'ui.settings', payload: { action: 'patch', patch: { ui: { designVersion: 'v1' } } } }, designFlow, {}, {}, {}, {});
check(designOutput?.[0]?.payload?.config?.ui?.designVersion === undefined, 'Settings-Patch kann V1 nicht wieder aktivieren');
check(designFile.get('camperConfig')?.ui?.designVersion === undefined, 'V1-Auswahl wird nicht persistent gespeichert');

const locationPatch = {
  schema: 1,
  weather: { mode: 'station', stationId: '10866' },
  tide: { mode: 'station', stationId: 'wilhelmshaven_alter_vorhafen' }
};
const locationPatchOutput = runSettings({ topic: 'ui.settings', payload: { action: 'patch', patch: { weatherLocation: locationPatch } } }, designFlow, {}, {}, {}, {});
check(JSON.stringify(locationPatchOutput?.[0]?.payload?.config?.weatherLocation) === JSON.stringify(locationPatch), 'Settings-Patch speichert Wetter und Tide unabhängig');
check(JSON.parse(locationPatchOutput?.[4]?.payload || '{}')?.tide?.stationId === 'wilhelmshaven_alter_vorhafen', 'Nur ein validierter kanonischer Standortwert wird zum Cerbo ausgegeben');

const centralLocationStore = new Map([['camperConfig', JSON.parse(JSON.stringify(locationPatchOutput?.[0]?.payload?.config))]]);
const centralLocationWrites = [];
const centralLocationFlow = {
  get: key => centralLocationStore.get(key),
  set: (key, value) => { centralLocationStore.set(key, value); centralLocationWrites.push(key); }
};
const centralEchoOutput = runSettings({
  topic: 'ui.settings',
  _weatherLocationFromCerbo: true,
  payload: { action: 'patch', patch: { weatherLocation: locationPatch } }
}, centralLocationFlow, {}, {}, {}, {});
check(centralEchoOutput?.[4] == null && centralLocationWrites.length === 0, 'Cerbo-Echo erzeugt weder Rückschreibschleife noch unnötigen persistenten Write');

const invalidLocationPatchOutput = runSettings({ topic: 'ui.settings', payload: { action: 'patch', patch: {
  weatherLocation: { schema: 1, weather: { mode: 'station', stationId: '../x' }, tide: { mode: 'station', stationId: 'Baltic Gauge' } }
} } }, designFlow, {}, {}, {}, {});
check(JSON.stringify(invalidLocationPatchOutput?.[0]?.payload?.config?.weatherLocation) === JSON.stringify({
  schema: 1,
  weather: { mode: 'gps', stationId: '' },
  tide: { mode: 'gps', stationId: '' }
}), 'Ungültiger Standort-Patch fällt vollständig auf den sicheren GPS-Standard zurück');

const favoritePatchOutput = runSettings({ topic: 'ui.settings', payload: { action: 'patch', patch: { ui: { favoriteIds: ['device:heater', 'device:heater', 'invalid', 'switch:water_pump', 'device:maxxfan', 'device:inverter'] } } } }, designFlow, {}, {}, {}, {});
const favoritePatchedConfig = favoritePatchOutput?.[0]?.payload?.config || {};
check(JSON.stringify(favoritePatchedConfig.ui?.favoriteIds) === JSON.stringify(['device:heater', 'switch:water_pump', 'device:maxxfan', 'device:inverter']), 'Favoriten-Patch wird erlaubt, dedupliziert, gegen den Katalog gefiltert und auf vier begrenzt');
check(JSON.stringify(favoritePatchedConfig.ui?.quickAccessIds) === JSON.stringify(migratedConfig.ui?.quickAccessIds), 'Favoriten-Patch verändert den Home-Schnellzugriff nicht');

const climatePatchOutput = runSettings({ topic: 'ui.settings', payload: { action: 'patch', patch: { climateAutomation: { controlMode: 'off' } } } }, designFlow, {}, {}, {}, {});
const climatePatchedConfig = climatePatchOutput?.[0]?.payload?.config || {};
check(climatePatchedConfig.climateAutomation?.controlMode === 'off'
  && climatePatchedConfig.climateAutomation?.enabled === false, 'Klima-Aus wird als eigene persistente Betriebsart gespeichert');
check(settingsDashboard.includes('v-model="cfg.climateAutomation.controlMode"')
  && settingsDashboard.includes('<option value="off">Aus</option>')
  && settingsDashboard.includes('<option value="manual">Manuell</option>')
  && settingsDashboard.includes('<option value="auto">Automatik</option>')
  && !settingsDashboard.includes('Klimaautomatik aktiv'), 'Einstellungen verwenden denselben dreistufigen Klimavertrag statt eines widersprüchlichen Kontrollkästchens');

check(migratedConfig.coldProtection?.enabled === false
  && migratedConfig.coldProtection?.startTemperature === 3
  && migratedConfig.coldProtection?.stopTemperature === 5
  && migratedConfig.coldProtection?.power === 4
  && migratedConfig.coldProtection?.sensor === 'floor', 'Migration ergänzt den sicheren ausgeschalteten Kälteschutzstandard 3/5 °C · Stufe 4 · Boden');
const coldProtectionPatchOutput = runSettings({ topic: 'ui.settings', payload: { action: 'patch', patch: { coldProtection: {
  enabled: true, startTemperature: 9, stopTemperature: 1, power: 99, sensor: 'ceiling'
} } } }, designFlow, {}, {}, {}, {});
const coldProtectionPatched = coldProtectionPatchOutput?.[0]?.payload?.config?.coldProtection || {};
check(coldProtectionPatched.enabled === true
  && coldProtectionPatched.startTemperature === 8
  && coldProtectionPatched.stopTemperature === 9
  && coldProtectionPatched.power === 10
  && coldProtectionPatched.sensor === 'floor', 'Kälteschutz-Patch begrenzt Temperaturen und Stufe und hält B7B8/Boden fest');
check(settingsDashboard.includes('<h2>AUTOTERM-Kälteschutz</h2>')
  && settingsDashboard.includes('v-model="cfg.coldProtection.enabled"')
  && settingsDashboard.includes('saveColdProtection(){this.patch({coldProtection:this.cfg.coldProtection})}')
  && settingsDashboard.includes('Ruuvi B7B8 · Boden'), 'Der zentrale Web-Schalter und alle Kälteschutzwerte liegen unter Einstellungen');
const autotermDashboard = get('bc45ae1b0fc6611d').format || '';
check(!autotermDashboard.includes('v-model="cfg.frostEnabled"')
  && autotermDashboard.includes('Kälteschutz wird zentral unter Einstellungen konfiguriert'), 'Die AUTOTERM-Technikseite besitzt keinen widersprüchlichen zweiten Frostschutzschalter');

const climateControllerFunction = get('ec5c5c0618d69359').func || '';
check(climateControllerFunction.includes("const controlMode = ['off', 'manual', 'auto']")
  && !climateControllerFunction.includes("const forceOff = controlMode === 'off'")
  && snapshotFunction.includes("controlMode: ['off', 'manual', 'auto'].includes(climateAutomation.controlMode)"), 'Controller und Snapshot führen die drei Klima-Betriebsarten ohne Eingriff in manuelle Geräte');
const runClimateController = ({ controlMode, heaterOwned = false, fanOwned = false, heaterRunning = false, fanRunning = false, temperature = 22, frostEnabled = false, startedByFrost = false, heaterConfigMatches = true }) => {
  const values = new Map([
    ['camperConfig', {
      climateAutomation: { controlMode, enabled: controlMode === 'auto', mode: 'auto', targetTemperature: 22, hysteresis: 1, fanSpeed: 50 },
      coldProtection: { enabled: frostEnabled, startTemperature: 3, stopTemperature: 5, power: 4, sensor: 'floor' }
    }],
    ['state', { running: heaterRunning, cooling: false, startedByFrost }],
    ['cfg', heaterConfigMatches ? { setpoint: 22, frostEnabled, frostTemp: 3, frostStop: 5, frostPower: 4 } : { setpoint: 22 }],
    ['camperAdapters', { 'maxxfan.state': { on: fanRunning, speed: 50 } }],
    ['climateAutomationState', { demand: 'idle', heaterOwned, fanOwned, roomTemperature: temperature, ceilingTemperature: temperature, sensorOnline: true, enabled: false, controlMode: 'manual' }]
  ]);
  const flowApi = { get: key => values.get(key), set: (key, value) => values.set(key, value) };
  const output = new Function('msg', 'flow', 'context', 'node', 'env', 'RED', climateControllerFunction)({}, flowApi, {}, {}, {}, {});
  return { output, state: values.get('climateAutomationState') };
};
const manualClimate = runClimateController({ controlMode: 'manual', heaterRunning: true, fanRunning: true });
check(manualClimate.output?.[0] == null && manualClimate.output?.[1] == null
  && manualClimate.state?.controlMode === 'manual', 'Manuell lässt nicht von der Automatik gestartete AUTOTERM-/MaxxFan-Geräte unangetastet');
const releasedClimate = runClimateController({ controlMode: 'manual', heaterOwned: true, fanOwned: true, heaterRunning: true, fanRunning: true });
check(releasedClimate.output?.[0]?.[0]?.payload?.action === 'stop'
  && releasedClimate.output?.[1]?.[0]?.payload?.value === false, 'Manuell beendet nur Geräte, die zuvor der Klimaautomatik gehörten');
const offClimate = runClimateController({ controlMode: 'off', heaterRunning: true, fanRunning: true });
check(offClimate.output?.[0] == null && offClimate.output?.[1] == null
  && offClimate.state?.controlMode === 'off', 'Klima-Aus lässt manuell gestartete AUTOTERM-/MaxxFan-Geräte unangetastet');
const autoClimate = runClimateController({ controlMode: 'auto', temperature: 19 });
check(autoClimate.output?.[0]?.some(message => message.payload?.action === 'start')
  && autoClimate.state?.demand === 'heat', 'Auto nutzt weiterhin die bestehende temperaturgeführte Cerbo-Regelung');
const autoCooling = runClimateController({ controlMode: 'auto', temperature: 25 });
check(autoCooling.output?.[1]?.length === 1
  && autoCooling.output?.[1]?.[0]?.payload?.action === 'speed', 'Auto-Kühlung startet RJ45 ausschließlich mit dem idempotenten Geschwindigkeitsbefehl');
check(!climateControllerFunction.includes("payload: { action: 'mode'")
  && get('dec0785f657dc7d1').format.includes("@click=\"fanSetMode('reverse')\"")
  && get('dec0785f657dc7d1').format.includes("@click=\"fanSetMode('forward')\""), 'Zuluft und Abluft bleiben auch bei aktiver Klimaautomatik ausschließlich manuell wählbar');
const coldProtectionOffMode = runClimateController({ controlMode: 'off', heaterRunning: true, frostEnabled: true, startedByFrost: true });
check(coldProtectionOffMode.output?.[0] == null
  && coldProtectionOffMode.output?.[1] == null, 'Klima-Aus beendet eine vom aktivierten Kälteschutz gestartete AUTOTERM-Heizung nicht');
const coldProtectionSync = runClimateController({ controlMode: 'manual', frostEnabled: true, heaterConfigMatches: false });
check(coldProtectionSync.output?.[0]?.map(message => message.payload?.key).join(',') === 'frostTemp,frostStop,frostPower,frostEnabled'
  && coldProtectionSync.output?.[0]?.every(message => message.payload?._coldProtectionSync === true), 'Kälteschutzwerte werden vor dem Aktivieren sicher und vollständig an den AUTOTERM-Kern gespiegelt');
check(snapshotFunction.includes('coldProtection: {')
  && snapshotFunction.includes("sensor: 'floor'")
  && snapshotFunction.includes("sensorName: heater.frostSensor || 'Ruuvi B7B8 · Boden'"), 'Der öffentliche Klimasnapshot liefert Kälteschutzstatus und festen Bodensensor');
const operationsDashboard = get('976479fdec9530f1').format || '';
check(snapshotFunction.includes('const retainedEvents = events.slice(-25)')
  && snapshotFunction.includes('recent: events.slice(-25).reverse()')
  && operationsDashboard.includes('(ops.events?.recent||[]).slice(0,25)')
  && !operationsDashboard.includes("sendCommand('system','acknowledge'")
  && !operationsDashboard.includes('evt.acknowledgedAt'), 'Meldungen sind ein bestätigungsfreier Verlauf mit maximal 25 gespeicherten Einträgen');

const lightingPatchOutput = runSettings({ topic: 'ui.settings', payload: { action: 'patch', patch: { lightingScenes: {
  camping: { inside_main: 42.4, outside_front_amber: 37, outside_left: -9, unknown_light: 80 },
  night: { inside_main: 999, outside_right: null },
  all_off: { inside_main: 0, outside_front_white: 0, ignored: 0 }
} } } }, designFlow, {}, {}, {}, {});
const lightingPatchedConfig = lightingPatchOutput?.[0]?.payload?.config || {};
check(JSON.stringify(lightingPatchedConfig.lightingScenes?.camping) === JSON.stringify({ inside_main: 42, outside_front_amber: 100, outside_left: 0 }), 'Campingprofil rundet und begrenzt dimmbare Werte, normalisiert nicht dimmbares Warnlicht und verwirft unbekannte IDs');
check(lightingPatchedConfig.lightingScenes?.night?.inside_main === 100
  && lightingPatchedConfig.lightingScenes?.night?.outside_right === 0
  && lightingPatchedConfig.lightingScenes?.night?.unknown_light === undefined, 'Nachtprofil begrenzt Helligkeit und enthält ausschließlich reale Lichtkreise');
check(Object.keys(lightingPatchedConfig.lightingScenes?.all_off || {}).length === 6
  && Object.values(lightingPatchedConfig.lightingScenes?.all_off || {}).every(value => value === 0)
  && lightingPatchedConfig.lightingScenes?.all_off?.ignored === undefined, 'Alles-aus-Profil enthält alle sechs realen Lichtkreise als AUS und verwirft unbekannte IDs');
check(JSON.stringify(lightingPatchedConfig.ui?.quickAccessIds) === JSON.stringify(favoritePatchedConfig.ui?.quickAccessIds)
  && JSON.stringify(lightingPatchedConfig.ui?.favoriteIds) === JSON.stringify(favoritePatchedConfig.ui?.favoriteIds), 'Lichtszenen-Patch verändert weder Schnellzugriff noch Favoriten');

const commandStore = new Map([['camperConfig', migratedConfig], ['camperCommands', []], ['camperWsClients', {}]]);
const commandFlow = {
  get: key => commandStore.get(key),
  set: (key, value) => commandStore.set(key, value)
};
const runCommandRouter = new Function('msg', 'flow', 'context', 'node', 'env', 'RED', get('6265bf6f9bade1e5').func || '');
const settingsCommandOutput = runCommandRouter({ payload: { target: 'settings', action: 'patch', patch: { ui: { quickAccessIds: ['switch:water_pump'] } } } }, commandFlow, {}, {}, {}, {});
check(settingsCommandOutput?.[4]?.topic === 'ws.settings' && settingsCommandOutput?.[4]?.payload?.patch?.ui?.quickAccessIds?.[0] === 'switch:water_pump', 'Schnellzugriff nutzt weiterhin den vorhandenen Settings-Router');
check([0, 1, 2, 3, 9, 11].every(index => settingsCommandOutput?.[index] == null), 'Schnellzugriffsauswahl erzeugt keinen Hardwarebefehl');
const favoritesCommandOutput = runCommandRouter({ payload: { target: 'settings', action: 'patch', patch: { ui: { favoriteIds: ['device:heater'] } } } }, commandFlow, {}, {}, {}, {});
check(favoritesCommandOutput?.[4]?.topic === 'ws.settings' && favoritesCommandOutput?.[4]?.payload?.patch?.ui?.favoriteIds?.[0] === 'device:heater', 'Favoritenauswahl nutzt den bestehenden Settings-Patch mit eigenem Feld');
check([0, 1, 2, 3, 9, 11].every(index => favoritesCommandOutput?.[index] == null), 'Favoritenauswahl erzeugt keinerlei Hardwareausgabe');
const lightingCommandOutput = runCommandRouter({ payload: { target: 'settings', action: 'patch', patch: { lightingScenes: { camping: { inside_main: 55 } } } } }, commandFlow, {}, {}, {}, {});
check(lightingCommandOutput?.[4]?.topic === 'ws.settings'
  && lightingCommandOutput?.[4]?.payload?.patch?.lightingScenes?.camping?.inside_main === 55, 'Lichtszenen-Editor nutzt den vorhandenen Settings-Router');
check([0, 1, 2, 3, 9, 11].every(index => lightingCommandOutput?.[index] == null), 'Speichern eines Lichtprofils erzeugt keinerlei Hardwareausgabe');
const runProtectedCommand = (payload, config = migratedConfig) => {
  const values = new Map([['camperConfig', JSON.parse(JSON.stringify(config))], ['camperCommands', []], ['camperWsClients', {}]]);
  const writes = [];
  const flowApi = {
    get: key => values.get(key),
    set: (key, value) => { values.set(key, value); writes.push(key); }
  };
  const output = runCommandRouter(
    { payload, req: {}, res: {}, _msgid: 'security-test' }, flowApi, {}, {}, {}, {}
  );
  return { output, values, writes };
};
const configuredSceneConfig = JSON.parse(JSON.stringify(lightingPatchedConfig));
configuredSceneConfig.lightingScenes.camping = { inside_main: 42, outside_front_amber: 100 };
const configuredCamping = runProtectedCommand({ origin: 'gx', target: 'scene', action: 'run', sceneId: 'camping' }, configuredSceneConfig);
const configuredCampingStarPower = configuredCamping.output?.[0] || [];
check(configuredCamping.output?.[5]?.statusCode === 202
  && configuredCampingStarPower.some(item => item.payload?.channel === 9 && item.payload?.action === 'dim' && item.payload?.value === 42)
  && configuredCampingStarPower.some(item => item.payload?.channel === 8 && item.payload?.action === 'toggle' && item.payload?.value === 1), 'Camping startet exakt das gespeicherte Innenlicht- und Warnlichtprofil');
check(!configuredCampingStarPower.some(item => [7, 10, 11, 12].includes(Number(item.payload?.channel))), '„Wie zuvor“ erzeugt für ausgelassene Lichtkreise keinen Schaltbefehl');
check(configuredCampingStarPower.some(item => item.payload?.channel === configuredSceneConfig.mappings.waterPumpChannel && item.payload?.value === 1)
  && configuredCamping.output?.[3]?.some(item => item.payload?.action === 'speed'), 'Camping behält vorhandene Nicht-Licht-Aktionen wie Wasserpumpe und MaxxFan bei');
const vrmStarlinkOff = runProtectedCommand({ origin: 'vrm', target: 'starpower', action: 'set', channel: 5, value: false });
check(vrmStarlinkOff.output?.[5]?.statusCode === 400 && vrmStarlinkOff.output?.[5]?.payload?.error === 'remote_link_protection', 'VRM-Starlink-AUS wird mit remote_link_protection abgelehnt');
check([0, 1, 2, 3, 9, 11].every(index => vrmStarlinkOff.output?.[index] == null), 'VRM-Starlink-AUS erreicht keinen Hardwareausgang');
check(vrmStarlinkOff.output?.[7] == null && !vrmStarlinkOff.writes.includes('camperCommands'), 'Abgelehnter VRM-Linkbefehl erzeugt weder Tick noch persistenten Kommandoeintrag');
for (const value of [0, '0', '', null]) {
  const coercedOff = runProtectedCommand({ origin: 'vrm', target: 'starpower', action: 'set', channel: 5, value });
  check(coercedOff.output?.[5]?.statusCode === 400 && [0, 1, 2, 3, 9, 11].every(index => coercedOff.output?.[index] == null), `VRM-Starlink-AUS mit ${JSON.stringify(value)} kann die Normalisierung nicht umgehen`);
}
const vrmStarlinkOn = runProtectedCommand({ origin: 'vrm', target: 'starpower', action: 'set', channel: 5, value: true });
check(vrmStarlinkOn.output?.[0]?.[0]?.payload?.value === 1 && vrmStarlinkOn.output?.[5]?.statusCode === 202, 'VRM darf Starlink weiterhin einschalten');
for (const origin of ['gx', 'sync', undefined]) {
  const localOff = runProtectedCommand({ ...(origin ? { origin } : {}), target: 'starpower', action: 'set', channel: 5, value: false });
  check(localOff.output?.[0]?.[0]?.payload?.value === 0 && localOff.output?.[5]?.statusCode === 202, `${origin || 'lokal'} darf Starlink ausschalten`);
}

const remoteSceneConfig = JSON.parse(JSON.stringify(migratedConfig));
remoteSceneConfig.scenes = [{
  id: 'remote-cut', name: 'Remote cut', visible: true, actions: [
    { target: 'waterPump', action: 'set', value: true },
    { target: 'starpower', action: 'set', channel: 5, value: false },
    { target: 'starpower', action: 'set', channel: 7, value: true }
  ]
}, {
  id: 'remote-safe', name: 'Remote safe', visible: true,
  actions: [{ target: 'starpower', action: 'set', channel: 5, value: true }]
}];
const vrmSceneOff = runProtectedCommand({ origin: 'vrm', target: 'scene', action: 'run', sceneId: 'remote-cut' }, remoteSceneConfig);
check(vrmSceneOff.output?.[5]?.statusCode === 400 && vrmSceneOff.output?.[5]?.payload?.error === 'remote_link_protection', 'VRM-Szene mit Starlink-AUS wird zentral abgelehnt');
check([0, 1, 2, 3, 9, 11].every(index => vrmSceneOff.output?.[index] == null) && vrmSceneOff.output?.[7] == null, 'VRM-Szene wird vor der ersten Hardwareausgabe atomar abgelehnt');
check(!vrmSceneOff.writes.includes('camperCommands') && (vrmSceneOff.values.get('camperCommands') || []).length === 0, 'Abgelehnte VRM-Szene persistiert weder Eltern- noch Kindkommandos');
const vrmSceneSafe = runProtectedCommand({ origin: 'vrm', target: 'scene', action: 'run', sceneId: 'remote-safe' }, remoteSceneConfig);
check(vrmSceneSafe.output?.[5]?.statusCode === 202 && vrmSceneSafe.output?.[0]?.[0]?.payload?.value === 1, 'VRM-Szene ohne Uplink-AUS bleibt erlaubt');
for (const origin of ['gx', 'sync']) {
  const localSceneOff = runProtectedCommand({ origin, target: 'scene', action: 'run', sceneId: 'remote-cut' }, remoteSceneConfig);
  check(localSceneOff.output?.[5]?.statusCode === 202 && localSceneOff.output?.[0]?.some(item => item.payload?.channel === 5 && item.payload?.value === 0), `${origin} darf die lokale AUS-Szene weiterhin ausführen`);
}
const pumpOnUplinkConfig = JSON.parse(JSON.stringify(remoteSceneConfig));
pumpOnUplinkConfig.mappings.waterPumpChannel = 5;
pumpOnUplinkConfig.scenes.push({ id: 'pump-off', name: 'Pump off', visible: true, actions: [{ target: 'waterPump', action: 'set', value: false }] });
const vrmPumpOff = runProtectedCommand({ origin: 'vrm', target: 'waterPump', action: 'set', value: false }, pumpOnUplinkConfig);
const vrmPumpSceneOff = runProtectedCommand({ origin: 'vrm', target: 'scene', action: 'run', sceneId: 'pump-off' }, pumpOnUplinkConfig);
check(vrmPumpOff.output?.[5]?.payload?.error === 'remote_link_protection' && vrmPumpOff.output?.[0] == null, 'VRM-Linkschutz erfasst eine direkt auf Kanal 5 gemappte Wasserpumpe');
check(vrmPumpSceneOff.output?.[5]?.payload?.error === 'remote_link_protection' && vrmPumpSceneOff.output?.[0] == null, 'VRM-Linkschutz erfasst Kanal 5 auch innerhalb einer Pumpenszene');
const areaOnUplinkConfig = JSON.parse(JSON.stringify(remoteSceneConfig));
const outsideLight = areaOnUplinkConfig.lights.find(light => light.area === 'outside');
outsideLight.channel = 5;
areaOnUplinkConfig.scenes.push({ id: 'outside-off', name: 'Outside off', visible: true, actions: [{ target: 'starpower', action: 'set', area: 'outside', value: 0 }] });
const vrmAreaSceneOff = runProtectedCommand({ origin: 'vrm', target: 'scene', action: 'run', sceneId: 'outside-off' }, areaOnUplinkConfig);
check(vrmAreaSceneOff.output?.[5]?.payload?.error === 'remote_link_protection' && [0, 1, 2, 3, 9, 11].every(index => vrmAreaSceneOff.output?.[index] == null), 'VRM-Linkschutz prüft auch jede aus einer Flächenaktion expandierte Einzelaktion');
check(get('6265bf6f9bade1e5').func.includes("if (isRemoteLinkProtected(item)) return 'remote_link_protection';") && get('6265bf6f9bade1e5').func.includes('const validationError = validateItem(item);'), 'Ein zentraler Guard schützt Einzelaktionsvalidierung und jeden Hardware-Dispatch');

const runStarlinkPowerGate = new Function('msg', 'flow', 'context', 'node', 'env', 'RED', get('camper_starlink_power_gate').func || '');
const starlinkGateValues = new Map();
const starlinkGateWrites = [];
const starlinkGateFlow = {
  get: key => starlinkGateValues.get(key),
  set: (key, value) => { starlinkGateValues.set(key, value); starlinkGateWrites.push(key); }
};
const firstStarlinkOff = runStarlinkPowerGate({ payload: 0 }, starlinkGateFlow, {}, {}, {}, {});
const firstStarlinkTimestamp = starlinkGateValues.get('starlinkState')?.updatedAt;
const duplicateStarlinkOff = runStarlinkPowerGate({ payload: 0 }, starlinkGateFlow, {}, {}, {}, {});
check(firstStarlinkOff?.[1]?.topic === 'tick' && starlinkGateWrites.filter(key => key === 'starlinkState').length === 1, 'Erster CH-5-Zustand initialisiert den Starlink-State genau einmal');
check(duplicateStarlinkOff == null && starlinkGateValues.get('starlinkState')?.updatedAt === firstStarlinkTimestamp, 'Identischer CH-5-Zustand erzeugt weder Timestamp noch Context-Write oder Tick');
const starlinkOnTransition = runStarlinkPowerGate({ payload: 1 }, starlinkGateFlow, {}, {}, {}, {});
check(starlinkOnTransition?.[0]?.topic === 'starlink.poll' && starlinkOnTransition?.[1]?.topic === 'tick' && starlinkGateValues.get('starlinkState')?.powered === true, 'Echter CH-5-EIN-Übergang startet Poll und Snapshot weiterhin');

const runIndevoltDiscovery = new Function('msg', 'flow', 'context', 'node', 'env', 'RED', get('d92d04ca2b1964f9').func || '');
const indevoltPacket = (ip, serial = 'IV-1') => JSON.stringify({ ip, sn: serial, fw: '1.0', opendata_ver: '2' });
const createIndevoltFlow = scan => {
  const values = new Map([['indevoltScan', scan], ['indevoltRegistry', {}]]);
  const writes = [];
  return {
    values,
    writes,
    api: {
      get: key => values.get(key),
      set: (key, value) => { values.set(key, value); writes.push(key); }
    }
  };
};
const inactiveIndevolt = createIndevoltFlow({ active: false, results: [] });
const inactiveDiscovery = runIndevoltDiscovery({ payload: indevoltPacket('172.24.24.12') }, inactiveIndevolt.api, {}, {}, {}, {});
check(inactiveDiscovery == null && inactiveIndevolt.writes.length === 0, 'INDEVOLT-UDP außerhalb eines aktiven Scans wird vollständig ignoriert');
for (const payload of ['null', '[]', '"text"']) {
  const invalidIndevolt = createIndevoltFlow({ active: true, started: Date.now(), token: 'scan-invalid', results: [], acceptedIps: [] });
  check(runIndevoltDiscovery({ payload }, invalidIndevolt.api, {}, {}, {}, {}) == null && invalidIndevolt.writes.length === 0, `INDEVOLT verwirft Nicht-Objekt-JSON ${payload}`);
}
const activeIndevolt = createIndevoltFlow({ active: true, started: Date.now(), token: 'scan-a', results: [], acceptedIps: [] });
const firstDiscovery = runIndevoltDiscovery({ payload: indevoltPacket('172.24.24.12') }, activeIndevolt.api, {}, {}, {}, {});
const writesAfterFirstDiscovery = activeIndevolt.writes.length;
const duplicateDiscovery = runIndevoltDiscovery({ payload: indevoltPacket('172.24.24.12') }, activeIndevolt.api, {}, {}, {}, {});
check(firstDiscovery?.topic === 'indevolt.discovered' && duplicateDiscovery == null && activeIndevolt.writes.length === writesAfterFirstDiscovery, 'Doppelte INDEVOLT-Antwort desselben Scans erzeugt weder Poll noch Context-Write');
activeIndevolt.values.set('indevoltScan', { active: true, started: Date.now(), token: 'scan-b', results: [], acceptedIps: [] });
activeIndevolt.writes.length = 0;
const unchangedNextScan = runIndevoltDiscovery({ payload: indevoltPacket('172.24.24.12') }, activeIndevolt.api, {}, {}, {}, {});
check(unchangedNextScan?.topic === 'indevolt.discovered' && !activeIndevolt.writes.includes('indevoltRegistry'), 'Unverändertes INDEVOLT-Gerät schreibt das Registry im nächsten Scan nicht erneut');
const burstIndevolt = createIndevoltFlow({ active: true, started: Date.now(), token: 'scan-burst', results: [], acceptedIps: [] });
let burstDiscoveryOutputs = 0;
for (let index = 1; index <= 20; index += 1) {
  if (runIndevoltDiscovery({ payload: indevoltPacket(`172.24.24.${index}`, `IV-${index}`) }, burstIndevolt.api, {}, {}, {}, {})) burstDiscoveryOutputs += 1;
}
check(burstDiscoveryOutputs === 4 && burstIndevolt.values.get('indevoltScan').acceptedIps.length === 4, 'INDEVOLT-Burst ist hart auf vier Antworten pro Scan begrenzt');
check((burstIndevolt.values.get('indevoltScan').results || []).length <= 8 && Object.keys(burstIndevolt.values.get('indevoltRegistry') || {}).length === 1, 'INDEVOLT hält höchstens acht Scanergebnisse und genau ein Fahrzeuggerät');
const oversizedIndevolt = createIndevoltFlow({ active: true, started: Date.now(), token: 'scan-large', results: [], acceptedIps: [] });
check(runIndevoltDiscovery({ payload: 'x'.repeat(4097) }, oversizedIndevolt.api, {}, {}, {}, {}) == null && oversizedIndevolt.writes.length === 0, 'INDEVOLT verwirft UDP-Payloads über 4 KiB vor JSON-Verarbeitung');
const runIndevoltDirectory = new Function('msg', 'flow', 'context', 'node', 'env', 'RED', get('99e30f749692fa13').func || '');
const staleScanNow = Date.now();
const staleScanValues = new Map([
  ['indevoltScan', { active: true, started: staleScanNow - 20000, token: 'stale', results: [] }],
  ['indevoltLastScan', staleScanNow - 200000],
  ['indevoltRegistry', {}],
  ['camperConfig', { network: {} }]
]);
const staleScanFlow = { get: key => staleScanValues.get(key), set: (key, value) => staleScanValues.set(key, value) };
const staleScanOutput = runIndevoltDirectory({ topic: 'poll', payload: 'poll' }, staleScanFlow, {}, {}, {}, {});
check(staleScanOutput?.[2]?.payload === 'scan' && staleScanValues.get('indevoltScan')?.active === true && staleScanValues.get('indevoltScan')?.token !== 'stale', 'Abgestürzter INDEVOLT-Scan wird beim nächsten Poll sicher ersetzt');

// Ruuvi: feste native Service-Zuordnung, kein Discovery/Exec/Cache.
const ruuviNodes = {
  ruuvi_ceiling_temperature_in: ['/Temperature', 'victron-input-temperature', 'com.victronenergy.temperature/24', false],
  ruuvi_ceiling_humidity_in: ['/Humidity', 'victron-input-custom', 'com.victronenergy.temperature/24', true],
  ruuvi_ceiling_pressure_in: ['/Pressure', 'victron-input-custom', 'com.victronenergy.temperature/24', true],
  ruuvi_ceiling_batteryVoltage_in: ['/BatteryVoltage', 'victron-input-custom', 'com.victronenergy.temperature/24', true],
  ruuvi_ceiling_deviceName_in: ['/DeviceName', 'victron-input-custom', 'com.victronenergy.temperature/24', true],
  ruuvi_floor_temperature_in: ['/Temperature', 'victron-input-temperature', 'com.victronenergy.temperature/25', false],
  ruuvi_floor_humidity_in: ['/Humidity', 'victron-input-custom', 'com.victronenergy.temperature/25', true],
  ruuvi_floor_pressure_in: ['/Pressure', 'victron-input-custom', 'com.victronenergy.temperature/25', true],
  ruuvi_floor_batteryVoltage_in: ['/BatteryVoltage', 'victron-input-custom', 'com.victronenergy.temperature/25', true],
  ruuvi_floor_deviceName_in: ['/DeviceName', 'victron-input-custom', 'com.victronenergy.temperature/25', true]
};
for (const [id, [pathValue, expectedType, service, onlyChanges]] of Object.entries(ruuviNodes)) {
  const node = get(id);
  check(node.type === expectedType, `${id} nutzt ${expectedType}`);
  check(node.service === service, `${id} ist fest auf ${service}`);
  check(node.path === pathValue, `${id} liest ${pathValue}`);
  check(node.onlyChanges === onlyChanges, `${id} nutzt die erwartete Wiederholungsstrategie`);
}
check(get('ruuvi_manual_adapter').type === 'function', 'Ruuvi-FB31-/B7B8-Werte werden ohne Discovery normalisiert');
check(get('ruuvi_manual_adapter').func.includes("ceilingService: 'com.victronenergy.temperature/24'"), 'Deckenrolle ist fest /24');
check(get('ruuvi_manual_adapter').func.includes("floorService: 'com.victronenergy.temperature/25'"), 'Bodenrolle ist fest /25');
check(get('ruuvi_manual_adapter').func.includes("floorConfigured: true"), 'Bodenrolle wird als konfiguriert veröffentlicht');
check(get('ruuvi_manual_adapter').func.includes("flow.set('camperTemperatureDiscovery'"), 'Feste Rollen ersetzen alte Discovery-Metadaten');
check(!flows.some(node => String(node.id).includes('ruuvi_discovery')), 'Keine Ruuvi-Discovery-Nodes');
check(!sourceText.includes('read-temperature-sensors.sh'), 'Kein Ruuvi-Shellprozess');
check(!sourceText.includes('/victron/cache'), 'Kein Ruuvi-Cache-Polling');

const ruuviValues = new Map();
const ruuviFlow = { get: key => ruuviValues.get(key), set: (key, value) => ruuviValues.set(key, value) };
const runRuuvi = new Function('msg', 'flow', 'context', 'node', 'env', 'RED', get('ruuvi_manual_adapter').func || '');
const ruuviSeen = Date.now();
const feedRuuvi = (role, values) => {
  let output = null;
  for (const [field, payload] of Object.entries(values)) {
    const result = runRuuvi({ topic: `ruuvi.${role}.${field}`, payload, _camperSeen: ruuviSeen }, ruuviFlow, {}, {}, {}, {});
    if (result) output = result;
  }
  return output;
};
feedRuuvi('ceiling', { temperature: 24.4, humidity: 56.6, pressure: 1010.5, batteryVoltage: 2.696, deviceName: 'Ruuvi FB31' });
const ruuviOutput = feedRuuvi('floor', { temperature: 22.2, humidity: 60.0, pressure: 1011.0, batteryVoltage: 3.298, deviceName: 'Ruuvi B7B8' });
const ruuviMessages = Array.isArray(ruuviOutput?.[0]) ? ruuviOutput[0] : [];
const ruuviCeiling = ruuviMessages.find(message => message.topic === 'ruuvi1')?.payload;
const ruuviFloor = ruuviMessages.find(message => message.topic === 'ruuvi2')?.payload;
const ruuviComfort = ruuviMessages.find(message => message.topic === 'ruuvi3')?.payload;
const ruuviAssignment = ruuviValues.get('camperTemperatureAssignment') || {};
const ruuviDiscovery = ruuviValues.get('camperTemperatureDiscovery') || {};
check(ruuviCeiling?.service === 'com.victronenergy.temperature/24' && ruuviCeiling?.deviceName === 'Ruuvi FB31', 'FB31 wird als Deckenwert veröffentlicht');
check(ruuviFloor?.service === 'com.victronenergy.temperature/25' && ruuviFloor?.deviceName === 'Ruuvi B7B8' && ruuviFloor?.temp === 22.2, 'B7B8 wird als Bodenwert veröffentlicht');
check(ruuviComfort?.temp === 23.3 && ruuviComfort?.source === 'calculated', 'Komfortwert ist der Mittelwert aus Decke und Boden');
check(ruuviAssignment.floorService === 'com.victronenergy.temperature/25' && ruuviAssignment.floorConfigured === true, 'Temperaturzuordnung enthält den aktiven Bodensensor');
check(ruuviDiscovery.assignment?.floorService === 'com.victronenergy.temperature/25' && ruuviDiscovery.candidates?.length === 2, 'API-Metadaten enthalten beide festen Ruuvi-Dienste');

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
check(settingsDashboard.includes('Lüfter manuell dauerhaft EIN'), 'Manueller CPU-Lüfter bleibt in den Einstellungen erreichbar');

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
  check(node.onlyChanges === (id !== 'orion_mode_in'), id === 'orion_mode_in'
    ? 'Orion /Mode akzeptiert Initial- und Wiederholungswerte'
    : `${id} sendet nur Änderungen`);
}
check(!flows.some(node => String(node.id).startsWith('orion_cache_')), 'Kein Orion-Cache-Polling');
const stateAggregator = get('ada9353cc6ea4a4c').func || '';
check(stateAggregator.includes("const orionModeRecord = sensors['orion.mode']"), 'Orion hält den validierten /Mode-Wert separat von der Telemetrie');
check(stateAggregator.includes("const orionModeNumber = orionOnline ? orionModeValue : null"), 'Orion nutzt den gelatchten /Mode nur bei frischer Geräteverbindung');
check(stateAggregator.includes("seen('orion.inputVoltage')") && stateAggregator.includes("seen('orion.inputPower')"), 'Orion-Verfügbarkeit berücksichtigt alle nativen Telemetriepfade');
check(stateAggregator.includes("orionModeNumber === 4 ? 'AUS'"), 'Orion zeigt AUS ausschließlich bei Mode 4');
check(stateAggregator.includes("'FREIGEGEBEN · WARTET'"), 'Orion Mode 1 mit State 0/null wird als freigegeben und wartend angezeigt');
check(!stateAggregator.includes("const orionStateNames = { 0: 'AUS'"), 'Orion State 0 wird nicht mehr eigenständig als AUS interpretiert');
check(stateAggregator.includes('stateText: orionStateText'), 'Snapshot verwendet die modebewusste Orion-Zustandsanzeige');

const runStateAggregator = (sensors, extraValues = {}) => {
  const values = new Map([['camperSensors', sensors], ...Object.entries(extraValues)]);
  const globalValues = new Map();
  const flowApi = {
    get: key => values.get(key),
    set: (key, value) => values.set(key, value)
  };
  const globalApi = {
    get: key => globalValues.get(key),
    set: (key, value) => globalValues.set(key, value)
  };
  const result = new Function('msg', 'flow', 'context', 'node', 'env', 'RED', 'global', stateAggregator)(
    { topic: 'tick' }, flowApi, {}, { warn() {}, error() {}, status() {} }, {}, {}, globalApi
  );
  return result?.[0]?.payload;
};

const energyFixtureNow = Date.now();
const separatedEnergyFixture = runStateAggregator({
  'battery.power': { value: -52, seen: energyFixtureNow },
  'solar.total.power': { value: 318, seen: energyFixtureNow },
  'dc.system.power': { value: 184, seen: energyFixtureNow }
}, {
  indevoltState: { online: true, lastSeen: energyFixtureNow, solarPower: 777 }
})?.energy;
check(separatedEnergyFixture?.battery?.power === -52
  && separatedEnergyFixture?.dcSystemPower === 184, 'Fixture hält SmartShunt-Leistung und Victron-DC-Gesamtverbrauch getrennt');
check(separatedEnergyFixture?.totalSolarPower === 318
  && separatedEnergyFixture?.indevolt?.solarPower === 777, 'Fixture schließt INDEVOLT aus Solar gesamt aus und veröffentlicht es weiterhin separat');
const unchangedSwitchFixture = runStateAggregator({}, {
  starpowerState: { channels: {
    2: { state: 0, seen: energyFixtureNow - 10 * 60 * 1000 },
    5: { state: 0, seen: energyFixtureNow - 10 * 60 * 1000 }
  } }
})?.ui?.quickAccess || [];
const unchangedPump = unchangedSwitchFixture.find(item => item.id === 'switch:water_pump');
const unchangedStarlink = unchangedSwitchFixture.find(item => item.id === 'switch:starlink');
check(unchangedPump?.available === true && unchangedPump?.active === false
  && unchangedPump?.command?.value === true
  && unchangedStarlink?.available === true && unchangedStarlink?.active === false
  && unchangedStarlink?.command?.value === 1,
  'Unveränderte ausgeschaltete Wasserpumpe und Starlink bleiben lokal einschaltbar');

// Dynamische Persistenzregression: Auch ein massiver identischer Burst darf
// den großen Snapshot und die gebundenen UI-Ausgänge nur einmal markieren.
// Der Core-Delay wird strukturell separat geprüft; hier wird die zweite
// Schutzschicht des Aggregators direkt belastet.
const burstNow = Date.now();
const burstValues = new Map([['camperSensors', {
  'battery.soc': { value: 74, seen: burstNow },
  'battery.voltage': { value: 13.2, seen: burstNow },
  'solar.total.power': { value: 318, seen: burstNow }
}]]);
const burstWrites = new Map();
const burstFlow = {
  get: key => burstValues.get(key),
  set: (key, value) => {
    burstValues.set(key, value);
    burstWrites.set(key, Number(burstWrites.get(key) || 0) + 1);
  }
};
const burstGlobalValues = new Map();
const burstGlobal = {
  get: key => burstGlobalValues.get(key),
  set: (key, value) => burstGlobalValues.set(key, value)
};
const runBurstAggregator = new Function('msg', 'flow', 'context', 'node', 'env', 'RED', 'global', stateAggregator);
const originalDateNow = Date.now;
let burstOutputs = 0;
try {
  Date.now = () => burstNow;
  for (let index = 0; index < 500; index += 1) {
    const output = runBurstAggregator(
      { topic: 'burst' }, burstFlow, {}, { warn() {}, error() {}, status() {} }, {}, {}, burstGlobal
    );
    if (output) burstOutputs += 1;
  }
} finally {
  Date.now = originalDateNow;
}
check(burstOutputs === 1, '500 identische Aggregator-Aufrufe erzeugen genau eine UI-Ausgabe');
check(burstWrites.get('camperSnapshot') === 1, '500 identische Aggregator-Aufrufe persistieren den großen Snapshot genau einmal');
check(Buffer.byteLength(JSON.stringify(burstValues.get('camperSnapshot')), 'utf8') < 256 * 1024, 'Dynamischer Snapshot bleibt unter dem 256-KiB-Limit');
check(!burstGlobalValues.has('camper.snapshot'), 'Burst erzeugt keine redundante globale Snapshot-Kopie');

const countSteadyStringifies = clients => {
  burstValues.set('camperWsClients', clients);
  const originalStringify = JSON.stringify;
  let calls = 0;
  let output;
  try {
    JSON.stringify = (...args) => { calls += 1; return originalStringify(...args); };
    Date.now = () => burstNow;
    output = runBurstAggregator({ topic: 'steady-ws' }, burstFlow, {}, { warn() {}, error() {}, status() {} }, {}, {}, burstGlobal);
  } finally {
    JSON.stringify = originalStringify;
    Date.now = originalDateNow;
  }
  return { calls, output };
};
const steadyWithoutClient = countSteadyStringifies({});
const steadyWithClient = countSteadyStringifies({ client: { session: { id: 'client' }, lastSeen: burstNow } });
check(steadyWithoutClient.output == null && steadyWithClient.output == null, 'Unveränderter Snapshot erzeugt mit und ohne WebSocket-Client keine Ausgabe');
check(steadyWithClient.calls === steadyWithoutClient.calls, 'Unveränderter Snapshot wird nicht pro WebSocket-Client serialisiert');
const changedClientValues = new Map([['camperSensors', {}], ['camperWsClients', Object.fromEntries(Array.from({ length: 32 }, (_value, index) => [`client-${index}`, { session: { id: `client-${index}` }, lastSeen: burstNow }]))]]);
const changedClientFlow = { get: key => changedClientValues.get(key), set: (key, value) => changedClientValues.set(key, value) };
let changedStateSerializations = 0;
let changedClientOutput;
const originalStringifyForClients = JSON.stringify;
try {
  Date.now = () => burstNow;
  JSON.stringify = (...args) => {
    if (args[0]?.type === 'state' && args[0]?.data) changedStateSerializations += 1;
    return originalStringifyForClients(...args);
  };
  changedClientOutput = runBurstAggregator({ topic: 'changed-ws' }, changedClientFlow, {}, { warn() {}, error() {}, status() {} }, {}, {}, burstGlobal);
} finally {
  JSON.stringify = originalStringifyForClients;
  Date.now = originalDateNow;
}
check(changedStateSerializations === 1 && changedClientOutput?.[1]?.length === 32, 'Geänderter Snapshot wird für 32 Clients genau einmal serialisiert und 32-mal verteilt');
check(new Set((changedClientOutput?.[1] || []).map(message => message.payload)).size === 1, 'Alle WebSocket-Clients teilen denselben vorbereiteten Snapshot-Payload');

const historyNow = burstNow;
const historyPoint = index => ({ timestamp: historyNow - index * 1000, batterySoc: 70, solarPower: 100, freshLevel: 80 });
const oversizedHistory = {
  minute: Array.from({ length: 2000 }, (_value, index) => historyPoint(1999 - index)),
  quarterHour: Array.from({ length: 4000 }, (_value, index) => historyPoint(3999 - index)),
  daily: Array.from({ length: 500 }, (_value, index) => historyPoint(499 - index))
};
const historyValues = new Map([['camperSensors', {}], ['camperHistory', oversizedHistory]]);
const historyFlow = { get: key => historyValues.get(key), set: (key, value) => historyValues.set(key, value) };
try {
  Date.now = () => historyNow;
  runBurstAggregator({ topic: 'history-cap' }, historyFlow, {}, { warn() {}, error() {}, status() {} }, {}, {}, burstGlobal);
} finally {
  Date.now = originalDateNow;
}
check(historyValues.get('camperHistory').minute.length <= 1440 && historyValues.get('camperHistory').quarterHour.length <= 2880 && historyValues.get('camperHistory').daily.length <= 365, 'Legacy-Historie wird dynamisch auf insgesamt höchstens 4.685 Punkte gekürzt');
const steadyNow = Date.now();
const steadyOrion = runStateAggregator({
  'orion.mode': { value: 1, seen: steadyNow - 5 * 60 * 1000 },
  'orion.state': { value: 0, seen: steadyNow - 5 * 60 * 1000 },
  'orion.voltage': { value: 13.19, seen: steadyNow - 1000 },
  'orion.power': { value: 0, seen: steadyNow - 1000 }
})?.energy?.orion;
check(steadyOrion?.online === true, 'Frische Orion-Telemetrie hält das Gerät online');
check(steadyOrion?.mode === 1 && steadyOrion?.on === true, 'Ein unveränderter Mode 1 bleibt bei frischer Telemetrie erhalten');
check(steadyOrion?.stateText === 'FREIGEGEBEN · WARTET', 'Gelatchter Mode 1 und ruhender State ergeben den korrekten Bereitschaftsstatus');
const staleOrion = runStateAggregator({
  'orion.mode': { value: 1, seen: steadyNow - 5 * 60 * 1000 },
  'orion.voltage': { value: 13.19, seen: steadyNow - 5 * 60 * 1000 }
})?.energy?.orion;
check(staleOrion?.online === false && staleOrion?.mode === null && staleOrion?.on === false, 'Ohne frische Telemetrie wird kein alter Orion-Modus vorgetäuscht');

// Warnlicht/Heck: physisch und strukturell strikt getrennt.
const warningOut = get('959137a3ca444583');
const rearStateOut = get('4afab948e3bba101');
const rearDimOut = get('d1a6f2d556b5e888');
const warning = get('e0809a11d6ca3b34');
const warningClock = get('199eabbda79b02de');
const starpowerCoalescer = get('d36a1adac492ce3e');
const sensorCoalescer = get('cff2c4d32221ccd8');
const starRouter = get('6a22df3c7ebe02fc');
check(warningOut.path === '/SwitchableOutput/7/State', 'Warnlicht schaltet ausschließlich CH 8 State');
check(rearStateOut.path === '/SwitchableOutput/10/State', 'Hecklicht schaltet ausschließlich CH 11 State');
check(rearDimOut.path === '/SwitchableOutput/10/Dimming', 'Hecklicht dimmt ausschließlich CH 11');
check(warningOut.id !== rearStateOut.id && warningOut.path !== rearStateOut.path, 'Warnlicht und Heck besitzen getrennte Ausgänge');
check(nodesAt('com.victronenergy.switch/0', '/SwitchableOutput/7/Dimming', 'victron-output-switch').length === 0, 'Warnlicht besitzt keinen Dimming-Ausgang');
check(!byId.has('60540243db20bc53'), 'Alter Warnlicht-Dimming-Ausgang ist entfernt');
check(warning.outputs === 2, 'Warnblink-Controller trennt Hardware und seriellen Takt');
check(JSON.stringify(warning.wires) === JSON.stringify([['6a22df3c7ebe02fc'], ['199eabbda79b02de']]), 'Warnblink-Controller führt Hardware zum Router und Takt zum Trigger');
check(warningClock.type === 'trigger' && warningClock.duration === '500' && warningClock.units === 'ms', 'Warnblink-Takt verwendet eine Core-Trigger-Node mit 500 ms');
check(warningClock.op1type === 'nul' && warningClock.extend === false, 'Warnblink-Trigger sendet ausschließlich die verzögerte Taktmeldung');
check(JSON.stringify(warningClock.wires) === JSON.stringify([['e0809a11d6ca3b34']]), 'Warnblink-Trigger führt ausschließlich zum Controller zurück');
check(warning.func.includes("msg.topic === 'state:8'"), 'Warnblink-Takt wird durch CH-8-State bestätigt');
check(warning.func.includes("msg.topic === 'front-warning-clock'"), 'Warnblink-Controller verarbeitet nur explizite Trigger-Takte');
check(!warning.func.includes("msg.topic === 'dim:8'"), 'Warnblink-Takt verwendet keine Dimming-Bestätigung');
check(!warning.func.includes('WARNING_LEVEL') && !warning.func.includes('dimming('), 'Warnblink-Controller erzeugt keine Dimming-Befehle');
check(!warning.func.includes('SwitchableOutput/10') && !warning.func.includes('WARNING_CHANNEL = 11'), 'Warnblink-Controller kann CH 11 nicht ansprechen');
check(starpowerCoalescer.type === 'delay' && starpowerCoalescer.pauseType === 'rate', 'STAR-Power-Snapshot verwendet eine Core-Delay-Ratebegrenzung');
check(starpowerCoalescer.rate === '1' && starpowerCoalescer.nbRateUnits === '1' && starpowerCoalescer.rateUnits === 'second' && starpowerCoalescer.drop === true, 'STAR-Power-Snapshot ist auf maximal 1/s mit Drop begrenzt');
check(JSON.stringify(starpowerCoalescer.wires) === JSON.stringify([['cff2c4d32221ccd8']]), 'STAR-Power-Vorgate führt ausschließlich zum Gesamtgate');
check(sensorCoalescer.type === 'delay' && sensorCoalescer.pauseType === 'rate', 'Gesamt-Snapshot verwendet eine Core-Delay-Ratebegrenzung');
check(sensorCoalescer.rate === '2' && sensorCoalescer.nbRateUnits === '1' && sensorCoalescer.rateUnits === 'second' && sensorCoalescer.drop === true, 'Gesamt-Snapshot ist hart auf maximal 2/s mit Drop begrenzt');
const aggregatorInputs = flows.filter(node => targetsOf(node.id).includes('ada9353cc6ea4a4c')).map(node => node.id);
check(JSON.stringify(aggregatorInputs) === JSON.stringify(['cff2c4d32221ccd8']), 'Jeder Snapshot-Anlass durchläuft den einzigen gemeinsamen 2-Hz-Gate');
check(JSON.stringify(sensorCoalescer.wires) === JSON.stringify([['ada9353cc6ea4a4c']]), 'Gesamtgate führt ausschließlich zum Snapshot-Aggregator');
for (const coalescer of [starpowerCoalescer, sensorCoalescer, warningClock]) {
  check(!('func' in coalescer) && !('initialize' in coalescer) && !('finalize' in coalescer), `${coalescer.id} enthält keinen Function-/Context-Code`);
}
check(JSON.stringify(starRouter.wires?.[7] || []) === JSON.stringify(['959137a3ca444583']), 'STAR-Power State CH 8 führt exakt zum Warnlicht-Ausgang');
check((starRouter.wires?.[13] || []).length === 0, 'STAR-Power Dimming CH 8 ist unverdrahtet');
check(JSON.stringify(starRouter.wires?.[10] || []) === JSON.stringify(['4afab948e3bba101']), 'STAR-Power State CH 11 führt exakt zum Hecklicht-Ausgang');
check(JSON.stringify(starRouter.wires?.[16] || []) === JSON.stringify(['d1a6f2d556b5e888']), 'STAR-Power Dimming CH 11 führt exakt zum Hecklicht-Ausgang');
for (const id of ['7b14fa6e29773eb5', '4ae22adfa536b4be']) {
  check(!targetsOf(id).includes('e0809a11d6ca3b34'), `${id} umgeht den Warnblink-Controller`);
  check(targetsOf(id).includes('6a22df3c7ebe02fc') && targetsOf(id).includes('d36a1adac492ce3e'), `${id} geht direkt zu Zustand und Aggregator`);
}
check(get('86d942fcb177ccae').topic === 'init' && get('86d942fcb177ccae').once === true && get('86d942fcb177ccae').onceDelay === 0.2, 'STAR-Power-Init setzt Warnlicht zeitnah und sicher AUS');

// Funktionale Regression: ACK-gesteuerter Blinkzyklus ohne Timer-Handle im
// persistenten Context. Der Core-Trigger selbst wird strukturell geprüft;
// hier simulieren wir ausschließlich die serialisierbare Zustandsmaschine.
const warningValues = new Map();
const warningFlow = {
  get: key => warningValues.get(key),
  set: (key, value) => warningValues.set(key, value)
};
const runWarning = msg => new Function('msg', 'flow', 'context', 'node', 'env', 'RED', warning.func)(
  msg, warningFlow, { get() {}, set() {} }, { send() {}, warn() {}, error() {}, status() {} }, {}, {}
);
new Function('msg', 'flow', 'context', 'node', 'env', 'RED', warning.initialize || '')(
  {}, warningFlow, { get() {}, set() {} }, { send() {} }, {}, {}
);
const warningInit = runWarning({ topic: 'init', payload: '' });
check(warningInit?.[0]?.[0]?.payload?.channel === 8 && warningInit?.[0]?.[0]?.payload?.value === 0, 'Initialisierung schreibt ausschließlich Warnlicht CH 8 AUS');
check(warningInit?.[0]?.[1]?.topic === 'init' && warningInit?.[1]?.reset === true, 'Initialisierung erhält Dashboard-Init und verwirft alten Takt');
const warningStart = runWarning({ topic: 'ui', payload: { action: 'toggle', channel: 8, value: 1 } });
check(warningStart?.[0]?.length === 2 && warningStart[0][0].payload.channel === 7 && warningStart[0][0].payload.value === 0, 'Warnlichtstart schaltet Weißlicht zuerst AUS');
check(warningStart?.[0]?.[1]?.payload?.channel === 8 && warningStart[0][1].payload.value === 1 && warningStart?.[1]?.reset === true, 'Warnlichtstart schaltet CH 8 EIN und verwirft alten Takt');
const warningAckOn = runWarning({ topic: 'state:8', payload: 1 });
check(warningAckOn?.[1]?.topic === 'front-warning-clock' && warningAckOn?.[1]?.reset !== true, 'CH-8-ACK plant exakt einen Core-Trigger-Takt');
const warningEdge = runWarning({ topic: 'front-warning-clock', payload: '' });
check(warningEdge?.[0]?.payload?.channel === 8 && warningEdge?.[0]?.payload?.value === 0 && warningEdge?.[1] === null, 'Trigger-Takt erzeugt genau die nächste CH-8-Flanke');
const warningAckOff = runWarning({ topic: 'state:8', payload: 0 });
check(warningAckOff?.[1]?.topic === 'front-warning-clock', 'Nächster Takt wird erst nach passendem CH-8-ACK geplant');
const warningStop = runWarning({ topic: 'ui', payload: { action: 'toggle', channel: 8, value: 0 } });
check(warningStop?.[0]?.[0]?.payload?.channel === 8 && warningStop?.[0]?.[0]?.payload?.value === 0 && warningStop?.[1]?.reset === true, 'Warnlichtstopp setzt CH 8 AUS und löscht den Trigger-Takt');
const persistedWarning = warningValues.get('frontWarningBlink');
check(persistedWarning?.active === false && JSON.parse(JSON.stringify(persistedWarning)).pending === false, 'Warnblinkzustand bleibt vollständig JSON-serialisierbar');

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
check(['camper_network_repair_delay', 'camper_bluetooth_repair_delay', 'external_wifi_scan_refresh'].every(id => get(id).drop === true), 'Service-Refresh-Delays koaleszieren Bursts ohne Queuewachstum');
const autotermSessionSource = get('152e2fdda301b9e4').func;
const autotermDelayNode = get('19bb36cb2ea4a5c4');
check(autotermDelayNode.pauseType === 'queue' && autotermDelayNode.rate === '1' && autotermDelayNode.rateUnits === 'second' && autotermDelayNode.drop === false, 'AUTOTERM hält pro Topic nur den neuesten Befehl und sendet ressourcenschonend mit 1 Hz');
check(get('152e2fdda301b9e4').outputs === 4 && get('152e2fdda301b9e4').wires?.[3]?.includes('de71d27b69b0462f') && autotermSessionSource.includes("msg.topic = 'autoterm.stop';") && autotermSessionSource.includes("msg.topic = 'autoterm.latest';") && autotermSessionSource.indexOf("outgoingCommand === 0x03") < autotermSessionSource.indexOf('!session.ready && !diagnosticProbe'), 'AUTOTERM-Stop umgeht die Queue auch vor Session-Ready; normale Bursts bleiben latest-wins begrenzt');
check(get('7a397c289a9a3fc2').type === 'exec' && get('7a397c289a9a3fc2').command.includes('device-http-bounded.py indevolt') && get('a553dda137d3e5bf').type === 'exec' && get('a553dda137d3e5bf').command.includes('device-http-bounded.py vanturtle'), 'INDEVOLT und VanTurtle verwenden den vor dem Body-Puffer begrenzten HTTP-Transport');
check(deviceHttpHelperSource.includes('MAX_HEADER_BYTES = 16 * 1024') && deviceHttpHelperSource.includes('MAX_BODY_BYTES = 64 * 1024') && deviceHttpHelperSource.includes('if length > MAX_BODY_BYTES') && deviceHttpHelperSource.includes('ResponseTooLarge'), 'Lokaler Geräte-HTTP-Helper begrenzt Header, Content-Length, Chunked und EOF-Antworten');
check(get('51f0c8be7e1b4dbe').func.includes('MAX_DEVICE_RESPONSE_BYTES = 64 * 1024') && get('51f0c8be7e1b4dbe').func.includes('.slice(0, 64)'), 'INDEVOLT begrenzt Antwort und persistierte Seriennummer');
check(get('30de81a830592ed2').func.includes('MAX_DEVICE_RESPONSE_BYTES = 64 * 1024'), 'VanTurtle begrenzt jeden REST-/WebSocket-Statusframe');
check(starlinkHelperSource.includes('process.stdout.read(maximum + 1)') && starlinkHelperSource.includes('signal.alarm(8)') && starlinkHelperSource.includes('raise SystemExit(124)') && starlinkHelperSource.includes('raise SystemExit(return_code)') && starlinkHelperSource.includes('if overflow:') && get('camper_starlink_parse').func.includes('MAX_STARLINK_RESPONSE_BYTES = 64 * 1024'), 'Starlink-Ausgabe liest gestückeltes JSON bis EOF, besitzt einen äußeren Wall-Clock-Timeout, erhält grpcurl-Exitcodes und ist vor JSON/Context hart begrenzt');
check(get('camper_starlink_parse').func.includes(".slice(0, 32)") && get('camper_starlink_parse').func.includes("'attitudeUncertaintyDeg'"), 'Starlink persistiert höchstens 32 Alarme und nur bekannte Alignment-Skalare');
for (const id of ['163774a1197dbe4a', '152e2fdda301b9e4', 'e063b67ea21aacaf', '30de81a830592ed2']) {
  check(get(id).func.includes('warnRateLimited'), `${id} drosselt ungültige Hot-Path-Meldungen`);
}
check(get('ada9353cc6ea4a4c').func.includes("context.get('_snapshotOversizeLogAt')") && get('ada9353cc6ea4a4c').func.includes('now - lastOversizeLog >= 60000'), 'Snapshot-Oversizefehler wird höchstens einmal pro Minute geloggt');

const runServiceActions = new Function('msg', 'flow', 'context', 'node', 'env', 'RED', get('camper_service_action_router').func || '');
const serviceCooldownValues = new Map();
const serviceContext = { get: key => serviceCooldownValues.get(key), set: (key, value) => serviceCooldownValues.set(key, value) };
const serviceFlow = { get() {}, set() {} };
let networkExecCount = 0;
for (let index = 0; index < 1000; index += 1) {
  const output = runServiceActions({ payload: { action: 'networkRepair' } }, serviceFlow, serviceContext, {}, {}, {});
  if (output?.[0]) networkExecCount += 1;
}
check(networkExecCount === 1 && Object.keys(serviceCooldownValues.get('serviceCooldowns') || {}).length <= 8, '1.000 Service-Befehle erzeugen genau einen Prozess und einen festen Cooldown-State');

const noWriteFlow = () => {
  const writes = [];
  return { writes, api: { get: () => ({}), set: (key, value) => writes.push([key, value]) } };
};
const runStarlinkParser = new Function('msg', 'flow', 'context', 'node', 'env', 'RED', get('camper_starlink_parse').func || '');
const oversizedStarlinkFlow = noWriteFlow();
check(runStarlinkParser({ payload: Buffer.alloc(64 * 1024 + 1, 120) }, oversizedStarlinkFlow.api, {}, {}, {}, {}) == null && oversizedStarlinkFlow.writes.length === 0, 'Starlink >64 KiB wird vor JSON und Context verworfen');
const manyAlerts = Object.fromEntries(Array.from({ length: 50 }, (_value, index) => [`alert-${index}`, true]));
const normalStarlinkFlow = noWriteFlow();
runStarlinkParser({ payload: Buffer.from(JSON.stringify({ dishGetDiagnostics: { id: 'x'.repeat(300), hardwareVersion: 'h'.repeat(100), softwareVersion: 's'.repeat(300), disablementCode: 'OKAY', alerts: manyAlerts, alignmentStats: { boresightAzimuthDeg: 12, unknownHuge: 'x'.repeat(1000) } } })) }, normalStarlinkFlow.api, {}, {}, {}, {});
const normalizedStarlink = normalStarlinkFlow.writes.find(([key]) => key === 'starlinkState')?.[1];
check(normalizedStarlink?.alerts?.length === 32 && normalizedStarlink.id.length === 128 && normalizedStarlink.hardwareVersion.length === 64 && normalizedStarlink.alignment?.boresightAzimuthDeg === 12 && normalizedStarlink.alignment?.unknownHuge === undefined, 'Starlink-Normalzustand ist vollständig gecappt und gewhitelistet');

const runIndevoltMerge = new Function('msg', 'flow', 'context', 'node', 'env', 'RED', get('51f0c8be7e1b4dbe').func || '');
const oversizedIndevoltApi = noWriteFlow();
check(runIndevoltMerge({ _indevoltIp: '172.24.24.159', payload: Buffer.alloc(64 * 1024 + 1, 120) }, oversizedIndevoltApi.api, {}, {}, {}, {}) == null && oversizedIndevoltApi.writes.length === 0, 'INDEVOLT >64 KiB erzeugt keinen Context-Write');
const runVanturtleState = new Function('msg', 'flow', 'context', 'node', 'env', 'RED', get('30de81a830592ed2').func || '');
const oversizedVanturtleApi = noWriteFlow();
check(runVanturtleState({ payload: Buffer.alloc(64 * 1024 + 1, 120) }, oversizedVanturtleApi.api, { get() {}, set() {} }, { warn() {} }, {}, {}) == null && oversizedVanturtleApi.writes.length === 0, 'VanTurtle >64 KiB erzeugt keinen Context-Write');
check(get('6265bf6f9bade1e5').func.includes("'wifiConnect'"), 'Zentraler Router kennt wifiConnect');
check(get('external_wifi_state_update').func.includes('source.wifi'), 'WLAN-Parser verarbeitet die verschachtelte Venus-Struktur');
check(get('ada9353cc6ea4a4c').func.includes('externalWifi: externalWifiStatus'), 'Snapshot enthält strukturierten WLAN-Status');
check(!dashboard.includes('wifiPassphrase') && !dashboard.includes('autocomplete="new-password"'), 'V2-Hauptdashboard hält keine WLAN-Zugangsdaten im Browserzustand');

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
