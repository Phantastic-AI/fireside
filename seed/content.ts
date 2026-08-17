/**
 * Fireside — seed content.
 *
 * Pure data. No imports, no I/O, no side effects. Everything here is written to
 * be read by a stranger: the cast, the proposals, the sessions and the question
 * set are the product's face as much as any screen is.
 *
 * SAFETY (05 §9): every identity in this file is invented. Mail is @example.org,
 * phones are +1 555 XXXX, employers do not exist, no surname repeats, no real
 * person is named. Recordings point at videos.example.org.
 *
 * ---------------------------------------------------------------------------
 * R-1 ARITHMETIC — the closed distribution this file is built to satisfy.
 *
 *   AI Engineer New York 2026 — 1,000 non-draft proposals, plus 8 drafts:
 *     accepted   60   (all notified — these ARE the published agenda)
 *     waitlisted 12   (decided, not told)
 *     rejected  598   (decided, not told)      → decided-not-told = 610
 *     submitted 328   (undecided)
 *     withdrawn   2
 *     ----------------
 *     total   1,000   + 8 drafts outside the 1,000
 *
 *   HAND_PROPOSALS supplies 40 of those 1,000, split:
 *     accepted 26 · waitlisted 4 · rejected 4 · submitted 6
 *
 *   Therefore the expander must generate exactly 960 more:
 *     accepted 34 · waitlisted 8 · rejected 594 · submitted 322 · withdrawn 2
 *     plus 8 drafts.
 *   See EXPANSION_TARGETS below — the numbers are exported, not left in prose.
 *
 *   One accepted AIE session is cancelled on the published agenda:
 *   CANCELLED_SESSION_SLUG = "nobody-notices-latency-until-they-do"
 *   (Ben Halloran, Fri 11:30, Studio). He keeps his Thursday talk, so the
 *   agenda shows one struck-through row without losing the speaker.
 *
 *   DevOps Days Charlotte 2025 — 84 proposals, 14 accepted and placed.
 *   Exactly 8 carry a recording; exactly one is historically cancelled
 *   (CHARLOTTE_CANCELLED_SLUG).
 *
 *   38 people appear at BOTH events — SHARED_SPEAKER_IDS. That array is the
 *   overlap contract: the expander must ensure every id in it holds at least
 *   one proposal under each event slug. It feeds the cross-conference
 *   Speaker CRM ("we know Anouk from Charlotte").
 *
 * NOTE ON SLUGS: slugs are unique WITHIN an event, not across events. Six
 * talks appear at both conferences on purpose — a speaker re-pitching the
 * talk that worked in Charlotte is the whole point of the CRM story. Key on
 * (eventSlug, slug).
 * ---------------------------------------------------------------------------
 */

export const AIE_EVENT_SLUG = "aie-nyc";
export const CHARLOTTE_EVENT_SLUG = "ddc-clt";

/* ============================================================
   The cast
   ============================================================ */

export type CastPerson = {
  id: string;
  name: string;
  email: string;
  jobTitle: string;
  organisation: string;
  bio: string;
  phone: string | null;
  links: string | null;
  pronouns: string | null;
  internalRole: "organizer" | "reviewer" | null;
};

