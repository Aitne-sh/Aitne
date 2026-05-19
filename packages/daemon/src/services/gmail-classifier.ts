/**
 * Gmail email classifier focused on travel bookings and related documents.
 *
 * Finance categories were removed. The classifier now only extracts travel
 * bookings plus unknown emails, while keeping parse-failure reporting for the
 * remaining Gmail pipeline.
 */

export type EmailCategory = "travel" | "kindle_notebook" | "unknown";

export interface ClassifiedEmail {
  messageId: string;
  category: EmailCategory;
  sender: string | null;
  senderDomain: string | null;
  subject: string | null;
  date: string | null;
}

export interface TravelExtraction {
  type: "flight" | "hotel" | "restaurant" | "train" | "bus" | "other";
  provider: string;
  destination: string | null;
  startDate: string | null;
  endDate: string | null;
  confirmationNumber: string | null;
  amount: number | null;
  currency: string;
}

export interface EmailInput {
  messageId: string;
  from: string | null;
  subject: string | null;
  snippet: string;
  date: string | null;
  body: string | null;
}

const TRAVEL_DOMAINS: ReadonlyMap<string, { provider: string; type: TravelExtraction["type"] }> = new Map([
  ["jetblue.com", { provider: "JetBlue", type: "flight" }],
  ["alaskaair.com", { provider: "Alaska Airlines", type: "flight" }],
  ["hawaiianairlines.com", { provider: "Hawaiian Airlines", type: "flight" }],
  ["spirit.com", { provider: "Spirit Airlines", type: "flight" }],
  ["frontier.com", { provider: "Frontier Airlines", type: "flight" }],
  ["jetstar.com", { provider: "Jetstar", type: "flight" }],

  ["united.com", { provider: "United Airlines", type: "flight" }],
  ["delta.com", { provider: "Delta Air Lines", type: "flight" }],
  ["aa.com", { provider: "American Airlines", type: "flight" }],
  ["southwest.com", { provider: "Southwest Airlines", type: "flight" }],
  ["emirates.com", { provider: "Emirates", type: "flight" }],
  ["singaporeair.com", { provider: "Singapore Airlines", type: "flight" }],
  ["cathaypacific.com", { provider: "Cathay Pacific", type: "flight" }],
  ["britishairways.com", { provider: "British Airways", type: "flight" }],
  ["lufthansa.com", { provider: "Lufthansa", type: "flight" }],
  ["klm.com", { provider: "KLM", type: "flight" }],
  ["airfrance.com", { provider: "Air France", type: "flight" }],
  ["ryanair.com", { provider: "Ryanair", type: "flight" }],
  ["easyjet.com", { provider: "easyJet", type: "flight" }],
  ["qantas.com", { provider: "Qantas", type: "flight" }],
  ["aircanada.com", { provider: "Air Canada", type: "flight" }],

  ["marriott.com", { provider: "Marriott", type: "hotel" }],
  ["hilton.com", { provider: "Hilton", type: "hotel" }],
  ["ihg.com", { provider: "IHG", type: "hotel" }],
  ["hyatt.com", { provider: "Hyatt", type: "hotel" }],
  ["wyndhamhotels.com", { provider: "Wyndham", type: "hotel" }],
  ["bestwestern.com", { provider: "Best Western", type: "hotel" }],
  ["accor.com", { provider: "Accor", type: "hotel" }],
  ["choicehotels.com", { provider: "Choice Hotels", type: "hotel" }],

  ["booking.com", { provider: "Booking.com", type: "hotel" }],
  ["hotels.com", { provider: "Hotels.com", type: "hotel" }],
  ["expedia.com", { provider: "Expedia", type: "hotel" }],
  ["agoda.com", { provider: "Agoda", type: "hotel" }],
  ["airbnb.com", { provider: "Airbnb", type: "hotel" }],
  ["vrbo.com", { provider: "Vrbo", type: "hotel" }],
  ["priceline.com", { provider: "Priceline", type: "hotel" }],
  ["kayak.com", { provider: "Kayak", type: "hotel" }],

  ["opentable.com", { provider: "OpenTable", type: "restaurant" }],
  ["resy.com", { provider: "Resy", type: "restaurant" }],
  ["yelp.com", { provider: "Yelp", type: "restaurant" }],
  ["tock.com", { provider: "Tock", type: "restaurant" }],

  ["eurostar.com", { provider: "Eurostar", type: "train" }],
  ["amtrak.com", { provider: "Amtrak", type: "train" }],
  ["bahn.de", { provider: "Deutsche Bahn", type: "train" }],
  ["sncf.com", { provider: "SNCF", type: "train" }],
  ["thetrainline.com", { provider: "Trainline", type: "train" }],
  ["greyhound.com", { provider: "Greyhound", type: "bus" }],
  ["flixbus.com", { provider: "FlixBus", type: "bus" }],
  ["megabus.com", { provider: "Megabus", type: "bus" }],
]);

