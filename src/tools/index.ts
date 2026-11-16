import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  findOrgUnitByName,
  getOrgUnitChildren,
  getOrgUnitsByLevelUnderAncestor,
  findAntigenDataElements,
  getAnalytics,
  getAnalyticsByLevel,
  parseAnalyticsRows,
  VACCINE_COVERAGE_INDICATORS,
  findCoverageIndicatorsByKeyword,
  findDataElementGeneric,
  findDataElementDisaggregations,
  findDatasetByName,
  getCompletenessTimeliness,
  getCompletenessTimelinessByLevel,
  getSessionImplementation,
  getSessionImplementationByLevel
} from '../services/dhis2Client.js';

const CHARACTER_LIMIT = 20000;

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function jsonResult(obj: unknown) {
  const text = JSON.stringify(obj, null, 2);
  const truncated = text.length > CHARACTER_LIMIT
    ? text.slice(0, CHARACTER_LIMIT) + `\n... [truncated, ${text.length} chars total — narrow your query]`
    : text;
  return {
    content: [{ type: 'text' as const, text: truncated }],
    structuredContent: obj as Record<string, unknown>
  };
}

export function registerDhis2Tools(server: McpServer) {

  // ---------------------------------------------------------------
  // dhis2_find_org_unit
  // ---------------------------------------------------------------
  server.registerTool(
    'dhis2_find_org_unit',
    {
      title: 'Find DHIS2 org unit',
      description: `Search for an organisation unit (state, LGA, ward, or health facility) by name.

Use this FIRST to resolve a human-readable place name (e.g. "Ilorin South", "Offa", a facility name) into the DHIS2 UID needed by other tools. Returns all fuzzy matches — if multiple results come back, check the "level" and "parent" fields to pick the right one before using its id elsewhere.

Args:
  - name (string): Name or partial name to search for, e.g. "Kwara", "Ilorin", "Offa"
  - level (number, optional): Restrict to a specific org unit level if known (e.g. 2=state, 3=LGA, 4=facility — levels vary by instance, use dhis2_list_org_unit_levels if unsure)

Returns: array of { id, name, level, parent } for each match.

Error Handling:
  - Returns an empty array (not an error) if nothing matches — try a shorter or different search term.`,
      inputSchema: {
        name: z.string().min(2).max(200).describe('Name or partial name of the org unit to search for'),
        level: z.number().int().min(1).max(10).optional().describe('Restrict results to this org unit level')
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ name, level }) => {
      const results = await findOrgUnitByName(name, level);
      if (results.length === 0) {
        return textResult(`No org units found matching "${name}". Try a shorter search term.`);
      }
      return jsonResult({ count: results.length, orgUnits: results });
    }
  );

  // ---------------------------------------------------------------
  // dhis2_list_org_unit_children
  // ---------------------------------------------------------------
  server.registerTool(
    'dhis2_list_org_unit_children',
    {
      title: 'List DHIS2 org unit children',
      description: `List the direct children of a given organisation unit — e.g. the LGAs under a state, or the facilities under an LGA/ward.

Use dhis2_find_org_unit first to get the parent's UID, then pass it here to see one level down the hierarchy.

Args:
  - orgUnitId (string): UID of the parent org unit

Returns: array of { id, name, level } for each direct child.`,
      inputSchema: {
        orgUnitId: z.string().min(11).max(11).describe('DHIS2 UID of the parent org unit')
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ orgUnitId }) => {
      const children = await getOrgUnitChildren(orgUnitId);
      return jsonResult({ count: children.length, children });
    }
  );

  // ---------------------------------------------------------------
  // dhis2_list_org_units_by_level
  // ---------------------------------------------------------------
  server.registerTool(
    'dhis2_list_org_units_by_level',
    {
      title: 'List all DHIS2 org units at a level under an ancestor',
      description: `List every org unit at a given hierarchy level under an ancestor org unit in one call — e.g. every health facility under a state, without walking the tree LGA by LGA.

More efficient than dhis2_list_org_unit_children when you need a full facility list rather than one LGA's children.

Args:
  - level (number): Target org unit level (e.g. the facility level for this instance — check with dhis2_find_org_unit on a known facility to see its level)
  - ancestorId (string): UID of the ancestor org unit (e.g. the state)

Returns: array of { id, name, level, parent } for every matching org unit.`,
      inputSchema: {
        level: z.number().int().min(1).max(10).describe('Org unit level to list'),
        ancestorId: z.string().min(11).max(11).describe('UID of the ancestor org unit to search under')
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ level, ancestorId }) => {
      const orgUnits = await getOrgUnitsByLevelUnderAncestor(level, ancestorId);
      return jsonResult({ count: orgUnits.length, orgUnits });
    }
  );

  // ---------------------------------------------------------------
  // dhis2_find_antigen
  // ---------------------------------------------------------------
  server.registerTool(
    'dhis2_find_antigen',
    {
      title: 'Find DHIS2 antigen data element',
      description: `Search for a routine immunization antigen "doses given" data element by keyword (e.g. "Penta1", "BCG", "Measles", "Yellow Fever").

Automatically excludes vaccine stock/logistics data elements (vials received, opened, returned, wasted) so results are limited to actual doses administered. Use this to resolve an antigen name into the UID needed by dhis2_get_coverage.

Args:
  - keyword (string): Antigen keyword to search for, e.g. "Penta1", "OPV3", "Measles"

Returns: array of { id, name } for matching data elements. Multiple results can appear if an instance has more than one matching element — check the name to pick the right one.

Error Handling:
  - Returns an empty array if no dose-administered element matches — the keyword may not match your instance's naming, try a broader term.`,
      inputSchema: {
        keyword: z.string().min(2).max(100).describe('Antigen keyword, e.g. "Penta1", "BCG", "Measles"')
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ keyword }) => {
      const results = await findAntigenDataElements(keyword);
      if (results.length === 0) {
        return textResult(`No dose-administered data elements found matching "${keyword}". All matches may have been stock/logistics elements, or the naming differs — try a different keyword.`);
      }
      return jsonResult({ count: results.length, dataElements: results });
    }
  );

  // ---------------------------------------------------------------
  // dhis2_get_coverage
  // ---------------------------------------------------------------
  server.registerTool(
    'dhis2_get_coverage',
    {
      title: 'Get antigen coverage for an org unit',
      description: `Get antigen dose counts for one or more org units over a period range. This is the main data-retrieval tool — use it after resolving antigen and org unit UIDs with dhis2_find_antigen and dhis2_find_org_unit.

Args:
  - dataElementIds (string[]): One or more antigen data element UIDs (from dhis2_find_antigen)
  - orgUnitIds (string[]): One or more org unit UIDs (from dhis2_find_org_unit or dhis2_list_org_units_by_level)
  - periods (string[]): DHIS2 monthly periods in YYYYMM format, e.g. ["202601","202602","202603"] for Jan-Mar 2026. For a single relative range you can also pass a single DHIS2 relative period keyword like "LAST_12_MONTHS" as the only array element.

Returns: 
  {
    "rows": [{ dataElement, orgUnit, orgUnitId, period, value }, ...],
    "totalByOrgUnit": { "<orgUnit name>": <sum across periods and data elements> },
    "grandTotal": <sum of all values>
  }

Examples:
  - Use when: "Penta1 given in Ilorin South LGA, Jan-June 2026" -> dataElementIds=[Penta1 UID], orgUnitIds=[Ilorin South UID], periods=["202601",...,"202606"]
  - Use when: comparing multiple LGAs -> pass multiple orgUnitIds at once (one call, not a loop)
  - Use when: a data element is disaggregated into sub-categories (e.g. "RI fixed sessions" split into "Planned" vs "Conducted") and you need just ONE slice -> first call dhis2_find_data_element_disaggregations to get the category option combo id, then pass it as categoryOptionComboId here to get that slice alone instead of the combined total.

Error Handling:
  - Returns rows: [] with grandTotal: 0 if there's no data for the given combination — this is a valid "no data" result, not a failure.`,
      inputSchema: {
        dataElementIds: z.array(z.string()).min(1).max(20).describe('Antigen data element UIDs'),
        orgUnitIds: z.array(z.string()).min(1).max(50).describe('Org unit UIDs to query'),
        periods: z.array(z.string()).min(1).max(60).describe('YYYYMM periods, e.g. ["202601","202602"], or a single relative period keyword like "LAST_12_MONTHS"'),
        categoryOptionComboId: z.string().min(11).max(11).optional().describe('Optional: restrict to ONE disaggregation/category option combo (from dhis2_find_data_element_disaggregations) instead of the combined total across all disaggregations. Applied to every dataElementId in this call.')
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ dataElementIds, orgUnitIds, periods, categoryOptionComboId }) => {
      const periodSpec = periods.length === 1 && /^[A-Z_]+$/.test(periods[0]!) ? periods[0]! : periods.join(';');
      const data = await getAnalytics(dataElementIds, orgUnitIds, periodSpec, categoryOptionComboId);
      const rows = parseAnalyticsRows(data);

      const totalByOrgUnit: Record<string, number> = {};
      let grandTotal = 0;
      for (const row of rows) {
        totalByOrgUnit[row.orgUnit] = (totalByOrgUnit[row.orgUnit] || 0) + row.value;
        grandTotal += row.value;
      }

      return jsonResult({ rows, totalByOrgUnit, grandTotal });
    }
  );

  // ---------------------------------------------------------------
  // dhis2_get_coverage_by_level
  // ---------------------------------------------------------------
  server.registerTool(
    'dhis2_get_coverage_by_level',
    {
      title: 'Get antigen coverage for every org unit at a level (e.g. all facilities in a state)',
      description: `Get antigen dose counts for EVERY org unit at a given level under an ancestor, in a single efficient call — e.g. every health facility's Penta1 count under a state, without listing facility UIDs first or looping per facility.

Prefer this over dhis2_get_coverage + a loop whenever the question is about "every LGA" or "every facility" rather than a specific named one.

Args:
  - dataElementIds (string[]): Antigen data element UIDs (from dhis2_find_antigen)
  - level (number): Org unit level to break down by (e.g. the facility level)
  - ancestorId (string): UID of the ancestor org unit to search under (e.g. the state or an LGA)
  - periods (string[]): YYYYMM periods, e.g. ["202601","202602"], or a single relative period keyword like "LAST_12_MONTHS"

Returns: same shape as dhis2_get_coverage — { rows, totalByOrgUnit, grandTotal } — but rows span every org unit at the target level.

Examples:
  - Use when: "Penta1 by facility across all of Kwara State" -> level=<facility level>, ancestorId=<Kwara State UID>
  - Use when: "Penta1 by facility within Ilorin South LGA only" -> level=<facility level>, ancestorId=<Ilorin South LGA UID>
  - Use when: a data element is disaggregated into sub-categories (e.g. "RI fixed sessions" split into "Planned" vs "Conducted") and you need just ONE slice -> first call dhis2_find_data_element_disaggregations to get the category option combo id, then pass it as categoryOptionComboId here to get that slice alone instead of the combined total.`,
      inputSchema: {
        dataElementIds: z.array(z.string()).min(1).max(20).describe('Antigen data element UIDs'),
        level: z.number().int().min(1).max(10).describe('Target org unit level to break down by'),
        ancestorId: z.string().min(11).max(11).describe('UID of the ancestor org unit to search under'),
        periods: z.array(z.string()).min(1).max(60).describe('YYYYMM periods or a single relative period keyword'),
        categoryOptionComboId: z.string().min(11).max(11).optional().describe('Optional: restrict to ONE disaggregation/category option combo (from dhis2_find_data_element_disaggregations) instead of the combined total across all disaggregations. Applied to every dataElementId in this call.')
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ dataElementIds, level, ancestorId, periods, categoryOptionComboId }) => {
      const periodSpec = periods.length === 1 && /^[A-Z_]+$/.test(periods[0]!) ? periods[0]! : periods.join(';');
      const data = await getAnalyticsByLevel(dataElementIds, level, ancestorId, periodSpec, categoryOptionComboId);
      const rows = parseAnalyticsRows(data);

      const totalByOrgUnit: Record<string, number> = {};
      let grandTotal = 0;
      for (const row of rows) {
        totalByOrgUnit[row.orgUnit] = (totalByOrgUnit[row.orgUnit] || 0) + row.value;
        grandTotal += row.value;
      }

      return jsonResult({ rows, totalByOrgUnit, grandTotal });
    }
  );
// ---------------------------------------------------------------
  // dhis2_get_indicator_coverage
  // ---------------------------------------------------------------
  server.registerTool(
    'dhis2_get_indicator_coverage',
    {
      title: 'Get vaccine coverage percentage (indicator-based) for an org unit',
      description: `Get vaccine coverage PERCENTAGE using DHIS2's pre-built coverage indicators (doses given ÷ target population × 100, already calculated by DHIS2 — no manual denominator needed).

This is different from dhis2_get_coverage, which returns raw dose COUNTS. Use this tool whenever the user asks for "coverage" as a rate/percentage rather than a dose count.

Args:
  - vaccines (string[], optional): Vaccine name(s) to get coverage for, e.g. ["Penta 1"], ["BCG", "Measles 1"]. Matched against a curated list first (BCG, HBV 0, Penta 1, Penta 3, OPV 1, OPV 3, IPV 1, IPV 2, PCV 3, Rotavirus 1/2/3, Measles 1/2, Yellow Fever, Men A); if a name isn't in that list, falls back to a live search on the instance. OMIT this argument entirely to get coverage for ALL known vaccines at once.
  - orgUnitIds (string[]): Org unit UIDs to query (from dhis2_find_org_unit or dhis2_list_org_units_by_level)
  - periods (string[]): YYYYMM periods, e.g. ["202607"], or a single relative period keyword like "LAST_12_MONTHS"

Returns:
  {
    "rows": [{ indicator, orgUnit, orgUnitId, period, coveragePercent }, ...],
    "averageByIndicatorAndOrgUnit": { "<indicator> — <orgUnit>": <average % across the given periods> }
  }

Examples:
  - Use when: "Penta 1 coverage for Ilorin South, July 2026" -> vaccines=["Penta 1"], orgUnitIds=[Ilorin South UID], periods=["202607"]
  - Use when: "coverage for all vaccines in Ilorin South, July 2026" -> omit vaccines, orgUnitIds=[Ilorin South UID], periods=["202607"]

Error Handling:
  - Returns rows: [] if there's no data for the given combination — this is a valid "no data" result, not a failure.
  - If a requested vaccine name matches nothing (curated list or live search), it is skipped and noted in the response rather than failing the whole call.`,
      inputSchema: {
        vaccines: z.array(z.string()).min(1).max(20).optional().describe('Vaccine names to get coverage for. Omit for ALL known vaccines.'),
        orgUnitIds: z.array(z.string()).min(1).max(50).describe('Org unit UIDs to query'),
        periods: z.array(z.string()).min(1).max(60).describe('YYYYMM periods, e.g. ["202607"], or a single relative period keyword like "LAST_12_MONTHS"')
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ vaccines, orgUnitIds, periods }) => {
      const notFound: string[] = [];
      const indicatorIdToLabel: Record<string, string> = {};

      if (!vaccines || vaccines.length === 0) {
        // All known vaccines.
        for (const [label, id] of Object.entries(VACCINE_COVERAGE_INDICATORS)) {
          indicatorIdToLabel[id] = label;
        }
      } else {
        for (const requested of vaccines) {
          const curatedEntry = Object.entries(VACCINE_COVERAGE_INDICATORS).find(
            ([label]) => label.toLowerCase() === requested.toLowerCase() ||
                         label.toLowerCase().includes(requested.toLowerCase())
          );
          if (curatedEntry) {
            indicatorIdToLabel[curatedEntry[1]] = curatedEntry[0];
            continue;
          }
          const liveMatches = await findCoverageIndicatorsByKeyword(requested);
          if (liveMatches.length > 0) {
            for (const match of liveMatches) {
              indicatorIdToLabel[match.id] = match.name;
            }
          } else {
            notFound.push(requested);
          }
        }
      }

      const indicatorIds = Object.keys(indicatorIdToLabel);
      if (indicatorIds.length === 0) {
        return textResult(`No coverage indicators matched: ${notFound.join(', ')}.`);
      }

      const periodSpec = periods.length === 1 && /^[A-Z_]+$/.test(periods[0]!) ? periods[0]! : periods.join(';');
      const data = await getAnalytics(indicatorIds, orgUnitIds, periodSpec);
      const parsedRows = parseAnalyticsRows(data);

      const rows = parsedRows.map(r => ({
        indicator: r.dataElement,
        orgUnit: r.orgUnit,
        orgUnitId: r.orgUnitId,
        period: r.period,
        coveragePercent: r.value
      }));

      const groups: Record<string, number[]> = {};
      for (const row of rows) {
        const key = `${row.indicator} — ${row.orgUnit}`;
        (groups[key] ||= []).push(row.coveragePercent);
      }
      const averageByIndicatorAndOrgUnit: Record<string, number> = {};
      for (const [key, values] of Object.entries(groups)) {
        averageByIndicatorAndOrgUnit[key] = Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;
      }

      const result: Record<string, unknown> = { rows, averageByIndicatorAndOrgUnit };
      if (notFound.length > 0) {
        result.warning = `No coverage indicator matched: ${notFound.join(', ')}`;
      }
      return jsonResult(result);
    }
  );

  // ---------------------------------------------------------------
  // dhis2_find_data_element
  // ---------------------------------------------------------------
  server.registerTool(
    'dhis2_find_data_element',
    {
      title: 'Find any DHIS2 data element (unfiltered)',
      description: `Generic data element search — no keyword filtering, unlike dhis2_find_antigen. Use this for anything that is NOT a dose-administered antigen:

- Session planned/conducted elements (e.g. "Fixed Session Planned", "Outreach Session Conducted")
- Vaccine stock/utilization elements ("vaccines used" — vials received, opened, used, wasted, returned, balance)
- AEFI (Adverse Event Following Immunization) case/report elements
- Cold-chain/temperature elements, or anything else dhis2_find_antigen excludes

After finding the right UID(s) here, pull values with dhis2_get_coverage or dhis2_get_coverage_by_level (both accept any data element UID, not just antigens).

Args:
  - keyword (string): Search term, e.g. "AEFI", "Fixed Session Planned", "Vaccine used", "vials opened"

Returns: array of { id, name } for every matching data element (no exclusions applied).

Error Handling:
  - Returns an empty array if nothing matches — try a broader or different keyword; naming varies by instance (e.g. "Session Planned" vs "Planned Session" vs "Fixed Planned").`,
      inputSchema: {
        keyword: z.string().min(2).max(100).describe('Search term for any data element name')
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ keyword }) => {
      const results = await findDataElementGeneric(keyword);
      if (results.length === 0) {
        return textResult(`No data elements found matching "${keyword}". Try a broader or different keyword.`);
      }
      return jsonResult({ count: results.length, dataElements: results });
    }
  );

  // ---------------------------------------------------------------
  // dhis2_find_data_element_disaggregations
  // ---------------------------------------------------------------
  server.registerTool(
    'dhis2_find_data_element_disaggregations',
    {
      title: 'Find a data element\'s disaggregations (category option combos)',
      description: `Search data elements by keyword AND return their disaggregation categories (category option combos) — e.g. a single data element like "RI fixed sessions" may internally be split into "Planned" vs "Conducted" (or similarly named sub-categories), rather than being two separate data elements with distinct UIDs.

Use this when dhis2_find_data_element / dhis2_get_coverage return a value that looks combined or blended (e.g. much larger than expected), and you suspect the data element has a "Details" or similar disaggregation you need to pull apart. This mirrors navigating: Data Element Group -> pick element -> Disaggregation -> "Details" in the DHIS2 UI.

Once you have the category option combo id for the slice you want (e.g. "Planned"), pass it as categoryOptionComboId to dhis2_get_coverage or dhis2_get_coverage_by_level to get ONLY that slice instead of the combined total.

Args:
  - keyword (string): Data element search term, e.g. "RI fixed sessions", "RI outreach sessions"

Returns: array of { id, name, categoryOptionCombos: [{ id, name }, ...] } for each matching data element. An empty categoryOptionCombos array means that element has no disaggregation (its total from dhis2_get_coverage is already the full, undivided value).

Error Handling:
  - Returns an empty array if no data element matches — try a broader or different keyword.`,
      inputSchema: {
        keyword: z.string().min(2).max(100).describe('Data element search term to check for disaggregations')
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ keyword }) => {
      const results = await findDataElementDisaggregations(keyword);
      if (results.length === 0) {
        return textResult(`No data elements found matching "${keyword}". Try a broader or different keyword.`);
      }
      return jsonResult({ count: results.length, dataElements: results });
    }
  );

  // ---------------------------------------------------------------
  // dhis2_find_dataset
  // ---------------------------------------------------------------
  server.registerTool(
    'dhis2_find_dataset',
    {
      title: 'Find a DHIS2 dataset',
      description: `Resolve a dataset name (e.g. "NHMIS Monthly Summary Form", "Health Facility Vaccines Utilization Summary") to its UID. Needed for dhis2_get_completeness_timeliness / dhis2_get_completeness_timeliness_by_level, since reporting-rate metrics are calculated per dataset, not per data element.

Args:
  - name (string): Dataset name or partial name to search for

Returns: array of { id, name, periodType } for each matching dataset.

Error Handling:
  - Returns an empty array if nothing matches — try a shorter search term.`,
      inputSchema: {
        name: z.string().min(2).max(200).describe('Dataset name or partial name')
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ name }) => {
      const results = await findDatasetByName(name);
      if (results.length === 0) {
        return textResult(`No datasets found matching "${name}". Try a shorter search term.`);
      }
      return jsonResult({ count: results.length, dataSets: results });
    }
  );

  // ---------------------------------------------------------------
  // dhis2_get_completeness_timeliness
  // ---------------------------------------------------------------
  server.registerTool(
    'dhis2_get_completeness_timeliness',
    {
      title: 'Get reporting/monitoring rate (completeness + timeliness) for a dataset',
      description: `Get reporting completeness (% of expected facility reports actually submitted) and timeliness (% submitted by the due date) for dataset(s) at specific org unit(s). This is the "monitoring rate" for RI reporting.

Use dhis2_find_dataset first to resolve the dataset UID(s).

Args:
  - datasetIds (string[]): Dataset UIDs (from dhis2_find_dataset)
  - orgUnitIds (string[]): Org unit UIDs to query
  - periods (string[]): YYYYMM periods, e.g. ["202607"], or a single relative period keyword like "LAST_12_MONTHS"

Returns:
  {
    "rows": [{ datasetId, orgUnitId, period, reportingRate, reportingRateOnTime, actualReports, actualReportsOnTime, expectedReports }, ...]
  }
  reportingRate = completeness %. reportingRateOnTime = timeliness %.

Examples:
  - Use when: "what's the reporting/monitoring rate for Ilorin South this month" -> resolve the relevant dataset with dhis2_find_dataset first, then call this with its UID.

Error Handling:
  - Returns rows: [] if there's no data for the given combination — a valid "no data" result, not a failure.`,
      inputSchema: {
        datasetIds: z.array(z.string()).min(1).max(10).describe('Dataset UIDs from dhis2_find_dataset'),
        orgUnitIds: z.array(z.string()).min(1).max(50).describe('Org unit UIDs to query'),
        periods: z.array(z.string()).min(1).max(60).describe('YYYYMM periods or a single relative period keyword')
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ datasetIds, orgUnitIds, periods }) => {
      const periodSpec = periods.length === 1 && /^[A-Z_]+$/.test(periods[0]!) ? periods[0]! : periods.join(';');
      const rows = await getCompletenessTimeliness(datasetIds, orgUnitIds, periodSpec);
      return jsonResult({ rows });
    }
  );

  // ---------------------------------------------------------------
  // dhis2_get_completeness_timeliness_by_level
  // ---------------------------------------------------------------
  server.registerTool(
    'dhis2_get_completeness_timeliness_by_level',
    {
      title: 'Get reporting/monitoring rate for every org unit at a level',
      description: `Get reporting completeness and timeliness (% of expected reports submitted / submitted on time) for dataset(s) across EVERY org unit at a given level under an ancestor — e.g. every ward's reporting rate under Ilorin South LGA, in one call.

Args:
  - datasetIds (string[]): Dataset UIDs (from dhis2_find_dataset)
  - level (number): Org unit level to break down by
  - ancestorId (string): UID of the ancestor org unit to search under
  - periods (string[]): YYYYMM periods or a single relative period keyword

Returns: same shape as dhis2_get_completeness_timeliness — { rows } — spanning every org unit at the target level.

Error Handling:
  - Returns rows: [] if there's no data for the given combination — a valid "no data" result, not a failure.`,
      inputSchema: {
        datasetIds: z.array(z.string()).min(1).max(10).describe('Dataset UIDs from dhis2_find_dataset'),
        level: z.number().int().min(1).max(10).describe('Target org unit level to break down by'),
        ancestorId: z.string().min(11).max(11).describe('UID of the ancestor org unit to search under'),
        periods: z.array(z.string()).min(1).max(60).describe('YYYYMM periods or a single relative period keyword')
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ datasetIds, level, ancestorId, periods }) => {
      const periodSpec = periods.length === 1 && /^[A-Z_]+$/.test(periods[0]!) ? periods[0]! : periods.join(';');
      const rows = await getCompletenessTimelinessByLevel(datasetIds, level, ancestorId, periodSpec);
      return jsonResult({ rows });
    }
  );

  // ---------------------------------------------------------------
  // dhis2_get_session_implementation
  // ---------------------------------------------------------------
  server.registerTool(
    'dhis2_get_session_implementation',
    {
      title: 'Get RI session planned vs conducted (% implementation) for specific org units',
      description: `Get planned-vs-conducted RI session counts (fixed or outreach) for specific org unit(s), with % implementation (conducted / planned × 100).

Use dhis2_find_data_element first to resolve the "Planned" and "Conducted" session data element UIDs (naming varies by instance — try keywords like "Fixed Session Planned", "Outreach Session Conducted").

Args:
  - plannedDataElementId (string): UID of the "sessions planned" data element
  - conductedDataElementId (string): UID of the "sessions conducted" data element
  - orgUnitIds (string[]): Org unit UIDs to query
  - periods (string[]): YYYYMM periods or a single relative period keyword

Returns:
  {
    "rows": [{ orgUnitId, period, planned, conducted, implementationPct }, ...]
  }
  implementationPct is null when planned is 0 (avoids divide-by-zero).

Examples:
  - Use when: "fixed session implementation for Ilorin South this month" -> find Fixed Session Planned/Conducted UIDs with dhis2_find_data_element, then call this.

Error Handling:
  - Returns rows: [] if neither data element has any values for the given combination — a valid "no data" result (common if session data isn't being entered yet), not a failure.`,
      inputSchema: {
        plannedDataElementId: z.string().min(11).max(11).describe('UID of the sessions-planned data element'),
        conductedDataElementId: z.string().min(11).max(11).describe('UID of the sessions-conducted data element'),
        orgUnitIds: z.array(z.string()).min(1).max(50).describe('Org unit UIDs to query'),
        periods: z.array(z.string()).min(1).max(60).describe('YYYYMM periods or a single relative period keyword')
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ plannedDataElementId, conductedDataElementId, orgUnitIds, periods }) => {
      const periodSpec = periods.length === 1 && /^[A-Z_]+$/.test(periods[0]!) ? periods[0]! : periods.join(';');
      const rows = await getSessionImplementation(plannedDataElementId, conductedDataElementId, orgUnitIds, periodSpec);
      return jsonResult({ rows });
    }
  );

  // ---------------------------------------------------------------
  // dhis2_get_session_implementation_by_level
  // ---------------------------------------------------------------
  server.registerTool(
    'dhis2_get_session_implementation_by_level',
    {
      title: 'Get RI session planned vs conducted (% implementation) for every org unit at a level',
      description: `Get planned-vs-conducted RI session implementation (fixed or outreach) across EVERY org unit at a given level under an ancestor — e.g. every ward's session implementation under Ilorin South LGA, in one call.

Args:
  - plannedDataElementId (string): UID of the "sessions planned" data element
  - conductedDataElementId (string): UID of the "sessions conducted" data element
  - level (number): Org unit level to break down by
  - ancestorId (string): UID of the ancestor org unit to search under
  - periods (string[]): YYYYMM periods or a single relative period keyword

Returns: same shape as dhis2_get_session_implementation — { rows } — spanning every org unit at the target level.

Error Handling:
  - Returns rows: [] if there's no session data for the given combination — a valid "no data" result, not a failure.`,
      inputSchema: {
        plannedDataElementId: z.string().min(11).max(11).describe('UID of the sessions-planned data element'),
        conductedDataElementId: z.string().min(11).max(11).describe('UID of the sessions-conducted data element'),
        level: z.number().int().min(1).max(10).describe('Target org unit level to break down by'),
        ancestorId: z.string().min(11).max(11).describe('UID of the ancestor org unit to search under'),
        periods: z.array(z.string()).min(1).max(60).describe('YYYYMM periods or a single relative period keyword')
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ plannedDataElementId, conductedDataElementId, level, ancestorId, periods }) => {
      const periodSpec = periods.length === 1 && /^[A-Z_]+$/.test(periods[0]!) ? periods[0]! : periods.join(';');
      const rows = await getSessionImplementationByLevel(plannedDataElementId, conductedDataElementId, level, ancestorId, periodSpec);
      return jsonResult({ rows });
    }
  );
}
