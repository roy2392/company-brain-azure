import { accountId, entity, personId, productId } from "../../brain/entities.ts";
import { docId } from "../../brain/indexer.ts";
import type { BrainDoc, ConnectorOutput, Entity, EntityLink, RawBatch } from "../../brain/types.ts";
import type { EraClient } from "../client.ts";
import { asDate, rawDoc } from "../util.ts";

/**
 * Salesforce is the system of record for accounts, so it runs first: it defines the account
 * universe (for mention matching) and picks the focus accounts the other connectors go deep on.
 */
export interface SalesforceResult extends ConnectorOutput {
  accounts: Array<{ id: string; name: string; sfId: string; type?: string; aliases: string[] }>;
  focus: Array<{ id: string; name: string; sfId: string; aliases: string[] }>;
  now: Date;
}

const WANT: Record<string, string[]> = {
  Account: ["Id", "Name", "Type", "Industry", "BillingState", "BillingCountry", "Phone", "Website", "OwnerId", "AnnualRevenue", "NumberOfEmployees", "Description", "CreatedDate", "LastModifiedDate"],
  Opportunity: ["Id", "Name", "AccountId", "StageName", "Amount", "CloseDate", "IsClosed", "IsWon", "Type", "Probability", "OwnerId", "Description", "NextStep", "CreatedDate", "LastModifiedDate"],
  Contract: ["Id", "ContractNumber", "AccountId", "Status", "StartDate", "EndDate", "ContractTerm", "Description", "OwnerId", "CreatedDate", "LastModifiedDate"],
  Contact: ["Id", "Name", "FirstName", "LastName", "Email", "Title", "AccountId", "Department", "Phone"],
  User: ["Id", "Name", "Email", "Title", "Department", "IsActive", "ManagerId", "Alias"],
  Product2: ["Id", "Name", "Family", "Description", "ProductCode", "IsActive"],
  Case: ["Id", "CaseNumber", "Subject", "Description", "Status", "Priority", "Origin", "Type", "AccountId", "ContactId", "OwnerId", "IsEscalated", "CreatedDate", "ClosedDate", "LastModifiedDate"],
  Task: ["Id", "Subject", "Description", "Status", "Priority", "ActivityDate", "WhatId", "WhoId", "OwnerId", "CreatedDate"],
};

