/**
 * Whisper-supported language registry.
 *
 * Whisper (large-v3 / large-v3-turbo) supports 99 spoken languages plus
 * Cantonese (added in v3). Codes are ISO 639-1 two-letter where one exists,
 * with a few model-specific identifiers (`haw`, `yue`, `jw`) preserved as
 * Whisper itself uses them.
 *
 * Used by:
 *   - `voiceTranscriptionPrimaryLanguage` runtime-settings validation
 *   - dashboard install dialog dropdown (top + full lists)
 *   - daemon API `/api/voice/status` payload
 *
 * Sources:
 *   https://huggingface.co/openai/whisper-large-v3#supported-languages
 *   https://github.com/openai/whisper/blob/main/whisper/tokenizer.py (LANGUAGES)
 */

/**
 * Curated short list shown in the dashboard's primary-language picker as
 * the headline options. Ordered by global speaker population so the most
 * common cases are one click away. Falls back to the full list via the
 * "More languages" affordance.
 */
export const VOICE_LANGUAGE_TOP: readonly VoiceLanguage[] = [
  { code: "en", englishName: "English", nativeName: "English" },
  { code: "ja", englishName: "Japanese", nativeName: "日本語" },
  { code: "zh", englishName: "Chinese", nativeName: "中文" },
  { code: "es", englishName: "Spanish", nativeName: "Español" },
  { code: "ko", englishName: "Korean", nativeName: "한국어" },
  { code: "fr", englishName: "French", nativeName: "Français" },
  { code: "de", englishName: "German", nativeName: "Deutsch" },
  { code: "pt", englishName: "Portuguese", nativeName: "Português" },
  { code: "it", englishName: "Italian", nativeName: "Italiano" },
  { code: "ru", englishName: "Russian", nativeName: "Русский" },
  { code: "ar", englishName: "Arabic", nativeName: "العربية" },
  { code: "hi", englishName: "Hindi", nativeName: "हिन्दी" },
  { code: "nl", englishName: "Dutch", nativeName: "Nederlands" },
  { code: "pl", englishName: "Polish", nativeName: "Polski" },
  { code: "tr", englishName: "Turkish", nativeName: "Türkçe" },
  { code: "vi", englishName: "Vietnamese", nativeName: "Tiếng Việt" },
  { code: "id", englishName: "Indonesian", nativeName: "Bahasa Indonesia" },
  { code: "th", englishName: "Thai", nativeName: "ไทย" },
] as const;

/**
 * Full list of Whisper-supported language codes. Used to validate the
 * `voiceTranscriptionPrimaryLanguage` setting and to populate the "More
 * languages" sub-list in the dashboard picker. Codes match what Whisper
 * accepts as the `language` argument to its tokenizer.
 */
