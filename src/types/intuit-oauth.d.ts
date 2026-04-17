// Type declarations for intuit-oauth

declare module "intuit-oauth" {
  export interface OAuthClientConfig {
    clientId: string;
    clientSecret: string;
    environment: "sandbox" | "production";
    redirectUri: string;
    logging?: boolean;
    token?: TokenData;
  }

  export interface TokenData {
    access_token?: string;
    refresh_token?: string;
    token_type?: string;
    expires_in?: number;
    x_refresh_token_expires_in?: number;
    id_token?: string;
    realmId?: string;
    state?: string;
    createdAt?: number;
  }

  export interface Token {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in: number;
    x_refresh_token_expires_in: number;
    id_token?: string;
    realmId: string;
    state?: string;
    createdAt: number;
    isAccessTokenValid(): boolean;
    isRefreshTokenValid(): boolean;
    refreshToken(): string;
    getToken(): TokenData;
    setToken(token: TokenData): void;
    clearToken(): void;
  }

  export interface AuthResponse {
    token: Token;
    response: {
      status: number;
      statusText: string;
      headers: Record<string, string>;
    };
    body: string;
    json: Record<string, unknown>;
    getToken(): Token;
    valid(): boolean;
    getIntuitTid(): string;
  }

  export interface AuthorizeUriParams {
    scope: string | string[];
    state?: string;
  }

  class OAuthClient {
    static scopes: {
      Accounting: string;
      Payment: string;
      Payroll: string;
      TimeTracking: string;
      Benefits: string;
      Profile: string;
      Email: string;
      Phone: string;
      Address: string;
      OpenId: string;
      Intuit_name: string;
    };

    static environment: {
      sandbox: string;
      production: string;
    };

    constructor(config: OAuthClientConfig);

    token: Token;
    environment: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;

    authorizeUri(params: AuthorizeUriParams): string;
    createToken(uri: string): Promise<AuthResponse>;
    refresh(): Promise<AuthResponse>;
    refreshUsingToken(refreshToken: string): Promise<AuthResponse>;
    revoke(params?: { access_token?: string; refresh_token?: string }): Promise<AuthResponse>;
    getUserInfo(): Promise<AuthResponse>;
    getToken(): Token;
    setToken(params: TokenData): Token;
    isAccessTokenValid(): boolean;
  }

  export default OAuthClient;
}
