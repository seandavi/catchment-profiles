// What the page shows, from what the Cancer Basemap release actually holds.
// To add a measure: add its measure_id (and stratum_id, if the measure has several) to a
// group below. Labels and units come from measure.definition; nothing else needs to change.
//
// Group fields
//   source, release  measure.observation.source / source_release (bump `release` when the bundle gets a newer one)
//   level            'county' (the catchment's counties) or 'tract' (all tracts inside them)
//   agg              how counties/tracts become one catchment number: 'median', 'sum' or 'pooled'
//                    ('pooled' = 100 * sum(numerator) / sum(denominator); needs both in the data)
//   reference        geo levels to compare against, first one with a value wins
//   measures[]       { id, stratum?, suffix? (appended to the label), agg? (overrides the group's) }

const scpSites = ['001', '003', '017', '018', '020', '035', '040', '047', '053', '055', '057', '058', '061', '066',
  '071', '072', '076', '080', '086', '090'];
// Sex-specific sites use their own sex stratum (1 male, 2 female); the rest use both sexes (0).
const scpSex = { '066': '1', '055': '2', '057': '2', '058': '2', '061': '2' };

const scp = (kind, title, stage) => ({
  key: kind,
  title,
  source: 'SCP',
  release: 'V3',
  level: 'county',
  agg: 'median',
  reference: ['state', 'nation'],
  measures: scpSites.map((code) => ({ id: `SCP:${kind}:${code}`, stratum: `SCP:${scpSex[code] ?? '0'}:001:00:${stage}` })),
});

const places = (title, codes) => ({
  key: 'places',
  title,
  source: 'PLACES',
  release: '2025',
  level: 'county',
  agg: 'median',
  reference: ['nation'],
  measures: codes.map((c) => ({ id: `PLACES:${c}:age_adjusted` })),
});

export const SECTIONS = [
  {
    id: 'burden',
    title: 'Cancer burden',
    intro: 'Age-adjusted rates per 100,000, all races, all ages, by cancer site. Sex-specific sites use the sex-specific rate.',
    tables: [[scp('incidence', 'Incidence', '999'), scp('mortality', 'Mortality', 'NA')]],
  },
  {
    id: 'screening',
    title: 'Screening & risk factors',
    intro: 'Model-based county estimates of adult prevalence, age-adjusted.',
    tables: [
      [places('Screening and access', ['COLON_SCREEN', 'MAMMOUSE', 'CHECKUP', 'ACCESS2', 'DENTAL'])],
      [places('Risk factors and conditions', ['CSMOKING', 'BINGE', 'OBESITY', 'LPA', 'SLEEP', 'DIABETES', 'CANCER'])],
    ],
  },
  {
    id: 'social',
    title: 'Social context',
    intro: 'Who lives in the catchment and how vulnerable and rural it is.',
    tables: [
      [{
        key: 'acs', title: 'American Community Survey (5-year)', source: 'ACS', release: '2019-2023', level: 'county', agg: 'pooled', reference: [],
        measures: [
          { id: 'ACS:total_population', agg: 'sum' },
          { id: 'ACS:median_household_income', agg: 'median' },
          { id: 'ACS:poverty_rate' }, { id: 'ACS:unemployment_rate' }, { id: 'ACS:bachelors_or_higher' },
          { id: 'ACS:no_hs_diploma' }, { id: 'ACS:no_vehicle_households' }, { id: 'ACS:rent_burden_30' },
          { id: 'ACS:age_distribution', stratum: 'ACS:age:age_65_plus', suffix: 'age 65 and older' },
          { id: 'ACS:race_ethnicity', stratum: 'ACS:race:hispanic', suffix: 'Hispanic' },
          { id: 'ACS:race_ethnicity', stratum: 'ACS:race:nh_black', suffix: 'Black, non-Hispanic' },
          { id: 'ACS:race_ethnicity', stratum: 'ACS:race:nh_white', suffix: 'White, non-Hispanic' },
        ],
      }],
      [{
        key: 'svi', title: 'CDC/ATSDR Social Vulnerability Index', source: 'SVI', release: '2022', level: 'county', agg: 'median', reference: [],
        measures: ['RPL_THEMES:2020', 'RPL_THEME1:2020', 'RPL_THEME2:2020', 'RPL_THEME3:2020', 'RPL_THEME4:2020',
          'poverty150', 'uninsured', 'no_vehicle', 'age_65_plus'].map((id) => ({ id: `SVI:${id}` })),
      }],
      [{
        key: 'rucc', title: 'USDA rural-urban continuum', source: 'RUCC', release: '2023', level: 'county', agg: 'median', reference: [],
        measures: [{ id: 'RUCC:code' }],
      }],
    ],
  },
  {
    id: 'environment',
    title: 'Environment',
    intro: 'Tract-level modeled exposures, summarized across every tract in the catchment; radon is county-level.',
    tables: [
      [{
        key: 'ejscreen', title: 'EPA EJScreen', source: 'EJSCREEN', release: '2024', level: 'tract', agg: 'median', reference: [],
        measures: ['pm25', 'ozone', 'no2', 'dslpm', 'ptraf:2024', 'pnpl', 'ust', 'rsei_air'].map((id) => ({ id: `EJSCREEN:${id}` })),
      }],
      [{
        key: 'airtoxscreen', title: 'EPA AirToxScreen', source: 'AIRTOXSCREEN', release: '2019', level: 'tract', agg: 'median', reference: [],
        measures: ['total_cancer_risk', 'benzene', 'formaldehyde', 'ethylene_oxide'].map((id) => ({ id: `AIRTOXSCREEN:${id}` })),
      }],
      [{
        key: 'radon', title: 'EPA radon zones', source: 'EPA_RADON', release: '1993', level: 'county', agg: 'median', reference: [],
        measures: [{ id: 'EPA_RADON:zone' }],
      }],
    ],
  },
];