export const CAST: CastPerson[] = [
  {
    id: "naomi-adeyemi",
    name: "Naomi Adeyemi",
    email: "naomi@example.org",
    jobTitle: "Program chair",
    organisation: "AI Engineer",
    bio: "Naomi has chaired the program for three years and still reads every proposal herself.",
    phone: "+1 555 0101",
    links: "https://aiengineer.example.org/program",
    pronouns: "she/her",
    internalRole: "organizer",
  },
  {
    id: "lena-fischer",
    name: "Lena Fischer",
    email: "lena.fischer@example.org",
    jobTitle: "Head of Machine Learning",
    organisation: "Roseway Analytics",
    bio: "Lena has read the committee's pile three years running and keeps a private tally of the talks she was wrong about. Two of them are now on the main stage.",
    phone: "+1 555 0150",
    links: null,
    pronouns: "she/her",
    internalRole: "reviewer",
  },
  {
    id: "priya-raghunathan",
    name: "Priya Raghunathan",
    email: "priya.raghunathan@example.org",
    jobTitle: "SVP Engineering",
    organisation: "Meridian Underwriting",
    bio: "Priya runs the 400-person engineering group at Meridian, where underwriting and claims systems that predate her career are being rebuilt around agents. She has been shipping insurance software for nineteen years and is unromantic about all of it.",
    phone: "+1 555 0100",
    links: "https://priya.example.org",
    pronouns: "she/her",
    internalRole: null,
  },
  {
    id: "amara-nwosu",
    name: "Amara Nwosu",
    email: "amara.nwosu@example.org",
    jobTitle: "VP Claims Operations",
    organisation: "Meridian Underwriting",
    bio: "Amara runs claims for 11 states. She is the business partner on Meridian's agent rollout and the person who decides when a model is allowed near a customer.",
    phone: "+1 555 0102",
    links: null,
    pronouns: "she/her",
    internalRole: null,
  },
  {
    id: "tomas-okonkwo",
    name: "Tomás Okonkwo",
    email: "tomas.okonkwo@example.org",
    jobTitle: "Head of Platform",
    organisation: "Cadence Freight",
    bio: "Tomás built the internal platform that 60 teams at Cadence deploy through, then spent a year building the eval harness that told him half of it was wrong.",
    phone: "+1 555 0103",
    links: "https://notes.example.org/tomas-okonkwo",
    pronouns: "he/him",
    internalRole: null,
  },
  {
    id: "ingrid-solheim",
    name: "Ingrid Solheim",
    email: "ingrid.solheim@example.org",
    jobTitle: "Principal Engineer",
    organisation: "Nordhavn Bank",
    bio: "Ingrid has been on call for payments infrastructure for eleven years and has opinions about queues that she can defend with graphs.",
    phone: "+1 555 0104",
    links: "https://ingrid.example.org/writing",
    pronouns: "she/her",
    internalRole: null,
  },
  {
    id: "marcus-delacroix",
    name: "Marcus Delacroix",
    email: "marcus@example.org",
    jobTitle: "Director of Data",
    organisation: "Halcyon Retail",
    bio: "Marcus leads the data platform at Halcyon and organises DevOps Days Charlotte on the side, which he describes as a fair trade.",
    phone: "+1 555 0105",
    links: "https://devopsdays-charlotte.example.org",
    pronouns: "he/him",
    internalRole: null,
  },
  {
    id: "yuki-tanabe",
    name: "Yuki Tanabe",
    email: "yuki.tanabe@example.org",
    jobTitle: "Staff ML Engineer",
    organisation: "Kestrel Robotics",
    bio: "Yuki works on perception at Kestrel. She deleted the company vector database in March and has been explaining herself ever since.",
    phone: "+1 555 0106",
    links: "https://yuki.example.org",
    pronouns: "she/her",
    internalRole: null,
  },
  {
    id: "ben-halloran",
    name: "Ben Halloran",
    email: "ben.halloran@example.org",
    jobTitle: "Site Reliability Lead",
    organisation: "Tidewater Energy",
    bio: "Ben keeps a grid operator online. He treats paging policy as a product surface and has the incident review notes to prove it.",
    phone: "+1 555 0107",
    links: null,
    pronouns: "he/him",
    internalRole: null,
  },
  {
    id: "sofia-marchetti",
    name: "Sofia Marchetti",
    email: "sofia.marchetti@example.org",
    jobTitle: "Engineering Manager",
    organisation: "Bellwether Labs",
    bio: "Sofia took a research team from notebooks to a production on-call rotation in ninety days and would like to warn you about days 40 through 60.",
    phone: "+1 555 0108",
    links: "https://sofia.example.org/talks",
    pronouns: "she/her",
    internalRole: null,
  },
  {
    id: "dev-chaudhary",
    name: "Dev Chaudhary",
    email: "dev.chaudhary@example.org",
    jobTitle: "Founder",
    organisation: "Slipstream AI",
    bio: "Dev has now run the same rollout at four companies. The first three did not stick and he can tell you exactly why.",
    phone: "+1 555 0109",
    links: "https://slipstream.example.org/dev",
    pronouns: "he/him",
    internalRole: null,
  },
  {
    id: "nia-fitzgerald",
    name: "Nia Fitzgerald",
    email: "nia.fitzgerald@example.org",
    jobTitle: "Head of Developer Experience",
    organisation: "Orchard Systems",
    bio: "Nia rewrote Orchard's documentation for machines first and humans second, which turned out to be the same job.",
    phone: "+1 555 0110",
    links: "https://nia.example.org",
    pronouns: "she/her",
    internalRole: null,
  },
  {
    id: "hassan-qureshi",
    name: "Hassan Qureshi",
    email: "hassan.qureshi@example.org",
    jobTitle: "Principal Architect",
    organisation: "Vantage Insurance",
    bio: "Hassan owns the number the board asks about: cost per resolved ticket. He halved it and is honest about which half was luck.",
    phone: "+1 555 0111",
    links: null,
    pronouns: "he/him",
    internalRole: null,
  },
  {
    id: "elena-vasquez",
    name: "Elena Vasquez",
    email: "elena.vasquez@example.org",
    jobTitle: "CTO",
    organisation: "Northbeam Logistics",
    bio: "Elena has hired 200 engineers in four years and has changed what she screens for twice.",
    phone: "+1 555 0112",
    links: "https://elena.example.org",
    pronouns: "she/her",
    internalRole: null,
  },
  {
    id: "kwame-asante",
    name: "Kwame Asante",
    email: "kwame.asante@example.org",
    jobTitle: "Platform Engineer",
    organisation: "Copperline Media",
    bio: "Kwame is the reason Copperline's fastest team also writes the most tests, and he thinks the causation runs the way you would not guess.",
    phone: "+1 555 0113",
    links: "https://kwame.example.org/notes",
    pronouns: "he/him",
    internalRole: null,
  },
  {
    id: "rowan-petrenko",
    name: "Rowan Petrenko",
    email: "rowan.petrenko@example.org",
    jobTitle: "Data Platform Lead",
    organisation: "Anvil Manufacturing",
    bio: "Rowan migrated Anvil's warehouse twice in eighteen months. The second one worked.",
    phone: "+1 555 0114",
    links: null,
    pronouns: "they/them",
    internalRole: null,
  },
  {
    id: "lucia-berrigan",
    name: "Lucia Berrigan",
    email: "lucia.berrigan@example.org",
    jobTitle: "Head of Research",
    organisation: "Fathom Health",
    bio: "Lucia reads clinical notes for a living, or rather she has stopped, which is the talk.",
    phone: "+1 555 0115",
    links: "https://lucia.example.org",
    pronouns: "she/her",
    internalRole: null,
  },
  {
    id: "jonah-wexler",
    name: "Jonah Wexler",
    email: "jonah.wexler@example.org",
    jobTitle: "Staff Engineer",
    organisation: "Pinewood Grocery",
    bio: "Jonah built the guardrail layer that sits between Pinewood's agents and its inventory system, and has never once been paged for it.",
    phone: "+1 555 0116",
    links: null,
    pronouns: "he/him",
    internalRole: null,
  },
  {
    id: "adaeze-okereke",
    name: "Adaeze Okereke",
    email: "adaeze.okereke@example.org",
    jobTitle: "Head of Engineering",
    organisation: "Willow Bank",
    bio: "Adaeze spent a quarter trying to reproduce a build and turned the failure into policy.",
    phone: "+1 555 0117",
    links: null,
    pronouns: "she/her",
    internalRole: null,
  },
  {
    id: "callum-fraser",
    name: "Callum Fraser",
    email: "callum.fraser@example.org",
    jobTitle: "Staff SRE",
    organisation: "Beacon Media",
    bio: "Callum deleted Beacon's runbooks. Reception has been mixed.",
    phone: "+1 555 0118",
    links: null,
    pronouns: "he/him",
    internalRole: null,
  },
  {
    id: "mei-lin-chow",
    name: "Mei-Lin Chow",
    email: "mei.lin.chow@example.org",
    jobTitle: "Principal Data Scientist",
    organisation: "Harborline Retail",
    bio: "Mei-Lin forecasts demand for 900 stores using data she does not fully trust, and says so in public.",
    phone: "+1 555 0119",
    links: "https://meilin.example.org",
    pronouns: "she/her",
    internalRole: null,
  },
  {
    id: "otto-lindqvist",
    name: "Otto Lindqvist",
    email: "otto.lindqvist@example.org",
    jobTitle: "Engineering Director",
    organisation: "Fjordway Logistics",
    bio: "Otto runs the platform group at Fjordway and is the person who signs off on the on-call roster.",
    phone: "+1 555 0120",
    links: null,
    pronouns: "he/him",
    internalRole: null,
  },
  {
    id: "rafael-duarte",
    name: "Rafael Duarte",
    email: "rafael.duarte@example.org",
    jobTitle: "Platform Lead",
    organisation: "Sierra Foods",
    bio: "Rafael has shipped four internal AI products at Sierra and thinks the prompt was never the interesting part.",
    phone: "+1 555 0121",
    links: null,
    pronouns: "he/him",
    internalRole: null,
  },
  {
    id: "tessa-abbott",
    name: "Tessa Abbott",
    email: "tessa.abbott@example.org",
    jobTitle: "Director of Support Engineering",
    organisation: "Larkspur Software",
    bio: "Tessa's support team wrote the eval set that the model team now depends on.",
    phone: "+1 555 0122",
    links: null,
    pronouns: "she/her",
    internalRole: null,
  },
  {
    id: "idris-bello",
    name: "Idris Bello",
    email: "idris.bello@example.org",
    jobTitle: "Staff Engineer",
    organisation: "Kirkwall Energy",
    bio: "Idris turned off a pilot with executive sponsorship and lived to talk about it.",
    phone: "+1 555 0123",
    links: null,
    pronouns: "he/him",
    internalRole: null,
  },
  {
    id: "hannah-ostrowski",
    name: "Hannah Ostrowski",
    email: "hannah.ostrowski@example.org",
    jobTitle: "VP Product Engineering",
    organisation: "Tallgrass Health",
    bio: "Hannah budgets for infrastructure that gets 40% cheaper every quarter, which breaks every planning process she has.",
    phone: "+1 555 0124",
    links: null,
    pronouns: "she/her",
    internalRole: null,
  },
  {
    id: "greta-lindholm",
    name: "Greta Lindholm",
    email: "greta.lindholm@example.org",
    jobTitle: "Staff Engineer",
    organisation: "Piedmont Freight",
    bio: "Greta keeps a fifteen-year-old deployment pipeline alive and has made peace with it.",
    phone: "+1 555 0130",
    links: "https://greta.example.org",
    pronouns: "she/her",
    internalRole: null,
  },
  {
    id: "omar-siddiqui",
    name: "Omar Siddiqui",
    email: "omar.siddiqui@example.org",
    jobTitle: "SRE Manager",
    organisation: "Catawba Utilities",
    bio: "Omar runs the on-call rotation for a utility and has strong feelings about alert fatigue.",
    phone: "+1 555 0131",
    links: null,
    pronouns: "he/him",
    internalRole: null,
  },
  {
    id: "bea-thornton",
    name: "Bea Thornton",
    email: "bea.thornton@example.org",
    jobTitle: "DevEx Lead",
    organisation: "Queen City Fintech",
    bio: "Bea measures how long it takes a new hire to ship, and has the graph going the right way.",
    phone: "+1 555 0132",
    links: "https://bea.example.org/measuring",
    pronouns: "she/her",
    internalRole: null,
  },
  {
    id: "luis-moreira",
    name: "Luis Moreira",
    email: "luis.moreira@example.org",
    jobTitle: "Head of Infrastructure",
    organisation: "Southbound Logistics",
    bio: "Luis moved 400 services off a mainframe and would rather talk about the 12 that stayed.",
    phone: "+1 555 0133",
    links: null,
    pronouns: "he/him",
    internalRole: null,
  },
  {
    id: "anouk-devries",
    name: "Anouk de Vries",
    email: "anouk.devries@example.org",
    jobTitle: "Principal Engineer",
    organisation: "Blue Ridge Bank",
    bio: "Anouk works on payments reliability and thinks most postmortems are written for the wrong reader.",
    phone: "+1 555 0134",
    links: "https://anouk.example.org",
    pronouns: "she/her",
    internalRole: null,
  },
  {
    id: "samir-haddad",
    name: "Samir Haddad",
    email: "samir.haddad@example.org",
    jobTitle: "Platform Architect",
    organisation: "Uptown Health Systems",
    bio: "Samir has run the same migration in three regulated industries.",
    phone: "+1 555 0135",
    links: null,
    pronouns: "he/him",
    internalRole: null,
  },
  {
    id: "freya-lindgren",
    name: "Freya Lindgren",
    email: "freya.lindgren@example.org",
    jobTitle: "Engineering Manager",
    organisation: "Cardinal Insurance",
    bio: "Freya rebuilt her team's deployment process around a stopwatch.",
    phone: "+1 555 0136",
    links: null,
    pronouns: "she/her",
    internalRole: null,
  },
  {
    id: "theo-vandermeer",
    name: "Theo van der Meer",
    email: "theo.vandermeer@example.org",
    jobTitle: "Staff SRE",
    organisation: "Trident Payments",
    bio: "Theo maintains the chaos testing suite that everyone complains about and nobody will remove.",
    phone: "+1 555 0137",
    links: "https://theo.example.org/chaos",
    pronouns: "he/him",
    internalRole: null,
  },
  {
    id: "imani-clarke",
    name: "Imani Clarke",
    email: "imani.clarke@example.org",
    jobTitle: "Director of Engineering",
    organisation: "Wellspring Care",
    bio: "Imani took a hospital system from quarterly releases to daily ones.",
    phone: "+1 555 0138",
    links: "https://imani.example.org",
    pronouns: "she/her",
    internalRole: null,
  },
  {
    id: "viktor-novak",
    name: "Viktor Novák",
    email: "viktor.novak@example.org",
    jobTitle: "Infrastructure Lead",
    organisation: "Foothills Energy",
    bio: "Viktor has been running Kubernetes since before it was reasonable.",
    phone: "+1 555 0139",
    links: null,
    pronouns: "he/him",
    internalRole: null,
  },
  {
    id: "anya-kowalczyk",
    name: "Anya Kowalczyk",
    email: "anya.kowalczyk@example.org",
    jobTitle: "Staff Engineer",
    organisation: "Meridian Underwriting",
    bio: "Anya works on Meridian's claims platform and is the person the auditors talk to.",
    phone: "+1 555 0140",
    links: null,
    pronouns: "she/her",
    internalRole: null,
  },
  {
    id: "desmond-oyelaran",
    name: "Desmond Oyelaran",
    email: "desmond.oyelaran@example.org",
    jobTitle: "Head of SRE",
    organisation: "Charlotte Transit",
    bio: "Desmond keeps a transit system's real-time feed honest.",
    phone: "+1 555 0141",
    links: null,
    pronouns: "he/him",
    internalRole: null,
  },
  {
    id: "nadia-berkovich",
    name: "Nadia Berkovich",
    email: "nadia.berkovich@example.org",
    jobTitle: "Head of Applied AI",
    organisation: "Kingsford Mutual",
    bio: "Nadia's team ships to two million policyholders and she still reviews every prompt change herself, which she admits does not scale.",
    phone: "+1 555 0151",
    links: "https://nadia.example.org",
    pronouns: "she/her",
    internalRole: null,
  },
  {
    id: "colm-rafferty",
    name: "Colm Rafferty",
    email: "colm.rafferty@example.org",
    jobTitle: "Staff Engineer",
    organisation: "Ardmore Payments",
    bio: "Colm has been on the wrong end of three payment incidents and wrote the postmortem for all of them. The third one is short.",
    phone: "+1 555 0152",
    links: null,
    pronouns: "he/him",
    internalRole: null,
  },
  {
    id: "zainab-oduya",
    name: "Zainab Oduya",
    email: "zainab.oduya@example.org",
    jobTitle: "Director of Platform",
    organisation: "Halyard Shipping",
    bio: "Zainab runs the platform group for a shipping line and measures her work in hours of berth time saved.",
    phone: "+1 555 0153",
    links: null,
    pronouns: "she/her",
    internalRole: null,
  },
  {
    id: "piotr-waleski",
    name: "Piotr Waleski",
    email: "piotr.waleski@example.org",
    jobTitle: "Principal SRE",
    organisation: "Vistula Telecom",
    bio: "Piotr has carried the pager for a national network for nine years and can tell you which two nights actually mattered.",
    phone: "+1 555 0154",
    links: null,
    pronouns: "he/him",
    internalRole: null,
  },
  {
    id: "sanne-bakhuis",
    name: "Sanne Bakhuis",
    email: "sanne.bakhuis@example.org",
    jobTitle: "Data Platform Lead",
    organisation: "Zuiderzee Grocers",
    bio: "Sanne moved a grocery chain's forecasting off a spreadsheet that four people understood and one person maintained.",
    phone: null,
    links: null,
    pronouns: "she/her",
    internalRole: null,
  },
  {
    id: "emeka-ubani",
    name: "Emeka Ubani",
    email: "emeka.ubani@example.org",
    jobTitle: "Engineering Manager",
    organisation: "Ironbark Lending",
    bio: "Emeka rebuilt his team's review process after counting how long a pull request waited before anyone looked at it.",
    phone: "+1 555 0156",
    links: null,
    pronouns: "he/him",
    internalRole: null,
  },
  {
    id: "marta-salgado",
    name: "Marta Salgado",
    email: "marta.salgado@example.org",
    jobTitle: "Head of Quality Engineering",
    organisation: "Aurelio Pharma",
    bio: "Marta signs off on releases in a regulated lab and has made the sign-off shorter every year for four years.",
    phone: "+1 555 0157",
    links: null,
    pronouns: "she/her",
    internalRole: null,
  },
  {
    id: "devon-achterberg",
    name: "Devon Achterberg",
    email: "devon.achterberg@example.org",
    jobTitle: "VP Engineering",
    organisation: "Thistlewood Insurance",
    bio: "Devon inherited an engineering group that had not shipped in two quarters. He is candid about which of his first three decisions was the wrong one.",
    phone: "+1 555 0158",
    links: null,
    pronouns: "he/him",
    internalRole: null,
  },
  {
    id: "ines-carvalho",
    name: "Inês Carvalho",
    email: "ines.carvalho@example.org",
    jobTitle: "Staff Data Engineer",
    organisation: "Cascais Water",
    bio: "Inês builds the pipelines that tell a water utility where the leaks are, and knows exactly how often they are wrong.",
    phone: null,
    links: null,
    pronouns: "she/her",
    internalRole: null,
  },
  {
    id: "tobias-rennweg",
    name: "Tobias Rennweg",
    email: "tobias.rennweg@example.org",
    jobTitle: "Head of Infrastructure",
    organisation: "Alpsee Manufacturing",
    bio: "Tobias keeps a factory floor's software running on hardware older than most of his team.",
    phone: "+1 555 0160",
    links: null,
    pronouns: "he/him",
    internalRole: null,
  },
  {
    id: "ruth-ngoma",
    name: "Ruth Ngoma",
    email: "ruth.ngoma@example.org",
    jobTitle: "Director of Support Engineering",
    organisation: "Highveld Mobile",
    bio: "Ruth's support team answers 9,000 tickets a month and now writes the eval set the model team argues with.",
    phone: "+1 555 0161",
    links: "https://ruth.example.org",
    pronouns: "she/her",
    internalRole: null,
  },
  {
    id: "kaveh-nassiri",
    name: "Kaveh Nassiri",
    email: "kaveh.nassiri@example.org",
    jobTitle: "Principal Architect",
    organisation: "Damavand Logistics",
    bio: "Kaveh has drawn the same architecture diagram at three companies and thinks the third one finally earned it.",
    phone: null,
    links: null,
    pronouns: "he/him",
    internalRole: null,
  },
  {
    id: "bridget-molloy",
    name: "Bridget Molloy",
    email: "bridget.molloy@example.org",
    jobTitle: "Head of Data Science",
    organisation: "Clonmel Foods",
    bio: "Bridget forecasts perishable stock, where a wrong forecast is a thing you can taste.",
    phone: "+1 555 0163",
    links: null,
    pronouns: "she/her",
    internalRole: null,
  },
  {
    id: "hyeon-woo-baek",
    name: "Hyeon-woo Baek",
    email: "hyeon.woo.baek@example.org",
    jobTitle: "Staff ML Engineer",
    organisation: "Hanbit Semiconductor",
    bio: "Hyeon-woo works on defect detection in a fab and has retrained the same model through two process changes without telling anyone it was hard.",
    phone: "+1 555 0164",
    links: null,
    pronouns: "he/him",
    internalRole: null,
  },
  // Two real people, seeded as prospects with profiles already on file, so an
  // organiser inviting a fresh conference's speakers has a concrete, recognisable
  // name to reach for. Synthetic emails; public-role bios only.
  {
    id: "aditya-advani",
    name: "Aditya Advani",
    email: "aditya.advani@example.org",
    jobTitle: "Founder",
    organisation: "MoltPod",
    bio: "Aditya builds MoltPod, an AI-native event manager, and has hacked and spoken at AI Engineer three years running. He is unreasonably interested in agents that do the operational work no one wants to.",
    phone: null,
    links: "https://moltpod.example.org",
    pronouns: null,
    internalRole: null,
  },
  {
    id: "swyx",
    name: "Swyx",
    email: "swyx@example.org",
    jobTitle: "Curator",
    organisation: "AI Engineer",
    bio: "Swyx named 'the AI Engineer' and curates the conference by that name, alongside the Latent Space podcast. He writes about the people building on top of foundation models.",
    phone: null,
    links: "https://latent.space",
    pronouns: null,
    internalRole: null,
  },
];

