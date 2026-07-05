"use client"

// ---------------------------------------------------------------------------
// Client-side face capture helper. Lazy-loads face-api.js and its model weights
// (served from /public/models) only when the camera UI is actually used, so the
// ~7MB of models never affect normal page loads. Produces a 128-float descriptor
// from the webcam — we never upload images, only the embedding.
// ---------------------------------------------------------------------------

import type * as FaceApi from "@vladmandic/face-api"

const MODEL_URL = "/models"

/** Error thrown when the face-api library or its model weights fail to load.
 *  Lets the UI show an environment-specific, actionable message (common in
 *  in-app browser webviews that block the ~7MB model fetch or lack WebGL). */
export class FaceModelLoadError extends Error {
  constructor(cause?: unknown) {
    super("Failed to load face recognition models")
    this.name = "FaceModelLoadError"
    if (cause) this.cause = cause
  }
}

let faceapi: typeof FaceApi | null = null
let modelsPromise: Promise<void> | null = null

/** Lazy-import the library and load the three required models exactly once.
 *  CRITICAL: on failure we reset `modelsPromise` to null so a later retry can
 *  re-attempt — otherwise the rejected promise is cached forever and every
 *  subsequent "try again" awaits the same rejection (no recovery without a full
 *  page reload). */
async function ensureModels(): Promise<typeof FaceApi> {
  try {
    if (!faceapi) {
      faceapi = await import("@vladmandic/face-api")
    }
    if (!modelsPromise) {
      modelsPromise = (async () => {
        await faceapi!.nets.tinyFaceDetector.loadFromUri(MODEL_URL)
        await faceapi!.nets.faceLandmark68Net.loadFromUri(MODEL_URL)
        await faceapi!.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
      })()
    }
    await modelsPromise
    return faceapi!
  } catch (err) {
    // Allow the next call to retry from scratch.
    modelsPromise = null
    throw new FaceModelLoadError(err)
  }
}

export async function preloadFaceModels(): Promise<void> {
  await ensureModels()
}

/**
 * Detect a single face in the given video element and return its 128-float
 * descriptor, or null if no (single, confident) face is found.
 */
export async function captureDescriptor(video: HTMLVideoElement): Promise<number[] | null> {
  const api = await ensureModels()
  const detection = await api
    .detectSingleFace(video, new api.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
    .withFaceLandmarks()
    .withFaceDescriptor()
  if (!detection) return null
  return Array.from(detection.descriptor)
}

/**
 * Compute a 128-float descriptor from the face photo on a STATIC image (a
 * passport bio page). Used by the identity-verification gate to match a live
 * selfie against the document photo. A larger input size and lower score
 * threshold help find the small, often low-contrast photo printed on a passport.
 * Returns null if no face can be located on the document.
 *
 * As with the webcam path, the image never leaves the device for THIS step —
 * only the resulting numeric descriptor is sent to the server. (The passport
 * image is uploaded separately so the server can read its MRZ/bio-data.)
 */
export async function descriptorFromImage(
  img: HTMLImageElement | HTMLCanvasElement,
): Promise<number[] | null> {
  const api = await ensureModels()
  const detection = await api
    .detectSingleFace(img, new api.TinyFaceDetectorOptions({ inputSize: 512, scoreThreshold: 0.3 }))
    .withFaceLandmarks()
    .withFaceDescriptor()
  if (!detection) return null
  return Array.from(detection.descriptor)
}

/** Load a File/Blob into a decoded <img> element (for descriptor extraction). */
export function loadImageFromFile(file: File | Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.crossOrigin = "anonymous"
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error("Could not read the selected image."))
    }
    img.src = url
  })
}
