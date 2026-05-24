/**
 * Country dialing codes for the phone-input picker.
 *
 * `iso2` is the canonical ISO 3166-1 alpha-2 code (used as the React key and
 * the basis for the regional-indicator flag emoji). `dial` is the international
 * trunk code WITHOUT the leading `+`. `flag` is precomputed at module load
 * because rebuilding ~250 emojis on every render would be wasteful.
 */
export interface Country {
  iso2: string;
  name: string;
  dial: string;
  flag: string;
}

// Convert an ISO2 code (e.g. "JP") to its regional-indicator-symbol flag.
function iso2ToFlag(iso2: string): string {
  if (iso2.length !== 2) return "🏳";
  const A = 0x1f1e6;
  const a = "A".charCodeAt(0);
  const codePoints = iso2
    .toUpperCase()
    .split("")
    .map((c) => A + (c.charCodeAt(0) - a));
  return String.fromCodePoint(...codePoints);
}

const RAW: Array<Omit<Country, "flag">> = [
  { iso2: "AF", name: "Afghanistan", dial: "93" },
  { iso2: "AL", name: "Albania", dial: "355" },
  { iso2: "DZ", name: "Algeria", dial: "213" },
  { iso2: "AD", name: "Andorra", dial: "376" },
  { iso2: "AO", name: "Angola", dial: "244" },
  { iso2: "AR", name: "Argentina", dial: "54" },
  { iso2: "AM", name: "Armenia", dial: "374" },
  { iso2: "AU", name: "Australia", dial: "61" },
  { iso2: "AT", name: "Austria", dial: "43" },
  { iso2: "AZ", name: "Azerbaijan", dial: "994" },
  { iso2: "BS", name: "Bahamas", dial: "1242" },
  { iso2: "BH", name: "Bahrain", dial: "973" },
  { iso2: "BD", name: "Bangladesh", dial: "880" },
  { iso2: "BB", name: "Barbados", dial: "1246" },
  { iso2: "BY", name: "Belarus", dial: "375" },
  { iso2: "BE", name: "Belgium", dial: "32" },
  { iso2: "BZ", name: "Belize", dial: "501" },
  { iso2: "BJ", name: "Benin", dial: "229" },
  { iso2: "BT", name: "Bhutan", dial: "975" },
  { iso2: "BO", name: "Bolivia", dial: "591" },
  { iso2: "BA", name: "Bosnia and Herzegovina", dial: "387" },
  { iso2: "BW", name: "Botswana", dial: "267" },
  { iso2: "BR", name: "Brazil", dial: "55" },
  { iso2: "BN", name: "Brunei", dial: "673" },
  { iso2: "BG", name: "Bulgaria", dial: "359" },
  { iso2: "BF", name: "Burkina Faso", dial: "226" },
  { iso2: "BI", name: "Burundi", dial: "257" },
  { iso2: "KH", name: "Cambodia", dial: "855" },
  { iso2: "CM", name: "Cameroon", dial: "237" },
  { iso2: "CA", name: "Canada", dial: "1" },
  { iso2: "CV", name: "Cape Verde", dial: "238" },
  { iso2: "CF", name: "Central African Republic", dial: "236" },
  { iso2: "TD", name: "Chad", dial: "235" },
  { iso2: "CL", name: "Chile", dial: "56" },
  { iso2: "CN", name: "China", dial: "86" },
  { iso2: "CO", name: "Colombia", dial: "57" },
  { iso2: "KM", name: "Comoros", dial: "269" },
  { iso2: "CG", name: "Congo", dial: "242" },
  { iso2: "CD", name: "Congo (DRC)", dial: "243" },
  { iso2: "CR", name: "Costa Rica", dial: "506" },
  { iso2: "CI", name: "Côte d'Ivoire", dial: "225" },
  { iso2: "HR", name: "Croatia", dial: "385" },
  { iso2: "CU", name: "Cuba", dial: "53" },
  { iso2: "CY", name: "Cyprus", dial: "357" },
  { iso2: "CZ", name: "Czech Republic", dial: "420" },
  { iso2: "DK", name: "Denmark", dial: "45" },
  { iso2: "DJ", name: "Djibouti", dial: "253" },
  { iso2: "DM", name: "Dominica", dial: "1767" },
  { iso2: "DO", name: "Dominican Republic", dial: "1809" },
  { iso2: "EC", name: "Ecuador", dial: "593" },
  { iso2: "EG", name: "Egypt", dial: "20" },
  { iso2: "SV", name: "El Salvador", dial: "503" },
  { iso2: "GQ", name: "Equatorial Guinea", dial: "240" },
  { iso2: "ER", name: "Eritrea", dial: "291" },
  { iso2: "EE", name: "Estonia", dial: "372" },
  { iso2: "SZ", name: "Eswatini", dial: "268" },
  { iso2: "ET", name: "Ethiopia", dial: "251" },
  { iso2: "FJ", name: "Fiji", dial: "679" },
  { iso2: "FI", name: "Finland", dial: "358" },
  { iso2: "FR", name: "France", dial: "33" },
  { iso2: "GA", name: "Gabon", dial: "241" },
  { iso2: "GM", name: "Gambia", dial: "220" },
  { iso2: "GE", name: "Georgia", dial: "995" },
  { iso2: "DE", name: "Germany", dial: "49" },
  { iso2: "GH", name: "Ghana", dial: "233" },
  { iso2: "GR", name: "Greece", dial: "30" },
  { iso2: "GL", name: "Greenland", dial: "299" },
  { iso2: "GD", name: "Grenada", dial: "1473" },
  { iso2: "GT", name: "Guatemala", dial: "502" },
  { iso2: "GN", name: "Guinea", dial: "224" },
  { iso2: "GW", name: "Guinea-Bissau", dial: "245" },
  { iso2: "GY", name: "Guyana", dial: "592" },
  { iso2: "HT", name: "Haiti", dial: "509" },
  { iso2: "HN", name: "Honduras", dial: "504" },
  { iso2: "HK", name: "Hong Kong", dial: "852" },
  { iso2: "HU", name: "Hungary", dial: "36" },
  { iso2: "IS", name: "Iceland", dial: "354" },
  { iso2: "IN", name: "India", dial: "91" },
  { iso2: "ID", name: "Indonesia", dial: "62" },
  { iso2: "IR", name: "Iran", dial: "98" },
  { iso2: "IQ", name: "Iraq", dial: "964" },
  { iso2: "IE", name: "Ireland", dial: "353" },
  { iso2: "IL", name: "Israel", dial: "972" },
  { iso2: "IT", name: "Italy", dial: "39" },
  { iso2: "JM", name: "Jamaica", dial: "1876" },
  { iso2: "JP", name: "Japan", dial: "81" },
  { iso2: "JO", name: "Jordan", dial: "962" },
  { iso2: "KZ", name: "Kazakhstan", dial: "7" },
  { iso2: "KE", name: "Kenya", dial: "254" },
  { iso2: "KI", name: "Kiribati", dial: "686" },
  { iso2: "KW", name: "Kuwait", dial: "965" },
  { iso2: "KG", name: "Kyrgyzstan", dial: "996" },
  { iso2: "LA", name: "Laos", dial: "856" },
  { iso2: "LV", name: "Latvia", dial: "371" },
  { iso2: "LB", name: "Lebanon", dial: "961" },
  { iso2: "LS", name: "Lesotho", dial: "266" },
  { iso2: "LR", name: "Liberia", dial: "231" },
  { iso2: "LY", name: "Libya", dial: "218" },
  { iso2: "LI", name: "Liechtenstein", dial: "423" },
  { iso2: "LT", name: "Lithuania", dial: "370" },
  { iso2: "LU", name: "Luxembourg", dial: "352" },
  { iso2: "MO", name: "Macau", dial: "853" },
  { iso2: "MG", name: "Madagascar", dial: "261" },
  { iso2: "MW", name: "Malawi", dial: "265" },
  { iso2: "MY", name: "Malaysia", dial: "60" },
  { iso2: "MV", name: "Maldives", dial: "960" },
  { iso2: "ML", name: "Mali", dial: "223" },
  { iso2: "MT", name: "Malta", dial: "356" },
  { iso2: "MR", name: "Mauritania", dial: "222" },
  { iso2: "MU", name: "Mauritius", dial: "230" },
  { iso2: "MX", name: "Mexico", dial: "52" },
  { iso2: "FM", name: "Micronesia", dial: "691" },
  { iso2: "MD", name: "Moldova", dial: "373" },
  { iso2: "MC", name: "Monaco", dial: "377" },
  { iso2: "MN", name: "Mongolia", dial: "976" },
  { iso2: "ME", name: "Montenegro", dial: "382" },
  { iso2: "MA", name: "Morocco", dial: "212" },
  { iso2: "MZ", name: "Mozambique", dial: "258" },
  { iso2: "MM", name: "Myanmar", dial: "95" },
  { iso2: "NA", name: "Namibia", dial: "264" },
  { iso2: "NR", name: "Nauru", dial: "674" },
  { iso2: "NP", name: "Nepal", dial: "977" },
  { iso2: "NL", name: "Netherlands", dial: "31" },
  { iso2: "NZ", name: "New Zealand", dial: "64" },
  { iso2: "NI", name: "Nicaragua", dial: "505" },
  { iso2: "NE", name: "Niger", dial: "227" },
  { iso2: "NG", name: "Nigeria", dial: "234" },
  { iso2: "KP", name: "North Korea", dial: "850" },
  { iso2: "MK", name: "North Macedonia", dial: "389" },
  { iso2: "NO", name: "Norway", dial: "47" },
  { iso2: "OM", name: "Oman", dial: "968" },
  { iso2: "PK", name: "Pakistan", dial: "92" },
  { iso2: "PW", name: "Palau", dial: "680" },
  { iso2: "PS", name: "Palestine", dial: "970" },
  { iso2: "PA", name: "Panama", dial: "507" },
  { iso2: "PG", name: "Papua New Guinea", dial: "675" },
  { iso2: "PY", name: "Paraguay", dial: "595" },
  { iso2: "PE", name: "Peru", dial: "51" },
  { iso2: "PH", name: "Philippines", dial: "63" },
  { iso2: "PL", name: "Poland", dial: "48" },
  { iso2: "PT", name: "Portugal", dial: "351" },
  { iso2: "PR", name: "Puerto Rico", dial: "1787" },
  { iso2: "QA", name: "Qatar", dial: "974" },
  { iso2: "RO", name: "Romania", dial: "40" },
  { iso2: "RU", name: "Russia", dial: "7" },
  { iso2: "RW", name: "Rwanda", dial: "250" },
  { iso2: "WS", name: "Samoa", dial: "685" },
  { iso2: "SM", name: "San Marino", dial: "378" },
  { iso2: "ST", name: "São Tomé and Príncipe", dial: "239" },
  { iso2: "SA", name: "Saudi Arabia", dial: "966" },
  { iso2: "SN", name: "Senegal", dial: "221" },
  { iso2: "RS", name: "Serbia", dial: "381" },
  { iso2: "SC", name: "Seychelles", dial: "248" },
  { iso2: "SL", name: "Sierra Leone", dial: "232" },
  { iso2: "SG", name: "Singapore", dial: "65" },
  { iso2: "SK", name: "Slovakia", dial: "421" },
  { iso2: "SI", name: "Slovenia", dial: "386" },
  { iso2: "SB", name: "Solomon Islands", dial: "677" },
  { iso2: "SO", name: "Somalia", dial: "252" },
  { iso2: "ZA", name: "South Africa", dial: "27" },
  { iso2: "KR", name: "South Korea", dial: "82" },
  { iso2: "SS", name: "South Sudan", dial: "211" },
  { iso2: "ES", name: "Spain", dial: "34" },
  { iso2: "LK", name: "Sri Lanka", dial: "94" },
  { iso2: "SD", name: "Sudan", dial: "249" },
  { iso2: "SR", name: "Suriname", dial: "597" },
  { iso2: "SE", name: "Sweden", dial: "46" },
  { iso2: "CH", name: "Switzerland", dial: "41" },
  { iso2: "SY", name: "Syria", dial: "963" },
  { iso2: "TW", name: "Taiwan", dial: "886" },
  { iso2: "TJ", name: "Tajikistan", dial: "992" },
  { iso2: "TZ", name: "Tanzania", dial: "255" },
  { iso2: "TH", name: "Thailand", dial: "66" },
  { iso2: "TL", name: "Timor-Leste", dial: "670" },
  { iso2: "TG", name: "Togo", dial: "228" },
  { iso2: "TO", name: "Tonga", dial: "676" },
  { iso2: "TT", name: "Trinidad and Tobago", dial: "1868" },
  { iso2: "TN", name: "Tunisia", dial: "216" },
  { iso2: "TR", name: "Turkey", dial: "90" },
  { iso2: "TM", name: "Turkmenistan", dial: "993" },
  { iso2: "TV", name: "Tuvalu", dial: "688" },
  { iso2: "UG", name: "Uganda", dial: "256" },
  { iso2: "UA", name: "Ukraine", dial: "380" },
  { iso2: "AE", name: "United Arab Emirates", dial: "971" },
  { iso2: "GB", name: "United Kingdom", dial: "44" },
  { iso2: "US", name: "United States", dial: "1" },
  { iso2: "UY", name: "Uruguay", dial: "598" },
  { iso2: "UZ", name: "Uzbekistan", dial: "998" },
  { iso2: "VU", name: "Vanuatu", dial: "678" },
  { iso2: "VA", name: "Vatican City", dial: "379" },
  { iso2: "VE", name: "Venezuela", dial: "58" },
  { iso2: "VN", name: "Vietnam", dial: "84" },
  { iso2: "YE", name: "Yemen", dial: "967" },
  { iso2: "ZM", name: "Zambia", dial: "260" },
  { iso2: "ZW", name: "Zimbabwe", dial: "263" },
];

