/**
 * Centralized DHIS2 API client. Every call to DHIS2 goes through here.
 * The Personal Access Token lives only in this process's environment
 * variables (DHIS2_TOKEN) — it is never sent to or visible from Claude.
 */

export interface Dhis2OrgUnit {
  id: string;
  name: string;
  level: number;
  parent?: { id: string; name: string };
}

export interface Dhis2DataElement {
  id: string;
  name: string;
}
export interface Dhis2Indicator {
  id: string;
  name: string;
}

/**
 * Curated map of vaccine -> coverage indicator UID on this DHIS2 instance.
 * Prefers "Monthly" variants (matches monthly YYYYMM period queries used
 * elsewhere in this server) over "Annualized" ones, and skips "_Alt_"
 * duplicate indicators. Resolved by hand from /api/indicators.json.
 * Update this map if new coverage indicators are added on the instance.
 */
export const VACCINE_COVERAGE_INDICATORS: Record<string, string> = {
  'BCG': 'ZeMXMabbR4C',
  'HBV 0': 'k7TZGtTN2Md',
  'Penta 1': 'yHw3A23QqP8',
  'Penta 3': 'VRycpXG44y1',
  'OPV 1': 'slvffucfWn0',
  'OPV 3': 'gi9jd7BjHxq',
  'IPV 1': 'ny4uBALk8li',
  'IPV 2': 'Fq9e1cXk4Us',
  'PCV 3': 'dfBzw8zQDHk',
  'Rotavirus 1': 'gPT6M0Tr6A7',
  'Rotavirus 2': 'XxqSEWDAKty',
  'Rotavirus 3': 'O6WyM4NQLLX',
  'Measles 1': 'tb5NGUMB9dQ',
  'Measles 2': 'qagHWllYle8',
  'Yellow Fever': 'RtXOV3xQvWT',
  'Men A': 'SruoPzzt3ES'
};

/**
 * Search coverage indicators by keyword, live against the instance (used as
 * a fallback when a vaccine name isn't in VACCINE_COVERAGE_INDICATORS).
 */
export async function findCoverageIndicatorsByKeyword(keyword: string): Promise<Dhis2Indicator[]> {
  const data = await dhis2Get<{ indicators: Dhis2Indicator[] }>(
    `/api/indicators.json?filter=name:like:${encodeURIComponent(keyword)}&filter=name:like:Coverage&fields=id,name&paging=false&rootJunction=AND`
  );
  return data.indicators;
}
export interface Dhis2AnalyticsResponse {
  headers: Array<{ name: string; column: string }>;
  metaData: {
    items: Record<string, { name: string }>;
  };
  rows: string[][];
}

// Vaccine names contaminated with stock/logistics terms are excluded when
// listing "antigens", since they represent vials received/opened/wasted,
// not doses given to children.
const STOCK_LOGISTICS_KEYWORDS = [
  'received', 'opened', 'returned', 'stock out', 'diluent',
  'wastage', 'balance', 'issued', 'damaged', 'expired'
];

function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}. Set it in your hosting platform's environment settings.`);
  }
  return value;
}

