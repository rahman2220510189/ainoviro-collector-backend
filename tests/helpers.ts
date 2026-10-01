import type { AppDeps } from '../src/app';
import type { Env } from '../src/config/env';
import type { AdminRecord, AuthStore } from '../src/auth/store';
import type { CategoryNode, CategoryStore } from '../src/services/categories';
import type { LocationNode, LocationStore } from '../src/services/locations';
import type {
  JobDetail,
  JobPreview,
  JobService,
  JobSummary,
  QuotaStatus,
} from '../src/jobs/job-service';
import type { ExportService } from '../src/export/export-service';
import type { LeadDetail, LeadService } from '../src/leads/lead-service';
import type { SuppressionService } from '../src/services/suppression-service';
import type { DashboardService, DashboardSummary } from '../src/services/dashboard-service';
import type { AllSettings, SettingsService } from '../src/services/settings-service';

/** Config for tests: no real database is contacted. */
export const testEnv: Env = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: 0,
  LOG_LEVEL: 'silent',
  CORS_ORIGIN: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://unused',
  DIRECT_URL: 'postgresql://unused',
  JWT_SECRET: 'test-secret-that-is-at-least-32-characters-long',
  SESSION_TTL_HOURS: 12,
  TRUST_PROXY: false,
  GOOGLE_PLACES_BASE_URL: 'https://places.googleapis.com',
  GOOGLE_LIVE_REQUESTS: false,
  WORKER_CONCURRENCY: 4,
  WORKER_POLL_SECONDS: 5,
  WORKER_CRAWL: false,
};

export interface FakeAuthStore extends AuthStore {
  admins: AdminRecord[];
  loginCalls: number[];
}

/** In-memory AuthStore for tests. */
export function createFakeAuthStore(admins: AdminRecord[] = []): FakeAuthStore {
  const store: FakeAuthStore = {
    admins: [...admins],
    loginCalls: [],
    async findAdminByEmail(email) {
      return store.admins.find((a) => a.email === email) ?? null;
    },
    async findAdminById(id) {
      return store.admins.find((a) => a.id === id) ?? null;
    },
    async recordLogin(adminId) {
      store.loginCalls.push(adminId);
    },
  };
  return store;
}

export interface FakeCategoryStore extends CategoryStore {
  tree: CategoryNode[];
  /** includeInactive value of every call, in order. */
  calls: boolean[];
}

/** In-memory CategoryStore for tests. */
export function createFakeCategoryStore(tree: CategoryNode[] = []): FakeCategoryStore {
  const store: FakeCategoryStore = {
    tree,
    calls: [],
    async listCategoryTree(includeInactive) {
      store.calls.push(includeInactive);
      return store.tree;
    },
  };
  return store;
}

export interface FakeLocationStore extends LocationStore {
  children: Map<number | null, LocationNode[]>;
  resolved: number[];
  childCalls: (number | null)[];
  resolveCalls: number[][];
}

/** In-memory LocationStore for tests. */
export function createFakeLocationStore(
  children: Map<number | null, LocationNode[]> = new Map(),
  resolved: number[] = [],
): FakeLocationStore {
  const store: FakeLocationStore = {
    children,
    resolved,
    childCalls: [],
    resolveCalls: [],
    async listChildren(parentId) {
      store.childCalls.push(parentId);
      return store.children.get(parentId) ?? [];
    },
    async resolveCityIds(ids) {
      store.resolveCalls.push(ids);
      return store.resolved;
    },
  };
  return store;
}

export const FAKE_PREVIEW: JobPreview = {
  scopeLabel: 'Cyprus (Limassol)',
  mode: 'MOCK',
  areas: 1,
  absorbedTowns: 3,
  keywordCount: 9,
  tasksTotal: 9,
  tasksToRun: 9,
  skippedByCooldown: 0,
  includeRural: false,
  minCityPopulation: 5000,
  cooldownDays: 30,
  forceRerun: false,
  cost: {
    minimum: 9,
    estimated: 18,
    maximumWithoutSplits: 27,
    averagePages: 2,
    freeRemaining: 1000,
    verdict: 'FITS',
  },
};

export const FAKE_SUMMARY: JobSummary = {
  id: 7,
  name: 'Test job',
  status: 'QUEUED',
  createdAt: '2026-09-25T00:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  lastError: null,
  tasks: { PENDING: 9 },
  resultsReturned: 0,
};

export const FAKE_QUOTA: QuotaStatus = {
  mode: 'MOCK',
  liveRequestsEnabled: false,
  period: '2026-10',
  freeLimit: 1000,
  freeCap: 1000,
  used: 120,
  freeRemaining: 880,
  warnAt: 800,
  paidCount: 0,
  monthlyHardCapEur: 0,
  pricePerRequestEur: 0.0315,
  worker: {
    running: true,
    lastSeenAt: '2026-10-02T10:00:00.000Z',
    mode: 'MOCK',
    searching: true,
    crawling: true,
  },
};

