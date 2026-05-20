export type SensitiveHostCategory = "banking" | "health" | "adult";

const BANKING_SUFFIXES: readonly string[] = [
  "chase.com",
  "bankofamerica.com",
  "wellsfargo.com",
  "citi.com",
  "citibank.com",
  "usbank.com",
  "capitalone.com",
  "americanexpress.com",
  "amex.com",
  "discover.com",
  "paypal.com",
  "venmo.com",
  "wise.com",
  "revolut.com",
  "n26.com",
  "monzo.com",
  "starlingbank.com",
  "barclays.co.uk",
  "hsbc.com",
  "hsbc.co.uk",
  "lloydsbank.com",
  "natwest.com",
  "santander.co.uk",
  "santander.com",
  "smbc.co.jp",
  "mufg.jp",
  "bk.mufg.jp",
  "smbctrust.co.jp",
  "shinseibank.com",
  "sonybank.net",
  "rakuten-bank.co.jp",
  "japannetbank.co.jp",
  "paypay-bank.co.jp",
  "ufj.jp",
  "mizuhobank.co.jp",
  "yuchobank.jp",
  "jp-bank.japanpost.jp",
  "stripe.com",
  "square.com",
  "squareup.com",
  "coinbase.com",
  "binance.com",
  "kraken.com",
  "bitflyer.com",
  "fidelity.com",
  "vanguard.com",
  "schwab.com",
  "etrade.com",
  "interactivebrokers.com",
  "robinhood.com",
  "wealthsimple.com",
];

const HEALTH_SUFFIXES: readonly string[] = [
  "mychart.com",
  "kp.org",
  "kaiserpermanente.org",
  "cvs.com",
  "walgreens.com",
  "webmd.com",
  "mayoclinic.org",
  "clevelandclinic.org",
  "nih.gov",
  "cdc.gov",
  "who.int",
  "uptodate.com",
  "epicmychart.com",
  "anthem.com",
  "aetna.com",
  "cigna.com",
  "unitedhealthcare.com",
  "humana.com",
  "23andme.com",
  "ancestry.com",
  "doxy.me",
  "teladoc.com",
  "amwell.com",
  "betterhelp.com",
  "talkspace.com",
  "headspace.com",
  "calm.com",
  "myfitnesspal.com",
  "fitbit.com",
  "ouraring.com",
  "withings.com",
];

const ADULT_SUFFIXES: readonly string[] = [
  "pornhub.com",
  "xvideos.com",
  "xnxx.com",
  "redtube.com",
  "youporn.com",
  "xhamster.com",
  "onlyfans.com",
  "chaturbate.com",
  "cam4.com",
  "stripchat.com",
  "spankbang.com",
  "tnaflix.com",
  "brazzers.com",
  "playboy.com",
  "adultfriendfinder.com",
  "fansly.com",
  "manyvids.com",
  "clips4sale.com",
  "fanza.co.jp",
  "dmm.co.jp",
];

const BANKING_KEYWORDS = [
  "bank",
  "banco",
  "banque",
  "banking",
  "credit-union",
  "creditunion",
  "brokerage",
];
const HEALTH_KEYWORDS = [
  "health",
  "clinic",
  "hospital",
  "medical",
  "pharma",
  "pharmacy",
  "wellness",
  "therapy",
];

function matchesSuffix(host: string, suffixes: readonly string[]): boolean {
  const cleaned = host.replace(/^www\./i, "").toLowerCase();
  return suffixes.some((suffix) => cleaned === suffix || cleaned.endsWith(`.${suffix}`));
}

function registeredDomain(host: string): string {
  const parts = host.split(".");
  if (parts.length < 2) return host;
  // Treat two-level public suffixes (co.jp, co.uk, com.au, …) as one
  // unit. This is intentionally a small list; the heuristic falls back
  // to last-two-labels for anything else, which is enough for the
  // intent here (we only need the *registered* label for keyword
  // probing).
  const twoLevelTlds = ["co.jp", "co.uk", "com.au", "com.br", "co.kr"];
  const lastTwo = parts.slice(-2).join(".");
  if (twoLevelTlds.includes(lastTwo) && parts.length >= 3) {
    return parts[parts.length - 3];
  }
  return parts[parts.length - 2];
}

function keywordHit(host: string, keywords: readonly string[]): boolean {
  const reg = registeredDomain(host);
  return keywords.some((keyword) => reg.includes(keyword));
}

export function classifyHost(host: string): SensitiveHostCategory | null {
  if (!host) return null;
  const cleaned = host.replace(/^www\./i, "").toLowerCase();
  if (matchesSuffix(cleaned, ADULT_SUFFIXES)) return "adult";
  if (matchesSuffix(cleaned, BANKING_SUFFIXES)) return "banking";
  if (matchesSuffix(cleaned, HEALTH_SUFFIXES)) return "health";
  // Heuristic keyword match against the registered domain label only —
  // catches "somelocalbank.com" / "acme-credit-union.com" without
  // false-positiving "creditcardrewards.org" (registered domain is
  // `creditcardrewards`, no "credit-union" / "bank" exact match). The
  // failure mode is "we lose signal", never "we leak sensitive
  // content".
  if (keywordHit(cleaned, BANKING_KEYWORDS)) return "banking";
  if (keywordHit(cleaned, HEALTH_KEYWORDS)) return "health";
  return null;
}