/**
 * The 38 people who hold proposals at BOTH events. The first fourteen are the
 * Charlotte speakers who came back; the rest submitted to Charlotte and are
 * trying New York, or the other way round. The expander must guarantee each id
 * here has at least one proposal under each event slug.
 */
export const SHARED_SPEAKER_IDS: string[] = [
  "greta-lindholm",
  "omar-siddiqui",
  "bea-thornton",
  "luis-moreira",
  "anouk-devries",
  "samir-haddad",
  "freya-lindgren",
  "theo-vandermeer",
  "imani-clarke",
  "viktor-novak",
  "anya-kowalczyk",
  "desmond-oyelaran",
  "ben-halloran",
  "nia-fitzgerald",
  "priya-raghunathan",
  "amara-nwosu",
  "tomas-okonkwo",
  "ingrid-solheim",
  "yuki-tanabe",
  "sofia-marchetti",
  "dev-chaudhary",
  "hassan-qureshi",
  "elena-vasquez",
  "kwame-asante",
  "rowan-petrenko",
  "lucia-berrigan",
  "jonah-wexler",
  "adaeze-okereke",
  "callum-fraser",
  "mei-lin-chow",
  "otto-lindqvist",
  "rafael-duarte",
  "tessa-abbott",
  "idris-bello",
  "hannah-ostrowski",
  "colm-rafferty",
  "zainab-oduya",
  "tobias-rennweg",
];

