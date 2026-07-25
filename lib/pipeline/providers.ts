/**
 * ILLUSTRATIVE FIXTURE — NOT a real provider feed.
 *
 * These clinics are invented for the demo. Names, waits and prices are
 * plausible for UK private imaging but are not quoted from any real provider,
 * are not a booking integration, and must never be presented as a live or
 * national directory. Waits and prices are indicative only.
 */

import type { InvestigationType, PrivateProvider } from "./types";

export const PRIVATE_PROVIDERS: PrivateProvider[] = [
  {
    id: "meridian-imaging-london",
    name: "Meridian Imaging (Marylebone)",
    specialty: "Diagnostic imaging",
    invTypes: ["ct", "mri", "xray"],
    region: "London",
    indicative_wait_days: 4,
    indicative_price_gbp: 480,
  },
  {
    id: "kingsway-respiratory-london",
    name: "Kingsway Respiratory Centre",
    specialty: "Respiratory medicine",
    invTypes: ["bronchoscopy", "consult", "xray"],
    region: "London",
    indicative_wait_days: 11,
    indicative_price_gbp: 1850,
  },
  {
    id: "northgate-diagnostics-manchester",
    name: "Northgate Diagnostics (Manchester)",
    specialty: "Diagnostic imaging",
    invTypes: ["ct", "mri", "bloods"],
    region: "North West",
    indicative_wait_days: 6,
    indicative_price_gbp: 395,
  },
  {
    id: "avonside-specialist-clinic-bristol",
    name: "Avonside Specialist Clinic",
    specialty: "General medicine and outpatient consults",
    invTypes: ["consult", "bloods"],
    region: "South West",
    indicative_wait_days: 8,
    indicative_price_gbp: 250,
  },
];

/**
 * Providers that can perform a given investigation type, nearest wait first.
 * `region` narrows the list when supplied; an unmatched region yields none
 * rather than silently offering a clinic hundreds of miles away.
 */
export function providersFor(invType: string, region?: string): PrivateProvider[] {
  return PRIVATE_PROVIDERS.filter(
    (provider) =>
      provider.invTypes.includes(invType as InvestigationType) &&
      (!region || provider.region.toLowerCase() === region.toLowerCase()),
  ).sort((a, b) => a.indicative_wait_days - b.indicative_wait_days);
}