const TRAVEL_SUBJECT_PATTERNS: readonly RegExp[] = [
  /booking\s+confirm/i,
  /reservation\s+confirm/i,
  /itinerary/i,
  /e-?ticket/i,
  /check-?in/i,
  /check-?out/i,
  /your\s+(?:trip|flight|booking|reservation|stay)/i,
  /seat\s+reserv/i,
];

export function extractSenderDomain(from: string | null): string | null {
  if (!from) return null;
  const match = from.match(/@([^\s>]+)/);
  return match ? match[1].toLowerCase() : null;
}

const KINDLE_NOTEBOOK_SENDER_RE = /(?:^|[@.])(?:kindle\.amazon|amazon)\.(?:com|co\.jp|co\.uk|de|fr|it|es|ca|com\.au|in)$/i;

const KINDLE_NOTEBOOK_SUBJECT_PATTERNS: readonly RegExp[] = [
  /your\s+kindle\s+notebook/i,
  /kindle\s+notes?\s+(?:and\s+highlights?|export)/i,
  /kindle\s+notebook\s+(?:from|for)/i,
];

export function isKindleNotebookEmail(input: {
  senderDomain: string | null;
  subject: string | null;
  snippet: string | null;
}): boolean {
  if (!input.senderDomain || !KINDLE_NOTEBOOK_SENDER_RE.test(input.senderDomain)) {
    return false;
  }
  const searchText = `${input.subject ?? ""} ${input.snippet ?? ""}`;
  return KINDLE_NOTEBOOK_SUBJECT_PATTERNS.some((re) => re.test(searchText));
}

export function classifyEmail(email: EmailInput): ClassifiedEmail {
  const senderDomain = extractSenderDomain(email.from);
  let category: EmailCategory = "unknown";

  if (senderDomain) {
    const searchText = `${email.subject ?? ""} ${email.snippet ?? ""}`;
    if (isKindleNotebookEmail({ senderDomain, subject: email.subject, snippet: email.snippet })) {
      category = "kindle_notebook";
    } else if (
      TRAVEL_DOMAINS.has(senderDomain) &&
      TRAVEL_SUBJECT_PATTERNS.some((pattern) => pattern.test(searchText))
    ) {
      category = "travel";
    }
  }

  return {
    messageId: email.messageId,
    category,
    sender: email.from,
    senderDomain,
    subject: email.subject,
    date: email.date,
  };
}

export function extractTravel(
  email: EmailInput,
  classified: ClassifiedEmail,
): TravelExtraction | null {
  if (classified.category !== "travel" || !classified.senderDomain) {
    return null;
  }

  const text = `${email.subject ?? ""} ${email.snippet ?? ""} ${email.body ?? ""}`;
  const domainInfo = TRAVEL_DOMAINS.get(classified.senderDomain);
  const amountResult = extractAmountWithCurrency(text);

  return {
    type: domainInfo?.type ?? detectTravelType(text),
    provider: domainInfo?.provider ?? classified.senderDomain,
    destination: extractDestination(text),
    startDate: null,
    endDate: null,
    confirmationNumber: extractConfirmationNumber(text),
    amount: amountResult?.amount ?? null,
    currency: amountResult?.currency ?? "USD",
  };
}