async function dhis2Get<T>(path: string): Promise<T> {
  const base = getEnv('DHIS2_BASE_URL').replace(/\/$/, '');
  const token = getEnv('DHIS2_TOKEN');

  const res = await fetch(base + path, {
    method: 'GET',
    headers: { Authorization: `ApiToken ${token}` }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`DHIS2 API error ${res.status} for ${path}: ${body.slice(0, 500)}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Find an org unit by fuzzy name match (case-insensitive substring).
 * Used to resolve LGA/facility names the model receives from the user
 * into DHIS2 UIDs.
 */
export async function findOrgUnitByName(name: string, level?: number): Promise<Dhis2OrgUnit[]> {
  const levelFilter = level ? `&filter=level:eq:${level}` : '';
  const data = await dhis2Get<{ organisationUnits: Dhis2OrgUnit[] }>(
    `/api/organisationUnits.json?filter=name:like:${encodeURIComponent(name)}${levelFilter}&fields=id,name,level,parent[id,name]&paging=false`
  );
  return data.organisationUnits;
}

export async function getOrgUnitChildren(orgUnitId: string): Promise<Dhis2OrgUnit[]> {
  const data = await dhis2Get<{ children: Dhis2OrgUnit[] }>(
    `/api/organisationUnits/${orgUnitId}.json?fields=children[id,name,level]`
  );
  return data.children;
}

export async function getOrgUnitsByLevelUnderAncestor(level: number, ancestorId: string): Promise<Dhis2OrgUnit[]> {
  const data = await dhis2Get<{ organisationUnits: Dhis2OrgUnit[] }>(
    `/api/organisationUnits.json?filter=level:eq:${level}&filter=ancestors.id:eq:${ancestorId}&fields=id,name,level,parent[id,name]&paging=false`
  );
  return data.organisationUnits;
}

/**
 * Find antigen (dose-administered) data elements by keyword, excluding
 * vaccine stock/logistics entries.
 */
export async function findAntigenDataElements(keyword: string): Promise<Dhis2DataElement[]> {
  const data = await dhis2Get<{ dataElements: Dhis2DataElement[] }>(
    `/api/dataElements.json?filter=name:like:${encodeURIComponent(keyword)}&fields=id,name&paging=false`
  );
  return data.dataElements.filter(
    de => !STOCK_LOGISTICS_KEYWORDS.some(bad => de.name.toLowerCase().includes(bad))
  );
}

/**
 * Core analytics query: given data element UID(s), org unit UID(s), and a
 * period spec, return the raw DHIS2 analytics response.
 *
 * periodSpec examples: "LAST_12_MONTHS", "202601;202602;202603",
 * or a DHIS2 relative period keyword.
 */
export async function getAnalytics(
  dataElementIds: string[],
  orgUnitIds: string[],
  periodSpec: string,
  categoryOptionComboId?: string
): Promise<Dhis2AnalyticsResponse> {
  const dx = dataElementIds
    .map(id => (categoryOptionComboId ? `${id}.${categoryOptionComboId}` : id))
    .join(';');
  const ou = orgUnitIds.join(';');
  return dhis2Get<Dhis2AnalyticsResponse>(
    `/api/analytics.json?dimension=dx:${dx}&dimension=ou:${ou}&dimension=pe:${periodSpec}`
  );
}

/**
 * Analytics query using a LEVEL-N org unit dimension (pulls all org units
 * at that level under an ancestor in a single call — used for facility-wide
 * queries without looping per facility).
 */
export async function getAnalyticsByLevel(
  dataElementIds: string[],
  level: number,
  ancestorId: string,
  periodSpec: string,
  categoryOptionComboId?: string
): Promise<Dhis2AnalyticsResponse> {
  const dx = dataElementIds
    .map(id => (categoryOptionComboId ? `${id}.${categoryOptionComboId}` : id))
    .join(';');
  return dhis2Get<Dhis2AnalyticsResponse>(
    `/api/analytics.json?dimension=dx:${dx}&dimension=ou:LEVEL-${level};${ancestorId}&dimension=pe:${periodSpec}`
  );
}

/**
 * Parses an analytics response's rows into plain objects using metadata
 * names instead of raw UIDs. Row column order from DHIS2 is [dx, ou, pe, value].
 */
export function parseAnalyticsRows(data: Dhis2AnalyticsResponse) {
  const names = data.metaData.items;
  return data.rows.map(([deId, ouId, peId, value]) => ({
    dataElement: names[deId]?.name || deId,
    orgUnit: names[ouId]?.name || ouId,
    orgUnitId: ouId,
    period: peId,
    value: Number(value)
  }));
}


/**
 * Generic data element search — NO keyword filtering. Use this (instead of
 * findAntigenDataElements) for anything that isn't a dose-administered
 * antigen: session planned/conducted counts, vaccine stock/utilization
 * (vials received/opened/used/wasted), AEFI (Adverse Event Following
 * Immunization) case counts, temperature/cold-chain elements, etc.
 */
export async function findDataElementGeneric(keyword: string): Promise<Dhis2DataElement[]> {
  const data = await dhis2Get<{ dataElements: Dhis2DataElement[] }>(
    `/api/dataElements.json?filter=name:like:${encodeURIComponent(keyword)}&fields=id,name&paging=false`
  );
  return data.dataElements;
}

export interface Dhis2CategoryOptionCombo {
  id: string;
  name: string;
}

export interface Dhis2DataElementWithDisaggregations extends Dhis2DataElement {
  categoryOptionCombos: Dhis2CategoryOptionCombo[];
}

/**
 * Search data elements by keyword AND return their category option combos
 * (disaggregations) — e.g. a single data element like "RI fixed sessions"
 * may be split into "Planned" vs "Conducted" (or similarly named) category
 * option combos rather than being two separate data elements. Use this when
 * dhis2_find_data_element finds an element whose value looks combined/blended
 * and you need to pull one specific disaggregation out of it — pass the
 * returned category option combo id as categoryOptionComboId to
 * dhis2_get_coverage / dhis2_get_coverage_by_level.
 */
export async function findDataElementDisaggregations(keyword: string): Promise<Dhis2DataElementWithDisaggregations[]> {
  const data = await dhis2Get<{
    dataElements: Array<{
      id: string;
      name: string;
      categoryCombo?: { categoryOptionCombos?: Dhis2CategoryOptionCombo[] };
    }>;
  }>(
    `/api/dataElements.json?filter=name:like:${encodeURIComponent(keyword)}&fields=id,name,categoryCombo[categoryOptionCombos[id,name]]&paging=false`
  );
  return data.dataElements.map(de => ({
    id: de.id,
    name: de.name,
    categoryOptionCombos: de.categoryCombo?.categoryOptionCombos || []
  }));
}

export interface Dhis2DataSet {
  id: string;
  name: string;
  periodType: string;
}

/**
 * Resolve a dataset name (e.g. "NHMIS Monthly Summary Form", "Health
 * Facility Vaccines Utilization Summary") to its UID. Needed for
 * completeness/timeliness (reporting-rate) queries, which are dataset-level
 * rather than data-element-level.
 */
export async function findDatasetByName(name: string): Promise<Dhis2DataSet[]> {
  const data = await dhis2Get<{ dataSets: Dhis2DataSet[] }>(
    `/api/dataSets.json?filter=name:like:${encodeURIComponent(name)}&fields=id,name,periodType&paging=false`
  );
  return data.dataSets;
}

export interface Dhis2CompletenessRow {
  datasetId: string;
  orgUnitId: string;
  period: string;
  reportingRate: number | null;       // completeness %: actual reports / expected reports
  reportingRateOnTime: number | null; // timeliness %: on-time reports / expected reports
  actualReports: number | null;
  actualReportsOnTime: number | null;
  expectedReports: number | null;
}

const COMPLETENESS_METRICS = [
  'REPORTING_RATE',
  'REPORTING_RATE_ON_TIME',
  'ACTUAL_REPORTS',
  'ACTUAL_REPORTS_ON_TIME',
  'EXPECTED_REPORTS'
] as const;

function buildCompletenessDx(datasetIds: string[]): string {
  return datasetIds.flatMap(id => COMPLETENESS_METRICS.map(m => `${id}.${m}`)).join(';');
}

function assembleCompletenessRows(data: Dhis2AnalyticsResponse): Dhis2CompletenessRow[] {
  const dxIdx = data.headers.findIndex(h => h.name === 'dx');
  const ouIdx = data.headers.findIndex(h => h.name === 'ou');
  const peIdx = data.headers.findIndex(h => h.name === 'pe');
  const valIdx = data.headers.findIndex(h => h.name === 'value');

  const grouped = new Map<string, Dhis2CompletenessRow>();
  for (const row of data.rows) {
    const dx = row[dxIdx]!;
    const dotIdx = dx.lastIndexOf('.');
    const datasetId = dx.slice(0, dotIdx);
    const metric = dx.slice(dotIdx + 1);
    const ouId = row[ouIdx]!;
    const period = row[peIdx]!;
    const value = Number(row[valIdx]);
    const key = `${datasetId}|${ouId}|${period}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        datasetId, orgUnitId: ouId, period,
        reportingRate: null, reportingRateOnTime: null,
        actualReports: null, actualReportsOnTime: null, expectedReports: null
      });
    }
    const entry = grouped.get(key)!;
    if (metric === 'REPORTING_RATE') entry.reportingRate = value;
    else if (metric === 'REPORTING_RATE_ON_TIME') entry.reportingRateOnTime = value;
    else if (metric === 'ACTUAL_REPORTS') entry.actualReports = value;
    else if (metric === 'ACTUAL_REPORTS_ON_TIME') entry.actualReportsOnTime = value;
    else if (metric === 'EXPECTED_REPORTS') entry.expectedReports = value;
  }
  return [...grouped.values()];
}