export const VOICE_LANGUAGE_FULL: readonly VoiceLanguage[] = [
  ...VOICE_LANGUAGE_TOP,
  { code: "ca", englishName: "Catalan", nativeName: "Català" },
  { code: "sv", englishName: "Swedish", nativeName: "Svenska" },
  { code: "fi", englishName: "Finnish", nativeName: "Suomi" },
  { code: "he", englishName: "Hebrew", nativeName: "עברית" },
  { code: "uk", englishName: "Ukrainian", nativeName: "Українська" },
  { code: "el", englishName: "Greek", nativeName: "Ελληνικά" },
  { code: "ms", englishName: "Malay", nativeName: "Bahasa Melayu" },
  { code: "cs", englishName: "Czech", nativeName: "Čeština" },
  { code: "ro", englishName: "Romanian", nativeName: "Română" },
  { code: "da", englishName: "Danish", nativeName: "Dansk" },
  { code: "hu", englishName: "Hungarian", nativeName: "Magyar" },
  { code: "ta", englishName: "Tamil", nativeName: "தமிழ்" },
  { code: "no", englishName: "Norwegian", nativeName: "Norsk" },
  { code: "ur", englishName: "Urdu", nativeName: "اردو" },
  { code: "hr", englishName: "Croatian", nativeName: "Hrvatski" },
  { code: "bg", englishName: "Bulgarian", nativeName: "Български" },
  { code: "lt", englishName: "Lithuanian", nativeName: "Lietuvių" },
  { code: "la", englishName: "Latin", nativeName: "Latina" },
  { code: "mi", englishName: "Maori", nativeName: "Māori" },
  { code: "ml", englishName: "Malayalam", nativeName: "മലയാളം" },
  { code: "cy", englishName: "Welsh", nativeName: "Cymraeg" },
  { code: "sk", englishName: "Slovak", nativeName: "Slovenčina" },
  { code: "te", englishName: "Telugu", nativeName: "తెలుగు" },
  { code: "fa", englishName: "Persian", nativeName: "فارسی" },
  { code: "lv", englishName: "Latvian", nativeName: "Latviešu" },
  { code: "bn", englishName: "Bengali", nativeName: "বাংলা" },
  { code: "sr", englishName: "Serbian", nativeName: "Српски" },
  { code: "az", englishName: "Azerbaijani", nativeName: "Azərbaycanca" },
  { code: "sl", englishName: "Slovenian", nativeName: "Slovenščina" },
  { code: "kn", englishName: "Kannada", nativeName: "ಕನ್ನಡ" },
  { code: "et", englishName: "Estonian", nativeName: "Eesti" },
  { code: "mk", englishName: "Macedonian", nativeName: "Македонски" },
  { code: "br", englishName: "Breton", nativeName: "Brezhoneg" },
  { code: "eu", englishName: "Basque", nativeName: "Euskara" },
  { code: "is", englishName: "Icelandic", nativeName: "Íslenska" },
  { code: "hy", englishName: "Armenian", nativeName: "Հայերեն" },
  { code: "ne", englishName: "Nepali", nativeName: "नेपाली" },
  { code: "mn", englishName: "Mongolian", nativeName: "Монгол" },
  { code: "bs", englishName: "Bosnian", nativeName: "Bosanski" },
  { code: "kk", englishName: "Kazakh", nativeName: "Қазақ" },
  { code: "sq", englishName: "Albanian", nativeName: "Shqip" },
  { code: "sw", englishName: "Swahili", nativeName: "Kiswahili" },
  { code: "gl", englishName: "Galician", nativeName: "Galego" },
  { code: "mr", englishName: "Marathi", nativeName: "मराठी" },
  { code: "pa", englishName: "Punjabi", nativeName: "ਪੰਜਾਬੀ" },
  { code: "si", englishName: "Sinhala", nativeName: "සිංහල" },
  { code: "km", englishName: "Khmer", nativeName: "ខ្មែរ" },
  { code: "sn", englishName: "Shona", nativeName: "ChiShona" },
  { code: "yo", englishName: "Yoruba", nativeName: "Yorùbá" },
  { code: "so", englishName: "Somali", nativeName: "Soomaali" },
  { code: "af", englishName: "Afrikaans", nativeName: "Afrikaans" },
  { code: "oc", englishName: "Occitan", nativeName: "Occitan" },
  { code: "ka", englishName: "Georgian", nativeName: "ქართული" },
  { code: "be", englishName: "Belarusian", nativeName: "Беларуская" },
  { code: "tg", englishName: "Tajik", nativeName: "Тоҷикӣ" },
  { code: "sd", englishName: "Sindhi", nativeName: "سنڌي" },
  { code: "gu", englishName: "Gujarati", nativeName: "ગુજરાતી" },
  { code: "am", englishName: "Amharic", nativeName: "አማርኛ" },
  { code: "yi", englishName: "Yiddish", nativeName: "ייִדיש" },
  { code: "lo", englishName: "Lao", nativeName: "ລາວ" },
  { code: "uz", englishName: "Uzbek", nativeName: "Oʻzbekcha" },
  { code: "fo", englishName: "Faroese", nativeName: "Føroyskt" },
  { code: "ht", englishName: "Haitian Creole", nativeName: "Kreyòl Ayisyen" },
  { code: "ps", englishName: "Pashto", nativeName: "پښتو" },
  { code: "tk", englishName: "Turkmen", nativeName: "Türkmen" },
  { code: "nn", englishName: "Norwegian Nynorsk", nativeName: "Nynorsk" },
  { code: "mt", englishName: "Maltese", nativeName: "Malti" },
  { code: "sa", englishName: "Sanskrit", nativeName: "संस्कृतम्" },
  { code: "lb", englishName: "Luxembourgish", nativeName: "Lëtzebuergesch" },
  { code: "my", englishName: "Myanmar", nativeName: "မြန်မာ" },
  { code: "bo", englishName: "Tibetan", nativeName: "བོད་སྐད" },
  { code: "tl", englishName: "Tagalog", nativeName: "Tagalog" },
  { code: "mg", englishName: "Malagasy", nativeName: "Malagasy" },
  { code: "as", englishName: "Assamese", nativeName: "অসমীয়া" },
  { code: "tt", englishName: "Tatar", nativeName: "Татарча" },
  { code: "haw", englishName: "Hawaiian", nativeName: "ʻŌlelo Hawaiʻi" },
  { code: "ln", englishName: "Lingala", nativeName: "Lingála" },
  { code: "ha", englishName: "Hausa", nativeName: "Hausa" },
  { code: "ba", englishName: "Bashkir", nativeName: "Башҡортса" },
  { code: "jw", englishName: "Javanese", nativeName: "Basa Jawa" },
  { code: "su", englishName: "Sundanese", nativeName: "Basa Sunda" },
  { code: "yue", englishName: "Cantonese", nativeName: "粵語" },
] as const;