export function processEmailBatch(emails: EmailInput[]): {
  travelBookings: Array<{
    email: ClassifiedEmail;
    extraction: TravelExtraction;
  }>;
  kindleNotebooks: ClassifiedEmail[];
  unknown: ClassifiedEmail[];
  parseFailures: Array<{
    messageId: string;
    sender: string | null;
    subject: string | null;
    snippet: string;
    errorReason: string;
  }>;
} {
  const travelBookings: Array<{
    email: ClassifiedEmail;
    extraction: TravelExtraction;
  }> = [];
  const kindleNotebooks: ClassifiedEmail[] = [];
  const unknown: ClassifiedEmail[] = [];
  const parseFailures: Array<{
    messageId: string;
    sender: string | null;
    subject: string | null;
    snippet: string;
    errorReason: string;
  }> = [];

  for (const input of emails) {
    try {
      const classified = classifyEmail(input);

      if (classified.category === "travel") {
        const extraction = extractTravel(input, classified);
        if (extraction) {
          travelBookings.push({ email: classified, extraction });
        } else {
          parseFailures.push({
            messageId: input.messageId,
            sender: input.from,
            subject: input.subject,
            snippet: input.snippet.slice(0, 500),
            errorReason: "travel_extraction_failed",
          });
        }
      } else if (classified.category === "kindle_notebook") {
        kindleNotebooks.push(classified);
      } else {
        unknown.push(classified);
      }
    } catch (err) {
      parseFailures.push({
        messageId: input.messageId,
        sender: input.from,
        subject: input.subject,
        snippet: input.snippet.slice(0, 500),
        errorReason: `classification_error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return { travelBookings, kindleNotebooks, unknown, parseFailures };
}

export function extractAmountWithCurrency(
  text: string,
): { amount: number; currency: string } | null {
  for (const m of text.matchAll(/\$\s*([\d,.]+)/g)) {
    const dollars = parseFloat(m[1].replace(/,/g, ""));
    if (!isNaN(dollars) && dollars > 0) {
      return { amount: Math.round(dollars * 100), currency: "USD" };
    }
  }

  for (const m of text.matchAll(/€\s*([\d,.]+)/g)) {
    const euros = parseFloat(m[1].replace(/,/g, ""));
    if (!isNaN(euros) && euros > 0) {
      return { amount: Math.round(euros * 100), currency: "EUR" };
    }
  }

  for (const m of text.matchAll(/£\s*([\d,.]+)/g)) {
    const pounds = parseFloat(m[1].replace(/,/g, ""));
    if (!isNaN(pounds) && pounds > 0) {
      return { amount: Math.round(pounds * 100), currency: "GBP" };
    }
  }

  return null;
}

function detectTravelType(text: string): TravelExtraction["type"] {
  if (/flight|airline|boarding/i.test(text)) return "flight";
  if (/hotel|check-?in.*room/i.test(text)) return "hotel";
  if (/restaurant|dinner|lunch/i.test(text)) return "restaurant";
  if (/train|rail/i.test(text)) return "train";
  if (/\bbus\b/i.test(text)) return "bus";
  return "other";
}

function extractDestination(text: string): string | null {
  const namePattern = /([^\n,$€£\d][^\n,$€£]{1,38})/;

  const venue = text.match(
    new RegExp(`(?:hotel|property|venue)\\s*(?:name)?\\s*:\\s*${namePattern.source}`, "i"),
  );
  if (venue) return venue[1].trim();

  const destination = text.match(
    new RegExp(`(?:destination|arriving\\s+(?:at|in))\\s*:?\\s*${namePattern.source}`, "i"),
  );
  if (destination) return destination[1].trim();

  const restaurant = text.match(
    new RegExp(`restaurant\\s*(?:name)?\\s*:\\s*${namePattern.source}`, "i"),
  );
  if (restaurant) return restaurant[1].trim();

  return null;
}

function extractConfirmationNumber(text: string): string | null {
  const match = text.match(
    /(?:confirmation\s*(?:number|code|#|no\.?)|booking\s*(?:number|reference|ref(?:\.|erence)?|#|no\.?)|reservation\s*(?:number|code|#|no\.?)|PNR)[\s:]+([A-Z0-9][\w-]{3,19})/i,
  );
  return match ? match[1].replace(/[-\s]/g, "") : null;
}
