import { BaseBaasAdapter } from "./BaasAdapter";
export class UnitAdapter extends BaseBaasAdapter {
  readonly provider = "unit" as const;
}
