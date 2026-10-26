'use strict';

/**
 * Campaign shelf colours. Named so staff can say "the purple shelf" and match
 * them with coloured tape or stickers bought off the shelf.
 */
const CAMPAIGN_COLOURS = [
  { key: 'red', name: 'Red', hex: '#d93025' },
  { key: 'orange', name: 'Orange', hex: '#f28c28' },
  { key: 'yellow', name: 'Yellow', hex: '#f2c200' },
  { key: 'lime', name: 'Lime', hex: '#8bc34a' },
  { key: 'green', name: 'Green', hex: '#1e8e3e' },
  { key: 'teal', name: 'Teal', hex: '#009688' },
  { key: 'sky', name: 'Sky blue', hex: '#4fb3e8' },
  { key: 'blue', name: 'Blue', hex: '#1a5fd0' },
  { key: 'purple', name: 'Purple', hex: '#7b3fbf' },
  { key: 'pink', name: 'Pink', hex: '#e8559a' },
  { key: 'brown', name: 'Brown', hex: '#8d5a3b' },
  { key: 'grey', name: 'Grey', hex: '#8a8f98' },
];
const COLOUR_KEYS = CAMPAIGN_COLOURS.map((c) => c.key);

/** The colour fewest running campaigns are using, so neighbouring shelves differ. */
async function nextColour(db) {
  const used = new Map(
    (await db.all("SELECT colour, COUNT(*) AS n FROM campaigns WHERE colour IS NOT NULL AND status IN ('planned','active') GROUP BY colour"))
      .map((r) => [r.colour, r.n]),
  );
  return COLOUR_KEYS.reduce((best, key) => ((used.get(key) || 0) < (used.get(best) || 0) ? key : best), COLOUR_KEYS[0]);
}

module.exports = { CAMPAIGN_COLOURS, COLOUR_KEYS, nextColour };
