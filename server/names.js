'use strict';

// Name and color pools for agents (contract section 7).
// Allocation always prefers entries that are not used by a live agent.

const COLORS = Object.freeze([
  '#FF8A5B', '#5BA4E6', '#7BC67E', '#B48EE0', '#F2C14E', '#E0709B',
  '#4FC1B9', '#E8955A', '#8E9BF0', '#C9D86B', '#F07C6C', '#A0A7B8',
]);

const NAMES = Object.freeze([
  'Nova', 'Pixel', 'Biscotte', 'Orion', 'Luna', 'Zéphyr', 'Praline', 'Cosmo',
  'Mochi', 'Atlas', 'Noisette', 'Kiwi', 'Comète', 'Sirius', 'Galette', 'Écho',
  'Pistache', 'Nimbus', 'Caramel', 'Vega', 'Myrtille', 'Quartz', 'Sésame', 'Lyra',
]);

function toLowerSet(values) {
  const set = new Set();
  if (!values) return set;
  for (const v of values) {
    if (typeof v === 'string') set.add(v.toLowerCase());
  }
  return set;
}

/**
 * Returns the first pool name not used by a live agent. When the whole pool is
 * taken, numbered variants are tried in order: "Nova 2", "Pixel 2", …, "Nova 3"…
 * @param {Iterable<string>} usedNames names of live agents
 * @returns {string}
 */
function pickName(usedNames) {
  const used = toLowerSet(usedNames);
  for (const name of NAMES) {
    if (!used.has(name.toLowerCase())) return name;
  }
  for (let n = 2; n < 10000; n++) {
    for (const name of NAMES) {
      const candidate = `${name} ${n}`;
      if (!used.has(candidate.toLowerCase())) return candidate;
    }
  }
  // Unreachable in practice (would need 240 000 live agents).
  return `${NAMES[0]} ${Date.now()}`;
}

/**
 * Returns the first palette color not used by a live agent. When every color
 * is taken, returns the least used one (first in palette order on ties).
 * @param {Iterable<string>} usedColors colors of live agents
 * @returns {string}
 */
function pickColor(usedColors) {
  const counts = new Map(COLORS.map((c) => [c.toLowerCase(), 0]));
  if (usedColors) {
    for (const c of usedColors) {
      if (typeof c !== 'string') continue;
      const key = c.toLowerCase();
      if (counts.has(key)) counts.set(key, counts.get(key) + 1);
    }
  }
  let best = COLORS[0];
  let bestCount = Infinity;
  for (const color of COLORS) {
    const count = counts.get(color.toLowerCase());
    if (count === 0) return color;
    if (count < bestCount) {
      best = color;
      bestCount = count;
    }
  }
  return best;
}

module.exports = { COLORS, NAMES, pickName, pickColor };
