import type {
  CreatorTaxProfile,
  CreatorYtdEarnings,
  TaxEscrowRecord,
} from "@/modules/don/records";
import { FORM_1099_THRESHOLD_CENTS } from "@/modules/don/constants";

// The full Store interface (src/lib/server/store.ts) lands with the
// SupabaseStore PR. Until then the store parameter is typed structurally from
// exactly the methods this function reads, over the foundation record types.
// Cursor's Store implements every member below, so the wiring PR passes the
// real Store through with no edit to this function.
export type ComplianceStore = {
  getCreatorTaxProfile(
    creatorId: string,
  ): CreatorTaxProfile | null | undefined;
  getCreatorYtd(
    creatorId: string,
    taxYear: number,
  ): CreatorYtdEarnings | null | undefined;
  listTaxEscrowByCreator(creatorId: string, taxYear: number): TaxEscrowRecord[];
};

// Local stand-in for Cursor's TinStatus (Phase 2 drop); the withholding
// module unifies the type when it lands.
type TinStatus = {
  tin_verified: boolean;
  w9_on_file: boolean;
};

export function readCreatorCompliance(
  store: ComplianceStore,
  creatorId: string,
  taxYear: number,
) {
  const profile = store.getCreatorTaxProfile(creatorId);
  const ytd = store.getCreatorYtd(creatorId, taxYear);
  const status: TinStatus = {
    tin_verified: profile?.tin_verified === 1,
    w9_on_file: profile?.w9_on_file === 1,
  };
  const ytdGross = ytd?.gross_cents ?? 0;
  return {
    creator_id: creatorId,
    tax_year: taxYear,
    tin_verified: status.tin_verified,
    w9_on_file: status.w9_on_file,
    ytd_gross_cents: ytdGross,
    ytd_withheld_cents: ytd?.withheld_cents ?? 0,
    requires_1099: ytdGross >= FORM_1099_THRESHOLD_CENTS,
    escrow: store.listTaxEscrowByCreator(creatorId, taxYear),
  };
}
