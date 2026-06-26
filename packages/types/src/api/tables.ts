import { TableConfig } from "../config";
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
