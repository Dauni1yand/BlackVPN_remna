import axios, { type AxiosInstance, type AxiosRequestConfig, isAxiosError } from 'axios';

// Minimal, hand-verified wrapper around just the Remnawave Panel REST
// endpoints the provisioning CLIs need (auth, api tokens, config profiles,
// keygen, nodes, hosts). Every field here was checked directly against
// remnawave/backend's contracts (libs/contract/commands/**) rather than
// guessed, since there is no test panel to verify against at write time.
//
// Not a full SDK on purpose: once the Telegram bot needs the rest of the
// API surface, prefer pulling in the official `@remnawave/backend-contract`
// package (pinned to match the deployed panel version) instead of growing
// this file by hand.

export interface Keypair {
  publicKey: string;
  privateKey: string;
}

export interface ConfigProfileInbound {
  uuid: string;
  profileUuid: string;
  tag: string;
  type: string;
  network: string | null;
  security: string | null;
  port: number | null;
  rawInbound: Record<string, unknown> | null;
}

export interface ConfigProfile {
  uuid: string;
  viewPosition: number;
  name: string;
  config: Record<string, unknown>;
  inbounds: ConfigProfileInbound[];
  nodes: { uuid: string; name: string; countryCode: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface RemnawaveNode {
  uuid: string;
  name: string;
  address: string;
  port: number | null;
  [key: string]: unknown;
}

export interface RemnawaveHost {
  uuid: string;
  [key: string]: unknown;
}

export interface ApiTokenResult {
  uuid: string;
  name: string;
  token: string;
  scopes: string[];
  expireAt: string;
}

export interface InternalSquad {
  uuid: string;
  viewPosition: number;
  name: string;
  info: { membersCount: number; inboundsCount: number };
  inbounds: ConfigProfileInbound[];
  createdAt: string;
  updatedAt: string;
}

export interface RemnawaveUser {
  id: number;
  shortUuid: string;
  username: string;
  status: 'ACTIVE' | 'DISABLED' | 'LIMITED' | 'EXPIRED';
  subscriptionUrl: string;
  expireAt: string;
  trafficLimitBytes: number;
  telegramId: number | null;
  [key: string]: unknown;
}

export class RemnawaveApiError extends Error {
  status?: number;
  data?: unknown;

  constructor(message: string, status?: number, data?: unknown) {
    super(message);
    this.name = 'RemnawaveApiError';
    this.status = status;
    this.data = data;
  }
}

export class RemnawaveClient {
  private readonly http: AxiosInstance;

  constructor(baseURL: string, token?: string) {
    this.http = axios.create({
      baseURL,
      timeout: 30_000,
      headers: {
        // Lets the panel be called directly (e.g. http://127.0.0.1:3000)
        // without tripping its "must come through a reverse proxy" checks —
        // documented pattern from Remnawave's own TypeScript SDK guide.
        'x-forwarded-for': '127.0.0.1',
        'x-forwarded-proto': 'https',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  }

  setToken(token: string): void {
    this.http.defaults.headers.common.Authorization = `Bearer ${token}`;
  }

  private async request<T>(config: AxiosRequestConfig): Promise<T> {
    try {
      const res = await this.http.request<{ response: T }>(config);
      return res.data.response;
    } catch (error) {
      if (isAxiosError(error)) {
        const status = error.response?.status;
        const data = error.response?.data;
        throw new RemnawaveApiError(
          `${config.method?.toUpperCase()} ${config.url} failed${status ? ` (${status})` : ''}: ${
            data ? JSON.stringify(data) : error.message
          }`,
          status,
          data,
        );
      }
      throw error;
    }
  }

  getStatus(): Promise<{ isLoginAllowed: boolean; isRegisterAllowed: boolean }> {
    return this.request({ url: '/api/auth/status', method: 'GET' });
  }

  register(username: string, password: string): Promise<{ accessToken: string }> {
    return this.request({ url: '/api/auth/register', method: 'POST', data: { username, password } });
  }

  login(username: string, password: string): Promise<{ accessToken: string }> {
    return this.request({ url: '/api/auth/login', method: 'POST', data: { username, password } });
  }

  createApiToken(name: string, expiresInDays: number, scopes: string[] = ['*']): Promise<ApiTokenResult> {
    return this.request({ url: '/api/tokens', method: 'POST', data: { name, expiresInDays, scopes } });
  }

  getConfigProfiles(): Promise<{ total: number; configProfiles: ConfigProfile[] }> {
    return this.request({ url: '/api/config-profiles', method: 'GET' });
  }

  createConfigProfile(name: string, config: Record<string, unknown>): Promise<ConfigProfile> {
    return this.request({ url: '/api/config-profiles', method: 'POST', data: { name, config } });
  }

  updateConfigProfile(
    uuid: string,
    body: { name?: string; config?: Record<string, unknown> },
  ): Promise<ConfigProfile> {
    return this.request({ url: '/api/config-profiles', method: 'PATCH', data: { uuid, ...body } });
  }

  generateX25519(): Promise<{ keypairs: Keypair[] }> {
    return this.request({ url: '/api/system/tools/x25519/generate', method: 'GET' });
  }

  getNodeSecretKey(): Promise<{ secretKey: string }> {
    return this.request({ url: '/api/keygen', method: 'GET' });
  }

  createNode(body: {
    name: string;
    address: string;
    port?: number;
    countryCode?: string;
    configProfile: { activeConfigProfileUuid: string; activeInbounds: string[] };
  }): Promise<RemnawaveNode> {
    return this.request({ url: '/api/nodes', method: 'POST', data: body });
  }

  getInternalSquads(): Promise<{ total: number; internalSquads: InternalSquad[] }> {
    return this.request({ url: '/api/internal-squads', method: 'GET' });
  }

  createInternalSquad(name: string, inbounds: string[]): Promise<InternalSquad> {
    return this.request({ url: '/api/internal-squads', method: 'POST', data: { name, inbounds } });
  }

  updateInternalSquad(uuid: string, body: { name?: string; inbounds?: string[] }): Promise<InternalSquad> {
    return this.request({ url: '/api/internal-squads', method: 'PATCH', data: { uuid, ...body } });
  }

  createUser(body: {
    username: string;
    expireAt: string;
    trafficLimitBytes?: number;
    trafficLimitStrategy?: 'NO_RESET' | 'DAY' | 'WEEK' | 'MONTH';
    telegramId?: number;
    activeInternalSquads?: string[];
    description?: string;
    tag?: string;
  }): Promise<RemnawaveUser> {
    return this.request({ url: '/api/users', method: 'POST', data: body });
  }

  createHost(body: {
    inbound: { configProfileUuid: string; configProfileInboundUuid: string };
    remark: string;
    address: string;
    port: number;
    sni?: string;
    fingerprint?: string;
    securityLayer?: 'DEFAULT' | 'TLS' | 'NONE';
    nodes?: string[];
  }): Promise<RemnawaveHost> {
    return this.request({ url: '/api/hosts', method: 'POST', data: body });
  }
}
