import type {
  ExtensionMessage,
  ExtensionResponse,
} from "./messaging";

export async function sendToBackground<T = unknown>(
  type: ExtensionMessage["type"],
  payload?: unknown,
): Promise<T> {
  const response = (await browser.runtime.sendMessage({
    type,
    payload,
  } satisfies ExtensionMessage)) as ExtensionResponse;
  if (!response?.ok) {
    throw new Error(response?.error ?? "Background request failed");
  }
  return response.data as T;
}
