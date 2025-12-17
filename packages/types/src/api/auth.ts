export interface LoginRequest {
  message: string;
  signature: `0x${string}`;
}

export interface LoginResponse {
  token: string;
  user: {
    id: string;
    username: string;
  };
}

export interface NonceResponse {
  nonce: string;
}
