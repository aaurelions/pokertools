import { TableConfig } from "../Config";
import { PublicState } from "../PublicState";
import { TableStatus } from "./common";

export interface TableListItem {
  id: string;
  name: string;
  config: TableConfig;
  status: TableStatus;
}

export interface GetTablesResponse {
  tables: TableListItem[];
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface StandRequest {}

export interface TableStateResponse {
  state: PublicState;
}