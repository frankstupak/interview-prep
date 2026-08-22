// auth-types.ts
export enum AuthType {
  BASIC = "basic",
  SESSION_TOKEN = "session_token",
  JWT = "jwt",
  API_KEY = "api_key",
  BEARER_TOKEN = "bearer_token",
}

export enum Role {
  ADMIN = "admin",
  USER = "user",
  GUEST = "guest",
}

export interface User {
  id: string;
  username: string;
  email: string;
  passwordHash: string;
  roles: Role[];
  createdAt: Date;
  lastLogin?: Date;
}

export interface Session {
  id: string;
  userId: string;
  token: string;
  expiresAt: Date;
  createdAt: Date;
  lastUsed: Date;
}

export interface JWTPayload {
  userId: string;
  username: string;
  roles: Role[];
  /** Unique token id — enables server-side revocation on logout */
  jti?: string;
  iat: number;
  exp: number;
}

/** Successful authentication: user (and optionally session) are defined */
export interface AuthSuccess {
  success: true;
  user: User;
  session?: Session;
}

/** Failed authentication: error message is defined */
export interface AuthFailure {
  success: false;
  error: string;
}

/** Discriminated union for type-safe auth handling */
export type AuthResult = AuthSuccess | AuthFailure;

export interface AuthConfig {
  jwtSecret: string;
  jwtExpiresIn: string;
  sessionExpiresIn: number; // milliseconds
  bcryptRounds: number;
  bearerTokenExpiresIn: number; // milliseconds
  refreshTokenExpiresIn: number; // milliseconds
  apiKeyPrefix: string;
  /** Optional iss claim: signed into and verified on every JWT when set */
  jwtIssuer?: string;
  /** Optional aud claim: signed into and verified on every JWT when set */
  jwtAudience?: string;
}

export interface AuthRequest {
  username: string;
  password: string;
}

export interface RegisterRequest extends AuthRequest {
  email: string;
  roles?: Role[];
}

export interface ApiKey {
  id: string;
  userId: string;
  keyHash: string;
  name: string;
  scopes: string[];
  lastUsed?: Date;
  expiresAt?: Date;
  createdAt: Date;
  isActive: boolean;
}

export interface BearerToken {
  id: string;
  userId: string;
  token: string;
  refreshToken: string;
  scopes: string[];
  expiresAt: Date;
  refreshExpiresAt: Date;
  createdAt: Date;
  lastUsed: Date;
}

export interface RefreshTokenRequest {
  refreshToken: string;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
  scope: string;
}

export interface ApiKeyRequest {
  name: string;
  scopes?: string[];
  expiresAt?: Date;
}

export interface AuthContext {
  user: User;
  authType: AuthType;
  session?: Session;
  apiKey?: ApiKey;
  bearerToken?: BearerToken;
}