/* ============================================================
   Hand-written proposals — AI Engineer New York 2026
   ============================================================

   Exactly 40. These are the first two pages of every default sort, so every
   one is written the way a person writes: a number, a rollout that failed, an
   eval that changed somebody's mind. Twenty-six are accepted and make up the
   hand-quality core of the published agenda.
*/

export type HandProposal = {
  slug: string;
  title: string;
  abstract: string;
  speakerId: string;
  coSpeakerIds: string[];
  track: "platform" | "practice" | "leadership";
  format: "Talk" | "Lightning talk" | "Workshop" | "Panel";
  minutes: 15 | 30 | 45 | 90;
  level: "intro" | "practitioner" | "deep";
  state: "accepted" | "waitlisted" | "rejected" | "submitted";
};

export const HAND_PROPOSALS: HandProposal[] = [
  /* --- accepted · placed on the published agenda (22) --- */
  {
    slug: "the-year-the-tooling-caught-up",
    title: "The year the tooling caught up",
    abstract:
      "Four years ago every one of these talks was a demo. This one is a maintenance report. I will walk through what changed in our stack between 2024 and now, which of the promises actually landed, and the two places we are still doing it by hand because nothing better exists yet.",
    speakerId: "elena-vasquez",
    coSpeakerIds: [],
    track: "leadership",
    format: "Talk",
    minutes: 30,
    level: "intro",
    state: "accepted",
  },
  {
    slug: "what-the-incident-taught-us-about-queues",
    title: "What the incident taught us about queues",
    abstract:
      "On a Tuesday in March our payment queue backed up for 41 minutes and we learned that three separate teams each believed a different team owned the retry policy. Fifteen minutes on what the graphs said, what we thought they said, and the one line of config that would have made it a non-event.",
    speakerId: "ingrid-solheim",
    coSpeakerIds: [],
    track: "practice",
    format: "Lightning talk",
    minutes: 15,
    level: "practitioner",
    state: "accepted",
  },
  {
    slug: "claims-agents-three-rollouts-one-that-stuck",
    title: "Claims agents: three rollouts, one that stuck",
    abstract:
      "In 18 months we went from a pilot nobody used to agents drafting two thirds of first-pass claims notes. This talk walks through the three failed rollouts before the one that stuck: the eval set of 212 real claims that finally told us the truth, the 11 days that came off the median cycle time, and the operating-model changes that made it durable. Amara ran the business side and will contradict me at least twice.",
    speakerId: "priya-raghunathan",
    coSpeakerIds: ["amara-nwosu"],
    track: "platform",
    format: "Talk",
    minutes: 45,
    level: "practitioner",
    state: "accepted",
  },
  {
    slug: "the-eval-suite-that-finally-told-us-the-truth",
    title: "The eval suite that finally told us the truth",
    abstract:
      "We had a green dashboard and an angry customer at the same time for six weeks. The fix was not a better model, it was an eval set built from real tickets, scored by the people who answer them. Here is the harness, the sampling method, and the moment it told us to roll back a launch.",
    speakerId: "tomas-okonkwo",
    coSpeakerIds: [],
    track: "practice",
    format: "Talk",
    minutes: 45,
    level: "practitioner",
    state: "accepted",
  },
  {
    slug: "retrieval-is-a-data-problem-wearing-an-ai-hat",
    title: "Retrieval is a data problem wearing an AI hat",
    abstract:
      "Every retrieval bug we have shipped in two years traced back to something boring: a stale sync, a bad join, a document nobody owned. I will show the four failure classes we now test for, and why our best week of quality improvement involved no model changes at all.",
    speakerId: "marcus-delacroix",
    coSpeakerIds: [],
    track: "platform",
    format: "Talk",
    minutes: 45,
    level: "practitioner",
    state: "accepted",
  },
  {
    slug: "cost-per-resolved-ticket-and-how-we-halved-it",
    title: "Cost per resolved ticket, and how we halved it",
    abstract:
      "The board asks one number. I will show you how we defined it so it could not be gamed, the four levers that moved it, and the one that moved it backwards for a quarter while we argued about attribution.",
    speakerId: "hassan-qureshi",
    coSpeakerIds: [],
    track: "leadership",
    format: "Talk",
    minutes: 30,
    level: "practitioner",
    state: "accepted",
  },
  {
    slug: "reading-40000-clinical-notes-without-reading-any-of-them",
    title: "Reading 40,000 clinical notes without reading any of them",
    abstract:
      "Clinical notes are the richest and least usable data in a hospital. We built a pipeline that surfaces the twelve findings a care team actually acts on, and threw away everything else on purpose. What we validated, what the clinicians vetoed, and the audit trail that made it shippable.",
    speakerId: "lucia-berrigan",
    coSpeakerIds: [],
    track: "practice",
    format: "Talk",
    minutes: 45,
    level: "deep",
    state: "accepted",
  },
  {
    slug: "paging-is-a-product-decision",
    title: "Paging is a product decision",
    abstract:
      "Every alert is a promise that someone will do something. We audited 1,100 alerts against that test and deleted 700 of them. Twelve months of on-call data before and after, plus the argument I lost about severity levels.",
    speakerId: "ben-halloran",
    coSpeakerIds: [],
    track: "practice",
    format: "Talk",
    minutes: 30,
    level: "practitioner",
    state: "accepted",
  },
  {
    slug: "we-deleted-our-vector-database-and-nothing-broke",
    title: "We deleted our vector database and nothing broke",
    abstract:
      "We ran a vector store in production for fourteen months. In March we replaced it with Postgres and a well-chosen index, cut p99 by 60% and our bill by more than that. This is the honest version, including the two use cases where it was the wrong call.",
    speakerId: "yuki-tanabe",
    coSpeakerIds: [],
    track: "platform",
    format: "Talk",
    minutes: 30,
    level: "deep",
    state: "accepted",
  },
  {
    slug: "docs-as-the-first-agent-surface",
    title: "Docs as the first agent surface",
    abstract:
      "A working session. Bring a page of your own documentation and we will restructure it so a model can act on it without guessing — headings that carry contracts, examples that are runnable, and the negative space that stops an agent inventing an endpoint you do not have.",
    speakerId: "nia-fitzgerald",
    coSpeakerIds: [],
    track: "practice",
    format: "Workshop",
    minutes: 90,
    level: "practitioner",
    state: "accepted",
  },
  {
    slug: "from-notebook-to-on-call-in-ninety-days",
    title: "From notebook to on-call in ninety days",
    abstract:
      "Six researchers, one production deadline, and no platform team. What we automated first, what we deliberately left manual, and the week in the middle where everything felt worse than when we started.",
    speakerId: "sofia-marchetti",
    coSpeakerIds: [],
    track: "platform",
    format: "Talk",
    minutes: 45,
    level: "practitioner",
    state: "accepted",
  },
  {
    slug: "guardrails-that-do-not-get-in-the-way",
    title: "Guardrails that do not get in the way",
    abstract:
      "Our agents touch inventory for 1,200 stores. The guardrail layer has never paged anyone, which took three rewrites. I will show the interface, the two rules that catch 90% of it, and how we test the thing that is supposed to never fire.",
    speakerId: "jonah-wexler",
    coSpeakerIds: [],
    track: "platform",
    format: "Talk",
    minutes: 30,
    level: "deep",
    state: "accepted",
  },
  {
    slug: "small-models-boring-wins",
    title: "Small models, boring wins",
    abstract:
      "Three claims workflows where the small model was better, cheaper and easier to defend to a regulator. Fifteen minutes, three graphs, no benchmarks.",
    speakerId: "amara-nwosu",
    coSpeakerIds: [],
    track: "practice",
    format: "Lightning talk",
    minutes: 15,
    level: "intro",
    state: "accepted",
  },
  {
    slug: "the-migration-we-did-twice",
    title: "The migration we did twice",
    abstract:
      "The first migration was technically correct and organisationally impossible. The second one moved less and worked. What we would test for before starting a third.",
    speakerId: "rowan-petrenko",
    coSpeakerIds: [],
    track: "platform",
    format: "Talk",
    minutes: 30,
    level: "practitioner",
    state: "accepted",
  },
  {
    slug: "hiring-for-judgment-when-the-code-writes-itself",
    title: "Hiring for judgment when the code writes itself",
    abstract:
      "I have hired 200 engineers in four years and rewritten the loop twice. What we screen for now, what we stopped screening for, and the interview question that turned out to predict nothing at all.",
    speakerId: "elena-vasquez",
    coSpeakerIds: [],
    track: "leadership",
    format: "Talk",
    minutes: 45,
    level: "intro",
    state: "accepted",
  },
  {
    slug: "three-failed-rollouts-before-the-one-that-stuck",
    title: "Three failed rollouts before the one that stuck",
    abstract:
      "Same tooling, four companies, three failures. The failures rhyme: a sponsor without a budget, a metric nobody owned, and a pilot group who were already convinced. What the fourth one did differently in its first three weeks.",
    speakerId: "dev-chaudhary",
    coSpeakerIds: [],
    track: "leadership",
    format: "Talk",
    minutes: 30,
    level: "intro",
    state: "accepted",
  },
  {
    slug: "why-our-fastest-team-writes-the-most-tests",
    title: "Why our fastest team writes the most tests",
    abstract:
      "We measured it expecting the opposite. Eighteen months of data across nine teams, what the correlation actually is, and the two confounders I could not eliminate.",
    speakerId: "kwame-asante",
    coSpeakerIds: [],
    track: "practice",
    format: "Talk",
    minutes: 30,
    level: "practitioner",
    state: "accepted",
  },
  {
    slug: "workshop-building-an-eval-set-from-your-own-tickets",
    title: "Workshop: building an eval set from your own tickets",
    abstract:
      "Bring 50 real support tickets on a laptop. In ninety minutes you will leave with a scored eval set, a rubric your team can argue with, and a harness that runs it. Laptops required; we will not be watching slides.",
    speakerId: "tomas-okonkwo",
    coSpeakerIds: ["lucia-berrigan"],
    track: "practice",
    format: "Workshop",
    minutes: 90,
    level: "practitioner",
    state: "accepted",
  },
  {
    /* THE CANCELLED ONE. Accepted, notified, placed Fri 11:30 Studio, then
       called off — struck through in place, room released, tasks stood down.
       Ben still gives "Paging is a product decision" on the Thursday. */
    slug: "nobody-notices-latency-until-they-do",
    title: "Nobody notices latency until they do",
    abstract:
      "The p99 that nobody complained about for a year, and the product change that made 400ms suddenly unacceptable. How we found the threshold, and why it moved.",
    speakerId: "ben-halloran",
    coSpeakerIds: [],
    track: "platform",
    format: "Talk",
    minutes: 30,
    level: "practitioner",
    state: "accepted",
  },
  {
    slug: "panel-what-we-would-not-automate-again",
    title: "Panel: what we would not automate again",
    abstract:
      "Three engineers who each shipped something they later pulled back. Moderated, unrehearsed, with a rule: every claim needs a number or a story, not both.",
    speakerId: "kwame-asante",
    coSpeakerIds: ["yuki-tanabe", "sofia-marchetti"],
    track: "leadership",
    format: "Panel",
    minutes: 45,
    level: "intro",
    state: "accepted",
  },
  {
    slug: "contracts-not-prompts",
    title: "Contracts, not prompts",
    abstract:
      "We stopped versioning prompts and started versioning the contract between the caller and the model: inputs, guarantees, failure modes, and what the caller must do when it breaks. Two years of migration pain, avoided.",
    speakerId: "ingrid-solheim",
    coSpeakerIds: [],
    track: "platform",
    format: "Talk",
    minutes: 45,
    level: "deep",
    state: "accepted",
  },
  {
    slug: "what-the-schedule-does-not-tell-you",
    title: "What the schedule does not tell you",
    abstract:
      "A closing note on the eleven conversations in the hallway that were better than the talks, and how to engineer for more of them next year.",
    speakerId: "nia-fitzgerald",
    coSpeakerIds: [],
    track: "leadership",
    format: "Lightning talk",
    minutes: 15,
    level: "intro",
    state: "accepted",
  },

  /* --- accepted · told this morning, still to be placed (4) --- */
  {
    slug: "the-build-we-could-not-reproduce",
    title: "The build we could not reproduce",
    abstract:
      "A quarter of our engineers could not rebuild last month's release from source. Finding out why turned into a policy change, a build-cache rewrite and one very uncomfortable audit conversation.",
    speakerId: "adaeze-okereke",
    coSpeakerIds: [],
    track: "platform",
    format: "Talk",
    minutes: 30,
    level: "practitioner",
    state: "accepted",
  },
  {
    slug: "forecasting-demand-when-the-data-lies",
    title: "Forecasting demand when the data lies",
    abstract:
      "Nine hundred stores, four years of history, and a two-year gap where the numbers mean something different. How we model a known lie without pretending it is not there.",
    speakerId: "mei-lin-chow",
    coSpeakerIds: [],
    track: "platform",
    format: "Talk",
    minutes: 45,
    level: "deep",
    state: "accepted",
  },
  {
    slug: "turning-off-the-pilot-nobody-used",
    title: "Turning off the pilot nobody used",
    abstract:
      "It had a sponsor, a budget and a launch email. It had eleven weekly users out of 900. This is how we killed it without burning the sponsor, and what we did with the money.",
    speakerId: "idris-bello",
    coSpeakerIds: [],
    track: "leadership",
    format: "Talk",
    minutes: 30,
    level: "intro",
    state: "accepted",
  },
  {
    slug: "budgeting-for-a-thing-that-gets-cheaper-every-quarter",
    title: "Budgeting for a thing that gets cheaper every quarter",
    abstract:
      "Every planning cycle assumes costs go up. Ours fall 40% a year and that breaks the process in three specific ways. What we changed in finance, not in engineering.",
    speakerId: "hannah-ostrowski",
    coSpeakerIds: [],
    track: "leadership",
    format: "Talk",
    minutes: 45,
    level: "intro",
    state: "accepted",
  },

  /* --- waitlisted · decided, not told (4) --- */
  {
    slug: "the-runbook-nobody-read",
    title: "The runbook nobody read",
    abstract:
      "We audited every runbook at Beacon against the last 200 incidents. Eleven were used. The rest were documentation theatre and we deleted them in one afternoon.",
    speakerId: "callum-fraser",
    coSpeakerIds: [],
    track: "practice",
    format: "Talk",
    minutes: 30,
    level: "practitioner",
    state: "waitlisted",
  },
  {
    slug: "config-drift-is-a-people-problem",
    title: "Config drift is a people problem",
    abstract:
      "Four environments, one intended configuration, and eighteen months of small human decisions. How we made drift visible without adding a gate anyone would route around.",
    speakerId: "greta-lindholm",
    coSpeakerIds: [],
    track: "platform",
    format: "Talk",
    minutes: 30,
    level: "practitioner",
    state: "waitlisted",
  },
  {
    slug: "postmortems-written-for-the-wrong-reader",
    title: "Postmortems written for the wrong reader",
    abstract:
      "Most incident write-ups are written for the author's manager. We rewrote ours for the engineer who will hit it next, and the format changed completely.",
    speakerId: "anouk-devries",
    coSpeakerIds: [],
    track: "practice",
    format: "Talk",
    minutes: 30,
    level: "practitioner",
    state: "waitlisted",
  },
  {
    slug: "ninety-minutes-to-first-deploy",
    title: "Ninety minutes to first deploy",
    abstract:
      "A new hire's first deploy took nine days when I started measuring. It now takes ninety minutes. Fifteen minutes on the six things that were in the way.",
    speakerId: "bea-thornton",
    coSpeakerIds: [],
    track: "platform",
    format: "Lightning talk",
    minutes: 15,
    level: "intro",
    state: "waitlisted",
  },

  /* --- rejected · decided, not told (4) --- */
  {
    slug: "agentic-workflows-for-the-modern-enterprise",
    title: "Agentic workflows for the modern enterprise",
    abstract:
      "A survey of agentic architectures and how organisations can position themselves for the coming shift in enterprise automation.",
    speakerId: "viktor-novak",
    coSpeakerIds: [],
    track: "platform",
    format: "Talk",
    minutes: 45,
    level: "intro",
    state: "rejected",
  },
  {
    slug: "how-our-platform-can-help-your-team-ship-faster",
    title: "How our platform can help your team ship faster",
    abstract:
      "An overview of the tooling landscape, with reference to the deployment platform we build at Uptown.",
    speakerId: "samir-haddad",
    coSpeakerIds: [],
    track: "platform",
    format: "Talk",
    minutes: 30,
    level: "intro",
    state: "rejected",
  },
  {
    slug: "the-claims-model-we-retired-on-purpose",
    title: "The claims model we retired on purpose",
    abstract:
      "We built a claims triage model that worked and turned it off after eleven months. The reasons were regulatory, not technical, and I think they generalise.",
    speakerId: "priya-raghunathan",
    coSpeakerIds: [],
    track: "practice",
    format: "Talk",
    minutes: 30,
    level: "practitioner",
    state: "rejected",
  },
  {
    slug: "deployment-as-a-stopwatch",
    title: "Deployment as a stopwatch",
    abstract:
      "We timed every step between merge and production and cut the total by two thirds. Mostly by removing approvals nobody could justify.",
    speakerId: "freya-lindgren",
    coSpeakerIds: [],
    track: "practice",
    format: "Talk",
    minutes: 30,
    level: "practitioner",
    state: "rejected",
  },

  /* --- submitted · still undecided (6) --- */
  {
    slug: "underwriting-rules-as-code",
    title: "Underwriting rules as code",
    abstract:
      "Two thousand underwriting rules lived in a document that four people understood. Moving them into code was the easy part; deciding who is allowed to change them took a year.",
    speakerId: "priya-raghunathan",
    coSpeakerIds: [],
    track: "platform",
    format: "Talk",
    minutes: 45,
    level: "practitioner",
    state: "submitted",
  },
  {
    slug: "the-chaos-suite-everyone-complains-about",
    title: "The chaos suite everyone complains about",
    abstract:
      "Trident runs chaos tests in production on Thursday afternoons. Nobody likes it. Nobody will let me turn it off. Here is what four years of data says about why.",
    speakerId: "theo-vandermeer",
    coSpeakerIds: [],
    track: "practice",
    format: "Talk",
    minutes: 30,
    level: "practitioner",
    state: "submitted",
  },
  {
    slug: "quarterly-to-daily-in-a-hospital-system",
    title: "Quarterly to daily in a hospital system",
    abstract:
      "Regulated, risk-averse, and now deploying every day. What the compliance conversation actually looked like, and the two controls we added rather than removed.",
    speakerId: "imani-clarke",
    coSpeakerIds: [],
    track: "leadership",
    format: "Talk",
    minutes: 45,
    level: "practitioner",
    state: "submitted",
  },
  {
    slug: "what-the-auditors-taught-us-about-logging",
    title: "What the auditors taught us about logging",
    abstract:
      "Our audit trail was built for engineers and useless to auditors. Rebuilding it for them made it better for us, which I did not expect.",
    speakerId: "anya-kowalczyk",
    coSpeakerIds: [],
    track: "platform",
    format: "Talk",
    minutes: 30,
    level: "practitioner",
    state: "submitted",
  },
  {
    slug: "the-twelve-services-that-stayed-on-the-mainframe",
    title: "The twelve services that stayed on the mainframe",
    abstract:
      "We moved 400 services off. Twelve did not go, on purpose, and the case for leaving them is the most useful thing I learned.",
    speakerId: "luis-moreira",
    coSpeakerIds: [],
    track: "platform",
    format: "Talk",
    minutes: 45,
    level: "practitioner",
    state: "submitted",
  },
  {
    slug: "alert-fatigue-at-a-utility",
    title: "Alert fatigue at a utility",
    abstract:
      "Keeping the lights on means a lot of alerts. Cutting them means a different kind of risk. How we made that trade explicit and who signed it.",
    speakerId: "omar-siddiqui",
    coSpeakerIds: [],
    track: "practice",
    format: "Talk",
    minutes: 30,
    level: "practitioner",
    state: "submitted",
  },
];

