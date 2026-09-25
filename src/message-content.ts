import type { ScreenshotAttachment } from "./types";

const PNG_DATA_URL = "data:image/png;base64";

// The screenshot id rides on the image part so the agent can name the
// capture it was given; losing it makes the screenshot unpointable.
export function userContent(
  prompt: string,
  image: ScreenshotAttachment | null,
) {
  if (!image) return prompt;
  const [prefix, data] = image.dataUrl.split(",", 2);
  if (prefix !== PNG_DATA_URL || !data)
    throw new Error("The screenshot attachment is not a PNG data URL");
  return [
    { type: "text" as const, text: prompt },
    { type: "binary" as const, mimeType: "image/png", data, id: image.id },
  ];
}
