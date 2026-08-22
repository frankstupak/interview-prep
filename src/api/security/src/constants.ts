/**
 * HTTP status codes and auth error codes used across the security module.
 * Replaces magic number and string literals for consistency and maintainability.
 */

/** HTTP status codes used in API responses */
export const HttpStatus = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INTERNAL_SERVER_ERROR: 500,
} as const;

export type HttpStatusCode = (typeof HttpStatus)[keyof typeof HttpStatus];

/** Authorization header prefix strings (RFC 7235) */
export const AuthHeaderPrefix = {
  BASIC: "Basic ",
  BEARER: "Bearer ",
} as const;

export type AuthHeaderPrefixType = (typeof AuthHeaderPrefix)[keyof typeof AuthHeaderPrefix];

/** HTTP header names used for authentication */
export const AuthHeaderName = {
  AUTHORIZATION: "authorization",
  X_API_KEY: "x-api-key",
  X_SESSION_TOKEN: "x-session-token",
} as const;

export type AuthHeaderNameType = (typeof AuthHeaderName)[keyof typeof AuthHeaderName];

/** Default OAuth/API scopes when not specified */
export const DefaultScopes = ["read", "write"] as const;

/** Default auth config time values (milliseconds) for server/bootstrap */
export const AuthConfigDefaults = {
  /** 24 hours in ms */
  SESSION_EXPIRES_MS: 24 * 60 * 60 * 1000,
  /** 1 hour in ms */
  BEARER_TOKEN_EXPIRES_MS: 60 * 60 * 1000,
  /** 7 days in ms */
  REFRESH_TOKEN_EXPIRES_MS: 7 * 24 * 60 * 60 * 1000,
  /** JWT expiry string for jsonwebtoken */
  JWT_EXPIRES_IN: "24h",
  /** bcrypt rounds */
  BCRYPT_ROUNDS: 12,
  /** API key prefix for generated keys */
  API_KEY_PREFIX: "sk_live",
} as const;

/** Auth/API error codes returned in JSON body for client handling */
export const AuthErrorCode = {
  AUTHENTICATION_REQUIRED: "authentication_required",
  AUTHENTICATION_FAILED: "authentication_failed",
  AUTHENTICATION_ERROR: "authentication_error",
  INVALID_AUTH_FORMAT: "invalid_auth_format",
  AUTHORIZATION_FAILED: "authorization_failed",
  INVALID_REQUEST: "invalid_request",
  REGISTRATION_FAILED: "registration_failed",
  LOGIN_FAILED: "login_failed",
  INVALID_GRANT: "invalid_grant",
  UNSUPPORTED_GRANT_TYPE: "unsupported_grant_type",
  API_KEY_CREATION_FAILED: "api_key_creation_failed",
  USER_NOT_FOUND: "user_not_found",
  INVALID_ROLE: "invalid_role",
  API_KEY_NOT_FOUND: "api_key_not_found",
  ACCESS_DENIED: "access_denied",
  INTERNAL_SERVER_ERROR: "internal_server_error",
} as const;

export type AuthErrorCodeType = (typeof AuthErrorCode)[keyof typeof AuthErrorCode];

/** User-facing error messages for auth (aligned with AuthErrorCode where applicable) */
export const AuthErrorMessage = {
  NO_AUTH_PROVIDED: "No authentication provided",
  INVALID_AUTH_FORMAT: "Invalid authentication format",
  AUTH_PROCESSING_FAILED: "Authentication processing failed",
  USER_NOT_FOUND: "User not found",
  INVALID_BASIC_AUTH_HEADER: "Invalid Basic auth header",
  INVALID_SESSION_TOKEN: "Invalid session token",
  SESSION_EXPIRED: "Session expired",
  SESSION_AUTH_FAILED: "Session authentication failed",
  INVALID_API_KEY_FORMAT: "Invalid API key format",
  INVALID_API_KEY: "Invalid API key",
  API_KEY_EXPIRED: "API key expired",
  API_KEY_AUTH_FAILED: "API key authentication failed",
  INVALID_BEARER_TOKEN: "Invalid bearer token",
  BEARER_TOKEN_EXPIRED: "Bearer token expired",
  BEARER_TOKEN_AUTH_FAILED: "Bearer token authentication failed",
  INVALID_TOKEN: "Invalid token",
  TOKEN_EXPIRED: "Token expired",
  TOKEN_REVOKED: "Token revoked",
  PASSWORD_TOO_LONG: "Password must not exceed 72 bytes (bcrypt limit)",
  JWT_AUTH_FAILED: "JWT authentication failed",
  INVALID_CREDENTIALS: "Invalid credentials",
  CREDENTIAL_VALIDATION_FAILED: "Credential validation failed",
  SESSION_NOT_FOUND: "Session not found",
  BEARER_TOKEN_NOT_FOUND: "Bearer token not found",
  API_KEYS_VIA_CREATE: "API keys must be created through createApiKey method",
  API_KEYS_VIA_REVOKE: "API keys must be revoked through revokeApiKey method",
  UNSUPPORTED_AUTH_TYPE: "Unsupported auth type",
  LOGOUT_FAILED: "Logout failed",
  INVALID_REFRESH_TOKEN: "Invalid refresh token",
  REFRESH_TOKEN_EXPIRED: "Refresh token expired",
  REFRESH_TOKEN_FAILED: "Failed to refresh token",
  API_KEY_CREATION_FAILED_MSG: "Failed to create API key",
  API_KEY_REVOKE_FAILED_MSG: "Failed to revoke API key",
  API_KEY_NOT_FOUND_MSG: "API key not found",
  REGISTRATION_FAILED: "Registration failed",
  USER_ALREADY_EXISTS: "User already exists",
  INVALID_ROLE_SPECIFIED: "Invalid role specified",
} as const;