/** The accepted session that was later called off. Struck through in place. */
export const CANCELLED_SESSION_SLUG = "nobody-notices-latency-until-they-do";

/**
 * The crafted grid for the 22 hand-written sessions that were placed first.
 * Advisory, not law: the expander owns placement for all 60 accepted sessions
 * and will need more rooms or more slots than these two days hold (the
 * prototype's grid is 4 rooms across 11 slots = 44 places).
 */
export type AiePlacement = {
  slug: string;
  day: "thu" | "fri";
  time: string;
  room: "Ballroom A" | "Ballroom B" | "Studio" | "Loft";
};

export const AIE_PLACEMENTS: AiePlacement[] = [
  { slug: "the-year-the-tooling-caught-up", day: "thu", time: "09:30", room: "Ballroom A" },
  { slug: "what-the-incident-taught-us-about-queues", day: "thu", time: "09:30", room: "Ballroom B" },
  { slug: "claims-agents-three-rollouts-one-that-stuck", day: "thu", time: "10:30", room: "Ballroom A" },
  { slug: "the-eval-suite-that-finally-told-us-the-truth", day: "thu", time: "10:30", room: "Studio" },
  { slug: "retrieval-is-a-data-problem-wearing-an-ai-hat", day: "thu", time: "11:30", room: "Ballroom A" },
  { slug: "cost-per-resolved-ticket-and-how-we-halved-it", day: "thu", time: "11:30", room: "Ballroom B" },
  { slug: "reading-40000-clinical-notes-without-reading-any-of-them", day: "thu", time: "11:30", room: "Studio" },
  { slug: "paging-is-a-product-decision", day: "thu", time: "14:00", room: "Ballroom B" },
  { slug: "we-deleted-our-vector-database-and-nothing-broke", day: "thu", time: "14:00", room: "Studio" },
  { slug: "docs-as-the-first-agent-surface", day: "thu", time: "14:00", room: "Loft" },
  { slug: "from-notebook-to-on-call-in-ninety-days", day: "thu", time: "15:00", room: "Ballroom A" },
  { slug: "guardrails-that-do-not-get-in-the-way", day: "thu", time: "15:00", room: "Studio" },
  { slug: "small-models-boring-wins", day: "thu", time: "16:00", room: "Loft" },
  { slug: "the-migration-we-did-twice", day: "thu", time: "16:00", room: "Ballroom B" },
  { slug: "hiring-for-judgment-when-the-code-writes-itself", day: "fri", time: "09:30", room: "Ballroom A" },
  { slug: "three-failed-rollouts-before-the-one-that-stuck", day: "fri", time: "10:30", room: "Ballroom A" },
  { slug: "why-our-fastest-team-writes-the-most-tests", day: "fri", time: "10:30", room: "Ballroom B" },
  { slug: "workshop-building-an-eval-set-from-your-own-tickets", day: "fri", time: "11:30", room: "Loft" },
  { slug: "nobody-notices-latency-until-they-do", day: "fri", time: "11:30", room: "Studio" },
  { slug: "panel-what-we-would-not-automate-again", day: "fri", time: "14:00", room: "Ballroom A" },
  { slug: "contracts-not-prompts", day: "fri", time: "14:00", room: "Studio" },
  { slug: "what-the-schedule-does-not-tell-you", day: "fri", time: "15:00", room: "Ballroom A" },
];

