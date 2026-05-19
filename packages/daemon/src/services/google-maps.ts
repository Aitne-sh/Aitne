import { createLogger } from "../logging.js";
import type { SecretBroker } from "../secrets/secret-broker.js";

const logger = createLogger("google-maps-service");

const DIRECTIONS_API_BASE = "https://maps.googleapis.com/maps/api/directions/json";

export interface TravelTimeResult {
  origin: string;
  destination: string;
  mode: TravelMode;
  /** Duration in seconds. */
  durationSeconds: number;
  /** Human-readable duration (e.g., "1 hour 23 mins"). */
  durationText: string;
  /** Distance in meters. */
  distanceMeters: number;
  /** Human-readable distance (e.g., "45.2 km"). */
  distanceText: string;
  /** Suggested departure time to arrive on time. ISO 8601. */
  departBy: string | null;
}

export type TravelMode = "driving" | "transit" | "walking" | "bicycling";

export class GoogleMapsService {
  private apiKey: string | null = null;

  constructor(private readonly secretBroker: SecretBroker) {}

  get available(): boolean {
    return this.apiKey !== null;
  }

  async init(): Promise<void> {
    const key = await this.secretBroker.getGoogleMapsApiKey();
    if (!key) {
      logger.warn("Google Maps API key not configured");
      return;
    }
    this.apiKey = key;
    logger.info("Google Maps service initialized");
  }

  /**
   * Get travel time and distance between two locations.
   *
   * @param origin - Origin address or place name
   * @param destination - Destination address or place name
   * @param mode - Travel mode (default: transit)
   * @param arrivalTime - Desired arrival time (ISO 8601). Used to compute
   *   departure time. Only supported for transit mode.
   */
  async getTravelTime(
    origin: string,
    destination: string,
    mode: TravelMode = "transit",
    arrivalTime?: string,
  ): Promise<TravelTimeResult | null> {
    if (!this.apiKey) return null;

    const params = new URLSearchParams({
      origin,
      destination,
      mode,
      key: this.apiKey,
      language: "en",
    });

    if (arrivalTime && mode === "transit") {
      params.set("arrival_time", String(Math.floor(new Date(arrivalTime).getTime() / 1000)));
    } else if (arrivalTime) {
      // For non-transit modes, use departure_time to estimate duration
      // and compute depart-by from the arrival time minus duration
      params.set("departure_time", "now");
    }

    const url = `${DIRECTIONS_API_BASE}?${params.toString()}`;
    const res = await fetch(url);

    if (!res.ok) {
      logger.error({ status: res.status }, "Google Maps Directions API error");
      return null;
    }

    const data = await res.json() as DirectionsResponse;

    if (data.status !== "OK" || !data.routes?.length) {
      logger.warn({ status: data.status }, "No route found");
      return null;
    }

    const route = data.routes[0];
    const leg = route.legs[0];

    let departBy: string | null = null;
    if (arrivalTime) {
      const arrivalMs = new Date(arrivalTime).getTime();
      const durationMs = leg.duration.value * 1000;
      // Add 10% buffer for delays
      const buffer = Math.ceil(durationMs * 0.1);
      departBy = new Date(arrivalMs - durationMs - buffer).toISOString();
    }

    return {
      origin: leg.start_address,
      destination: leg.end_address,
      mode,
      durationSeconds: leg.duration.value,
      durationText: leg.duration.text,
      distanceMeters: leg.distance.value,
      distanceText: leg.distance.text,
      departBy,
    };
  }
}

// ── Google Directions API response types ──

interface DirectionsResponse {
  status: string;
  routes: Array<{
    legs: Array<{
      start_address: string;
      end_address: string;
      distance: { value: number; text: string };
      duration: { value: number; text: string };
      departure_time?: { value: number; text: string };
      arrival_time?: { value: number; text: string };
    }>;
  }>;
}
