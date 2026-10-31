import { HttpError } from "./http";
export function referenceSelection(b: any) {
  const list = (v: unknown, max: number) => {
    if (
      !Array.isArray(v) ||
      v.length > max ||
      v.some((i) => typeof i !== "string") ||
      new Set(v).size !== v.length
    )
      throw new HttpError(
        400,
        "Review your character and product image selections.",
      );
    return v as string[];
  };
  const characters = list(b.characterImageIds ?? [], 14);
  const subjects = list(b.subjectImageIds ?? [], 40);
  const images = list(b.imageIds ?? [], 1);
  if (
    characters.some((id) => subjects.includes(id)) ||
    images.some((id) => ![...characters, ...subjects].includes(id))
  )
    throw new HttpError(
      400,
      "Assign each image to character or product, then select the image to animate.",
    );
  if (
    b.service === "presenter" &&
    (images.length !== 1 || !characters.includes(images[0]))
  )
    throw new HttpError(
      400,
      "Select one character portrait for your presenter video.",
    );
  if (
    ["demo", "unboxing", "showcase"].includes(b.taskType) &&
    images.length !== 1
  )
    throw new HttpError(400, "Select the product or scene image to animate.");
  return { characters, subjects, images };
}
export function generationContext(b: any) {
  const refs = referenceSelection(b);
  return {
    taskType: b.taskType,
    service: b.service,
    duration: b.duration,
    resolution: b.resolution,
    theme: b.theme ?? "presenter",
    characterImageIds: refs.characters,
    subjectImageIds: refs.subjects,
    imageIds: refs.images,
    audioId: b.audioId ?? null,
    voiceId: b.voiceId ?? null,
    caption: !!b.caption,
    wording: b.wording ?? "exact",
    deliveryStyle: b.style ?? "Natural and conversational",
  };
}