/**
 * Reporting/monitoring rate for dataset(s): completeness (% of expected
 * facility reports submitted) and timeliness (% submitted on time), for
 * specific org unit(s).
 */
export async function getCompletenessTimeliness(
  datasetIds: string[],
  orgUnitIds: string[],
  periodSpec: string
): Promise<Dhis2CompletenessRow[]> {
  const dx = buildCompletenessDx(datasetIds);
  const ou = orgUnitIds.join(';');
  const data = await dhis2Get<Dhis2AnalyticsResponse>(
    `/api/analytics.json?dimension=dx:${dx}&dimension=ou:${ou}&dimension=pe:${periodSpec}`
  );
  return assembleCompletenessRows(data);
}

/**
 * Reporting/monitoring rate (completeness + timeliness) for dataset(s)
 * across every org unit at a level under an ancestor.
 */
export async function getCompletenessTimelinessByLevel(
  datasetIds: string[],
  level: number,
  ancestorId: string,
  periodSpec: string
): Promise<Dhis2CompletenessRow[]> {
  const dx = buildCompletenessDx(datasetIds);
  const data = await dhis2Get<Dhis2AnalyticsResponse>(
    `/api/analytics.json?dimension=dx:${dx}&dimension=ou:LEVEL-${level};${ancestorId}&dimension=pe:${periodSpec}`
  );
  return assembleCompletenessRows(data);
}

