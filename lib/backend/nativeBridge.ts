import { browser } from "#imports";
import { parseComponent } from "./nativeClient";
import { nativeTransport, NativeTransportError } from "./nativeTransport";
import { NATIVE_MESSAGE, NATIVE_UNINSTALL, isRecord, trustedNativePage, validPageRequest, type NativeReply } from "./nativeProtocol";

let uninstallReceipt: string | null = null;
const error = (code: string, message: string, status = 400): NativeReply => ({v:1,id:"bridge",ok:false,status,error:{code,message}});

export async function handleNativePageMessage(
  message: unknown,
  sender: {id?:string;url?:string;frameId?:number},
  controls: {invalidate():void; clear():Promise<void>},
): Promise<NativeReply | {ok:boolean;error?:string} | undefined> {
  if (!isRecord(message) || (message.action !== NATIVE_MESSAGE && message.action !== NATIVE_UNINSTALL)) return undefined;
  if (!trustedNativePage(sender, browser.runtime.id, browser.runtime.getURL("/"))) return error("forbidden", "Only Anagram setup and settings can manage the local component",403);
  if (message.action === NATIVE_UNINSTALL) {
    if (!uninstallReceipt || message.receipt !== uninstallReceipt) return {ok:false,error:"Local cleanup has not completed"};
    uninstallReceipt = null;
    try {
      await controls.clear();
      await browser.storage.local.clear();
      nativeTransport().close();
      await browser.management.uninstallSelf({showConfirmDialog:false});
      return {ok:true};
    } catch { return {ok:false,error:"Remove the extension from the browser's extension page"}; }
  }
  if (!validPageRequest(message.op, message.payload)) return error("invalid_request","Invalid local operation");
  try {
    const reply = await nativeTransport().request(message.op,message.payload as Record<string,unknown>);
    if (reply.ok && message.op !== "status" && message.op !== "runtime") controls.invalidate();
    if (reply.ok) {
      const snapshot = parseComponent(reply.data);
      if (snapshot?.operation?.status === "completed") {
        if (snapshot.operation.name === "uninstall") uninstallReceipt = snapshot.operation.receipt;
        if (snapshot.operation.name === "update") {
          controls.invalidate();
          nativeTransport().close();
        }
      }
    }
    return reply;
  } catch (e) { return error(e instanceof NativeTransportError ? e.code : "native_unavailable", "Local component is not connected",503); }
}
