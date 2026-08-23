'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const flow = JSON.parse(fs.readFileSync(path.join(root, 'flows', 'CamperControl_NodeRED.json'), 'utf8'));
const node = name => flow.find(item => item.name === name);
const climate = node('Klimaautomatik · AUTOTERM oder MaxxFan');
const settings = node('Settings validieren & speichern');

assert(climate && climate.func, 'Klimaautomatik-Knoten fehlt');
assert(settings && settings.func, 'Settings-Knoten fehlt');
assert(climate.func.includes('const heatingTemperature = Number(state.roomTemperature);'), 'Heizung muss den angezeigten Komfortwert verwenden');
assert(climate.func.includes('const coolingTemperature = heatingTemperature;'), 'Kühlung muss den angezeigten Komfortwert verwenden');
assert(!climate.func.includes("Lüftungsanforderung · Deckensensor"), 'Verdeckte Deckensensorregel ist noch aktiv');
assert(climate.func.includes("Lüftungsanforderung · Komfortwert"), 'Klima-Grund muss den Komfortwert nennen');
assert(settings.func.includes("sensor: 'floor'"), 'Nur der Frostschutz muss fest den Bodensensor verwenden');
assert(!settings.func.includes('{"target":"maxxfan","action":"auto"'), 'Eine Standardszene aktiviert auto_hold verdeckt');
assert(!settings.func.includes("'lid', 'auto'"), 'Szenen dürfen auto_hold nicht erneut speichern');

console.log('MaxxFan climate contract: 9/9 assertions passed');
