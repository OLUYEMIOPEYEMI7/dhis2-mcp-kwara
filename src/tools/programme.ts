import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { dhis2GetRaw, getOrgUnitsByLevelUnderAncestor, type RawParamValue } from '../services/dhis2Client.js';

const KWARA_STATE = 'jReUW6NCPkL';
const CHARACTER_LIMIT = 40000;
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

// Curated UIDs on the national DHIS2 instance (verified against Kwara data).
const AEFI_REPORTED = 'vgYoIHj8uAf';              // AEFI cases reported (Serious / Non-Serious)
const AEFI_SERIOUS_INVESTIGATED = 'XAWLGqJks6S';  // Serious cases of AEFI investigated
const SUP_FACILITIES_SUPERVISED = 'i7BzFyL6VYK';  // Facility staff received RI supportive supervision
const SUP_PCT_INDICATOR = 'PGdcLqpnewy';          // % of Health Facilities Receiving Supervision Visits
const SUP_BY_LEVEL = 'zao1f3BoLDn';               // Level of supportive supervision received (National/State/LGA)

function ok(obj: unknown) {
  const text = JSON.stringify(obj, null, 1);
  return { content: [{ type: 'text' as const, text: text.length > CHARACTER_LIMIT
    ? text.slice(0, CHARACTER_LIMIT) + `\n... [truncated, ${text.length} chars — narrow periods/org units]` : text }] };
}
function fail(e: unknown) {
  return { isError: true, content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }] };
}

interface Analytics {
  headers?: Array<{ name: string }>;
  metaData?: { items?: Record<string, { name?: string }> };
  rows?: string[][];
}
interface Row { item: string; category?: string; orgUnit: string; orgUnitId: string; period: string; value: number }

async function analytics(dx: string[], ou: string, pe: string, withCo = false): Promise<Row[]> {
  const dimension = [`dx:${dx.join(';')}`, `ou:${ou}`, `pe:${pe}`];
  if (withCo) dimension.push('co');
  const data = await dhis2GetRaw('/api/analytics', { dimension, skipRounding: false }) as Analytics;
  const h = (data.headers ?? []).map(x => x.name);
  const idx = (n: string) => h.indexOf(n);
  const items = data.metaData?.items ?? {};
  const nm = (id: string) => items[id]?.name ?? id;
  return (data.rows ?? []).map(r => ({
    item: nm(r[idx('dx')]!),
    ...(withCo ? { category: nm(r[idx('co')]!) } : {}),
    orgUnit: nm(r[idx('ou')]!),
    orgUnitId: r[idx('ou')]!,
    period: r[idx('pe')]!,
    value: Number(r[idx('value')])
  })).sort((a, b) => a.period.localeCompare(b.period) || a.orgUnit.localeCompare(b.orgUnit) || a.item.localeCompare(b.item));
}

function ouExpression(orgUnitIds?: string[], level?: number, ancestorId?: string): string {
  if (level) return `LEVEL-${level};${ancestorId ?? KWARA_STATE}`;
  return (orgUnitIds?.length ? orgUnitIds : [KWARA_STATE]).join(';');
}

const scope = {
  orgUnitIds: z.array(z.string().length(11)).max(50).optional()
    .describe('Org unit UIDs. Default: Kwara State (jReUW6NCPkL). Use dhis2_find_org_unit to resolve LGA/ward/facility names.'),
  level: z.number().int().min(2).max(6).optional()
    .describe('Break down by every org unit at this level under ancestorId (3 = LGAs, 4 = wards, 5 = facilities). Overrides orgUnitIds.'),
  ancestorId: z.string().length(11).optional().describe('Ancestor for level breakdown. Default: Kwara State.'),
  periods: z.array(z.string().min(4).max(30)).min(1).max(24)
    .describe('Monthly periods like ["202610"] or relative keywords like ["LAST_3_MONTHS"]')
};

