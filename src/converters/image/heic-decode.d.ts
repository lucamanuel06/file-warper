declare module 'heic-decode' {
  interface DecodedImage {
    width: number;
    height: number;
    data: Uint8ClampedArray;
  }

  interface DecodeInput {
    buffer: Buffer | ArrayBuffer;
  }

  function decode(input: DecodeInput): Promise<DecodedImage>;

  namespace decode {
    function all(input: DecodeInput): Promise<
      Array<{
        decode(): Promise<DecodedImage>;
      }>
    >;
  }

  export = decode;
}
