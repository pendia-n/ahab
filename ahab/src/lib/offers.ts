/** Public product rules. Provider names and credentials must never enter this module. */
export const OFFER_VERSION = 1;
export type TaskType =
  "presenter" | "demo" | "unboxing" | "reaction" | "showcase" | "explainer";
export type Service = "presenter" | "scene" | "express" | "image";
export type Resolution = "720p" | "1080p";
export const TASKS = [
  {
    id: "presenter",
    name: "Talking presenter",
    description:
      "Your face and words. Introductions, pitches and founder stories.",
    min: 5,
    max: 120,
  },
  {
    id: "demo",
    name: "Demo / tutorial",
    description: "Show what your product does and how to use it.",
    min: 5,
    max: 25,
  },
  {
    id: "unboxing",
    name: "Unboxing",
    description: "Open the package and introduce what is inside.",
    min: 5,
    max: 25,
  },
  {
    id: "reaction",
    name: "Scripted reaction",
    description: "A performed discovery, surprise or response.",
    min: 5,
    max: 25,
  },
  {
    id: "showcase",
    name: "Showcase / lifestyle",
    description: "Product details, atmosphere and everyday settings.",
    min: 10,
    max: 25,
  },
  {
    id: "explainer",
    name: "Explainer",
    description: "One problem, one clear explanation, one next step.",
    min: 5,
    max: 100,
  },
] as const;
export const RATES = {
  presenter: { single: 959, multiple: 950 },
  scene: { single: 2729, multiple: 2720 },
  express: { single: 3709, multiple: 3700 },
} as const;
export type OfferInput = {
  taskType: TaskType;
  service: Service;
  duration: number;
  resolution: Resolution;
  quantity: number;
  theme?: string;
};
export type QuoteItem = OfferInput & {
  generatedDuration: number;
  unitAmountCents: number;
  lineAmountCents: number;
  minimumApplied: boolean;
  name: string;
};
export type Quote = {
  version: number;
  items: QuoteItem[];
  amountCents: number;
  currency: "usd";
  expiresAt: number;
};
export function taskById(id: unknown) {
  return TASKS.find((t) => t.id === id);
}
export const EXPLAINER_THEMES = [
  { id: "presenter", name: "Person speaking to camera" },
  { id: "demo", name: "Product demonstration" },
  { id: "story", name: "Visual problem and solution" },
  { id: "features", name: "Product features / comparison" },
] as const;
export function serviceFor(
  task: TaskType,
  theme: boolean | string = false,
  duration = 0,
): Service {
  const visual =
    theme === true ||
    ["scene", "demo", "story", "features"].includes(String(theme));
  return task === "presenter" ||
    (task === "explainer" && (!visual || duration > 30))
    ? "presenter"
    : "scene";
}
export function generatedDuration(
  task: TaskType,
  selected: number,
  service: Service,
): number {
  if (task === "presenter")
    return selected < 8 ? 8 : selected > 115 ? 121 : selected;
  if (task === "explainer")
    return selected < 12
      ? 12
      : service === "presenter" && selected >= 100
        ? 106
        : selected;
  const floor = { demo: 8, unboxing: 7, reaction: 14, showcase: 12 }[task];
  return selected < floor
    ? floor
    : task !== "showcase" && selected === 25
      ? 29
      : selected;
}
export function validateOffer(value: any, _expressEnabled = true): OfferInput {
  if (value?.service === "image")
    throw new Error(
      "Image creation or editing is included with each video. Choose a video type.",
    );
  const task = taskById(value?.taskType);
  if (!task || !["presenter", "scene", "express"].includes(value.service))
    throw new Error("Choose a video type.");
  const theme =
    task.id === "explainer"
      ? (value.theme ?? (value.service === "presenter" ? "presenter" : "demo"))
      : undefined;
  if (theme && !EXPLAINER_THEMES.some((t) => t.id === theme))
    throw new Error("Choose an explanation style.");
  const presenter =
    serviceFor(task.id, theme ?? true, value.duration) === "presenter";
  if (
    (presenter && value.service !== "presenter") ||
    (!presenter && value.service === "presenter")
  )
    throw new Error("Choose an available service for this video type.");

  const max =
    task.id === "explainer" && value.service !== "presenter" ? 30 : task.max;
  if (
    !Number.isInteger(value.duration) ||
    value.duration < task.min ||
    value.duration > max
  )
    throw new Error(`Choose ${task.min}–${max} whole seconds.`);
  if (!["720p", "1080p"].includes(value.resolution))
    throw new Error("Choose 720p or 1080p.");
  if (
    !Number.isInteger(value.quantity) ||
    value.quantity < 1 ||
    value.quantity > 50
  )
    throw new Error("Choose 1–50 allowances.");
  return {
    taskType: task.id,
    service: value.service,
    duration: value.duration,
    resolution: value.resolution,
    quantity: value.quantity,
    ...(theme ? { theme } : {}),
  };
}
export function compatible(
  a: {
    service?: string;
    maxDuration: number;
    generatedCapacity?: number;
    resolution?: string;
    legacy?: boolean;
  },
  task: TaskType,
  service: Service,
  duration: number,
  resolution: Resolution,
) {
  const t = taskById(task);
  if (!t || service === "image") return false;
  if (a.legacy)
    return (
      service !== "express" &&
      duration <= a.maxDuration &&
      generatedDuration(task, duration, service) <=
        Math.max(a.maxDuration >= 120 ? 121 : a.maxDuration, 8)
    );
  return (
    a.service === service &&
    a.resolution === resolution &&
    duration <= a.maxDuration &&
    generatedDuration(task, duration, service) <= (a.generatedCapacity ?? 0)
  );
}