/* ============================================================
   The expansion kit
   ============================================================

   Fragments for deterministic combinatorial expansion to the remaining ~960
   proposals. Grammar is the contract here, so every combination reads like a
   person wrote it:

     - no shape begins with a slot, so nothing needs capitalising after the
       fact and no sentence starts lowercase;
     - every {domain} reads after "in", "for" and "across", and works as the
       subject of "taught us";
     - every {artifact} is a singular definite noun phrase, so verb agreement
       holds in "what {artifact} actually costs";
     - every {outcome} is a past-tense clause, so it completes "and {outcome}",
       "the week {outcome}" and "the quarter in which {outcome}".

   Spot-check: "What clinical-notes triage taught us about our retry queue" ·
   "We rebuilt the audit trail for a regulated insurer, and the audit passed
   first time" · "Inside port logistics: what the golden dataset actually
   costs".

   Two abstractShapes carry a format in their voice and should be gated to it:
   index 7 ("This is a working session, not slides") belongs to Workshop, and
   index 9 ("A short one, with three graphs") belongs to Lightning talk. The
   other ten fit any format.
*/

export type ExpansionKit = {
  titleShapes: string[];
  domains: string[];
  artifacts: string[];
  outcomes: string[];
  abstractShapes: string[];
};

export const EXPANSION: ExpansionKit = {
  titleShapes: [
    "What {domain} taught us about {artifact}",
    "We rebuilt {artifact} for {domain}, and {outcome}",
    "The year {artifact} stopped being the bottleneck in {domain}",
    "Inside {domain}: what {artifact} actually costs",
    "How {artifact} survived {domain}",
    "Two years with {artifact} in {domain}, and the numbers to show for it",
    "Why we stopped defending {artifact} in {domain}",
    "One bad quarter in {domain}, and what it did to {artifact}",
    "Rebuilding {artifact} around {domain}",
    "Before you buy anything: {artifact} in {domain}",
    "The unglamorous version of {artifact} in {domain}",
    "We took {artifact} apart in {domain} and {outcome}",
    "Everything we got wrong about {artifact} in {domain}",
    "Nobody owned {artifact} in {domain}",
    "Six months of {domain}, one rewrite of {artifact}",
    "The case for leaving {artifact} alone in {domain}",
    "We measured {artifact} across {domain} and {outcome}",
    "The quiet cost of {artifact} in {domain}",
  ],
  domains: [
    "claims processing",
    "clinical-notes triage",
    "a 900-store grocery chain",
    "a 12,000-person bank",
    "freight dispatch",
    "prior-authorisation review",
    "a regional hospital system",
    "utility outage response",
    "a two-person platform team",
    "mortgage underwriting",
    "warehouse replenishment",
    "a 60-team engineering org",
    "fraud review",
    "call-centre quality scoring",
    "a public transit agency",
    "contract redlining",
    "airline crew scheduling",
    "a four-region payments network",
    "onboarding for new hires",
    "invoice reconciliation",
    "a regulated insurer",
    "supply-chain forecasting",
    "field-service dispatch",
    "a 200-service monolith split",
    "student-records migration",
    "energy-grid telemetry",
    "pharmacy stock control",
    "a newsroom on deadline",
    "tax-document intake",
    "a rural broadband rollout",
    "loan servicing",
    "veterinary practice software",
    "a 40-person data team",
    "port logistics",
    "benefits enrolment",
    "a two-sided freight marketplace",
  ],
  artifacts: [
    "the eval set",
    "our retry queue",
    "the on-call rota",
    "the staging environment",
    "our incident review",
    "the model gateway",
    "the feature store",
    "our deploy pipeline",
    "the audit trail",
    "the guardrail layer",
    "our retrieval index",
    "the cost dashboard",
    "the schema migration",
    "the runbook library",
    "the review process",
    "our alerting policy",
    "the golden dataset",
    "the batch layer",
    "the escalation path",
    "the ingestion pipeline",
    "our design system",
    "the release train",
    "our test suite",
    "the prompt library",
    "the service catalogue",
    "our caching layer",
    "the handover document",
    "our rollback plan",
    "the data contract",
    "the observability stack",
    "the access review",
    "the load test",
    "our feature-flag system",
    "the intake form",
    "the scoring rubric",
  ],
  outcomes: [
    "nothing broke",
    "the bill halved",
    "p99 fell by 60%",
    "nobody noticed",
    "we got our Fridays back",
    "the graph finally moved",
    "onboarding got shorter",
    "the pager went quiet",
    "the audit passed first time",
    "the backlog stopped growing",
    "two teams merged",
    "the escalations halved",
    "the rewrite paid for itself",
    "we deleted a service",
    "the handover took an hour",
    "the number stopped lying",
    "the dashboard finally matched reality",
    "the on-call rota shrank to five",
    "we shipped on a Friday and slept",
    "the finance team stopped asking",
    "the queue drained in nine minutes",
    "the model got smaller",
    "nobody had to be woken up",
    "we won the argument with data",
  ],
  abstractShapes: [
    "We ran {artifact} in {domain} for two years before anyone measured it. When we finally did, {outcome} — and the reason was not the one anyone had bet on. This talk is the measurement, the argument it started, and what we changed the quarter after.",
    "Everyone in {domain} tells you {artifact} is the boring part. It is, until it takes a launch down. Here is what we instrumented, the two failure classes we now test for, and the week {outcome}.",
    "This is the version with the numbers in it. Three attempts at {artifact} in {domain}, two of which we rolled back, and a third where {outcome}. I will show the data we used to tell them apart.",
    "We inherited {artifact} from a team that no longer exists, and {domain} would not wait for us to understand it. Nine months later {outcome}. What we wrote down first, what we deleted, and the one decision I would take back.",
    "The honest report on {artifact} in {domain}: what it cost, what it bought, and where we are still doing it by hand. It ends in the quarter in which {outcome}, but the interesting part is the six weeks before that, when it looked like a mistake.",
    "Nobody signs off on {artifact} until it fails in front of a customer. Ours did, in {domain}, on a Thursday. This is the timeline, the fix that held, and the part that surprised the executives: {outcome}.",
    "We measured {artifact} across {domain} expecting to confirm what we already believed. The data said the opposite, and in the end {outcome}. We spent a quarter arguing about why, and both sides of that argument are in this talk.",
    "This is a working session, not slides. We will use {domain} as the running example, take {artifact} apart on your own laptop, and rebuild the two pieces that carry the weight. Teams who have done this with us report that {outcome}.",
    "Two years ago {artifact} was a spreadsheet and {domain} was somebody else's problem. Both changed. This talk is what we built in between, what it cost us to keep, and the week {outcome}.",
    "A short one, with three graphs. What {artifact} looked like in {domain} before, what it looks like now, and the single change after which {outcome}.",
    "We were told {artifact} could not be touched while {domain} was live. It could, twice, and the second time {outcome}. The talk is the sequencing, the rollback we never needed, and the two checks that made it safe to try.",
    "Half of what we believed about {artifact} came from a benchmark and half from {domain} itself. Only one half survived contact. Here is how we found out, what it cost to find out late, and the day {outcome}.",
  ],
};

