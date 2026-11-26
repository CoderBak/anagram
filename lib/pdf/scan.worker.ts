import { prepareBatch } from "./reflowScan";
import type { PdfPageText, ReflowTypography } from "./reflow";

self.onmessage = (event: MessageEvent<{ pages: PdfPageText[]; compoundHeads: string[]; typography: ReflowTypography }>) => self.postMessage(prepareBatch(event.data.pages, event.data.compoundHeads, event.data.typography));
