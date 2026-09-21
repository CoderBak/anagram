/** Automatic takeover is decided after authorization and top-level navigation validation. */
export interface AutoOpenFacts {
  setting: boolean;
  contentType: string;
  protocol: string;
  navigationType: string;
  frame: number;
  pass: boolean;
}
export function shouldAutoOpen(facts: AutoOpenFacts): boolean {
  return facts.setting && facts.frame === 0 && facts.contentType === "application/pdf" &&
    ["http:", "https:", "file:"].includes(facts.protocol) &&
    facts.navigationType !== "back_forward" && !facts.pass;
}

export interface PdfResponseFacts {
  method: string; statusCode: number;
  responseHeaders?: {name: string; value?: string}[];
}
/** A POST response and an attachment must remain with the browser's original request. */
export function isInlinePdfResponse(details: PdfResponseFacts): boolean {
  const header = (name: string) => details.responseHeaders?.find((h) => h.name.toLowerCase() === name)?.value ?? "";
  return details.method === "GET" && details.statusCode >= 200 && details.statusCode < 300 &&
    header("content-type").split(";", 1)[0].trim().toLowerCase() === "application/pdf" &&
    !/^attachment(?:\s*;|\s*$)/i.test(header("content-disposition"));
}
