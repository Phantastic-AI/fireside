// Every letter that leaves the building is signed by whoever actually sent it.
//
// A decision, a reminder, an invitation and a nudge all come from a
// conference — so they are signed with its name, not with the software's. The
// two letters the software genuinely sends on its own (a sign-in link, a
// check-in link) sign as Fireside, because that is who is writing.
//
// Found by an adversarial read of the whole outbound corpus: a committee's
// decision arriving signed "sent from Fireside" hands the reader a vendor
// they have no relationship with at the moment they most want a person.

/** The mailed shape of one letter: a greeting, the words, a signature. */
export function mailText(opts: { to: string; body: string; from: string }): string {
  return `Hello ${opts.to},\n\n${opts.body}\n\n— ${opts.from}`;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * A conference's dates, the way a person says them: "3–4 September 2026",
 * "17 October 2026". Written into letters so a speaker forwarding an
 * acceptance for travel approval has the dates in the mail itself.
 */
export function eventDates(startsOn: string, endsOn: string): string {
  if (!startsOn) return '';
  const day = (iso: string): number => Number(iso.slice(8, 10));
  const month = (iso: string): string => MONTHS[Number(iso.slice(5, 7)) - 1] ?? '';
  const year = startsOn.slice(0, 4);
  if (!endsOn || startsOn === endsOn) return `${day(startsOn)} ${month(startsOn)} ${year}`;
  if (startsOn.slice(0, 7) === endsOn.slice(0, 7)) {
    return `${day(startsOn)}–${day(endsOn)} ${month(startsOn)} ${year}`;
  }
  return `${day(startsOn)} ${month(startsOn)} – ${day(endsOn)} ${month(endsOn)} ${year}`;
}