export const FAKE_DASHBOARD: DashboardSummary = {
  country: 'CY',
  generatedAt: '2026-10-02T10:00:00.000Z',
  leads: {
    totalPlaces: 120,
    withEmail: 64,
    ready: 12,
    needsReview: 2,
    chains: 1,
    closed: 0,
    byStatus: { NEW: 15, EXPORTED: 44, REJECTED: 5 },
  },
  emails: {
    total: 70,
    generic: 50,
    personal: 20,
    ownDomain: 55,
    freeMail: 15,
    noMailServer: 1,
    bounced: 0,
    unsubscribed: 0,
    exported: 44,
    newThisMonth: 3,
  },
  websites: {
    withWebsite: 90,
    crawled: 80,
    emailFound: 50,
    noEmailFound: 20,
    failed: 6,
    robotsBlocked: 4,
    waiting: 10,
  },
  google: { months: [{ period: '2026-09', requests: 980, paid: 0 }] },
  exports: { batches: 1, rows: 44, rowsThisMonth: 0, lastExportAt: '2026-09-30T12:00:00.000Z' },
  suppression: { total: 3, byReason: { EXISTING_CONTACT: 3 } },
  jobs: { byStatus: { COMPLETED: 2 } },
  topCities: [{ name: 'Limassol', withEmail: 40, ready: 8 }],
  topCategories: [{ name: 'Personal Care & Beauty', withEmail: 64, ready: 12 }],
  activity: [{ date: '2026-10-02', newPlaces: 3, newEmails: 1, exported: 0 }],
};

const view = (values: Record<string, unknown>) => ({ values, defaults: values, updatedAt: null });

export const FAKE_SETTINGS: AllSettings = {
  sections: {
    quota: view({ freeLimit: 20, warnAt: 0.8, monthlyHardCapEur: 0 }),
    search: view({ minCityPopulation: 5000, includeRural: true, cooldownDays: 30 }),
    crawler: view({ maxPagesPerDomain: 5, delayMs: 1500 }),
    leadRules: view({ chains: { minPlacesPerDomain: 3 } }),
  },
  chains: [{ id: 1, name: 'Zara', domain: 'zara.com', addedAt: '2026-10-02T10:00:00.000Z' }],
};

export interface FakeSettingsService extends SettingsService {
  calls: { method: string; args: unknown[] }[];
}

export function createFakeSettingsService(): FakeSettingsService {
  const service: FakeSettingsService = {
    calls: [],
    async getAll() {
      service.calls.push({ method: 'getAll', args: [] });
      return FAKE_SETTINGS;
    },
    async update(section, values, adminId) {
      service.calls.push({ method: 'update', args: [section, values, adminId] });
      return view(values as Record<string, unknown>);
    },
    async addChain(name, domain, adminId) {
      service.calls.push({ method: 'addChain', args: [name, domain, adminId] });
      return FAKE_SETTINGS.chains;
    },
    async removeChain(id, adminId) {
      service.calls.push({ method: 'removeChain', args: [id, adminId] });
      return [];
    },
  };
  return service;
}

export interface FakeDashboardService extends DashboardService {
  calls: string[];
}

export function createFakeDashboardService(): FakeDashboardService {
  const service: FakeDashboardService = {
    calls: [],
    async summary(country) {
      service.calls.push(country);
      return FAKE_DASHBOARD;
    },
  };
  return service;
}

export interface FakeJobService extends JobService {
  calls: { method: string; args: unknown[] }[];
  detail: JobDetail | null;
}

/** In-memory JobService that records every call. */
export function createFakeJobService(): FakeJobService {
  const service: FakeJobService = {
    calls: [],
    detail: null,
    async preview(request) {
      service.calls.push({ method: 'preview', args: [request] });
      return FAKE_PREVIEW;
    },
    async create(request, createdById) {
      service.calls.push({ method: 'create', args: [request, createdById] });
      return { jobId: 7, preview: FAKE_PREVIEW };
    },
    async list(limit) {
      service.calls.push({ method: 'list', args: [limit] });
      return [FAKE_SUMMARY];
    },
    async get(id) {
      service.calls.push({ method: 'get', args: [id] });
      return service.detail;
    },
    async act(id, action) {
      service.calls.push({ method: 'act', args: [id, action] });
      return { ...FAKE_SUMMARY, status: action === 'pause' ? 'PAUSED_USER' : 'RUNNING' };
    },
    async approveBudget(id, extraEur) {
      service.calls.push({ method: 'approveBudget', args: [id, extraEur] });
      return { ...FAKE_SUMMARY, status: 'RUNNING' };
    },
    async quotaStatus() {
      service.calls.push({ method: 'quotaStatus', args: [] });
      return FAKE_QUOTA;
    },
  };
  return service;
}

export interface FakeExportService extends ExportService {
  calls: { method: string; args: unknown[] }[];
}

