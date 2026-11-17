import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { dhis2GetRaw, type RawParamValue } from '../services/dhis2Client.js';

const CHARACTER_LIMIT = 40000;
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

function jsonText(obj: unknown) {
  const text = JSON.stringify(obj, null, 1);
  return text.length > CHARACTER_LIMIT
    ? text.slice(0, CHARACTER_LIMIT) + `\n... [truncated, ${text.length} chars total — narrow the query: fewer fields, a filter, a smaller pageSize, or fewer periods/org units]`
    : text;
}
function ok(obj: unknown) {
  return { content: [{ type: 'text' as const, text: jsonText(obj) }] };
}
function fail(e: unknown) {
  return { isError: true, content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }] };
}

const paramValue = z.union([
  z.string(), z.number(), z.boolean(),
  z.array(z.union([z.string(), z.number(), z.boolean()]))
]);

const METADATA_RESOURCES = [
  'indicators', 'indicatorGroups', 'indicatorTypes', 'dataElements', 'dataElementGroups', 'dataElementGroupSets',
  'dataSets', 'categories', 'categoryCombos', 'categoryOptions', 'categoryOptionCombos', 'optionSets', 'options',
  'organisationUnits', 'organisationUnitGroups', 'organisationUnitGroupSets', 'organisationUnitLevels',
  'programs', 'programStages', 'programIndicators', 'trackedEntityTypes', 'trackedEntityAttributes',
  'validationRules', 'validationRuleGroups', 'legendSets', 'dimensions', 'visualizations', 'maps',
  'dashboards', 'eventVisualizations', 'predictors', 'constants', 'attributes'
] as const;