export const COUNTRIES: Country[] = RAW.map((c) => ({
  ...c,
  flag: iso2ToFlag(c.iso2),
})).sort((a, b) => a.name.localeCompare(b.name));

const BY_ISO2 = new Map(COUNTRIES.map((c) => [c.iso2, c]));

export function getCountryByIso2(iso2: string): Country | undefined {
  return BY_ISO2.get(iso2.toUpperCase());
}

/**
 * Tiebreaker for dial codes that are shared between several countries (most
 * notably the NANP `+1` block and the `+7` block shared by Russia and
 * Kazakhstan). When two countries have the same `dial` string the longest-
 * prefix sort below would otherwise fall back to the (alphabetical) order of
 * `COUNTRIES`, which puts Canada ahead of the United States — meaning a
 * San Diego number like `+18589107283` used to detect as Canada.
 *
 * The right fix is data, not heuristics: declare which ISO2 code wins when a
 * dial is fully ambiguous, and let the sort below honor it. Adding a new
 * shared code is a one-line change.
 */
const DIAL_CODE_PRIORITY: Record<string, string> = {
  "1": "US", // NANP — US/Canada/Caribbean share +1; default to US
  "7": "RU", // RU/KZ share +7; default to Russia
};

/**
 * Greedy longest-prefix match: given an E.164 phone (with or without `+`),
 * find the country whose dial code matches the longest prefix. We sort the
 * dial table by length descending so e.g. `+1242` (Bahamas) wins over `+1`
 * (US/Canada) when both could match.
 *
 * For dial codes of equal length we apply DIAL_CODE_PRIORITY first, then fall
 * back to a stable alphabetical order so the result is deterministic across
 * runs (V8's `Array.prototype.sort` has been stable since Node 12).
 */
