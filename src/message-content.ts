import type { ScreenshotAttachment } from "./types";

const PNG_DATA_URL = "data:image/png;base64";

// The screenshot id rides on the image part so the agent can name the
// capture it was given; losing it makes the screenshot unpointable.
export function userContent(
  prompt: string,
  image: ScreenshotAttachment | null,
) {
  if (!image) return prompt;
  const commaIndex = image.dataUrl.indexOf(",");
  const prefix =
    commaIndex === -1 ? image.dataUrl : image.dataUrl.slice(0, commaIndex);
  const data = commaIndex === -1 ? "" : image.dataUrl.slice(commaIndex + 1);
  if (prefix !== PNG_DATA_URL || !data || data.includes(","))
    throw new Error("The screenshot attachment is not a PNG data URL");
  return [
    { type: "text" as const, text: prompt },
    { type: "binary" as const, mimeType: "image/png", data, id: image.id },
  ];
}