/* ============================================================
   DevOps Days Charlotte 2025 — the past event (6–7 November 2025)
   ============================================================

   Fourteen placed sessions, agenda published, all speakers told on 6 Aug 2025.
   Exactly eight carry a recording. Exactly one was cancelled on the day and
   still sits on the agenda, struck through, because that is what happened.
   Because these end times are in the past, Were you there? / Saw it / Missed
   it / Catch up are all walkable by a judge today.
*/

export type CharlotteSession = {
  slug: string;
  title: string;
  abstract: string;
  speakerId: string;
  track: "delivery" | "reliability";
  format: "Talk" | "Lightning talk" | "Workshop";
  minutes: number;
  day: "thu" | "fri";
  time: string;
  room: "Main hall" | "Workshop room";
  recordingUrl: string | null;
  cancelled: boolean;
};

export const CHARLOTTE_SESSIONS: CharlotteSession[] = [
  {
    slug: "fifteen-years-of-one-deployment-pipeline",
    title: "Fifteen years of one deployment pipeline",
    abstract:
      "Piedmont's pipeline predates most of the team. We did not replace it. We wrote down what it actually does, deleted the four steps nobody could explain, and made it survivable for the next hire.",
    speakerId: "greta-lindholm",
    track: "delivery",
    format: "Talk",
    minutes: 30,
    day: "thu",
    time: "09:30",
    room: "Main hall",
    recordingUrl: "https://videos.example.org/ddc-clt-2025/fifteen-years-one-pipeline",
    cancelled: false,
  },
  {
    slug: "docs-as-the-first-agent-surface",
    title: "Docs as the first agent surface",
    abstract:
      "A working session on restructuring documentation so a machine can act on it without guessing. Bring a page of your own.",
    speakerId: "nia-fitzgerald",
    track: "delivery",
    format: "Workshop",
    minutes: 90,
    day: "thu",
    time: "09:30",
    room: "Workshop room",
    recordingUrl: null,
    cancelled: false,
  },
  {
    slug: "cutting-alerts-at-a-utility-without-cutting-the-lights",
    title: "Cutting alerts at a utility without cutting the lights",
    abstract:
      "A utility cannot simply page less. We removed 60% of alerts and added two, and the argument about which two took four months.",
    speakerId: "omar-siddiqui",
    track: "reliability",
    format: "Talk",
    minutes: 30,
    day: "thu",
    time: "10:30",
    room: "Main hall",
    recordingUrl: "https://videos.example.org/ddc-clt-2025/cutting-alerts-at-a-utility",
    cancelled: false,
  },
  {
    slug: "the-twelve-services-that-stayed",
    title: "The twelve services that stayed",
    abstract:
      "We moved 400 services off the mainframe. Twelve stayed on purpose. The case for leaving them is the most useful part of the project.",
    speakerId: "luis-moreira",
    track: "delivery",
    format: "Talk",
    minutes: 45,
    day: "thu",
    time: "11:30",
    room: "Main hall",
    recordingUrl: "https://videos.example.org/ddc-clt-2025/the-twelve-services-that-stayed",
    cancelled: false,
  },
  {
    slug: "ninety-minutes-to-first-deploy",
    title: "Ninety minutes to first deploy",
    abstract:
      "A new hire's first deploy took nine days when I started measuring it. Six changes later it takes ninety minutes and none of them were tooling purchases.",
    speakerId: "bea-thornton",
    track: "delivery",
    format: "Talk",
    minutes: 30,
    day: "thu",
    time: "11:30",
    room: "Workshop room",
    recordingUrl: "https://videos.example.org/ddc-clt-2025/ninety-minutes-to-first-deploy",
    cancelled: false,
  },
  {
    slug: "postmortems-for-the-engineer-who-hits-it-next",
    title: "Postmortems for the engineer who hits it next",
    abstract:
      "We rewrote our incident format for a different reader and the write-ups got shorter, later and far more used.",
    speakerId: "anouk-devries",
    track: "reliability",
    format: "Talk",
    minutes: 30,
    day: "thu",
    time: "14:00",
    room: "Main hall",
    recordingUrl: "https://videos.example.org/ddc-clt-2025/postmortems-for-the-next-engineer",
    cancelled: false,
  },
  {
    slug: "deployment-as-a-stopwatch",
    title: "Deployment as a stopwatch",
    abstract:
      "We timed every step between merge and production. Fifteen minutes on the three approvals we could not justify and removed.",
    speakerId: "freya-lindgren",
    track: "delivery",
    format: "Lightning talk",
    minutes: 15,
    day: "thu",
    time: "14:00",
    room: "Workshop room",
    recordingUrl: null,
    cancelled: false,
  },
  {
    slug: "thursday-afternoon-chaos",
    title: "Thursday afternoon chaos",
    abstract:
      "Trident runs chaos tests in production every Thursday. Four years of data on whether the complaints or the results are right.",
    speakerId: "theo-vandermeer",
    track: "reliability",
    format: "Talk",
    minutes: 30,
    day: "thu",
    time: "15:00",
    room: "Main hall",
    recordingUrl: "https://videos.example.org/ddc-clt-2025/thursday-afternoon-chaos",
    cancelled: false,
  },
  {
    slug: "publishing-uncertainty",
    title: "Publishing uncertainty",
    abstract:
      "A transit feed that says a bus is coming when it is not is worse than no feed. What we changed about how we publish confidence.",
    speakerId: "desmond-oyelaran",
    track: "reliability",
    format: "Lightning talk",
    minutes: 15,
    day: "thu",
    time: "15:00",
    room: "Workshop room",
    recordingUrl: null,
    cancelled: false,
  },
  {
    slug: "the-same-migration-in-three-regulated-industries",
    title: "The same migration in three regulated industries",
    abstract:
      "Banking, healthcare, energy. Same architecture, three completely different approval paths, and one lesson that transferred.",
    speakerId: "samir-haddad",
    track: "delivery",
    format: "Talk",
    minutes: 30,
    day: "fri",
    time: "09:30",
    room: "Main hall",
    recordingUrl: null,
    cancelled: false,
  },
  {
    slug: "quarterly-to-daily-in-a-hospital-system",
    title: "Quarterly to daily in a hospital system",
    abstract:
      "Regulated, risk-averse, and now deploying every day. The compliance conversation, in full, including the parts where I was wrong.",
    speakerId: "imani-clarke",
    track: "delivery",
    format: "Talk",
    minutes: 45,
    day: "fri",
    time: "10:30",
    room: "Main hall",
    recordingUrl: "https://videos.example.org/ddc-clt-2025/quarterly-to-daily",
    cancelled: false,
  },
  {
    slug: "what-the-auditors-taught-us-about-logging",
    title: "What the auditors taught us about logging",
    abstract:
      "Our audit trail was built for engineers and useless to auditors. Rebuilding it for them made it better for us.",
    speakerId: "anya-kowalczyk",
    track: "reliability",
    format: "Talk",
    minutes: 30,
    day: "fri",
    time: "10:30",
    room: "Workshop room",
    recordingUrl: null,
    cancelled: false,
  },
  {
    /* Cancelled on the Friday morning — the speaker's flight never left.
       Still on the agenda, struck through, because it happened that way. */
    slug: "kubernetes-before-it-was-reasonable",
    title: "Kubernetes before it was reasonable",
    abstract:
      "Nine years of running it in an energy company. What I would keep, what I would never do again, and the two versions that cost me a summer.",
    speakerId: "viktor-novak",
    track: "reliability",
    format: "Talk",
    minutes: 30,
    day: "fri",
    time: "11:30",
    room: "Main hall",
    recordingUrl: null,
    cancelled: true,
  },
  {
    slug: "paging-is-a-product-decision",
    title: "Paging is a product decision",
    abstract:
      "Every alert is a promise that someone will do something. We audited 1,100 alerts against that test and deleted 700.",
    speakerId: "ben-halloran",
    track: "reliability",
    format: "Talk",
    minutes: 30,
    day: "fri",
    time: "14:00",
    room: "Main hall",
    recordingUrl: "https://videos.example.org/ddc-clt-2025/paging-is-a-product-decision",
    cancelled: false,
  },
];

