/**
 * Typed API Client for Free VPS Dashboard
 * Uses Zod for runtime validation
 */

import { z } from 'https://esm.sh/zod@3.23.8';

// ---- Schema Definitions ----
const AuthResponseSchema = z.object({
  success: z.boolean(),
  email: z.string().email(),
  sessionToken: z.string(),
  githubToken: z.string().nullable().optional(),
  owner: z.string().nullable().optional(),
  machines: z.array(z.any()).optional(),
  credits: z.number().optional(),
  ngrokTokenSaved: z.boolean().optional(),
  role: z.string().optional(),
});

const ForkResponseSchema = z.object({
  success: z.boolean(),
  full_name: z.string(),
  html_url: z.string(),
  owner: z.string(),
  name: z.string(),
});

const DeployResponseSchema = z.object({
  success: z.boolean(),
  workflow: z.string().optional(),
  branch: z.string().optional(),
});

const RdpInfoSchema = z.object({
  success: z.boolean(),
  info: z.object({
    ngrok_url: z.string().nullable(),
    username: z.string(),
    password: z.string(),
  }),
  found: z.boolean(),
});

const MachineSchema = z.object({
  id: z.string(),
  user_email: z.string().optional(),
  ngrok_url: z.string().nullable(),
  username: z.string(),
  password: z.string(),
  owner: z.string(),
  repo: z.string(),
  status: z.string(),
  created_at: z.number(),
});

const MachinesResponseSchema = z.object({
  success: z.boolean(),
  machines: z.array(MachineSchema),
});

const SessionResponseSchema = z.object({
  success: z.boolean(),
  email: z.string(),
  githubToken: z.string().nullable(),
  owner: z.string().nullable(),
  machines: z.array(MachineSchema),
  credits: z.number(),
});

const ShopConfigSchema = z.object({
  success: z.boolean(),
  bankName: z.string().optional(),
  bankAccount: z.string().optional(),
  bankHolder: z.string().optional(),
  bannerText: z.string().optional(),
  logoUrl: z.string().nullable().optional(),
  qrUrl: z.string().nullable().optional(),
});

const ProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  price: z.number(),
  image_url: z.string().optional(),
  category: z.string().optional(),
  active: z.number().optional(),
  created_at: z.number().optional(),
  seller_email: z.string().optional(),
});

const ProductsResponseSchema = z.object({
  success: z.boolean(),
  products: z.array(ProductSchema),
});

const ShopLoginResponseSchema = z.object({
  success: z.boolean(),
  shopToken: z.string(),
  email: z.string(),
});

const SaveTokenResponseSchema = z.object({
  success: z.boolean(),
});

const ErrorResponseSchema = z.object({
  error: z.string(),
});

// ---- Types ----
export type AuthResponse = z.infer<typeof AuthResponseSchema>;
export type ForkResponse = z.infer<typeof ForkResponseSchema>;
export type DeployResponse = z.infer<typeof DeployResponseSchema>;
export type RdpInfoResponse = z.infer<typeof RdpInfoSchema>;
export type Machine = z.infer<typeof MachineSchema>;
export type SessionResponse = z.infer<typeof SessionResponseSchema>;
export type ShopConfig = z.infer<typeof ShopConfigSchema>;
export type Product = z.infer<typeof ProductSchema>;
export type ShopLoginResponse = z.infer<typeof ShopLoginResponseSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

// ---- API Client ----
class ApiClient {
  private baseUrl: string;
  private defaultHeaders: HeadersInit;

  constructor(baseUrl = '/api') {
    this.baseUrl = baseUrl;
    this.defaultHeaders = {
      'Content-Type': 'application/json',
    };
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    schema?: z.ZodSchema<T>
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    
    const response = await fetch(url, {
      ...options,
      headers: {
        ...this.defaultHeaders,
        ...options.headers,
      },
    });

    let data;
    try {
      data = await response.json();
    } catch {
      const text = await response.text().catch(() => '');
      throw new Error(text ? `Server: ${text.slice(0, 200)}` : `HTTP ${response.status}`);
    }

    if (!response.ok) {
      const error = data?.error || `HTTP ${response.status}`;
      throw new Error(error);
    }

    if (schema) {
      const result = schema.safeParse(data);
      if (!result.success) {
        console.warn('API response validation failed:', result.error);
        return data as T; // Return anyway for backward compat
      }
      return result.data;
    }

    return data as T;
  }

