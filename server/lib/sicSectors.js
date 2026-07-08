// Static SIC code → coarse sector map.
//
// SEC filings carry a 4-digit SIC (Standard Industrial Classification) code;
// we bucket them into ~12 coarse sectors used across scoring, committee
// relevance, and dashboards.

export const SECTORS = [
  'technology',
  'healthcare',
  'financials',
  'energy',
  'defense-aerospace',
  'industrials',
  'consumer',
  'real-estate',
  'utilities',
  'materials',
  'communications',
  'other',
];

// Ordered [min, max, sector] ranges — the first match wins, so specific
// ranges must precede the broad ones that contain them.
const RANGES = [
  // defense & aerospace
  [3480, 3489, 'defense-aerospace'], // ordnance & accessories
  [3720, 3728, 'defense-aerospace'], // aircraft & parts
  [3760, 3769, 'defense-aerospace'], // guided missiles, space vehicles
  [3812, 3812, 'defense-aerospace'], // search/navigation/defense electronics

  // healthcare
  [2833, 2836, 'healthcare'], // drugs, biologicals
  [3841, 3851, 'healthcare'], // medical devices & supplies
  [8000, 8099, 'healthcare'], // health services

  // real estate (before the broad financials range)
  [6500, 6599, 'real-estate'],
  [6798, 6798, 'real-estate'], // REITs

  // financials
  [6000, 6999, 'financials'],

  // energy (before the broad mining + transport ranges)
  [1300, 1399, 'energy'], // oil & gas extraction
  [2900, 2999, 'energy'], // petroleum refining
  [4600, 4699, 'energy'], // pipelines

  // utilities & communications
  [4900, 4999, 'utilities'],
  [4800, 4899, 'communications'],
  [2700, 2799, 'communications'], // printing & publishing
  [7800, 7999, 'communications'], // movies, entertainment, media

  // technology
  [3570, 3579, 'technology'], // computers & office equipment
  [3600, 3699, 'technology'], // electronics, semiconductors
  [3820, 3829, 'technology'], // measurement & lab instruments
  [7370, 7379, 'technology'], // software & computer services

  // materials
  [1000, 1499, 'materials'], // mining & metals
  [2600, 2699, 'materials'], // paper
  [2800, 2899, 'materials'], // chemicals (pharma carved out above)
  [3200, 3399, 'materials'], // stone, glass, primary metals

  // industrials
  [1500, 1799, 'industrials'], // construction
  [3400, 3599, 'industrials'], // fabricated metal, machinery
  [3700, 3799, 'industrials'], // transportation equipment (aero carved out)
  [3800, 3899, 'industrials'], // remaining instruments
  [4000, 4599, 'industrials'], // transportation services
  [4700, 4799, 'industrials'], // transportation arrangement

  // consumer
  [100, 999, 'consumer'],   // agriculture
  [2000, 2599, 'consumer'], // food, tobacco, textiles, apparel, furniture
  [3000, 3199, 'consumer'], // rubber, plastics, leather
  [5000, 5999, 'consumer'], // wholesale & retail
  [7000, 7099, 'consumer'], // hotels & lodging
];

/** Map a SIC code (number or string) to a coarse sector; null on bad input. */
export function sicToSector(sic) {
  const code = Number(sic);
  if (!Number.isFinite(code) || code <= 0) return null;
  for (const [min, max, sector] of RANGES) {
    if (code >= min && code <= max) return sector;
  }
  return 'other';
}
