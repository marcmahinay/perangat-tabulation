// Shrinks a phone photo of a paper scoresheet before it is sent to be read.
// Used by the encoder screen and by a judge's linked phone.

// Long enough edge to read handwriting, small enough to send over Wi-Fi quickly.
const PHOTO_EDGE = 2400;

/**
 * Returns { url, data }: `url` previews the original photo and must be released
 * with URL.revokeObjectURL when it is no longer shown; `data` is the shrunken
 * JPEG as a data URL, ready to send.
 */
export async function photoDataUrl(file) {
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  const scale = Math.min(1, PHOTO_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(image.naturalWidth * scale);
  canvas.height = Math.round(image.naturalHeight * scale);
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  return { url, data: canvas.toDataURL('image/jpeg', 0.85) };
}
