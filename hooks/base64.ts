type Base64Constructor = Uint8ArrayConstructor & { fromBase64: (text: string) => Uint8Array }
type Base64Bytes = Uint8Array & { toBase64: () => string }

export function fromBase64(text: string): Uint8Array {
  return (Uint8Array as Base64Constructor).fromBase64(text)
}

export function toBase64(bytes: Uint8Array): string {
  return (bytes as Base64Bytes).toBase64()
}