export async function pullSalesforce(era: EraClient, opts: { focusN: number; focusNames: string[]; log: (m: string) => void }): Promise<SalesforceResult> {
  const { log } = opts;
  const versions = await era.rest<Array<{ version: string; url: string }>>("/services/data/");
  const base = versions.at(-1)!.url; // e.g. /services/data/v60.0

  const describe = new Map<string, Set<string>>();
  const fields = async (obj: string) => {
    if (!describe.has(obj)) {
      try {
        const d = await era.rest<{ fields: Array<{ name: string }> }>(`${base}/sobjects/${obj}/describe`);
        describe.set(obj, new Set(d.fields.map((f) => f.name)));
      } catch {
        describe.set(obj, new Set(WANT[obj]));
      }
    }
    const have = describe.get(obj)!;
    return WANT[obj].filter((f) => have.has(f)).join(", ");
  };
  const soql = async (q: string, max = 50_000) => {
    let res = await era.rest<any>(`${base}/query`, { query: { q } });
    const out: any[] = [...res.records];
    while (!res.done && res.nextRecordsUrl && out.length < max) {
      res = await era.rest<any>(res.nextRecordsUrl);
      out.push(...res.records);
    }
    return out.map(({ attributes, ...r }) => r);
  };
  const inList = (ids: string[]) => ids.map((i) => `'${i.replace(/'/g, "")}'`).join(",");

  const [accounts, opps, contracts, users, products] = await Promise.all([
    soql(`SELECT ${await fields("Account")} FROM Account`),
    soql(`SELECT ${await fields("Opportunity")} FROM Opportunity`),
    soql(`SELECT ${await fields("Contract")} FROM Contract`),
    soql(`SELECT ${await fields("User")} FROM User`),
    soql(`SELECT ${await fields("Product2")} FROM Product2`),
  ]);
  log(`   salesforce: ${accounts.length} accounts, ${opps.length} opportunities, ${contracts.length} contracts, ${users.length} users`);

  const userById = new Map(users.map((u) => [u.Id, u]));
  const acctBySf = new Map(accounts.map((a) => [a.Id, a]));
  const nameOf = (sfId?: string) => (sfId ? acctBySf.get(sfId)?.Name : undefined);

  // the brain's clock: latest activity anywhere in the CRM
  const now = new Date(Math.max(...[...opps, ...contracts, ...accounts].map((r) => asDate(r.LastModifiedDate ?? r.CloseDate).getTime()).filter(Number.isFinite)));
  const yearAgo = new Date(now.getTime() - 365 * 86_400_000);

  // ---------- focus accounts: most commercial activity, plus names asked for explicitly ----------
  const score = new Map<string, number>();
  for (const o of opps) score.set(o.AccountId, (score.get(o.AccountId) ?? 0) + 1 + (Number(o.Amount) || 0) / 100_000 + (o.IsClosed ? 0 : 2));
  for (const c of contracts) score.set(c.AccountId, (score.get(c.AccountId) ?? 0) + 3);
  const customers = accounts.filter((a) => /customer/i.test(a.Type ?? ""));
  const wanted = new Set(opts.focusNames.map((n) => n.toLowerCase()));
  const ranked = customers
    .map((a) => ({ a, s: (score.get(a.Id) ?? 0) + (wanted.has(String(a.Name).toLowerCase()) ? 1e6 : 0) }))
    .sort((x, y) => y.s - x.s)
    .slice(0, opts.focusN)
    .map(({ a }) => a);
  const focusSf = ranked.map((a) => a.Id);

  const [cases, contacts, tasks] = await Promise.all([
    focusSf.length ? soql(`SELECT ${await fields("Case")} FROM Case WHERE AccountId IN (${inList(focusSf)})`, 5000) : [],
    soql(`SELECT ${await fields("Contact")} FROM Contact`),
    focusSf.length ? soql(`SELECT ${await fields("Task")} FROM Task WHERE WhatId IN (${inList(focusSf)})`, 5000).catch(() => []) : [],
  ]);
  log(`   salesforce: ${cases.length} cases, ${tasks.length} tasks for ${focusSf.length} focus accounts; ${contacts.length} contacts`);

  // ---------- entities ----------
  const entities: Entity[] = [];
  const wonByAcct = new Map<string, number>();
  for (const o of opps) if (o.IsWon && asDate(o.CloseDate) >= yearAgo) wonByAcct.set(o.AccountId, (wonByAcct.get(o.AccountId) ?? 0) + (Number(o.Amount) || 0));
  for (const a of accounts) {
    const owner = userById.get(a.OwnerId);
    const links: EntityLink[] = [];
    entities.push(
      entity("account", accountId(a.Name), a.Name, "salesforce", {
        sfId: a.Id,
        type: a.Type,
        industry: a.Industry,
        region: [a.BillingState, a.BillingCountry].filter(Boolean).join(", ") || undefined,
        owner: owner?.Name,
        website: a.Website,
        employees: a.NumberOfEmployees,
        arr: wonByAcct.get(a.Id) || undefined,
      }, links),
    );
  }
  for (const u of users) {
    const owned = accounts.filter((a) => a.OwnerId === u.Id && focusSf.includes(a.Id));
    entities.push(
      entity("person", personId(u.Email ?? u.Name), u.Name, "salesforce", { title: u.Title, department: u.Department, email: u.Email, internal: true, active: u.IsActive }, owned.map((a) => ({ to: accountId(a.Name), rel: "owns", source: "salesforce" as const }))),
    );
  }
  for (const c of contacts) {
    if (!c.AccountId || !acctBySf.has(c.AccountId)) continue;
    entities.push(entity("person", personId(c.Email ?? c.Name), c.Name, "salesforce", { title: c.Title, email: c.Email, department: c.Department, internal: false }, [{ to: accountId(nameOf(c.AccountId)!), rel: "contact_of", source: "salesforce" }]));
  }
  for (const p of products) entities.push(entity("product", productId(p.Name), p.Name, "salesforce", { family: p.Family, code: p.ProductCode, description: p.Description }));

  // ---------- docs ----------
  const docs: BrainDoc[] = [];
  const acctIds = (sfId?: string) => (sfId && nameOf(sfId) ? [accountId(nameOf(sfId)!)] : []);
  const money = (n: unknown) => (Number(n) ? `$${Number(n).toLocaleString("en-US")}` : "n/a");
  for (const a of ranked) {
    const owner = userById.get(a.OwnerId);
    docs.push({
      _id: docId("salesforce", "account", a.Id),
      source: "salesforce",
      kind: "account",
      sourceId: a.Id,
      title: `${a.Name} — account profile`,
      text: `${a.Name} is a ${a.Type ?? ""} account in ${a.Industry ?? "an unknown industry"}${a.BillingState ? `, based in ${a.BillingState}` : ""}. Account owner: ${owner?.Name ?? "unassigned"}. Employees: ${a.NumberOfEmployees ?? "n/a"}. Website: ${a.Website ?? "n/a"}.\n${a.Description ?? ""}`,
      ts: asDate(a.LastModifiedDate ?? a.CreatedDate, now),
      accountIds: [accountId(a.Name)],
      personIds: owner ? [personId(owner.Email ?? owner.Name)] : [],
      meta: { type: a.Type, industry: a.Industry, owner: owner?.Name },
    });
  }
  for (const o of opps) {
    const owner = userById.get(o.OwnerId);
    docs.push({
      _id: docId("salesforce", "opportunity", o.Id),
      source: "salesforce",
      kind: "opportunity",
      sourceId: o.Id,
      title: o.Name,
      text: `Opportunity "${o.Name}" for ${nameOf(o.AccountId) ?? "unknown account"}. Stage: ${o.StageName}. Amount: ${money(o.Amount)}. Close date: ${o.CloseDate ?? "n/a"}. Type: ${o.Type ?? "n/a"}. Probability: ${o.Probability ?? "n/a"}%. Owner: ${owner?.Name ?? "n/a"}.${o.NextStep ? ` Next step: ${o.NextStep}.` : ""}\n${o.Description ?? ""}`,
      ts: asDate(o.LastModifiedDate ?? o.CloseDate, now),
      accountIds: acctIds(o.AccountId),
      personIds: owner ? [personId(owner.Email ?? owner.Name)] : [],
      meta: { stage: o.StageName, amount: Number(o.Amount) || 0, closeDate: o.CloseDate, isClosed: !!o.IsClosed, isWon: !!o.IsWon, type: o.Type, probability: o.Probability },
    });
  }
  for (const c of contracts) {
    docs.push({
      _id: docId("salesforce", "contract", c.Id),
      source: "salesforce",
      kind: "contract",
      sourceId: c.Id,
      title: `Contract ${c.ContractNumber ?? c.Id} — ${nameOf(c.AccountId) ?? ""}`,
      text: `Contract ${c.ContractNumber ?? c.Id} with ${nameOf(c.AccountId) ?? "unknown account"}. Status: ${c.Status}. Start: ${c.StartDate ?? "n/a"}. End: ${c.EndDate ?? "n/a"}. Term: ${c.ContractTerm ?? "n/a"} months.\n${c.Description ?? ""}`,
      ts: asDate(c.LastModifiedDate ?? c.StartDate, now),
      accountIds: acctIds(c.AccountId),
      personIds: [],
      meta: { status: c.Status, startDate: c.StartDate, endDate: c.EndDate, term: c.ContractTerm },
    });
  }
  for (const c of cases) {
    docs.push({
      _id: docId("salesforce", "case", c.Id),
      source: "salesforce",
      kind: "case",
      sourceId: c.Id,
      title: `Case ${c.CaseNumber}: ${c.Subject ?? "(no subject)"}`,
      text: `${c.Subject ?? ""}\nStatus: ${c.Status}. Priority: ${c.Priority}. Origin: ${c.Origin ?? "n/a"}.${c.IsEscalated ? " ESCALATED." : ""}\n${c.Description ?? ""}`,
      ts: asDate(c.LastModifiedDate ?? c.CreatedDate, now),
      accountIds: acctIds(c.AccountId),
      personIds: [],
      meta: { status: c.Status, priority: c.Priority, escalated: !!c.IsEscalated, createdDate: c.CreatedDate, closedDate: c.ClosedDate },
    });
  }
  for (const t of tasks) {
    if (!t.Subject && !t.Description) continue;
    const owner = userById.get(t.OwnerId);
    docs.push({
      _id: docId("salesforce", "task", t.Id),
      source: "salesforce",
      kind: "task",
      sourceId: t.Id,
      title: t.Subject ?? "Task",
      text: `${t.Subject ?? ""} (${t.Status ?? ""}, due ${t.ActivityDate ?? "n/a"}) — ${owner?.Name ?? ""}\n${t.Description ?? ""}`,
      ts: asDate(t.ActivityDate ?? t.CreatedDate, now),
      accountIds: acctIds(t.WhatId),
      personIds: owner ? [personId(owner.Email ?? owner.Name)] : [],
      meta: { status: t.Status, priority: t.Priority },
    });
  }

  const raw: RawBatch[] = [
    { collection: "raw_salesforce_account", source: "salesforce", object: "Account", description: "Companies Wisteria sells to (customers and prospects).", docs: accounts.map((a) => rawDoc(a.Id, a)) },
    { collection: "raw_salesforce_opportunity", source: "salesforce", object: "Opportunity", description: "Deals with stage, amount and close date.", docs: opps.map((o) => rawDoc(o.Id, o)) },
    { collection: "raw_salesforce_contract", source: "salesforce", object: "Contract", description: "Signed customer contracts with start/end dates.", docs: contracts.map((c) => rawDoc(c.Id, c)) },
    { collection: "raw_salesforce_case", source: "salesforce", object: "Case", description: "Customer service cases for focus accounts.", docs: cases.map((c) => rawDoc(c.Id, c)) },
    { collection: "raw_salesforce_contact", source: "salesforce", object: "Contact", description: "People at customer and prospect accounts.", docs: contacts.map((c) => rawDoc(c.Id, c)) },
    { collection: "raw_salesforce_user", source: "salesforce", object: "User", description: "Wisteria employees with CRM access (account owners).", docs: users.map((u) => rawDoc(u.Id, u)) },
    { collection: "raw_salesforce_product", source: "salesforce", object: "Product2", description: "Wisteria's product catalog.", docs: products.map((p) => rawDoc(p.Id, p)) },
    ...(tasks.length ? [{ collection: "raw_salesforce_task", source: "salesforce" as const, object: "Task", description: "Sales activities logged against focus accounts.", docs: tasks.map((t) => rawDoc(t.Id, t)) }] : []),
  ];

  const toAcct = (a: any) => ({ id: accountId(a.Name), name: a.Name as string, sfId: a.Id as string, type: a.Type as string | undefined, aliases: [] as string[] });
  return { raw, docs, entities, accounts: accounts.map(toAcct), focus: ranked.map(toAcct), now };
}
