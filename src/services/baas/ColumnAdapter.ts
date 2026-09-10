import { BaseBaasAdapter } from "./BaasAdapter";
export class ColumnAdapter extends BaseBaasAdapter {
  readonly provider = "column" as const;
}
