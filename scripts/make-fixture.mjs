// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Generates the synthetic E2E fixture PDF (synthetic PHI only) used by
// tests/extension.e2e.spec.ts. Run from apps/redaction-extension:
//   node scripts/make-fixture.mjs
import { PDFDocument, StandardFonts } from "pdf-lib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const outDir = join(root, "..", "tests", "fixtures");

// Synthetic values only (project rule: never real PII/PHI). Content mirrors the
// discharge-summary fixture so page and document screenshots stay consistent.
const lines = [
  "St. Mary's Community Hospital",
  "Patient Care Services - Springfield, IL",
  "",
  "DISCHARGE SUMMARY",
  "",
  "Synthetic demonstration record. This is fictional discharge",
  "paperwork generated for the GovernWorld Redaction demo.",
  "",
  "Patient name: Jane Doe",
  "Date of birth: 1984-03-14",
  "Sex: F",
  "MRN: 44219",
  "Member ID: M882134",
  "SSN: 123-45-6789",
  "Phone: (415) 555-0199",
  "Email: jane.doe@example.com",
  "Address: 742 Evergreen Terrace, Springfield, IL 62704",
  "Payment method on file: 4111 1111 1111 1111",
  "Emergency contact: Mark Doe - (415) 555-0142 - mark.doe@example.net",
  "",
  "Admitted: 2026-08-10   Discharged: 2026-08-18",
  "Attending physician: Dr. Evelyn Reed",
  "Primary diagnosis: Acute bronchitis (J20.9)",
  "Secondary diagnosis: Type 2 diabetes, well controlled (E11.9)",
  "",
  "Summary of Stay",
  "Ms. Doe was admitted on 2026-08-10 with a productive cough, wheezing,",
  "and shortness of breath. Chest imaging showed changes consistent with",
  "acute bronchitis. She responded well to inhaled bronchodilators and",
  "oral fluids and was discharged on 2026-08-18 in stable condition.",
  "",
  "Discharge Medications",
  "- Amoxicillin 500 mg: one capsule by mouth three times daily for 7 days.",
  "- Metformin 1000 mg: one tablet twice daily with meals.",
  "- Albuterol 90 mcg HFA inhaler: two puffs every 4 hours as needed.",
  "",
  "Discharge Instructions",
  "Call the office or emergency services immediately for chest pain, difficulty",
  "breathing, facial swelling, or a fever above 101.5F. Complete all prescribed",
  "medications even if you feel better.",
  "",
  "Follow-Up Appointment",
  "A follow-up visit is scheduled for 2026-08-25 at 09:30 with Dr. Marcus Chen",
  "at Springfield Family Medicine (second floor, pulmonary clinic).",
  "",
  "Synthetic demo data only. No real personal information appears in this file.",
];

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const page = doc.addPage([612, 792]);
let y = 742;
for (const line of lines) {
  page.drawText(line, { x: 72, y, size: 11, font });
  y -= 16;
  if (y < 60) {
    y = 742;
    page.drawText("Page break placeholder - synthetic", { x: 72, y: 40, size: 9, font });
    break;
  }
}

const bytes = await doc.save();
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "sample.pdf"), bytes);
console.log("Wrote tests/fixtures/sample.pdf", bytes.length, "bytes");