const SORTED_DIALS = [...COUNTRIES].sort((a, b) => {
  if (b.dial.length !== a.dial.length) {
    return b.dial.length - a.dial.length;
  }
  const preferred = DIAL_CODE_PRIORITY[a.dial];
  if (preferred) {
    if (a.iso2 === preferred && b.iso2 !== preferred) return -1;
    if (b.iso2 === preferred && a.iso2 !== preferred) return 1;
  }
  return a.name.localeCompare(b.name);
});

export function detectCountryFromPhone(phone: string): Country | null {
  if (!phone) return null;
  const digits = phone.replace(/^\+/, "").replace(/\D/g, "");
  for (const c of SORTED_DIALS) {
    if (digits.startsWith(c.dial)) return c;
  }
  return null;
}

/**
 * Strip the dial-code prefix off a phone string. Returns the local part only,
 * with non-digits removed. Used so the number-input field shows just the
 * local subscriber number, not the redundant `+81` already shown by the flag.
 */
export function stripDialCode(phone: string, country: Country): string {
  const digits = phone.replace(/^\+/, "").replace(/\D/g, "");
  if (digits.startsWith(country.dial)) {
    return digits.slice(country.dial.length);
  }
  return digits;
}

/**
 * Compose an E.164-formatted phone string from a country and the local
 * subscriber number. The local part is sanitized to digits only; an empty
 * local part returns just `+<dial>` so partial input round-trips cleanly.
 */
export function composeE164(country: Country, localNumber: string): string {
  const local = localNumber.replace(/\D/g, "");
  return `+${country.dial}${local}`;
}