  // ---- Auth ----
  async login(email: string, password: string): Promise<AuthResponse> {
    return this.request('/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }, AuthResponseSchema);
  }

  async register(email: string, password: string): Promise<AuthResponse> {
    return this.request('/register', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }, AuthResponseSchema);
  }

  async restoreSession(sessionToken: string): Promise<SessionResponse> {
    return this.request('/session', {
      method: 'POST',
      body: JSON.stringify({ sessionToken }),
    }, SessionResponseSchema);
  }

  async saveGithubToken(sessionToken: string, githubToken: string): Promise<SaveTokenResponseSchema> {
    return this.request('/save-token', {
      method: 'POST',
      body: JSON.stringify({ sessionToken, githubToken }),
    }, SaveTokenResponseSchema);
  }

  async saveNgrokToken(sessionToken: string, ngrokToken: string): Promise<SaveTokenResponseSchema> {
    return this.request('/save-ngrok-token', {
      method: 'POST',
      body: JSON.stringify({ sessionToken, ngrokToken }),
    }, SaveTokenResponseSchema);
  }

  // ---- Deployment ----
  async forkRepo(token: string, sessionToken: string, mode: string): Promise<ForkResponse> {
    return this.request('/fork', {
      method: 'POST',
      body: JSON.stringify({ token, sessionToken, mode }),
    }, ForkResponseSchema);
  }

  async runWorkflow(token: string, owner: string, repo: string, sessionToken: string, mode: string): Promise<DeployResponse> {
    return this.request('/run-workflow', {
      method: 'POST',
      body: JSON.stringify({ token, owner, repo, sessionToken, mode }),
    }, DeployResponseSchema);
  }

  async getRdpInfo(token: string, owner: string, repo: string, sessionToken: string, mode: string): Promise<RdpInfoResponse> {
    return this.request('/rdp-info', {
      method: 'POST',
      body: JSON.stringify({ token, owner, repo, sessionToken, mode }),
    }, RdpInfoSchema);
  }

  // ---- Machines ----
  async getMachines(sessionToken: string): Promise<Machine[]> {
    const result = await this.request('/session', {
      method: 'POST',
      body: JSON.stringify({ sessionToken }),
    }, SessionResponseSchema);
    return result.machines || [];
  }

  async deleteMachine(sessionToken: string, machineId: string, token?: string): Promise<MachinesResponseSchema> {
    return this.request('/delete-machine', {
      method: 'POST',
      body: JSON.stringify({ sessionToken, machineId, token }),
    }, MachinesResponseSchema);
  }

  async pingMachine(token: string, sessionToken: string, machineId: string) {
    return this.request('/ping-machine', {
      method: 'POST',
      body: JSON.stringify({ token, sessionToken, machineId }),
    });
  }

  async refreshMachine(token: string, sessionToken: string, machineId: string): Promise<RdpInfoResponse & { machines: Machine[] }> {
    return this.request('/refresh-machine', {
      method: 'POST',
      body: JSON.stringify({ token, sessionToken, machineId }),
    });
  }

  // ---- Shop ----
  async getShopConfig(): Promise<ShopConfig> {
    return this.request('/shop-config', {
      method: 'GET',
    }, ShopConfigSchema);
  }

  async getProducts(): Promise<Product[]> {
    const result = await this.request('/shop/products', {
      method: 'GET',
    }, ProductsResponseSchema);
    return result.products || [];
  }

  // ---- Admin (if needed) ----
  async adminLogin(password: string, email?: string) {
    return this.request('/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password, email }),
    });
  }
}

// Export singleton
export const api = new ApiClient();

// Export schemas for external validation
export const schemas = {
  AuthResponse: AuthResponseSchema,
  ForkResponse: ForkResponseSchema,
  DeployResponse: DeployResponseSchema,
  RdpInfo: RdpInfoSchema,
  Machine: MachineSchema,
  SessionResponse: SessionResponseSchema,
  ShopConfig: ShopConfigSchema,
  Product: ProductSchema,
  ProductsResponse: ProductsResponseSchema,
  ShopLoginResponse: ShopLoginResponseSchema,
  ErrorResponse: ErrorResponseSchema,
};