// A made-up seller for tests. The real profile comes from the onboarding wizard; the defaults in profile.ts are empty.
import { normalizeProfile } from "./profile.ts";

export const SAMPLE_PROFILE = normalizeProfile({
  company_name: "Acme Ledger",
  website: "https://acmeledger.com",
  product_summary: "Acme Ledger closes the books for mid-market finance teams.",
  product_overview: "Acme Ledger automates the month-end close.",
  customers: [{ name: "Northwind", url: "https://northwind.example", live_instance: true }, { name: "Contoso", url: "", live_instance: false }],
  proof_points: [
    { text: "close in 3 days instead of 9", customer: "Northwind", use_when: "slow month-end close", link: "" },
    { text: "audit prep cut from 6 weeks to 2", customer: "Northwind", use_when: "audit season, controllers", link: "" },
  ],
  booking_link: "https://cal.example/acme",
  never_call_it: ["spreadsheet"],
  banned_words: ["synergy"],
  never_target: ["Initech"],
  adjacency: [{ match: ["fabrikam"], hook: "Northwind already runs Acme Ledger" }],
});
