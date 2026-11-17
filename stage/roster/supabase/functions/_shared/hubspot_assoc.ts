// Which HubSpot records a roster call note is linked to. Pure, so it is unit tested.

export const NOTE_ASSOC = { deal: 214, contact: 202, company: 190 } as const;
export type NoteTargets = { deal?: string | null; contact?: string | null; company?: string | null };

/** HUBSPOT_DEFINED associations for every record that exists, in deal, contact, company order. */
export function noteAssociations(t: NoteTargets) {
  return (["deal", "contact", "company"] as const)
    .filter((k) => t[k])
    .map((k) => ({ to: { id: String(t[k]) }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: NOTE_ASSOC[k] }] }));
}

/** "deal + contact + company" for the journey pill, and "deal:1 contact:2 company:3" for the ids. */
export function targetSummary(t: NoteTargets): { kinds: string; ids: string } {
  const ks = (["deal", "contact", "company"] as const).filter((k) => t[k]);
  return { kinds: ks.join(" + "), ids: ks.map((k) => `${k}:${t[k]}`).join(" ") };
}