export interface VoiceLanguage {
  /** Whisper language code (ISO 639-1 with a few model-specific exceptions). */
  code: string;
  /** Display name in English (for the picker label). */
  englishName: string;
  /** Display name in the language itself (for native-script affordance). */
  nativeName: string;
}

const supportedCodes = new Set(VOICE_LANGUAGE_FULL.map((l) => l.code));

/**
 * Returns true when `code` is a valid Whisper language identifier.
 * Used to validate user-supplied primary-language settings before persisting.
 */
export function isSupportedVoiceLanguage(code: string): boolean {
  return supportedCodes.has(code);
}

/**
 * Best-effort mapping from a BCP-47 locale tag (e.g. "ja-JP", "en_US.UTF-8")
 * to a Whisper language code. Used to seed the install dialog default from
 * the operator's OS locale. Returns `null` if the locale doesn't map to a
 * Whisper-supported language; the caller should then fall back to "en".
 */
export function localeToVoiceLanguage(locale: string | null | undefined): string | null {
  if (!locale) return null;
  // Strip encoding suffix ("ja_JP.UTF-8" → "ja_JP") and split on - or _.
  const head = locale.split(".")[0].replace(/_/g, "-").split("-")[0].toLowerCase();
  if (!head) return null;
  if (supportedCodes.has(head)) return head;
  // A handful of common aliases that don't round-trip via the prefix split.
  // Note: regional Chinese variants like `zh-Hans` / `zh-Hant` are already
  // resolved by the prefix-extraction above (head="zh"), so we do not need
  // separate cases for them. `nb-NO` likewise extracts to `nb` here, which
  // is the case below — Whisper's tokenizer uses `no` for Bokmål and a
  // distinct `nn` token for Nynorsk.
  switch (head) {
    case "iw": return "he";   // legacy Hebrew tag
    case "in": return "id";   // legacy Indonesian tag
    case "ji": return "yi";   // legacy Yiddish tag
    case "nb": return "no";   // Norwegian Bokmål → Whisper's `no`
    default:
      return null;
  }
}
