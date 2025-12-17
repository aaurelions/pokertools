export interface ApiErrorResponse {
  error: string;
  message?: string;
  code?: string;
}

export interface SuccessResponse {
  success: true;
}

export type GameMode = "CASH" | "TOURNAMENT";
export type TableStatus = "WAITING" | "ACTIVE" | "FINISHED";
