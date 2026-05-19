"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import {
  COUNTRIES,
  composeE164,
  detectCountryFromPhone,
  getCountryByIso2,
  stripDialCode,
  type Country,
} from "@/lib/countries";

interface PhoneInputProps {
  /** The current E.164 value (e.g. `+18589107283`). May be `""` for unset. */
  value: string;
  /** Called whenever the user types or picks a new country. Receives the
   *  fully-composed E.164 value. */
  onChange: (next: string) => void;
  placeholder?: string;
  defaultCountryIso2?: string;
  disabled?: boolean;
  id?: string;
}

/**
 * Phone-number input with a country flag picker. Selecting a country
 * auto-fills the dial code; the local-number text field only shows the
 * subscriber number portion. Pasting a full `+...` value into the local
 * field re-detects the country automatically.
 *
 * Why a single composed E.164 value (not separate state for country/local):
 * the rest of the dashboard treats `whatsappOwnerPhone` as one string, and
 * the daemon's validator (`STRING_VALIDATORS.whatsappOwnerPhone`) only
 * accepts E.164. Keeping the truth in one composed string avoids drift.
 */
export function PhoneInput({
  value,
  onChange,
  placeholder = "Subscriber number",
  defaultCountryIso2 = "US",
  disabled,
  id,
}: PhoneInputProps) {
  // Derive the country from the incoming `value`. If we can't detect one
  // (empty value, malformed prefix), fall back to the default. We persist
  // the chosen country in local state so users who clear the local field
  // don't suddenly lose their flag selection.
  const detected = useMemo(
    () => detectCountryFromPhone(value) ?? getCountryByIso2(defaultCountryIso2) ?? COUNTRIES[0],
    [value, defaultCountryIso2],
  );
  const [country, setCountry] = useState<Country>(detected);

  // Sync local country state when the parent value gives us a new prefix.
  useEffect(() => {
    const fromValue = detectCountryFromPhone(value);
    if (fromValue && fromValue.iso2 !== country.iso2) {
      setCountry(fromValue);
    }
    // Intentionally exclude `country` from deps — we only want to react to
    // EXTERNAL value changes here, not our own setCountry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const localNumber = stripDialCode(value, country);

  const handleCountryChange = (iso2: string) => {
    const next = getCountryByIso2(iso2);
    if (!next) return;
    setCountry(next);
    // Re-emit with the new dial code so the parent's E.164 stays consistent.
    onChange(composeE164(next, localNumber));
  };

  const handleLocalChange = (raw: string) => {
    // If the user pastes a full international number into the local field,
    // re-detect the country instead of treating the `+` as a stray digit.
    if (raw.startsWith("+")) {
      const detectedFromPaste = detectCountryFromPhone(raw);
      if (detectedFromPaste) {
        setCountry(detectedFromPaste);
        onChange(composeE164(detectedFromPaste, stripDialCode(raw, detectedFromPaste)));
        return;
      }
    }
    onChange(composeE164(country, raw));
  };

  return (
    <div className="flex items-stretch gap-2">
      <Select
        value={country.iso2}
        onValueChange={handleCountryChange}
        disabled={disabled}
      >
        <SelectTrigger
          className="w-[140px] flex-shrink-0"
          aria-label="Country code"
        >
          <SelectValue>
            <span className="flex items-center gap-2">
              <span className="text-base leading-none">{country.flag}</span>
              <span className="text-xs text-muted-foreground">+{country.dial}</span>
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent className="max-h-[320px]">
          {COUNTRIES.map((c) => (
            <SelectItem key={c.iso2} value={c.iso2}>
              <span className="flex items-center gap-2">
                <span className="text-base leading-none">{c.flag}</span>
                <span className="text-sm">{c.name}</span>
                <span className="text-xs text-muted-foreground">+{c.dial}</span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        id={id}
        type="tel"
        inputMode="tel"
        placeholder={placeholder}
        value={localNumber}
        onChange={(e) => handleLocalChange(e.target.value)}
        disabled={disabled}
        className="flex-1"
      />
    </div>
  );
}
