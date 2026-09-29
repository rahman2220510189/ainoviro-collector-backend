import type { AppDeps } from '../src/app';
import type { Env } from '../src/config/env';
import type { AdminRecord, AuthStore } from '../src/auth/store';
import type { CategoryNode, CategoryStore } from '../src/services/categories';
import type { LocationNode, LocationStore } from '../src/services/locations';
import type { JobDetail, JobPreview, JobService, JobSummary } from '../src/jobs/job-service';
import type { ExportService } from '../src/export/export-service';
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
  cost: { minimum: 9, estimated: 18, maximumWithoutSplits: 27, averagePages: 2, freeRemaining: 1000, verdict: 'FITS' },
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
/** Full AppDeps with harmless fakes; override only what a test needs. */
export function testDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    checkDatabase: async () => {},
    authStore: createFakeAuthStore(),
    categoryStore: createFakeCategoryStore(),
    locationStore: createFakeLocationStore(),
    jobService: createFakeJobService(),
        exportService: createFakeExportService(),
    ...overrides,
  };
}