/** In-memory ExportService for API tests: returns a tiny CSV with a Greek name. */
export function createFakeExportService(): FakeExportService {
  const file = {
    filename: 'ainoviro_leads_2026-09-30_CY_1.csv',
    csv: '\uFEFFbusiness_name,email\r\nΚομμωτήριο Ελένη,info@eleni.cy\r\n',
    rowCount: 1,
    batchId: 5,
  };
  const service: FakeExportService = {
    calls: [],
    async preview(filters) {
      service.calls.push({ method: 'preview', args: [filters] });
      return { newRows: 44, needsReview: 1 };
    },
    async exportCsv(request, adminId) {
      service.calls.push({ method: 'exportCsv', args: [request, adminId] });
      return file;
    },
    async listBatches(limit) {
      service.calls.push({ method: 'listBatches', args: [limit] });
      return [];
    },
    async download(batchId) {
      service.calls.push({ method: 'download', args: [batchId] });
      return batchId === 5 ? file : null;
    },
    async undo(batchId, adminId) {
      service.calls.push({ method: 'undo', args: [batchId, adminId] });
      return { batchId, returned: 1, kept: 0 };
    },
  };
  return service;
}

export interface FakeLeadService extends LeadService {
  calls: { method: string; args: unknown[] }[];
}

export const FAKE_LEAD: LeadDetail = {
  id: 7,
  name: 'Κομμωτήριο Ελένη',
  status: 'NEW',
  score: 75,
  needsReview: false,
  reviewReasons: [],
  isChain: false,
  businessStatus: 'OPERATIONAL',
  address: null,
  city: 'Limassol',
  countryCode: 'CY',
  lat: null,
  lng: null,
  website: 'https://eleni.cy/',
  websiteDomain: 'eleni.cy',
  phone: '+35799123456',
  phoneValid: true,
  rating: 4.8,
  ratingCount: 40,
  firstSeenAt: new Date('2026-09-20T10:00:00Z'),
  lastSeenAt: new Date('2026-09-20T10:00:00Z'),
  lastCrawledAt: null,
  emails: [],
  subcategories: [],
  sources: [],
  history: [],
};

/** In-memory LeadService for API tests. */
export function createFakeLeadService(): FakeLeadService {
  const service: FakeLeadService = {
    calls: [],
    async list(filters) {
      service.calls.push({ method: 'list', args: [filters] });
      return { items: [], total: 0, page: filters.page, pageSize: filters.pageSize };
    },
    async facets(country) {
      service.calls.push({ method: 'facets', args: [country] });
      return { cities: [{ name: 'Limassol', count: 280 }] };
    },
    async get(id) {
      service.calls.push({ method: 'get', args: [id] });
      return id === 7 ? FAKE_LEAD : null;
    },
    async setStatus(id, status, adminId) {
      service.calls.push({ method: 'setStatus', args: [id, status, adminId] });
      return { ...FAKE_LEAD, status };
    },
    async bulkReject(ids, adminId) {
      service.calls.push({ method: 'bulkReject', args: [ids, adminId] });
      return { rejected: ids.length };
    },
    async erase(id, adminId) {
      service.calls.push({ method: 'erase', args: [id, adminId] });
      return { placeId: id, emailsErased: 2 };
    },
  };
  return service;
}

export interface FakeSuppressionService extends SuppressionService {
  calls: { method: string; args: unknown[] }[];
}

/** In-memory SuppressionService for API tests. */
export function createFakeSuppressionService(): FakeSuppressionService {
  const service: FakeSuppressionService = {
    calls: [],
    async list(query) {
      service.calls.push({ method: 'list', args: [query] });
      return { items: [], total: 0, page: query.page, pageSize: query.pageSize, counts: {} };
    },
    async add(email, reason) {
      service.calls.push({ method: 'add', args: [email, reason] });
      return { inserted: 1, upgraded: 0, alreadySuppressed: 0 };
    },
    async importCsv(input) {
      service.calls.push({ method: 'importCsv', args: [input] });
      return {
        inserted: 2,
        upgraded: 0,
        alreadySuppressed: 0,
        rows: 2,
        invalid: 0,
        duplicatesInFile: 0,
        empty: 0,
        invalidExamples: [],
      };
    },
    async importMailerResults(input) {
      service.calls.push({ method: 'importMailerResults', args: [input] });
      return {
        rows: 1,
        byStatus: { bounced: 1 },
        leadsUpdated: 0,
        suppressed: 1,
        unknownEmails: 0,
        invalidRows: 0,
        unknownStatuses: [],
      };
    },
  };
  return service;
}

/** Full AppDeps with harmless fakes; override only what a test needs. */
export function testDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    checkDatabase: async () => {},
    authStore: createFakeAuthStore(),
    categoryStore: createFakeCategoryStore(),
    locationStore: createFakeLocationStore(),
    jobService: createFakeJobService(),
    exportService: createFakeExportService(),
    leadService: createFakeLeadService(),
    suppressionService: createFakeSuppressionService(),
    dashboardService: createFakeDashboardService(),
    settingsService: createFakeSettingsService(),
    ...overrides,
  };
}
