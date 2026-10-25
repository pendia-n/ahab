export const DAY = 86400000;
export const SESSION_SECONDS = 270 * 86400;
export const OUTPUT_DAYS = 121;
export const LIMITS = {
  prompts: 80,
  image: 40,
  audio: 20,
  video: 10,
  output: 23,
} as const;
export const PACKAGES = [
  {
    id: "starter",
    name: "First take",
    priceCents: 1100,
    videos: 1,
    maxDuration: 30,
    portraits: 1,
  },
  {
    id: "studio",
    name: "Creator set",
    priceCents: 2200,
    videos: 3,
    maxDuration: 80,
    portraits: 3,
  },
  {
    id: "campaign",
    name: "Campaign set",
    priceCents: 4700,
    videos: 5,
    maxDuration: 120,
    portraits: 5,
  },
] as const;
export function packageById(id: unknown) {
  return PACKAGES.find((p) => p.id === id);
}
export function usernameValid(value: string) {
  return /^[a-zA-Z0-9_]{3,24}$/.test(value);
}
export function passwordValid(value: string) {
  return (
    value.length >= 7 &&
    value.length <= 18 &&
    /[a-zA-Z]/.test(value) &&
    /[0-9]/.test(value)
  );
}
export function passcodeValid(value: string) {
  return /^[a-z0-9]{8}$/.test(value);
}
export function validateDuration(mode: string, duration: unknown, cap: number) {
  if (typeof duration !== "number" || !Number.isInteger(duration))
    throw new Error("Choose a whole number of seconds.");
  if (mode === "video_reference") {
    if (duration < 5 || duration > 15)
      throw new Error("Video-reference clips must be 5–15 seconds.");
  } else if (mode === "presenter") {
    if (duration < 10 || duration > cap)
      throw new Error(`Choose 10–${cap} seconds for this package.`);
  } else throw new Error("Choose a supported video format.");
  return duration;
}
// Conservative regular (non-promotional) prices, including reference overhead.
export function estimateCents(kind: string, mode: string, duration: number) {
  return kind === "portrait"
    ? 5
    : mode === "presenter"
      ? duration * 5 + 10
      : duration * 10 + 60;
}
