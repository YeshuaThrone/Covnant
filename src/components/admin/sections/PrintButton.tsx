'use client';

/**
 * The statement's print control (spec art_qNu4T32F, module 4) — the PDF
 * path IS the browser's print dialog; there is no PDF dependency. Hidden
 * from the printout itself by the `data-no-print` rule in the print
 * stylesheet.
 */
export function PrintButton() {
  return (
    <button
      type="button"
      data-testid="audit-statement-print"
      data-no-print
      onClick={() => window.print()}
      className="rounded-full border border-gold-champagne/40 bg-gold-champagne/10 px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-gold-champagne transition hover:bg-gold-champagne/20"
    >
      Print / Save as PDF
    </button>
  );
}