export interface Dhis2SessionRow {
  orgUnitId: string;
  period: string;
  planned: number;
  conducted: number;
  implementationPct: number | null;
}

function assembleSessionRows(
  data: Dhis2AnalyticsResponse,
  plannedId: string,
  conductedId: string
): Dhis2SessionRow[] {
  const dxIdx = data.headers.findIndex(h => h.name === 'dx');
  const ouIdx = data.headers.findIndex(h => h.name === 'ou');
  const peIdx = data.headers.findIndex(h => h.name === 'pe');
  const valIdx = data.headers.findIndex(h => h.name === 'value');

  const grouped = new Map<string, { planned: number; conducted: number }>();
  for (const row of data.rows) {
    const dx = row[dxIdx]!;
    const key = `${row[ouIdx]}|${row[peIdx]}`;
    if (!grouped.has(key)) grouped.set(key, { planned: 0, conducted: 0 });
    const entry = grouped.get(key)!;
    const value = Number(row[valIdx]);
    if (dx === plannedId) entry.planned = value;
    else if (dx === conductedId) entry.conducted = value;
  }

  return [...grouped.entries()].map(([key, v]) => {
    const [orgUnitId, period] = key.split('|') as [string, string];
    return {
      orgUnitId,
      period,
      planned: v.planned,
      conducted: v.conducted,
      implementationPct: v.planned > 0 ? Math.round((v.conducted / v.planned) * 1000) / 10 : null
    };
  });
}

/**
 * Planned vs conducted RI session counts (fixed or outreach) for specific
 * org unit(s), with % implementation (conducted / planned).
 */
export async function getSessionImplementation(
  plannedDataElementId: string,
  conductedDataElementId: string,
  orgUnitIds: string[],
  periodSpec: string
): Promise<Dhis2SessionRow[]> {
  const dx = `${plannedDataElementId};${conductedDataElementId}`;
  const ou = orgUnitIds.join(';');
  const data = await dhis2Get<Dhis2AnalyticsResponse>(
    `/api/analytics.json?dimension=dx:${dx}&dimension=ou:${ou}&dimension=pe:${periodSpec}`
  );
  return assembleSessionRows(data, plannedDataElementId, conductedDataElementId);
}

/**
 * Planned vs conducted RI session implementation across every org unit at a
 * level under an ancestor.
 */
export async function getSessionImplementationByLevel(
  plannedDataElementId: string,
  conductedDataElementId: string,
  level: number,
  ancestorId: string,
  periodSpec: string
): Promise<Dhis2SessionRow[]> {
  const dx = `${plannedDataElementId};${conductedDataElementId}`;
  const data = await dhis2Get<Dhis2AnalyticsResponse>(
    `/api/analytics.json?dimension=dx:${dx}&dimension=ou:LEVEL-${level};${ancestorId}&dimension=pe:${periodSpec}`
  );
  return assembleSessionRows(data, plannedDataElementId, conductedDataElementId);
}