/** The Charlotte session that was called off on the day. */
export const CHARLOTTE_CANCELLED_SLUG = "kubernetes-before-it-was-reasonable";

/* ============================================================
   What people asked — the Studio loop's starting pile
   ============================================================

   Fifteen real questions, already asked, across the three scopes. Two are
   still unanswered and that is the point: the parking one has been asked nine
   times and nobody has written the sentence yet.
*/

export const SEED_QUESTIONS: {
  scope: "public" | "speaker" | "organizer";
  text: string;
  timesAsked: number;
  answered: boolean;
}[] = [
  { scope: "public", text: "Is there parking at the venue?", timesAsked: 9, answered: false },
  { scope: "public", text: "Will the talks be recorded?", timesAsked: 22, answered: true },
  { scope: "public", text: "Is lunch included, and can you do gluten free?", timesAsked: 17, answered: true },
  { scope: "public", text: "What time can I pick up my badge on the first day?", timesAsked: 14, answered: true },
  { scope: "public", text: "Which sessions are good if I am new to this?", timesAsked: 11, answered: true },
  { scope: "public", text: "Is there a quiet room?", timesAsked: 6, answered: true },
  { scope: "public", text: "How do I get to Pier 57 from the airport?", timesAsked: 5, answered: true },
  { scope: "public", text: "Can I pass my ticket to a colleague?", timesAsked: 4, answered: true },
  { scope: "speaker", text: "When do I find out whether my talk was accepted?", timesAsked: 31, answered: true },
  { scope: "speaker", text: "Can I edit my proposal after I send it?", timesAsked: 19, answered: true },
  { scope: "speaker", text: "What format do you want the slides in?", timesAsked: 12, answered: true },
  { scope: "speaker", text: "Do you cover travel for speakers?", timesAsked: 8, answered: false },
  { scope: "speaker", text: "How long is my talk, exactly, and does that include questions?", timesAsked: 7, answered: true },
  { scope: "organizer", text: "Where do I see who has not been told yet?", timesAsked: 5, answered: true },
  { scope: "organizer", text: "How do I take a session off the agenda without deleting it?", timesAsked: 2, answered: true },
];

/* ============================================================
   The call's question set — AI Engineer New York 2026
   ============================================================

   Everything the organizer added on top of the core fields (title, abstract,
   track, format, level, name, organisation, email). Editable data on Event per
   R-10: label, hint, required, options, one show-if, position.
*/

export const CFP_QUESTIONS: {
  id: string;
  kind: "short" | "long" | "select" | "checkbox";
  label: string;
  hint: string | null;
  required: boolean;
  options: string[] | null;
  showIf: { questionId: string; equals: string } | null;
  position: number;
}[] = [
  {
    id: "takeaway",
    kind: "long",
    label: "What will people leave with?",
    hint: "One real number says more than three adjectives.",
    required: true,
    options: null,
    showIf: null,
    position: 1,
  },
  {
    id: "travelling-from",
    kind: "short",
    label: "Where would you travel from?",
    hint: "We do not pay for flights, but knowing the time zone stops us putting you on stage at 09:30 after a red-eye.",
    required: false,
    options: null,
    showIf: null,
    position: 2,
  },
  {
    id: "av-needs",
    kind: "select",
    label: "What do you need in the room?",
    hint: "The crew reads this in September, so be specific now rather than kind.",
    required: true,
    options: [
      "A screen and a clicker",
      "Sound from my laptop",
      "Live internet for a demo",
      "A second screen for a co-presenter",
      "Something else, and I have put it in the note below",
    ],
    showIf: null,
    position: 4,
  },
  {
    id: "workshop-laptops",
    kind: "checkbox",
    label: "Everyone should bring a laptop",
    hint: "We print this on the agenda so nobody turns up empty-handed.",
    required: false,
    options: null,
    showIf: { questionId: "format", equals: "Workshop" },
    position: 5,
  },
  {
    id: "prior-talk",
    kind: "short",
    label: "A talk you have given before",
    hint: "A link, if there is one. Not a requirement — plenty of the best talks here are somebody's first.",
    required: false,
    options: null,
    showIf: null,
    position: 6,
  },
  {
    id: "first-time",
    kind: "checkbox",
    label: "This would be my first conference talk",
    hint: "We keep a few slots for first-time speakers, and we pair you with someone who has done it before.",
    required: false,
    options: null,
    showIf: null,
    position: 7,
  },
  {
    id: "access-needs",
    kind: "long",
    label: "Anything we should know to make the day work for you?",
    hint: "Step-free access to the stage, a chair, an interpreter, food you cannot eat. We would rather sort it in July than in September.",
    required: false,
    options: null,
    showIf: null,
    position: 8,
  },
  {
    id: "committee-note",
    kind: "long",
    label: "Note to the committee",
    hint: "Only the committee ever reads this. Deadlines, travel, anything we should know.",
    required: false,
    options: null,
    showIf: null,
    position: 9,
  },
  // Last, so it sits against the About you block the form draws next. Optional
  // on purpose: a good proposal should never wait on somebody finding the
  // nerve to write about themselves at 23:50.
  {
    id: "speaker-bio",
    kind: "long",
    label: "A short life",
    hint: "A paragraph a stranger reads before you walk on. Two or three sentences is plenty, and you can rewrite it in your speaker portal whenever you like.",
    required: false,
    options: null,
    showIf: null,
    position: 10,
  },
];

/* ============================================================
   The arithmetic — R-1 made into constants
   ============================================================ */

/** Every non-draft proposal at AI Engineer New York 2026. */
export const AIE_NON_DRAFT_TOTAL = 1000;

/** The closed distribution. Every count on every screen derives from this. */
export const AIE_DISTRIBUTION = {
  accepted: 60,
  waitlisted: 12,
  rejected: 598,
  submitted: 328,
  withdrawn: 2,
  drafts: 8,
} as const;

/** Decided and not yet told: 12 maybe + 598 declined. The 610 is the product. */
export const AIE_DECIDED_NOT_TOLD = 610;

/** What HAND_PROPOSALS already contributes to the distribution. */
export const HAND_STATE_COUNTS = {
  accepted: 26,
  waitlisted: 4,
  rejected: 4,
  submitted: 6,
  withdrawn: 0,
  drafts: 0,
} as const;

/**
 * What the expander must generate to close the arithmetic: 960 more proposals
 * plus the 8 drafts. HAND_STATE_COUNTS + EXPANSION_TARGETS = AIE_DISTRIBUTION,
 * exactly.
 */
export const EXPANSION_TARGETS = {
  accepted: 34,
  waitlisted: 8,
  rejected: 594,
  submitted: 322,
  withdrawn: 2,
  drafts: 8,
} as const;

/** DevOps Days Charlotte 2025, closed and counted. */
export const CHARLOTTE_STATS = { proposals: 84, accepted: 14 } as const;

/** People who hold a proposal at both events. Length is the CRM's headline. */
export const SHARED_SPEAKER_COUNT = 38;