export function registerProgrammeTools(server: McpServer) {

  // ---------------- Vaccine stock balance ----------------
  server.registerTool(
    'dhis2_get_vaccine_stock',
    {
      title: 'Vaccine & immunization supplies stock balance',
      description: `Stock balance of vaccines, diluents, syringes and safety boxes, for Kwara State, an LGA, ward, facility, or every LGA/ward/facility at a level — per month.

Uses the "<item> Stock Balance" indicators (BCG, OPV, IPV, PCV, Penta, HBV/Hep B, Measles, Yellow Fever, Tetanus Toxoid, CSM, plus BCG/Measles/Yellow Fever/CSM diluents, AD/2ml/5ml/BCG syringes, safety boxes). Negative balances are flagged as data-quality issues (usually a reporting error).

Args:
  - vaccines (string[], optional): items to include, matched by name, e.g. ["Penta","BCG","Measles","Auto Disable"]. Omit for all items.
  - orgUnitIds / level / ancestorId: where (default Kwara State). level=3 gives one row per LGA.
  - periods (string[]): e.g. ["202610"] or ["LAST_3_MONTHS"].
  - includeMovement (boolean, optional): also return the stock movement data elements (opening balance, received, doses opened/used, returned, discarded, stock-out this month, min/max stock) for the named vaccines. Requires vaccines.

Returns: stockBalance rows { item, orgUnit, period, value, flag? } and optional movement rows.`,
      inputSchema: {
        vaccines: z.array(z.string().min(2).max(60)).max(20).optional(),
        ...scope,
        includeMovement: z.boolean().optional()
      },
      annotations: RO
    },
    async ({ vaccines, orgUnitIds, level, ancestorId, periods, includeMovement }) => {
      try {
        const ou = ouExpression(orgUnitIds, level, ancestorId);
        const pe = periods.join(';');
        const list = await dhis2GetRaw('/api/indicators.json', {
          filter: ['name:ilike:Stock Balance'], fields: 'id,name', paging: false
        }) as { indicators: Array<{ id: string; name: string }> };
        let inds = list.indicators;
        if (vaccines?.length) {
          const keys = vaccines.map(v => v.toLowerCase().replace(/\s+vaccine$/, ''));
          inds = inds.filter(i => keys.some(k => i.name.toLowerCase().includes(k)));
        }
        if (!inds.length) return ok({ message: 'No stock balance indicators matched. Try e.g. "Penta", "BCG", "Measles", "Syringe".' });
        const rows = await analytics(inds.map(i => i.id), ou, pe);
        const stockBalance = rows.map(r => ({
          item: r.item, orgUnit: r.orgUnit, orgUnitId: r.orgUnitId, period: r.period, value: r.value,
          ...(r.value < 0 ? { flag: 'NEGATIVE balance — likely a reporting/data-entry error' } : {})
        }));
        const out: Record<string, unknown> = {
          matchedItems: inds.map(i => i.name),
          stockBalance
        };
        if (includeMovement && vaccines?.length) {
          const movement: Row[] = [];
          for (const v of vaccines) {
            const key = v.replace(/\s+vaccine$/i, '');
            const des = await dhis2GetRaw('/api/dataElements.json', {
              filter: [`name:ilike:${key}`], fields: 'id,name', paging: false
            }) as { dataElements: Array<{ id: string; name: string }> };
            const ids = des.dataElements
              .filter(d => /(opening|received|opened|used|returned|discard|stock out|minimum|maximum)/i.test(d.name) && !/(syringe|safety)/i.test(d.name))
              .map(d => d.id).slice(0, 40);
            if (ids.length) movement.push(...await analytics(ids, ou, pe));
          }
          out.movement = movement;
        }
        return ok(out);
      } catch (e) { return fail(e); }
    }
  );

  // ---------------- AEFI ----------------
  server.registerTool(
    'dhis2_get_aefi',
    {
      title: 'AEFI cases (serious / non-serious) and investigations',
      description: `Adverse Events Following Immunization (AEFI) reported through NHMIS, split into Serious and Non-Serious, plus how many serious cases were investigated.

Args:
  - orgUnitIds / level / ancestorId: where (default Kwara State; level=3 = per LGA).
  - periods (string[]): e.g. ["202610"], ["202607","202608","202609"], or ["LAST_12_MONTHS"].

Returns: reported rows { orgUnit, period, category: "Serious"|"Non-Serious", value }, seriousInvestigated rows, and totals per period (serious, non-serious, serious investigated).`,
      inputSchema: { ...scope },
      annotations: RO
    },
    async ({ orgUnitIds, level, ancestorId, periods }) => {
      try {
        const ou = ouExpression(orgUnitIds, level, ancestorId);
        const pe = periods.join(';');
        const [reported, investigated] = await Promise.all([
          analytics([AEFI_REPORTED], ou, pe, true),
          analytics([AEFI_SERIOUS_INVESTIGATED], ou, pe)
        ]);
        const totals = new Map<string, { period: string; orgUnit: string; serious: number; nonSerious: number; seriousInvestigated: number | null }>();
        const key = (r: Row) => `${r.orgUnitId}|${r.period}`;
        for (const r of reported) {
          const t = totals.get(key(r)) ?? { period: r.period, orgUnit: r.orgUnit, serious: 0, nonSerious: 0, seriousInvestigated: null };
          if (/^serious$/i.test(r.category ?? '')) t.serious += r.value; else t.nonSerious += r.value;
          totals.set(key(r), t);
        }
        for (const r of investigated) {
          const t = totals.get(key(r));
          if (t) t.seriousInvestigated = r.value;
        }
        return ok({
          note: 'Serious cases investigated in a month can include cases reported in earlier months, so it is not a % of that month\'s serious cases.',
          totals: [...totals.values()],
          reported: reported.map(({ item: _i, ...r }) => r),
          seriousInvestigated: investigated.map(({ item: _i, ...r }) => r)
        });
      } catch (e) { return fail(e); }
    }
  );

  // ---------------- Supportive supervision ----------------
  server.registerTool(
    'dhis2_get_supervision',
    {
      title: 'RI supportive supervision conducted',
      description: `Routine immunization supportive supervision — how many health facilities received supervision, the % of facilities supervised, and which level supervised them (National / State / LGA).

Args:
  - orgUnitIds / level / ancestorId: where (default Kwara State; level=3 = per LGA).
  - periods (string[]): e.g. ["202610"], ["LAST_6_MONTHS"].

Returns:
  - facilitiesSupervised: number of facilities whose staff received RI supportive supervision (per org unit & month).
  - percentFacilitiesSupervised: % of health facilities receiving supervision visits (indicator; fetched one org unit at a time because DHIS2 cannot compute it across many org units in one call; capped at 40 org units).
  - supervisionByLevel: how many supervisory visits came from National, State and LGA level.

Note: the "Planned Supervision Visits" and "Supervision Visit Conducted" data elements currently hold no data for Kwara, so they are not used. For checklist-based supervision (program/tracker data) use dhis2_api_get.`,
      inputSchema: { ...scope },
      annotations: RO
    },
    async ({ orgUnitIds, level, ancestorId, periods }) => {
      try {
        const ou = ouExpression(orgUnitIds, level, ancestorId);
        const pe = periods.join(';');
        const [supervised, byLevel] = await Promise.all([
          analytics([SUP_FACILITIES_SUPERVISED], ou, pe),
          analytics([SUP_BY_LEVEL], ou, pe, true)
        ]);
        let targets: Array<{ id: string; name: string }>;
        if (level) {
          targets = (await getOrgUnitsByLevelUnderAncestor(level, ancestorId ?? KWARA_STATE)).map(o => ({ id: o.id, name: o.name }));
        } else {
          targets = (orgUnitIds?.length ? orgUnitIds : [KWARA_STATE]).map(id => ({ id, name: id }));
        }
        const capped = targets.slice(0, 40);
        const pct: Row[] = [];
        for (let i = 0; i < capped.length; i += 6) {
          const batch = await Promise.all(capped.slice(i, i + 6).map(t =>
            analytics([SUP_PCT_INDICATOR], t.id, pe).catch(() => [] as Row[])));
          batch.forEach(b => pct.push(...b));
        }
        return ok({
          facilitiesSupervised: supervised.map(({ item: _i, ...r }) => r),
          percentFacilitiesSupervised: pct.map(({ item: _i, ...r }) => r),
          supervisionByLevel: byLevel.map(({ item: _i, ...r }) => r),
          ...(targets.length > 40 ? { note: `percentFacilitiesSupervised limited to the first 40 of ${targets.length} org units` } : {})
        });
      } catch (e) { return fail(e); }
    }
  );
}
