import { attachmentDisposition } from './content-disposition';

describe('attachmentDisposition', () => {
  it('keeps ASCII names in both parameters', () => {
    expect(attachmentDisposition('demo_frames.zip')).toBe(
      `attachment; filename="demo_frames.zip"; filename*=UTF-8''demo_frames.zip`,
    );
  });

  it('encodes UTF-8 (RFC 5987) and neutralizes quotes and non-ASCII in the fallback', () => {
    expect(attachmentDisposition('férias "2026" (1)*_frames.zip')).toBe(
      `attachment; filename="f_rias _2026_ (1)*_frames.zip"; ` +
        `filename*=UTF-8''f%C3%A9rias%20%222026%22%20%281%29%2A_frames.zip`,
    );
  });

  it('never lets CR/LF reach the header', () => {
    expect(attachmentDisposition('a\r\nSet-Cookie: x.zip')).not.toMatch(/[\r\n]/);
  });
});