export function registerGenericDhis2Tools(server: McpServer) {

  server.registerTool(
    'dhis2_api_get',
    {
      title: 'DHIS2 API GET (any endpoint, read-only)',
      description: `Call ANY DHIS2 Web API endpoint with a GET request and return the JSON. This gives the connector the same read access as DHIS2 itself, so use it whenever no specialised tool fits (analytics, metadata, data values, tracker/events, data approvals, validation, program rules, dashboards, system info, etc.). Read-only: it can never create, change or delete anything.

Args:
  - path (string): API path, e.g. "/api/indicators.json", "/api/analytics", "/api/dataValueSets", "/api/tracker/events", "/api/system/info", "/api/dataApprovals". The "/api" prefix is added if missing. Do not put "?query" in the path.
  - params (object, optional): query parameters. Array values become repeated keys, e.g. {"dimension": ["dx:abc","ou:LEVEL-3;jReUW6NCPkL","pe:202609"]} or {"filter": ["name:like:Penta","id:eq:xyz"], "fields": "id,name", "paging": false}.

Notes:
  - Kwara State org unit UID is jReUW6NCPkL (level 2). LGAs are level 3, wards level 4, facilities level 5.
  - Large responses are truncated; use fields, filter, paging (page/pageSize) to narrow.
  - Account/credential endpoints (users, tokens, settings) are blocked.`,
      inputSchema: {
        path: z.string().min(1).max(300).describe('DHIS2 API path, e.g. /api/indicators.json'),
        params: z.record(paramValue).optional().describe('Query parameters; arrays become repeated keys')
      },
      annotations: RO
    },
    async ({ path, params }) => {
      try {
        return ok(await dhis2GetRaw(path, params as Record<string, RawParamValue> | undefined));
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    'dhis2_list_metadata',
    {
      title: 'List/search DHIS2 metadata',
      description: `List or search any DHIS2 metadata type: indicators, data elements, data sets, groups, programs, option sets, validation rules, dashboards, org unit groups, etc. Use this to discover UIDs before querying data.

Args:
  - resource: metadata type (e.g. "indicators", "dataElements", "dataSets", "indicatorGroups", "programs", "organisationUnitGroups", "validationRules").
  - search (string, optional): case-insensitive name contains filter.
  - filters (string[], optional): extra DHIS2 filters like "id:eq:abc", "level:eq:3", "periodType:eq:Monthly", "dataElementGroups.id:eq:xyz".
  - fields (string, optional): fields to return (default "id,name").
  - pageSize (number, optional): rows per page (default 100, max 1000). page (number, optional): page number (default 1).

Returns the matching objects plus paging info.`,
      inputSchema: {
        resource: z.enum(METADATA_RESOURCES).describe('Metadata resource type'),
        search: z.string().max(200).optional().describe('Name contains (case-insensitive)'),
        filters: z.array(z.string().max(300)).max(10).optional().describe('Additional DHIS2 filters, e.g. "level:eq:3"'),
        fields: z.string().max(500).optional().describe('Fields to return, default "id,name"'),
        pageSize: z.number().int().min(1).max(1000).optional(),
        page: z.number().int().min(1).optional()
      },
      annotations: RO
    },
    async ({ resource, search, filters, fields, pageSize, page }) => {
      try {
        const f: string[] = [];
        if (search) f.push(`name:ilike:${search}`);
        if (filters) f.push(...filters);
        const params: Record<string, RawParamValue> = {
          fields: fields ?? 'id,name',
          pageSize: pageSize ?? 100,
          page: page ?? 1
        };
        if (f.length) params.filter = f;
        return ok(await dhis2GetRaw(`/api/${resource}.json`, params));
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    'dhis2_get_metadata_object',
    {
      title: 'Get one DHIS2 metadata object by UID',
      description: `Fetch a single metadata object by resource and UID with chosen fields — e.g. an indicator's numerator/denominator formulas, a dataset's data elements and org-unit assignments, a program's stages, an org unit's ancestors/geometry, a data element's category combo.

Args:
  - resource: metadata type, e.g. "indicators", "dataElements", "dataSets", "organisationUnits", "programs".
  - id (string): the 11-character UID.
  - fields (string, optional): default ":owner" for most; use e.g. "id,name,numerator,denominator,indicatorType[name,factor]" or "id,name,dataSetElements[dataElement[id,name]]".`,
      inputSchema: {
        resource: z.enum(METADATA_RESOURCES),
        id: z.string().length(11).describe('11-character DHIS2 UID'),
        fields: z.string().max(800).optional().describe('Fields to return, default ":owner"')
      },
      annotations: RO
    },
    async ({ resource, id, fields }) => {
      try {
        return ok(await dhis2GetRaw(`/api/${resource}/${id}.json`, { fields: fields ?? ':owner' }));
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    'dhis2_query_analytics',
    {
      title: 'Flexible DHIS2 analytics query',
      description: `Run any aggregate analytics query with full control over dimensions — works for data elements, indicators, reporting rates, program indicators and category option combos, across any period type and org-unit level. Returns readable rows (names instead of UIDs) plus the header list.

Args:
  - dimension (string[]): dimension expressions, e.g.
      "dx:b6X0aWFCb2E;yHw3A23QqP8"      (data elements/indicators; "UID.cocUID" for a disaggregation; "dataSetUID.REPORTING_RATE" for reporting rates)
      "ou:LEVEL-3;jReUW6NCPkL"          (all LGAs under Kwara)  |  "ou:USER_ORGUNIT_CHILDREN"  |  "ou:xzTeTvNkxNv"
      "pe:202609" | "pe:LAST_12_MONTHS" | "pe:202601;202602" | "pe:2026Q3" | "pe:THIS_YEAR"
      "co" (category option combos) or a category UID for disaggregation
  - filter (string[], optional): filter dimensions (not shown in rows), same syntax.
  - aggregationType (string, optional): SUM, AVERAGE, COUNT, etc.
  - maxRows (number, optional): cap on rows returned (default 500, max 5000). Total row count is always reported.
  - raw (boolean, optional): true to return unmodified rows with UIDs.

Examples:
  - Penta 1 doses by LGA, last 12 months: dimension=["dx:b6X0aWFCb2E","ou:LEVEL-3;jReUW6NCPkL","pe:LAST_12_MONTHS"]`,
      inputSchema: {
        dimension: z.array(z.string().min(1).max(2000)).min(1).max(10),
        filter: z.array(z.string().min(1).max(2000)).max(10).optional(),
        aggregationType: z.string().max(40).optional(),
        maxRows: z.number().int().min(1).max(5000).optional(),
        raw: z.boolean().optional()
      },
      annotations: RO
    },
    async ({ dimension, filter, aggregationType, maxRows, raw }) => {
      try {
        const params: Record<string, RawParamValue> = { dimension, skipRounding: false };
        if (filter?.length) params.filter = filter;
        if (aggregationType) params.aggregationType = aggregationType;
        const data = await dhis2GetRaw('/api/analytics', params) as {
          headers?: Array<{ name: string; column: string }>;
          metaData?: { items?: Record<string, { name?: string }> };
          rows?: string[][];
          width?: number; height?: number;
        };
        const headers = data.headers ?? [];
        const rows = data.rows ?? [];
        const cap = maxRows ?? 500;
        const items = data.metaData?.items ?? {};
        const nameCols = new Set(headers.map((h, i) => (h.name === 'value' ? -1 : i)).filter(i => i >= 0));
        const shown = rows.slice(0, cap).map(r =>
          raw ? r : r.map((cell, i) => (nameCols.has(i) ? (items[cell]?.name ?? cell) : cell))
        );
        return ok({
          columns: headers.map(h => h.name),
          totalRows: rows.length,
          returnedRows: shown.length,
          rows: shown
        });
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    'dhis2_get_data_values',
    {
      title: 'Get raw data values (dataValueSets)',
      description: `Read raw submitted data values straight from the data entry tables (not aggregated analytics) — useful for checking what a facility actually reported, for data quality review, and for very recent data not yet in analytics tables.

Args:
  - dataSet (string[], optional): data set UID(s) — or dataElementGroup (string[]) instead.
  - orgUnit (string[]): org unit UID(s).
  - children (boolean, optional): include all descendants of the org unit(s) (default false).
  - period (string[], optional): e.g. ["202609"]; or use startDate/endDate (YYYY-MM-DD).
  - limit (number, optional): max values returned (default 1000).

Returns dataValues with dataElement, period, orgUnit, categoryOptionCombo, value.`,
      inputSchema: {
        dataSet: z.array(z.string().length(11)).max(20).optional(),
        dataElementGroup: z.array(z.string().length(11)).max(20).optional(),
        orgUnit: z.array(z.string().length(11)).min(1).max(20),
        children: z.boolean().optional(),
        period: z.array(z.string()).max(24).optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        limit: z.number().int().min(1).max(20000).optional()
      },
      annotations: RO
    },
    async ({ dataSet, dataElementGroup, orgUnit, children, period, startDate, endDate, limit }) => {
      try {
        const params: Record<string, RawParamValue> = { orgUnit, limit: limit ?? 1000 };
        if (dataSet?.length) params.dataSet = dataSet;
        if (dataElementGroup?.length) params.dataElementGroup = dataElementGroup;
        if (children) params.children = true;
        if (period?.length) params.period = period;
        if (startDate) params.startDate = startDate;
        if (endDate) params.endDate = endDate;
        return ok(await dhis2GetRaw('/api/dataValueSets', params));
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    'dhis2_get_system_info',
    {
      title: 'DHIS2 system info and current user scope',
      description: 'Returns the DHIS2 server version/build and the connected account\'s name and assigned org units (Kwara State). Use to confirm what the connector can see.',
      inputSchema: {},
      annotations: RO
    },
    async () => {
      try {
        const [info, me] = await Promise.all([
          dhis2GetRaw('/api/system/info.json', { fields: 'version,revision,serverDate,calendar,dateFormat' }),
          dhis2GetRaw('/api/me.json', { fields: 'id,name,organisationUnits[id,name,level],dataViewOrganisationUnits[id,name,level]' })
        ]);
        return ok({ system: info, account: me });
      } catch (e) { return fail(e); }
    }
  );
}
